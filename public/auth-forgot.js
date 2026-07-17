import { api, showError, showOk } from './auth-common.js';

const form = document.getElementById('forgot-form');
const errorEl = document.getElementById('error');
const okEl = document.getElementById('ok');
const submit = document.getElementById('submit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(errorEl, '');
  showOk(okEl, '');
  const email = document.getElementById('email').value.trim();
  if (!email) {
    showError(errorEl, 'E-posta gerekli.');
    return;
  }
  submit.disabled = true;
  try {
    await api('/api/forgot-password', { email });
    showOk(okEl, 'Sıfırlama bağlantısı gönderildi. E-postanı kontrol et.');
  } catch (err) {
    showError(errorEl, err.message || 'Gönderilemedi.');
  } finally {
    submit.disabled = false;
  }
});
