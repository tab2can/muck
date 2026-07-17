import { api, showError, setSessionCookies } from './auth-common.js';

const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');
const submit = document.getElementById('submit');

const params = new URLSearchParams(location.search);
if (params.get('confirmed') === '1') {
  showError(errorEl, '');
  const ok = document.createElement('p');
  ok.className = 'auth-ok';
  ok.textContent = 'E-posta doğrulandı. Şimdi giriş yapabilirsin.';
  form.prepend(ok);
}
if (params.get('check_email') === '1') {
  const ok = document.createElement('p');
  ok.className = 'auth-ok';
  ok.textContent = 'Hesap oluşturuldu. Giriş yapmadan önce e-postandaki doğrulama linkine tıkla.';
  form.prepend(ok);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(errorEl, '');
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) {
    showError(errorEl, 'E-posta ve şifre gerekli.');
    return;
  }
  submit.disabled = true;
  try {
    const data = await api('/api/login', { email, password });
    setSessionCookies(data.session);
    location.href = '/channels/@me';
  } catch (err) {
    showError(errorEl, err.message || 'Giriş başarısız.');
  } finally {
    submit.disabled = false;
  }
});
