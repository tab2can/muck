import { createVoiceManager } from './voice.js';

const $ = (id) => document.getElementById(id);
const THEME_COLORS = { dark: '#0f1117', black: '#000000', light: '#f3f5f9' };

// State
let socket = null;
let currentUser = null;
let friends = [];
let servers = [];
let activeServer = null; // full server object from get-server
let activeView = 'empty'; // empty | chat | dm | voice | settings
let activeChannelId = null;
let activeDmFriendId = null;
let activeDmChannelId = null;
let voiceManager = null;
let voicePresence = {}; // channelId -> participants
let maximizedTile = null; // büyütülen kutunun anahtarı
const onlineMembers = new Set(); // bilinen çevrimiçi üye id'leri (opsiyonel)

/* ================= Router ================= */
// URL'yi geçmişe ekle (aynıysa tekrar etme).
function navTo(path) {
  if (location.pathname === path) return;
  history.pushState({}, '', path);
}

// Geçerli URL'ye göre görünümü ayarla (deep-link, boot, geri/ileri).
function applyRoute() {
  if (!currentUser) return;
  const pathname = location.pathname;
  if (pathname === '/settings') { goHome(false); openSettings(); return; }
  const parts = pathname.split('/').filter(Boolean); // ['channels','@me', id?]
  if (parts[0] !== 'channels') { history.replaceState({}, '', '/channels/@me'); goHome(false); return; }
  const a = parts[1];
  const b = parts[2];
  if (!a || a === '@me') {
    if (b) openDMByChannel(b, false);
    else goHome(false);
    return;
  }
  selectServer(a, b || null, false);
}

const settings = { theme: 'dark', accent: 'blue', animations: true };

/* ================= Utils ================= */
function initials(name) { return (name || '?').slice(0, 2).toUpperCase(); }
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.classList.add('hidden'), 250); }, 2200);
}

