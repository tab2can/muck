export function showError(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

export function showOk(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

export async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'İstek başarısız.');
  return data;
}

export function setSessionCookies(session) {
  if (!session?.access_token) return;
  const maxAge = session.expires_in || 3600;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `muck_access=${encodeURIComponent(session.access_token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
  if (session.refresh_token) {
    document.cookie = `muck_refresh=${encodeURIComponent(session.refresh_token)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
  }
}

export function daysInMonth(year, month /* 1-12 */) {
  return new Date(year, month, 0).getDate();
}

export function ageFromYmd(year, month, day) {
  const today = new Date();
  let age = today.getFullYear() - year;
  const m = today.getMonth() + 1 - month;
  if (m < 0 || (m === 0 && today.getDate() < day)) age -= 1;
  return age;
}

const MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

export function initDobPicker(state) {
  const now = new Date().getFullYear();
  const minYear = now - 100;
  state.day = null;
  state.month = null;
  state.year = null;

  const dayMenu = document.getElementById('dob-day-menu');
  const monthMenu = document.getElementById('dob-month-menu');
  const yearMenu = document.getElementById('dob-year-menu');
  const dayBtn = document.getElementById('dob-day-btn');
  const monthBtn = document.getElementById('dob-month-btn');
  const yearBtn = document.getElementById('dob-year-btn');
  const dayLabel = document.getElementById('dob-day-label');
  const monthLabel = document.getElementById('dob-month-label');
  const yearLabel = document.getElementById('dob-year-label');

  function closeAll() {
    [dayMenu, monthMenu, yearMenu].forEach((m) => m?.classList.add('hidden'));
    [dayBtn, monthBtn, yearBtn].forEach((b) => {
      b?.classList.remove('open');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  function fillDays() {
    const y = state.year || now;
    const m = state.month || 1;
    const max = daysInMonth(y, m);
    if (state.day && state.day > max) {
      state.day = null;
      dayLabel.textContent = 'Gün';
    }
    dayMenu.innerHTML = '';
    for (let d = 1; d <= max; d++) {
      const li = document.createElement('li');
      li.role = 'option';
      li.textContent = String(d);
      if (state.day === d) li.classList.add('selected', 'active');
      li.addEventListener('click', () => {
        state.day = d;
        dayLabel.textContent = String(d);
        closeAll();
      });
      dayMenu.appendChild(li);
    }
  }

  monthMenu.innerHTML = '';
  MONTHS.forEach((name, i) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.textContent = name;
    li.addEventListener('click', () => {
      state.month = i + 1;
      monthLabel.textContent = name;
      fillDays();
      closeAll();
    });
    monthMenu.appendChild(li);
  });

  yearMenu.innerHTML = '';
  for (let y = now; y >= minYear; y--) {
    const li = document.createElement('li');
    li.role = 'option';
    li.textContent = String(y);
    li.addEventListener('click', () => {
      state.year = y;
      yearLabel.textContent = String(y);
      fillDays();
      closeAll();
    });
    yearMenu.appendChild(li);
  }
  fillDays();

  function toggle(btn, menu) {
    const open = !menu.classList.contains('hidden');
    closeAll();
    if (!open) {
      menu.classList.remove('hidden');
      btn.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  }

  dayBtn.addEventListener('click', (e) => { e.stopPropagation(); fillDays(); toggle(dayBtn, dayMenu); });
  monthBtn.addEventListener('click', (e) => { e.stopPropagation(); toggle(monthBtn, monthMenu); });
  yearBtn.addEventListener('click', (e) => { e.stopPropagation(); toggle(yearBtn, yearMenu); });
  document.addEventListener('click', closeAll);

  return {
    getYmd() {
      if (!state.day || !state.month || !state.year) return null;
      const mm = String(state.month).padStart(2, '0');
      const dd = String(state.day).padStart(2, '0');
      return `${state.year}-${mm}-${dd}`;
    },
    getParts: () => ({ ...state }),
  };
}
