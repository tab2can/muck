import { api, showError, setSessionCookies, initDobPicker, ageFromYmd } from './auth-common.js';

const form = document.getElementById('register-form');
const errorEl = document.getElementById('error');
const submit = document.getElementById('submit');
const dobState = {};
const dob = initDobPicker(dobState);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(errorEl, '');

  const email = document.getElementById('email').value.trim();
  const displayName = document.getElementById('display-name').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const marketing = document.getElementById('marketing').checked;
  const parts = dob.getParts();
  const birthDate = dob.getYmd();

  if (!email || !username || !password) {
    showError(errorEl, 'Zorunlu alanları doldur.');
    return;
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    showError(errorEl, 'Kullanıcı adı 3-20 karakter, harf/rakam/alt çizgi olmalı.');
    return;
  }
  if (password.length < 6) {
    showError(errorEl, 'Şifre en az 6 karakter olmalı.');
    return;
  }
  if (!birthDate) {
    showError(errorEl, 'Doğum tarihini seç.');
    return;
  }
  if (ageFromYmd(parts.year, parts.month, parts.day) < 13) {
    showError(errorEl, 'Muck kullanmak için en az 13 yaşında olmalısın.');
    return;
  }

  submit.disabled = true;
  try {
    const data = await api('/api/register', {
      email,
      password,
      username,
      displayName: displayName || null,
      birthDate,
      marketingOptIn: marketing,
    });
    if (data.session) {
      setSessionCookies(data.session);
      location.href = '/channels/@me';
      return;
    }
    location.href = '/login?check_email=1';
  } catch (err) {
    showError(errorEl, err.message || 'Kayıt başarısız.');
  } finally {
    submit.disabled = false;
  }
});