function setCookie(name, value) {
  const secure = location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${name}=${value}; max-age=${31536000}; path=/; samesite=lax${secure}`;
}
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
function deleteCookie(name) { document.cookie = `${name}=; max-age=0; path=/`; }

/* ================= Settings ================= */
function loadSettings() {
  try {
    settings.theme = localStorage.getItem('muck_theme') || localStorage.getItem('streamuck_theme') || 'dark';
    settings.accent = localStorage.getItem('muck_accent') || localStorage.getItem('streamuck_accent') || 'blue';
    settings.animations = (localStorage.getItem('muck_animations') || localStorage.getItem('streamuck_animations')) !== 'off';
  } catch {}
}
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.accent = settings.accent;
  document.documentElement.classList.toggle('no-anim', !settings.animations);
  const meta = $('theme-color-meta');
  if (meta) meta.setAttribute('content', THEME_COLORS[settings.theme] || '#0f1117');
  document.querySelectorAll('[data-theme-value]').forEach((el) => el.classList.toggle('active', el.dataset.themeValue === settings.theme));
  document.querySelectorAll('[data-accent-value]').forEach((el) => el.classList.toggle('active', el.dataset.accentValue === settings.accent));
  const ta = $('toggle-animations'); if (ta) ta.checked = settings.animations;
}
function saveSetting(key, storageKey, value) {
  settings[key] = value;
  try { localStorage.setItem(storageKey, value === true ? 'on' : value === false ? 'off' : value); } catch {}
  applySettings();
}

/* ================= Modals ================= */
function showModal(title, bodyHtml, actions) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const actionsEl = $('modal-actions');
  actionsEl.innerHTML = '';
  for (const { label, className, onClick } of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${className || 'btn-secondary'}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    actionsEl.appendChild(btn);
  }
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() { $('modal-overlay').classList.add('hidden'); }
$('modal-overlay').addEventListener('click', (e) => { if (e.target === $('modal-overlay')) closeModal(); });

/* ================= Views ================= */
function showApp() { $('auth-view').classList.add('hidden'); $('app').classList.remove('hidden'); }
function showAuth() { $('auth-view').classList.remove('hidden'); $('app').classList.add('hidden'); }

function setMainView(view) {
  activeView = view;
  ['view-empty', 'view-chat', 'view-dm', 'view-voice'].forEach((id) => $(id).classList.add('hidden'));
  if (view !== 'empty') $(`view-${view}`).classList.remove('hidden');
  else $('view-empty').classList.remove('hidden');
  updatePanel();
}

/* ================= Right panel (üyeler / profil) ================= */
function updatePanel() {
  const app = $('app');
  const members = $('panel-members');
  const profile = $('panel-profile');
  if (activeServer && (activeView === 'chat' || activeView === 'voice' || activeView === 'empty')) {
    renderMembers();
    members.classList.remove('hidden');
    profile.classList.add('hidden');
    app.classList.add('with-panel');
  } else if (activeView === 'dm' && activeDmFriendId) {
    renderProfile();
    profile.classList.remove('hidden');
    members.classList.add('hidden');
    app.classList.add('with-panel');
  } else {
    members.classList.add('hidden');
    profile.classList.add('hidden');
    app.classList.remove('with-panel');
  }
}

function renderMembers() {
  if (!activeServer) return;
  const list = $('member-list');
  list.innerHTML = '';
  const members = activeServer.members || [];
  $('member-count').textContent = members.length;
  const sorted = [...members].sort((a, b) => Number(isMemberOnline(b.id)) - Number(isMemberOnline(a.id)));
  for (const m of sorted) {
    const online = isMemberOnline(m.id);
    const li = document.createElement('li');
    li.className = `member-row${online ? '' : ' offline'}`;
    li.innerHTML = `
      <span class="member-avatar">${escapeHtml(initials(m.username))}<span class="member-status ${online ? 'on' : ''}"></span></span>
      <span class="member-name">${escapeHtml(m.username)}</span>`;
    list.appendChild(li);
  }
}

// Bir üyenin çevrimiçi olup olmadığını bilinen bilgilerden tahmin et.
function isMemberOnline(id) {
  if (id === currentUser?.id) return true;
  const f = friends.find((x) => x.id === id);
  if (f) return !!f.online;
  return onlineMembers.has(id);
}

function renderProfile() {
  const friend = friends.find((f) => f.id === activeDmFriendId);
  if (!friend) return;
  $('profile-avatar').textContent = initials(friend.username);
  $('profile-name').textContent = friend.username;
  $('profile-username').textContent = friend.username;
  const online = !!friend.online;
  $('profile-status').querySelector('.status-dot').classList.toggle('on', online);
  $('profile-status-text').textContent = online ? 'Çevrimiçi' : 'Çevrimdışı';
}

/* ================= Rail ================= */
function renderRail() {
  const container = $('rail-servers');
  container.innerHTML = '';
  for (const s of servers) {
    const btn = document.createElement('button');
    btn.className = 'rail-server' + (activeServer?.id === s.id ? ' active' : '');
    btn.title = s.name;
    btn.textContent = s.name.slice(0, 2).toUpperCase();
    btn.addEventListener('click', () => selectServer(s.id));
    container.appendChild(btn);
  }
}

function setRailActive(target) {
  $('btn-home').classList.toggle('active', target === 'home');
  $('btn-settings').classList.toggle('active', target === 'settings');
  document.querySelectorAll('.rail-server').forEach((el) => el.classList.remove('active'));
}

/* ================= Sidebar ================= */
function showSidebarHome() {
  $('sidebar-home').classList.remove('hidden');
  $('sidebar-server').classList.add('hidden');
  $('sidebar-title').textContent = 'Ana Sayfa';
  $('btn-add-friend').classList.remove('hidden');
  $('btn-server-settings').classList.add('hidden');
  setRailActive('home');
}

function showSidebarServer() {
  $('sidebar-home').classList.add('hidden');
  $('sidebar-server').classList.remove('hidden');
  $('sidebar-title').textContent = activeServer?.name || 'Sunucu';
  $('btn-add-friend').classList.add('hidden');
  $('btn-server-settings').classList.toggle('hidden', activeServer?.ownerId !== currentUser?.id);
  document.querySelectorAll('.rail-server').forEach((el) => {
    el.classList.toggle('active', el.title === activeServer?.name);
  });
}

function renderFriends() {
  const list = $('friends-list');
  list.innerHTML = '';
  const sorted = [...friends].sort((a, b) => Number(b.online) - Number(a.online));
  for (const f of sorted) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'sidebar-item' + (activeDmFriendId === f.id ? ' active' : '');
    btn.innerHTML = `<span class="status-dot ${f.online ? 'on' : ''}"></span>${escapeHtml(f.username)}`;
    btn.addEventListener('click', () => openDM(f.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
  $('friends-empty').classList.toggle('hidden', friends.length > 0);
}

function renderChannels() {
  if (!activeServer) return;
  const textList = $('text-channels');
  const voiceList = $('voice-channels');
  textList.innerHTML = '';
  voiceList.innerHTML = '';

  for (const ch of activeServer.channels.filter((c) => c.type === 'text')) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'sidebar-item' + (activeChannelId === ch.id ? ' active' : '');
    btn.innerHTML = `<span class="ch-icon">#</span>${escapeHtml(ch.name)}`;
    btn.addEventListener('click', () => openTextChannel(ch.id, ch.name));
    li.appendChild(btn);
    textList.appendChild(li);
  }

  for (const ch of activeServer.channels.filter((c) => c.type === 'voice')) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'sidebar-item' + (voiceManager?.getChannelId() === ch.id ? ' active' : '');
    btn.innerHTML = `<span class="ch-icon">🔊</span>${escapeHtml(ch.name)}`;
    btn.addEventListener('click', () => joinVoiceChannel(ch.id, ch.name));
    li.appendChild(btn);
    voiceList.appendChild(li);

    const presence = voicePresence[ch.id] || [];
    // Aynı kullanıcı birden fazla cihazdan bağlıysa tek kez göster.
    const seen = new Set();
    const uniquePresence = presence.filter((p) => (seen.has(p.userId) ? false : seen.add(p.userId)));
    if (uniquePresence.length) {
      const ul = document.createElement('ul');
      ul.className = 'voice-users';
      for (const p of uniquePresence) {
        const vu = document.createElement('li');
        vu.className = 'voice-user';
        vu.innerHTML = `<span class="status-dot on"></span>${escapeHtml(p.username)}${p.muted ? ' 🔇' : ''}`;
        ul.appendChild(vu);
      }
      li.appendChild(ul);
    }
  }
}

