/**
 * PIX Landing Page Proxy & Server Backend
 * Gateway: OramaPay / WLPix API
 * SSE real-time confirmation, webhook handler, lead capture.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ORAMAPAY_API_KEY = process.env.ORAMAPAY_API_KEY || '';
const ORAMAPAY_COMPANY_ID = process.env.ORAMAPAY_COMPANY_ID || '';

// Safety Check: Leads file path
const LEADS_FILE = path.join(__dirname, 'leads.json');

// Memory map to hold active SSE connections for real-time payment confirmation
// Key: txid (string), Value: Express Response Object
const activeStreams = new Map();

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static assets securely (only public directories)
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/images', express.static(path.join(__dirname, 'images')));
app.use('/fonts', express.static(path.join(__dirname, 'fonts')));

// Route to serve the landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Route to serve the thank you page
app.get('/obrigado', (req, res) => {
  res.sendFile(path.join(__dirname, 'obrigado.html'));
});

/**
 * POST /api/generate
 * Generates a PIX charge (supports Sandbox Fallback and Live API)
 */
app.post('/api/generate', async (req, res) => {
  console.log('--- /api/generate called ---');
  console.log('Headers:', req.headers);
  console.log('Raw body (as string) will be parsed by body-parser)');
  try {
    console.log('Parsed body:', req.body);
    const { amount_cents, product } = req.body;

    if (!amount_cents || isNaN(amount_cents)) {
      return res.status(400).json({ error: 'invalid_amount', message: 'Valor inválido para doação.' });
    }

    if (amount_cents < 500) { // Minimum R$ 5.00
      return res.status(400).json({ error: 'min_value_error', message: 'O valor mínimo para doação é R$ 5,00.' });
    }

    const isSandbox = ORAMAPAY_API_KEY === 'sandbox';

    if (isSandbox) {
      console.log(`[SANDBOX] Generating simulated PIX charge for BRL ${amount_cents / 100} (Product: ${product})...`);
      
      // Generate a mock txid
      const txid = 'ch_mock_' + Date.now() + Math.random().toString(36).substring(2, 8);
      
      // Generate a valid-looking PIX Copy & Paste code
      const amountFormatted = (amount_cents / 100).toFixed(2);
      const pixCode = `00020101021226850014br.gov.bcb.pix2563api.oramapay.com/v1/charge/${txid}5204000053039865405${amountFormatted}5802BR5913Amigos do Bem6009Sao Paulo62070503***6304D1B5`;
      
      // Generate a real QRCode base64 image (Data URL) from the PIX code
      const qrDataURL = await qrcode.toDataURL(pixCode);

      // Return both CamelCase and Snake_case variables to satisfy any frontend contract
      return res.json({
        txid,
        tx_id: txid,
        pixCode,
        pix_code: pixCode,
        qrDataURL
      });
    } else {
      console.log(`[PRODUCTION] Creating live PIX charge via OramaPay/WLPix for BRL ${amount_cents / 100}...`);

      // Call OramaPay/WLPix API to generate a charge
      // Typically, OramaPay / WLPix uses a POST to /charges or /v1/charges
      // We will proxy this call with Bearer authentication
      try {
        const payload = {
          amount: amount_cents,
          paymentMethod: "pix",
          customer: {
            name: "João Silva",
            email: "joao@email.com",
            phone: "11999998888",
            document: {
              number: "01234567890",
              type: "cpf"
            }
          },
          items: [
            {
              title: product || "Produto",
              unitPrice: amount_cents,
              quantity: 1,
              tangible: false
            }
          ],
          pix: { expiresInDays: 2 }
        };
        const response = await axios.post(
          "https://api.oramapay.com/api/v1/transactions",
          payload,
          {
            auth: {
              username: "live_KqPLrjYlMmKoXsH9rok7HpxLILoxDaOf",
              password: "80c8b00b-4d52-48da-b510-b2d952f07f96"
            },
            headers: {
              "User-Agent": "MinhaLoja/1.0 (+contato@minhaloja.com.br)",
              "Content-Type": "application/json"
            },
            timeout: 10000
          }
        );

        const data = response.data || {};
        console.log('OramaPay response data:', data);
        
        // Extract fields. Standard BRCode responses contain id (or txid), pix_code (or emv/payload), qr_code_url
        const txid = data.id || data.txid || data.tx_id;
        const pixCode = data.pix?.qrcode || data.pix_code || data.pixCode || data.emv || data.payload;
        let qrDataURL = data.qr_code_url || data.qrDataURL || data.qrcode;

        if (!pixCode) {
          throw new Error('OramaPay API did not return a valid pix_code/emv string.');
        }

        // If OramaPay didn't return a direct image URL or base64 qrDataURL, generate it locally from the pixCode
        if (!qrDataURL) {
          qrDataURL = await qrcode.toDataURL(pixCode);
        }

        console.log(`[PRODUCTION] Charge generated successfully. ID: ${txid}`);
        return res.json({
          txid,
          tx_id: txid,
          pixCode,
          pix_code: pixCode,
          qrDataURL
        });

      } catch (apiError) {
        console.error('OramaPay/WLPix API Error:', apiError.response ? apiError.response.data : apiError.message);
        
        // Check for specific API error indicators
        const errorData = apiError.response ? apiError.response.data : {};
        if (errorData.error === 'high_demand' || apiError.code === 'ECONNABORTED') {
          return res.status(503).json({ error: 'high_demand', message: 'Estamos com alta demanda. Tente novamente em alguns segundos.' });
        }
        
        return res.status(502).json({ 
          error: 'temporary_unavailable', 
          message: 'Não foi possível confirmar a geração do PIX agora. Tente novamente em alguns segundos.' 
        });
      }
    }
  } catch (err) {
    console.error('Error generating PIX:', err);
    res.status(500).json({ error: 'server_error', message: 'Erro interno ao gerar cobrança PIX.' });
  }
});

