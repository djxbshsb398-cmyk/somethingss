/* ==========================================================================
   PIX Landing Page — Main Application JS
   SSE-based payment confirmation, modal, upsell, lead capture.
   No external dependencies.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------- Constants ---------------- */
  const COUNTDOWN_SECONDS = 30 * 60; // 30 minutes
  const MIN_CUSTOM_VALUE_CENTS = 500; // R$5
  const REDIRECT_DELAY_MS = 1500;

  /* ---------------- State ---------------- */
  let countdownInterval = null;
  let countdownRemaining = COUNTDOWN_SECONDS;
  let eventSource = null;

  /* ---------------- DOM refs (populated on init) ---------------- */
  let modal,
    modalBackdrop,
    modalPanel,
    modalClose,
    modalQrcode,
    modalPixText,
    modalBtnCopy,
    modalStatus,
    modalAmount,
    modalTimer,
    modalSuccess;

  /* ==========================================================================
     Initialization
     ========================================================================== */

  document.addEventListener('DOMContentLoaded', function () {
    cacheModalElements();
    bindDonationButtons();
    bindCustomValue();
    bindLeadForm();
  });

  function cacheModalElements() {
    modal = document.getElementById('pix-modal');
    modalBackdrop = modal ? modal.querySelector('.modal-backdrop') : null;
    modalPanel = modal ? modal.querySelector('.modal-panel') : null;
    modalClose = document.getElementById('modal-close');
    modalQrcode = document.getElementById('modal-qrcode');
    modalPixText = document.getElementById('modal-pix-text');
    modalBtnCopy = document.getElementById('modal-btn-copy');
    modalStatus = document.getElementById('modal-status');
    modalAmount = document.getElementById('modal-amount');
    modalTimer = document.getElementById('modal-timer');
    modalSuccess = document.getElementById('modal-success');

    if (modalClose) {
      modalClose.addEventListener('click', closeModal);
    }
    if (modalBackdrop) {
      modalBackdrop.addEventListener('click', closeModal);
    }

    if (modalPixText) {
      modalPixText.style.cursor = 'pointer';
      modalPixText.addEventListener('click', function () {
        if (modalPixText.value) {
          copyToClipboard(modalPixText.value);
        }
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && modal.classList.contains('show')) {
        closeModal();
      }
    });
  }

  /* ==========================================================================
     Modal open / close
     ========================================================================== */

  function openModal() {
    if (!modal) return;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    // Force reflow before adding class so the transition fires
    void modal.offsetHeight;
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    // Wait for close transition then hide
    setTimeout(function () {
      if (!modal.classList.contains('show')) {
        modal.style.display = 'none';
      }
    }, 300);

    stopCountdown();
    // Do NOT close the EventSource — user may have copied the PIX code
    // and will pay later. SSE stays open to detect confirmation.
  }

  function resetModalContent() {
    if (modalQrcode) modalQrcode.innerHTML = '';
    if (modalPixText) modalPixText.value = '';
    if (modalStatus) {
      modalStatus.textContent = modalLabel('waitingLabel', '');
      modalStatus.classList.remove('blink');
    }
    if (modalAmount) modalAmount.textContent = '';
    if (modalTimer) modalTimer.textContent = '';
    if (modalSuccess) modalSuccess.style.display = 'none';
    if (modalBtnCopy) {
      setCopyButtonLabel(modalBtnCopy, copyButtonLabelValue(modalBtnCopy, 'defaultLabel', 'Copiar'));
      modalBtnCopy.disabled = false;
    }
  }

  /* ==========================================================================
     Donation Buttons
     ========================================================================== */

  function bindDonationButtons() {
    const buttons = document.querySelectorAll('.donation-button');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        const valueReais = parseFloat(btn.getAttribute('data-value'));
        if (!valueReais || valueReais <= 0) return;
        handleDonation(Math.round(valueReais * 100));
      });
    });
  }

  async function handleDonation(amountCents) {
    const product = document.body.getAttribute('data-product') || 'default';

    // Close any existing SSE connection from a previous payment
    closeEventSource();
    resetModalContent();

    // Show modal with loading state
    openModal();
    if (modalStatus) {
      modalStatus.textContent = modalLabel('generatingLabel', 'Gerando PIX...');
      modalStatus.classList.add('blink');
    }
    if (modalQrcode) {
      modalQrcode.innerHTML =
        '<svg class="icon icon-spin" style="width:2rem;height:2rem" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="31.4 31.4" stroke-linecap="round"/></svg>';
    }

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_cents: amountCents, product: product }),
      });

      const payload = await res.json().catch(function () {
        return null;
      });

      if (!res.ok) {
        const message =
          payload && typeof payload.message === 'string' && payload.message
            ? payload.message
            : 'HTTP ' + res.status;
        const err = new Error(message);
        err.status = res.status;
        err.apiError = payload && payload.error ? payload.error : '';
        throw err;
      }

      const data = payload || {};

      // Populate modal
      if (modalQrcode) {
        modalQrcode.innerHTML =
          '<img src="' +
          data.qrDataURL +
          '" alt="QR Code PIX" style="width:100%;height:auto;border-radius:0.5rem;" />';
      }
      if (modalPixText) {
        modalPixText.value = data.pixCode || data.pix_code || '';
      }
      if (modalAmount) {
        modalAmount.textContent = formatBRL(amountCents);
      }
      if (modalStatus) {
        modalStatus.textContent = modalLabel('waitingLabel', 'Aguardando pagamento...');
        modalStatus.classList.add('blink');
      }

      // Bind copy button for this code
      bindCopyButton(data.pixCode || data.pix_code || '');

      // Start countdown
      startCountdown();

      // Connect SSE stream
      const txid = data.txid || data.tx_id || '';
      if (txid) {
        connectPaymentStream(txid);
      }

    } catch (err) {
      console.error('Failed to generate PIX:', err);
      if (modalStatus) {
        let message = modalLabel('errorLabel', 'Erro ao gerar PIX. Tente novamente.');
        if (err && err.apiError === 'high_demand') {
          message = modalLabel(
            'highDemandMessage',
            'Estamos com alta demanda. Tente novamente em alguns segundos.'
          );
        } else if (err && err.apiError === 'temporary_unavailable') {
          message = modalLabel(
            'temporaryUnavailableMessage',
            'Nao foi possivel confirmar a geracao do PIX agora. Tente novamente em alguns segundos.'
          );
        }
        modalStatus.textContent = message;
        modalStatus.classList.remove('blink');
      }
      if (modalQrcode) {
        modalQrcode.innerHTML = '';
      }
    }
  }

  /* ==========================================================================
     SSE — Payment Stream
     ========================================================================== */

  function connectPaymentStream(txid) {
    closeEventSource();

    const source = new EventSource('/api/payment/stream/' + txid);

    source.addEventListener('confirmed', function () {
      // Reopen modal if user closed it (copied PIX code and paid externally)
      if (!modal.classList.contains('show')) {
        openModal();
      }
      if (modalStatus) {
        modalStatus.textContent = modalLabel('paidLabel', 'Pago!');
        modalStatus.classList.remove('blink');
      }
      if (modalSuccess) {
        modalSuccess.style.display = 'block';
      }
      stopCountdown();
      source.close();
      eventSource = null;

      setTimeout(function () {
        window.location.href = '/obrigado';
      }, REDIRECT_DELAY_MS);
    });

    source.addEventListener('expired', function () {
      if (modalStatus) {
        modalStatus.textContent = modalLabel('expiredLabel', 'Expirado');
        modalStatus.classList.remove('blink');
      }
      stopCountdown();
      source.close();
      eventSource = null;
    });

    source.onerror = function () {
      // EventSource will auto-reconnect on transient failures
      console.log('SSE connection error, will retry...');
    };

    eventSource = source;
  }

  function closeEventSource() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  /* ==========================================================================
     Countdown Timer
     ========================================================================== */

  function startCountdown() {
    stopCountdown();
    countdownRemaining = COUNTDOWN_SECONDS;
    updateTimerDisplay();

    countdownInterval = setInterval(function () {
      countdownRemaining--;
      if (countdownRemaining <= 0) {
        stopCountdown();
        if (modalStatus) {
          modalStatus.textContent = modalLabel('expiredLabel', 'Expirado');
          modalStatus.classList.remove('blink');
        }
        closeEventSource();
        return;
      }
      updateTimerDisplay();
    }, 1000);
  }

  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  function updateTimerDisplay() {
    if (!modalTimer) return;
    const min = Math.floor(countdownRemaining / 60);
    const sec = countdownRemaining % 60;
    modalTimer.textContent =
      String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  /* ==========================================================================
     Copy to Clipboard
     ========================================================================== */

  function bindCopyButton(pixCode) {
    if (!modalBtnCopy) return;

    // Remove old listeners by cloning
    const newBtn = modalBtnCopy.cloneNode(true);
    modalBtnCopy.parentNode.replaceChild(newBtn, modalBtnCopy);
    modalBtnCopy = newBtn;

    modalBtnCopy.addEventListener('click', function () {
      copyToClipboard(pixCode);
    });
  }

  async function copyToClipboard(text) {
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      showCopyFeedback(true);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showCopyFeedback(true);
      } catch {
        showCopyFeedback(false);
      }
      document.body.removeChild(textarea);
    }
  }

  function showCopyFeedback(success) {
    if (!modalBtnCopy) return;
    const original = copyButtonLabelValue(modalBtnCopy, 'defaultLabel', 'Copiar');
    setCopyButtonLabel(
      modalBtnCopy,
      success
        ? copyButtonLabelValue(modalBtnCopy, 'successLabel', 'Copiado!')
        : copyButtonLabelValue(modalBtnCopy, 'errorLabel', 'Erro')
    );
    modalBtnCopy.disabled = true;
    setTimeout(function () {
      setCopyButtonLabel(modalBtnCopy, original);
      modalBtnCopy.disabled = false;
    }, 2000);
  }

  /* ==========================================================================
     Custom Value (Upsell Page)
     ========================================================================== */

  function bindCustomValue() {
    const input = document.querySelector('.custom-input');
    const btn = document.querySelector('.custom-donate-btn');
    if (!input || !btn) return;

    // Allow only numbers and comma/period
    input.addEventListener('input', function () {
      this.value = this.value.replace(/[^\d.,]/g, '');
    });

    btn.addEventListener('click', function () {
      const raw = input.value.replace(',', '.');
      const valueReais = parseFloat(raw);

      if (isNaN(valueReais) || valueReais < MIN_CUSTOM_VALUE_CENTS / 100) {
        input.style.borderColor = 'var(--error)';
        input.focus();
        setTimeout(function () {
          input.style.borderColor = '';
        }, 2000);
        return;
      }

      handleDonation(Math.round(valueReais * 100));
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        btn.click();
      }
    });
  }

  /* ==========================================================================
     Lead Form (Obrigado Page)
     ========================================================================== */

  function bindLeadForm() {
    const form = document.getElementById('lead-form');
    if (!form) return;

    const phoneInput = form.querySelector('input[name="phone"]');
    if (phoneInput) {
      phoneInput.addEventListener('input', applyPhoneMask);
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      await handleLeadSubmit(form);
    });
  }

  function applyPhoneMask(e) {
    let v = e.target.value.replace(/\D/g, '');
    if (v.length > 11) v = v.slice(0, 11);

    if (v.length > 6) {
      v = '(' + v.slice(0, 2) + ') ' + v.slice(2, 7) + '-' + v.slice(7);
    } else if (v.length > 2) {
      v = '(' + v.slice(0, 2) + ') ' + v.slice(2);
    } else if (v.length > 0) {
      v = '(' + v;
    }

    e.target.value = v;
  }

  async function handleLeadSubmit(form) {
    // Clear previous errors
    form.querySelectorAll('.form-error').forEach(function (el) {
      el.classList.remove('visible');
    });
    form.querySelectorAll('input.error').forEach(function (el) {
      el.classList.remove('error');
    });

    const name = form.querySelector('input[name="name"]');
    const email = form.querySelector('input[name="email"]');
    const phone = form.querySelector('input[name="phone"]');
    let valid = true;

    if (!name || !name.value.trim()) {
      showFieldError(name, form.getAttribute('data-name-error') || 'Informe seu nome');
      valid = false;
    }

    if (!email || !email.value.trim() || !isValidEmail(email.value.trim())) {
      showFieldError(email, form.getAttribute('data-email-error') || 'Informe um e-mail valido');
      valid = false;
    }

    const phoneDigits = phone ? phone.value.replace(/\D/g, '') : '';
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      showFieldError(phone, form.getAttribute('data-phone-error') || 'Informe um telefone valido');
      valid = false;
    }

    if (!valid) return;

    const submitBtn = form.querySelector('.btn-submit');
    const downloadUrl = form.getAttribute('data-download-url') || '';
    const downloadName = form.getAttribute('data-download-name') || '';
    const redirectHref = form.getAttribute('data-redirect-href') || '';
    if (submitBtn) {
      submitBtn.disabled = true;
      setSubmitButtonText(submitBtn, submitBtn.getAttribute('data-submitting-text') || 'Enviando...');
    }

    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.value.trim(),
          email: email.value.trim(),
          phone: phoneDigits,
        }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);

      if (submitBtn) {
        setSubmitButtonText(
          submitBtn,
          submitBtn.getAttribute('data-success-text') ||
            (downloadUrl ? 'Enviado! Preparando download...' : 'Enviado!')
        );
      }

      if (downloadUrl) {
        triggerDownload(downloadUrl, downloadName);
      } else if (redirectHref) {
        window.location.href = redirectHref;
      }
    } catch (err) {
      console.error('Lead submission failed:', err);
      if (submitBtn) {
        submitBtn.disabled = false;
        setSubmitButtonText(submitBtn, submitBtn.getAttribute('data-retry-text') || 'Tentar novamente');
      }
    }
  }

  function showFieldError(input, message) {
    if (!input) return;
    input.classList.add('error');
    const errorEl = input.parentElement
      ? input.parentElement.querySelector('.form-error')
      : null;
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.add('visible');
    }
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || '';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ==========================================================================
     Helpers
     ========================================================================== */

  function formatBRL(cents) {
    const reais = (cents / 100).toFixed(2).replace('.', ',');
    return 'R$ ' + reais;
  }

  function modalLabel(key, fallback) {
    if (!modal || !modal.dataset) return fallback;
    return modal.dataset[key] || fallback;
  }

  function copyButtonLabelValue(button, key, fallback) {
    if (!button || !button.dataset) return fallback;
    return button.dataset[key] || fallback;
  }

  function setCopyButtonLabel(button, text) {
    if (!button) return;
    const label = button.querySelector('.modal-copy-label');
    if (label) {
      label.textContent = text;
      return;
    }
    button.textContent = text;
  }

  function setSubmitButtonText(button, text) {
    if (!button) return;
    const label = button.querySelector('#btn-text');
    if (label) {
      label.textContent = text;
      return;
    }
    button.textContent = text;
  }
})();