/* ================= Navigation ================= */
function goHome(push = true) {
  activeServer = null;
  activeChannelId = null;
  activeDmFriendId = null;
  activeDmChannelId = null;
  showSidebarHome();
  renderFriends();
  setMainView('empty');
  $('empty-hint').textContent = 'Bir arkadaş seç veya sunucuya katıl.';
  setRailActive('home');
  closeDrawers();
  if (push) navTo('/channels/@me');
}

function openSettings() {
  $('settings-username').textContent = currentUser?.username || '—';
  applySettings();
  $('settings-overlay').classList.remove('hidden');
  closeDrawers();
}
function closeSettings() { $('settings-overlay').classList.add('hidden'); }

function selectServer(serverId, channelId = null, push = true) {
  socket.emit('get-server', { serverId }, (res) => {
    if (res.error) { toast(res.error); goHome(false); navTo('/channels/@me'); return; }
    activeServer = res.server;
    activeDmFriendId = null;
    activeDmChannelId = null;
    // Ses kanallarının mevcut katılımcılarını yükle (yenileme sonrası da görünür).
    if (res.voice) for (const v of res.voice) voicePresence[v.channelId] = v.participants;
    showSidebarServer();
    renderChannels();
    if (channelId) {
      const ch = activeServer.channels.find((c) => c.id === channelId);
      if (ch) {
        if (ch.type === 'text') { openTextChannel(ch.id, ch.name, push); return; }
        joinVoiceChannel(ch.id, ch.name, push); return;
      }
    }
    setMainView('empty');
    $('empty-hint').textContent = 'Bir kanal seç.';
    closeDrawers();
    if (push) navTo(`/channels/${serverId}`);
  });
}

/* ================= Text chat ================= */
function openTextChannel(channelId, name, push = true) {
  activeChannelId = channelId;
  activeDmFriendId = null;
  activeDmChannelId = null;
  $('chat-title').textContent = `# ${name}`;
  $('chat-messages').innerHTML = '';
  setMainView('chat');
  renderChannels();
  socket.emit('open-text-channel', { channelId }, (res) => {
    if (res.error) { toast(res.error); return; }
    renderMessages($('chat-messages'), res.messages);
  });
  if (push && activeServer) navTo(`/channels/${activeServer.id}/${channelId}`);
  closeDrawers();
}

function renderMessages(container, messages) {
  container.innerHTML = '';
  for (const msg of messages) {
    appendMessage(container, msg);
  }
  container.scrollTop = container.scrollHeight;
}