/**
 * GET /api/payment/stream/:txid
 * Server-Sent Events (SSE) stream to push real-time status updates
 */
app.get('/api/payment/stream/:txid', (req, res) => {
  const { txid } = req.params;

  if (!txid) {
    return res.status(400).json({ error: 'missing_txid' });
  }

  // Set SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Disable proxy buffering for instant delivery
  });

  // Keep-alive: write initial comment to establish the connection
  res.write(':\n\n');

  // Register this response handle to our active streams map
  activeStreams.set(txid, res);
  console.log(`[SSE] Connected stream for txid: ${txid}. Active streams: ${activeStreams.size}`);

  // Send a keep-alive comment every 15 seconds to prevent intermediate gateway timeouts
  const keepAliveInterval = setInterval(() => {
    res.write(':\n\n');
  }, 15000);

  // Connection teardown when client disconnects
  req.on('close', () => {
    clearInterval(keepAliveInterval);
    activeStreams.delete(txid);
    console.log(`[SSE] Disconnected stream for txid: ${txid}. Active streams: ${activeStreams.size}`);
  });
});

/**
 * POST /api/webhooks/oramapay
 * Webhook endpoint for live OramaPay payment confirmation notifications
 */
app.post('/api/webhooks/oramapay', (req, res) => {
  try {
    const payload = req.body;
    console.log('[WEBHOOK] Received OramaPay payment notification:', JSON.stringify(payload));

    // Support multiple webhook structures
    // E.g., { id: "ch_...", status: "paid" } or { event: "charge.paid", data: { id: "ch_..." } }
    const txid = payload.id || (payload.data && payload.data.id);
    const status = payload.status || (payload.data && payload.data.status) || payload.event;

    if (!txid) {
      return res.status(400).json({ error: 'missing_id', message: 'Invalid payload: missing id' });
    }

    const isPaid = status === 'paid' || status === 'confirmed' || status === 'charge.paid';

    if (isPaid) {
      console.log(`[WEBHOOK] Confirming payment for txid: ${txid}`);
      const clientStream = activeStreams.get(txid);

      if (clientStream) {
        // Send confirmed event to frontend
        clientStream.write('event: confirmed\n');
        clientStream.write(`data: ${JSON.stringify({ status: 'confirmed', txid })}\n\n`);
        
        console.log(`[SSE] Dispatched "confirmed" event successfully for txid: ${txid}`);
      } else {
        console.log(`[SSE] Warning: No active SSE stream found for paid txid: ${txid}`);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[WEBHOOK] Webhook processing error:', err);
    res.status(500).json({ error: 'webhook_processing_failed' });
  }
});

/**
 * GET /api/test/confirm/:txid
 * Homologation / Sandbox testing utility to simulate a successful webhook payment confirmation
 */
app.get('/api/test/confirm/:txid', (req, res) => {
  const { txid } = req.params;

  console.log(`[TEST-SIMULATOR] Triggering simulated payment confirmation for txid: ${txid}`);

  const clientStream = activeStreams.get(txid);

  if (clientStream) {
    // Dispatch standard 'confirmed' event to the frontend EventSource
    clientStream.write('event: confirmed\n');
    clientStream.write(`data: ${JSON.stringify({ status: 'confirmed', txid })}\n\n`);

    console.log(`[TEST-SIMULATOR] Successfully dispatched confirmed event to stream for txid: ${txid}`);
    return res.json({ success: true, message: `Dispatched payment confirmation for txid: ${txid}` });
  } else {
    console.log(`[TEST-SIMULATOR] Error: No active SSE connection found for txid: ${txid}`);
    return res.status(404).json({ 
      success: false, 
      message: `Nenhuma conexão de stream ativa encontrada para o txid: ${txid}. Abra a landing page e gere o PIX antes de confirmar.` 
    });
  }
});

/**
 * POST /api/leads
 * Lead capture endpoint. Saves details to a local leads.json file securely.
 */
app.post('/api/leads', async (req, res) => {
  try {
    const { name, email, phone } = req.body;

    if (!name || !name.trim() || !email || !email.trim() || !phone) {
      return res.status(400).json({ error: 'missing_fields', message: 'Preencha todos os campos obrigatórios.' });
    }

    console.log(`[LEAD] Capturing new lead: Name=${name}, Email=${email}, Phone=${phone}`);

    const newLead = {
      id: 'lead_' + Date.now() + Math.random().toString(36).substring(2, 6),
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      timestamp: new Date().toISOString()
    };

    let leadsList = [];

    // Safely read and append to leads.json
    try {
      if (fs.existsSync(LEADS_FILE)) {
        const fileContent = fs.readFileSync(LEADS_FILE, 'utf8');
        leadsList = JSON.parse(fileContent || '[]');
      }
    } catch (readError) {
      console.warn('[LEAD] Warning reading leads file, starting fresh array:', readError.message);
    }

    leadsList.push(newLead);

    // Save back to file
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leadsList, null, 2), 'utf8');
    console.log(`[LEAD] Lead successfully saved to leads.json. Total leads: ${leadsList.length}`);

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving lead:', err);
    res.status(500).json({ error: 'lead_save_failed', message: 'Erro ao processar e salvar o cadastro.' });
  }
});

// Wildcard fallback to serve index.html for client side routing
app.get('*any', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Amigos do Bem - PIX Proxy Server rodando com sucesso!`);
  console.log(`  URL Local: http://localhost:${PORT}`);
  console.log(`  Chave API OramaPay: ${ORAMAPAY_API_KEY}`);
  console.log(`=======================================================`);
});