function appendMessage(container, msg) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `
    <span class="msg-avatar">${escapeHtml(initials(msg.username || currentUser?.username))}</span>
    <div class="msg-body">
      <span class="msg-author">${escapeHtml(msg.username || '—')}</span>
      <span class="msg-time">${formatTime(msg.ts)}</span>
      <div class="msg-text">${escapeHtml(msg.text)}</div>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !activeChannelId) return;
  input.value = '';
  socket.emit('send-message', { channelId: activeChannelId, text });
});

/* ================= DM ================= */
function openDM(friendId, push = true) {
  const friend = friends.find((f) => f.id === friendId);
  if (!friend) return;
  activeServer = null;
  activeDmFriendId = friendId;
  activeChannelId = null;
  showSidebarHome();
  setRailActive('home');
  $('dm-title').textContent = `@ ${friend.username}`;
  $('dm-messages').innerHTML = '';
  setMainView('dm');
  renderFriends();
  socket.emit('open-dm', { friendId }, (res) => {
    if (res.error) { toast(res.error); return; }
    activeDmChannelId = res.dmChannelId;
    renderDMMessages(res.messages, friendId);
    if (push) navTo(`/channels/@me/${res.dmChannelId}`);
  });
  closeDrawers();
}

// Deep-link/geri-ileri: DM'yi kanal id'sinden aç.
function openDMByChannel(dmChannelId, push = false) {
  socket.emit('get-dm-by-channel', { dmChannelId }, (res) => {
    if (res.error) { toast(res.error); goHome(false); navTo('/channels/@me'); return; }
    activeServer = null;
    activeChannelId = null;
    activeDmFriendId = res.friendId;
    activeDmChannelId = res.dmChannelId;
    showSidebarHome();
    setRailActive('home');
    renderFriends();
    $('dm-title').textContent = `@ ${res.friend.username}`;
    $('dm-messages').innerHTML = '';
    setMainView('dm');
    renderDMMessages(res.messages, res.friendId);
    if (push) navTo(`/channels/@me/${res.dmChannelId}`);
    closeDrawers();
  });
}

function renderDMMessages(messages, friendId) {
  const container = $('dm-messages');
  container.innerHTML = '';
  for (const msg of messages) {
    const isMe = msg.fromId === currentUser.id;
    const div = document.createElement('div');
    div.className = 'msg';
    const author = isMe ? currentUser.username : friends.find((f) => f.id === friendId)?.username;
    div.innerHTML = `
      <span class="msg-avatar">${escapeHtml(initials(author))}</span>
      <div class="msg-body">
        <span class="msg-author">${escapeHtml(author)}</span>
        <span class="msg-time">${formatTime(msg.ts)}</span>
        <div class="msg-text">${escapeHtml(msg.text)}</div>
      </div>`;
    container.appendChild(div);
  }
  container.scrollTop = container.scrollHeight;
}

$('dm-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('dm-input');
  const text = input.value.trim();
  if (!text || !activeDmFriendId) return;
  input.value = '';
  socket.emit('send-dm', { friendId: activeDmFriendId, text }, (res) => {
    if (res.error) { toast(res.error); return; }
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `
      <span class="msg-avatar">${escapeHtml(initials(currentUser.username))}</span>
      <div class="msg-body">
        <span class="msg-author">${escapeHtml(currentUser.username)}</span>
        <span class="msg-time">${formatTime(res.message.ts)}</span>
        <div class="msg-text">${escapeHtml(res.message.text)}</div>
      </div>`;
    $('dm-messages').appendChild(div);
    $('dm-messages').scrollTop = $('dm-messages').scrollHeight;
  });
});

/* ================= Voice ================= */
// Duruma göre gösterilecek kutuları (tile) hazırla.
function buildVoiceTiles(state) {
  const tiles = [];
  const meMuted = !!state?.local?.muted;
  // Kendi kişi kutumuz (kamera açıksa video, değilse avatar)
  tiles.push({
    key: 'self',
    label: `${currentUser?.username || 'Sen'} (sen)`,
    initials: initials(currentUser?.username),
    stream: state?.local?.cameraStream || null,
    isScreen: false,
    muted: meMuted,
    self: true,
  });
  // Kendi ekran paylaşımımız (ayrı kutu)
  if (state?.local?.screenStream) {
    tiles.push({
      key: 'self-screen',
      label: `${currentUser?.username || 'Sen'} — ekran`,
      initials: initials(currentUser?.username),
      stream: state.local.screenStream,
      isScreen: true,
      muted: false,
      self: true,
    });
  }
  // Uzak katılımcılar
  for (const p of state?.remote || []) {
    tiles.push({
      key: p.socketId,
      label: p.username,
      initials: initials(p.username),
      stream: p.cameraStream || null,
      isScreen: false,
      muted: !!p.muted,
      self: false,
    });
    if (p.screen && p.screenStream) {
      tiles.push({
        key: `${p.socketId}-screen`,
        label: `${p.username} — ekran`,
        initials: initials(p.username),
        stream: p.screenStream,
        isScreen: true,
        muted: false,
        self: false,
      });
    }
  }
  return tiles;
}

function makeVoiceTile(t) {
  const tile = document.createElement('div');
  tile.className = 'voice-tile' + (t.isScreen ? ' voice-tile--screen' : '');
  tile.dataset.key = t.key;

  if (t.stream && t.stream.getVideoTracks().length) {
    const v = document.createElement('video');
    v.srcObject = t.stream;
    v.autoplay = true; v.playsInline = true; v.muted = true; // ses ayrı <audio> öğesinden
    if (t.isScreen) v.classList.add('contain');
    tile.appendChild(v);
    const play = v.play();
    if (play && play.catch) play.catch(() => {});
  } else {
    const av = document.createElement('span');
    av.className = 'voice-tile-avatar';
    av.textContent = t.initials;
    tile.appendChild(av);
  }

  // Kontroller: büyüt/küçült + (video ise) tam ekran
  const controls = document.createElement('div');
  controls.className = 'voice-tile-controls';
  const maxBtn = document.createElement('button');
  maxBtn.className = 'tile-btn';
  maxBtn.title = maximizedTile === t.key ? 'Küçült' : 'Büyüt';
  maxBtn.innerHTML = maximizedTile === t.key
    ? '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M14 10h5v2h-7V5h2v5Zm-4 4H5v-2h7v7h-2v-5Z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M5 5h6V3H3v8h2V5Zm14 0v6h2V3h-8v2h6ZM5 19v-6H3v8h8v-2H5Zm14 0h-6v2h8v-8h-2v6Z"/></svg>';
  maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMaximize(t.key); });
  controls.appendChild(maxBtn);

  if (t.stream && t.stream.getVideoTracks().length) {
    const fsBtn = document.createElement('button');
    fsBtn.className = 'tile-btn';
    fsBtn.title = 'Tam ekran';
    fsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 7h4V5H5v6h2V7Zm10 0v4h2V5h-6v2h4ZM7 17v-4H5v6h6v-2H7Zm12-4v4h-4v2h6v-6h-2Z"/></svg>';
    fsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = tile.querySelector('video');
      if (vid?.requestFullscreen) vid.requestFullscreen().catch(() => {});
    });
    controls.appendChild(fsBtn);
  }
  tile.appendChild(controls);

  // Kutuya çift tıkla/tek tıkla büyüt
  tile.addEventListener('click', () => toggleMaximize(t.key));

  const name = document.createElement('div');
  name.className = 'voice-tile-name';
  name.innerHTML = `${escapeHtml(t.label)}${t.muted ? ' 🔇' : ''}${t.isScreen ? ' <span class="voice-tile-badge">EKRAN</span>' : ''}`;
  tile.appendChild(name);
  return tile;
}

function toggleMaximize(key) {
  maximizedTile = maximizedTile === key ? null : key;
  if (lastVoiceState) renderVoiceGrid(lastVoiceState);
}

let lastVoiceState = null;
let voiceResizeBound = false;
let pendingVoiceRender = false;
function renderVoiceGrid(state) {
  lastVoiceState = state;
  if (!voiceResizeBound) {
    voiceResizeBound = true;
    let rt = null;
    window.addEventListener('resize', () => {
      if (document.fullscreenElement) return; // tam ekranda yeniden çizme
      clearTimeout(rt);
      rt = setTimeout(() => { if (lastVoiceState && activeView === 'voice') renderVoiceGrid(lastVoiceState); }, 120);
    });
    // Tam ekrandan çıkınca (gerekiyorsa) ızgarayı tazele.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && pendingVoiceRender && lastVoiceState && activeView === 'voice') {
        pendingVoiceRender = false;
        renderVoiceGrid(lastVoiceState);
      }
    });
  }
  // Tam ekran açıkken DOM'u yeniden kurma (video kaldırılırsa tam ekran kapanır).
  if (document.fullscreenElement) { pendingVoiceRender = true; return; }
  const grid = $('voice-grid');
  grid.innerHTML = '';
  const tiles = buildVoiceTiles(state);

  // Büyütülen kutu artık yoksa sıfırla.
  if (maximizedTile && !tiles.some((t) => t.key === maximizedTile)) maximizedTile = null;

  if (maximizedTile) {
    grid.classList.add('maximized');
    grid.style.gridTemplateColumns = '1fr';
    grid.style.gridTemplateRows = '';
    const t = tiles.find((x) => x.key === maximizedTile);
    if (t) grid.appendChild(makeVoiceTile(t));
    return;
  }

  grid.classList.remove('maximized');
  // Kişi/kutu sayısına göre otomatik sütun düzeni; kutular 16/9 oranını korur.
  const n = tiles.length;
  const cols = Math.ceil(Math.sqrt(n));
  grid.style.gridTemplateRows = '';
  // Kutu boyutunu, hem genişliğe hem yüksekliğe sığacak şekilde sınırla.
  const gap = 0.6 * 16; // rem -> px
  const pad = 0.8 * 16 * 2;
  const availW = grid.clientWidth - pad;
  const availH = grid.clientHeight - pad;
  const rows = Math.ceil(n / cols);
  const wByCols = (availW - gap * (cols - 1)) / cols;
  const hByRows = (availH - gap * (rows - 1)) / rows;
  const wByRows = hByRows * (16 / 9); // yüksekliğe göre izin verilen genişlik
  const tileW = Math.max(120, Math.floor(Math.min(wByCols, wByRows)));
  grid.style.gridTemplateColumns = `repeat(${cols}, ${tileW}px)`;
  for (const t of tiles) grid.appendChild(makeVoiceTile(t));
}

function joinVoiceChannel(channelId, name, push = true) {
  if (voiceManager) voiceManager.leave();
  activeChannelId = null;
  activeDmFriendId = null;
  activeDmChannelId = null;
  maximizedTile = null;
  voiceManager = createVoiceManager({
    socket, username: currentUser.username,
    onUpdate: (state) => {
      renderVoiceGrid(state);
      $('voice-count').textContent = `${(state.remote?.length || 0) + 1} katılımcı`;
      $('vc-mic').classList.toggle('off', voiceManager.isMuted());
      $('vc-cam').classList.toggle('on', voiceManager.isCameraOn());
      $('vc-screen').classList.toggle('on', voiceManager.isScreenOn());
    },
  });

  $('voice-title').textContent = `🔊 ${name}`;
  setMainView('voice');
  renderChannels();

  socket.emit('join-voice', { channelId }, async (res) => {
    if (res.error) { toast(res.error); setMainView('empty'); return; }
    await voiceManager.join(channelId, res.participants);
  });
  if (push && activeServer) navTo(`/channels/${activeServer.id}/${channelId}`);
  closeDrawers();
}

$('vc-mic').addEventListener('click', () => voiceManager?.toggleMic());
$('vc-cam').addEventListener('click', () => voiceManager?.toggleCamera());
$('vc-screen').addEventListener('click', () => voiceManager?.toggleScreen());
$('vc-leave').addEventListener('click', () => {
  voiceManager?.leave();
  voiceManager = null;
  maximizedTile = null;
  lastVoiceState = null;
  setMainView('empty');
  $('empty-hint').textContent = 'Bir kanal seç.';
  renderChannels();
  if (activeServer) navTo(`/channels/${activeServer.id}`);
});

/* ================= Server modals ================= */
$('btn-server-menu').addEventListener('click', () => {
  showModal('Sunucu', `<div class="modal-menu">
    <button class="btn btn-primary" id="modal-create-server">Sunucu Oluştur</button>
    <button class="btn btn-secondary" id="modal-join-server">Sunucuya Katıl</button>
  </div>`, [{ label: 'İptal', onClick: closeModal }]);
  $('modal-create-server').addEventListener('click', () => {
    closeModal();
    showModal('Sunucu Oluştur', `<input class="modal-input" id="server-name-input" placeholder="Sunucu adı" maxlength="32" />`, [
      { label: 'İptal', onClick: closeModal },
      { label: 'Oluştur', className: 'btn-primary', onClick: () => {
        const name = $('server-name-input').value.trim();
        if (!name) return;
        socket.emit('create-server', { name }, (res) => {
          if (res.error) { toast(res.error); return; }
          servers.push(res.server);
          renderRail();
          closeModal();
          selectServer(res.server.id);
          toast('Sunucu oluşturuldu');
        });
      }},
    ]);
    $('server-name-input').focus();
  });
  $('modal-join-server').addEventListener('click', () => {
    closeModal();
    showModal('Sunucuya Katıl', `<input class="modal-input" id="join-code-input" placeholder="Davet kodu" maxlength="8" style="text-transform:uppercase;letter-spacing:.1em" />`, [
      { label: 'İptal', onClick: closeModal },
      { label: 'Katıl', className: 'btn-primary', onClick: () => {
        const code = $('join-code-input').value.trim().toUpperCase();
        if (!code) return;
        socket.emit('join-server', { code }, (res) => {
          if (res.error) { toast(res.error); return; }
          if (!servers.find((s) => s.id === res.server.id)) servers.push(res.server);
          renderRail();
          closeModal();
          selectServer(res.server.id);
          toast('Sunucuya katıldın');
        });
      }},
    ]);
    $('join-code-input').focus();
  });
});

$('btn-server-settings').addEventListener('click', () => {
  if (!activeServer || activeServer.ownerId !== currentUser.id) return;
  const isOwner = true;
  showModal(`${activeServer.name} — Ayarlar`, `
    <p style="color:var(--muted);font-size:.85rem">Davet kodu: <strong>${activeServer.inviteCode}</strong></p>
    <input class="modal-input" id="srv-rename-input" placeholder="Sunucu adı" value="${escapeHtml(activeServer.name)}" maxlength="32" />
    <div class="modal-menu" style="margin-top:.5rem">
      <button class="btn btn-secondary" id="modal-add-text-ch">+ Metin Kanalı</button>
      <button class="btn btn-secondary" id="modal-add-voice-ch">+ Ses Kanalı</button>
      <button class="btn btn-danger" id="modal-delete-server">Sunucuyu Sil</button>
    </div>`, [{ label: 'Kapat', onClick: closeModal }]);

  $('modal-add-text-ch').addEventListener('click', () => {
    const name = prompt('Metin kanalı adı:');
    if (!name) return;
    socket.emit('create-channel', { serverId: activeServer.id, name, type: 'text' }, (res) => {
      if (res.error) { toast(res.error); return; }
      activeServer = { ...activeServer, channels: res.server.channels };
      const idx = servers.findIndex((s) => s.id === activeServer.id);
      if (idx >= 0) servers[idx] = res.server;
      renderChannels();
      toast('Kanal eklendi');
    });
  });
  $('modal-add-voice-ch').addEventListener('click', () => {
    const name = prompt('Ses kanalı adı:');
    if (!name) return;
    socket.emit('create-channel', { serverId: activeServer.id, name, type: 'voice' }, (res) => {
      if (res.error) { toast(res.error); return; }
      activeServer = { ...activeServer, channels: res.server.channels };
      const idx = servers.findIndex((s) => s.id === activeServer.id);
      if (idx >= 0) servers[idx] = res.server;
      renderChannels();
      toast('Kanal eklendi');
    });
  });
  $('modal-delete-server').addEventListener('click', () => {
    if (!confirm('Sunucuyu silmek istediğine emin misin?')) return;
    socket.emit('delete-server', { serverId: activeServer.id }, (res) => {
      if (res.error) { toast(res.error); return; }
      servers = servers.filter((s) => s.id !== activeServer.id);
      activeServer = null;
      renderRail();
      closeModal();
      goHome();
      toast('Sunucu silindi');
    });
  });

  $('srv-rename-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const name = $('srv-rename-input').value.trim();
      socket.emit('update-server', { serverId: activeServer.id, name }, (res) => {
        if (res.error) { toast(res.error); return; }
        activeServer.name = res.server.name;
        $('sidebar-title').textContent = res.server.name;
        const idx = servers.findIndex((s) => s.id === activeServer.id);
        if (idx >= 0) servers[idx] = res.server;
        renderRail();
        toast('Sunucu adı güncellendi');
      });
    }
  });
});

/* ================= Friends ================= */
$('btn-add-friend').addEventListener('click', () => {
  showModal('Arkadaş Ekle', `<input class="modal-input" id="friend-input" placeholder="Kullanıcı adı" />`, [
    { label: 'İptal', onClick: closeModal },
    { label: 'Ekle', className: 'btn-primary', onClick: () => {
      const username = $('friend-input').value.trim();
      if (!username) return;
      socket.emit('add-friend', { username }, (res) => {
        if (res.error) { toast(res.error); return; }
        const idx = friends.findIndex((f) => f.id === res.friend.id);
        if (idx >= 0) friends[idx] = res.friend; else friends.push(res.friend);
        renderFriends();
        closeModal();
        toast(`${res.friend.username} eklendi`);
      });
    }},
  ]);
  $('friend-input').focus();
});

/* ================= Auth ================= */
const authTabs = document.querySelectorAll('.tab');
let authMode = 'login';
authTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    authTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    authMode = tab.dataset.tab;
    $('auth-tabs').dataset.active = authMode;
    $('auth-submit').textContent = authMode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
    $('auth-error').classList.add('hidden');
  });
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').classList.add('hidden');
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  $('auth-submit').disabled = true;
  try {
    const res = await fetch(`/api/${authMode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { $('auth-error').textContent = data.error; $('auth-error').classList.remove('hidden'); return; }
    setCookie('muck_token', data.token);
    currentUser = data.user;
    connectSocket(data.token);
  } catch { $('auth-error').textContent = 'Sunucuya ulaşılamadı.'; $('auth-error').classList.remove('hidden'); }
  finally { $('auth-submit').disabled = false; }
});

$('btn-logout').addEventListener('click', doLogout);
function doLogout() {
  voiceManager?.leave();
  closeSettings();
  fetch('/api/logout', { method: 'POST' }).catch(() => {});
  deleteCookie('muck_token');
  socket?.disconnect();
  currentUser = null;
  showAuth();
}

/* ================= Socket ================= */
function connectSocket(token) {
  if (socket) socket.disconnect();
  socket = io({
    auth: { token },
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') { deleteCookie('muck_token'); showAuth(); }
  });

  socket.on('init', ({ user, friends: fr, servers: srv }) => {
    currentUser = user;
    friends = fr;
    servers = srv;
    $('user-name').textContent = user.username;
    $('user-avatar').textContent = initials(user.username);
    $('settings-username').textContent = user.username;
    renderRail();
    renderFriends();
    showApp();
    applyRoute();
  });

  socket.on('friend-update', (f) => {
    const idx = friends.findIndex((x) => x.id === f.id);
    if (idx >= 0) friends[idx] = f; else friends.push(f);
    if (f.online) onlineMembers.add(f.id); else onlineMembers.delete(f.id);
    renderFriends();
    // Aktif üye paneli veya DM profili çevrimiçi durumunu yansıtsın.
    if (activeServer) renderMembers();
    if (activeView === 'dm' && activeDmFriendId === f.id) renderProfile();
  });

  socket.on('message', ({ channelId, message }) => {
    if (channelId === activeChannelId && activeView === 'chat') {
      appendMessage($('chat-messages'), message);
    }
  });

  socket.on('dm', ({ friendId, username, message }) => {
    if (activeDmFriendId === friendId && activeView === 'dm') {
      const div = document.createElement('div');
      div.className = 'msg';
      div.innerHTML = `
        <span class="msg-avatar">${escapeHtml(initials(username))}</span>
        <div class="msg-body">
          <span class="msg-author">${escapeHtml(username)}</span>
          <span class="msg-time">${formatTime(message.ts)}</span>
          <div class="msg-text">${escapeHtml(message.text)}</div>
        </div>`;
      $('dm-messages').appendChild(div);
      $('dm-messages').scrollTop = $('dm-messages').scrollHeight;
    } else {
      toast(`${username}: yeni mesaj`);
    }
  });

  socket.on('server-updated', ({ server }) => {
    const idx = servers.findIndex((s) => s.id === server.id);
    if (idx >= 0) servers[idx] = server;
    if (activeServer?.id === server.id) {
      activeServer = { ...activeServer, ...server, members: server.members || activeServer.members };
      renderChannels();
      updatePanel();
      $('sidebar-title').textContent = server.name;
    }
    renderRail();
  });

  socket.on('server-deleted', ({ serverId }) => {
    servers = servers.filter((s) => s.id !== serverId);
    if (activeServer?.id === serverId) { activeServer = null; goHome(); }
    renderRail();
  });

  // Voice signaling (socketId tabanlı, perfect negotiation)
  socket.on('voice-offer', ({ fromId, userId: uid, username: un, offer }) => {
    voiceManager?.onDescription(fromId, uid, un, offer);
  });
  socket.on('voice-answer', ({ fromId, answer }) => {
    voiceManager?.onDescription(fromId, null, null, answer);
  });
  socket.on('voice-ice', ({ fromId, candidate }) => {
    voiceManager?.onIce(fromId, candidate);
  });
  socket.on('voice-peer-joined', ({ userId: uid, username: un, socketId }) => {
    voiceManager?.onPeerJoined(socketId, uid, un);
  });
  socket.on('voice-peer-left', ({ socketId }) => {
    voiceManager?.onPeerLeft(socketId);
  });
  socket.on('voice-presence', ({ channelId, participants }) => {
    voicePresence[channelId] = participants;
    if (activeServer) renderChannels();
    voiceManager?.onPresence(participants);
  });
}

/* ================= Nav buttons ================= */
$('btn-home').addEventListener('click', () => goHome());
$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', closeSettings);
$('settings-overlay').addEventListener('click', (e) => { if (e.target === $('settings-overlay')) closeSettings(); });
window.addEventListener('popstate', applyRoute);

/* ================= Settings UI ================= */
$('theme-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-value]');
  if (btn) saveSetting('theme', 'muck_theme', btn.dataset.themeValue);
});
$('accent-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-accent-value]');
  if (btn) saveSetting('accent', 'muck_accent', btn.dataset.accentValue);
});
$('toggle-animations').addEventListener('change', (e) => saveSetting('animations', 'muck_animations', e.target.checked));

/* ================= Mobile drawers + swipe ================= */
function openLeftDrawer() { const a = $('app'); a.classList.add('nav-left'); a.classList.remove('nav-right'); }
function openRightDrawer() { const a = $('app'); if (!a.classList.contains('with-panel')) return; a.classList.add('nav-right'); a.classList.remove('nav-left'); }
function closeDrawers() { const a = $('app'); a.classList.remove('nav-left', 'nav-right'); }

$('scrim').addEventListener('click', closeDrawers);

// Dokunmatik yatay kaydırma ile sol/sağ panel geçişi.
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
let touchStartX = 0, touchStartY = 0, touching = false;
document.addEventListener('touchstart', (e) => {
  if (!isMobile() || e.touches.length !== 1) { touching = false; return; }
  // Modal/ayarlar açıkken jesti yoksay.
  if (!$('modal-overlay').classList.contains('hidden') || !$('settings-overlay').classList.contains('hidden')) { touching = false; return; }
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touching = true;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (!touching) return;
  touching = false;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.4) return; // yatay değilse yoksay
  const app = $('app');
  const leftOpen = app.classList.contains('nav-left');
  const rightOpen = app.classList.contains('nav-right');
  if (dx > 0) {
    // sağa kaydır: sağ paneli kapat → yoksa sol paneli aç
    if (rightOpen) closeDrawers();
    else if (!leftOpen) openLeftDrawer();
  } else {
    // sola kaydır: sol paneli kapat → yoksa sağ paneli aç
    if (leftOpen) closeDrawers();
    else if (!rightOpen) openRightDrawer();
  }
}, { passive: true });

/* ================= PWA ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* ================= Boot ================= */
(async function boot() {
  loadSettings();
  applySettings();
  const token = getCookie('muck_token') || getCookie('streamuck_token');
  if (!token) { $('splash').classList.add('hidden'); showAuth(); return; }
  try {
    const res = await fetch('/api/me');
    if (res.ok) { const { user } = await res.json(); currentUser = user; connectSocket(token); }
    else { deleteCookie('muck_token'); showAuth(); }
  } catch { showAuth(); }
  finally { $('splash').classList.add('hidden'); }
})();
