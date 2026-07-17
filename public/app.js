const $ = (id) => document.getElementById(id);
const THEME_COLORS = { dark: '#0f1117', black: '#000000', light: '#f3f5f9' };

const SPLASH_TIPS = [
  'Sunucularına bağlanıyor…',
  'Arkadaş listesi hazırlanıyor…',
  'Kanallar yükleniyor…',
  'Neredeyse hazır…',
  'Did you know? Muck’ta mesajlar anında akar.',
  'Sesli sohbet için bir kanala katılman yeterli.',
];
let splashTipTimer = null;

function setSplashStatus(text) {
  const el = $('splash-status');
  if (el) el.textContent = text;
}
function startSplashTips() {
  let i = 0;
  setSplashStatus(SPLASH_TIPS[0]);
  clearInterval(splashTipTimer);
  splashTipTimer = setInterval(() => {
    i = (i + 1) % SPLASH_TIPS.length;
    setSplashStatus(SPLASH_TIPS[i]);
  }, 2200);
}
function hideSplash() {
  clearInterval(splashTipTimer);
  splashTipTimer = null;
  const splash = $('splash');
  if (!splash) return;
  splash.classList.add('splash-hide');
  splash.setAttribute('aria-busy', 'false');
  setTimeout(() => splash.classList.add('hidden'), 320);
}

let createVoiceManager = null;
let initDmFeatures = null;
let modulesReady = null;

async function ensureAppModules() {
  if (modulesReady) return modulesReady;
  modulesReady = (async () => {
    const [voiceMod, dmMod] = await Promise.all([
      import('./voice.js'),
      import('./dm-features.js'),
    ]);
    createVoiceManager = voiceMod.createVoiceManager;
    initDmFeatures = dmMod.initDmFeatures;
  })();
  return modulesReady;
}

// State
let socket = null;
let currentUser = null;
let friends = [];
let friendRequests = { incoming: [], outgoing: [] };
let friendsTab = 'online'; // online | all | pending | add
let social = { pinnedDms: [], closedDms: [], mutedDms: {}, ignored: [], blocked: [], unreadDms: {}, friendSince: {}, notes: {}, pinnedGroups: [], closedGroups: [], mutedGroups: {}, unreadGroups: {} };
let profileTarget = null;
let profileMutualTab = 'friends';
let servers = [];
let groupDms = [];
let activeServer = null; // full server object from get-server
let activeView = 'friends'; // friends | empty | chat | dm | voice | settings
let activeChannelId = null;
let activeDmFriendId = null;
let activeDmChannelId = null;
let activeGroupId = null;
let activeGroupTitle = '';
let dmPins = [];
let dmProfileOpen = true;
let dmPanelMode = null; // null | search | pins
let dmCallActive = false;
let dmCallRinging = false; // giden arama (karşı taraf bekleniyor)
let dmIncoming = null; // { channelId, fromId, fromUsername }
let dmReply = null;
let dmFeatures = null;
let voiceManager = null;
let voicePresence = {}; // channelId -> participants
let maximizedTile = null; // büyütülen kutunun anahtarı
const onlineMembers = new Set(); // bilinen çevrimiçi üye id'leri (opsiyonel)

const MSG_PAGE = 20;
let chatHasMore = false;
let dmHasMore = false;
let loadingOlderMsgs = false;
let chatHistoryExpanded = false;
let dmHistoryExpanded = false;

/* ================= Message cache (localStorage, son 20) ================= */
function msgCacheKey(kind, id) {
  return `muck_msgs_v1_${currentUser?.id || 'anon'}_${kind}_${id}`;
}
function readMsgCache(kind, id) {
  if (!id) return null;
  try {
    const raw = localStorage.getItem(msgCacheKey(kind, id));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.messages)) return null;
    return data;
  } catch { return null; }
}
function writeMsgCache(kind, id, messages, hasMore) {
  if (!id || !currentUser?.id) return;
  const slice = (messages || []).filter((m) => m && m.id && !String(m.id).startsWith('local_')).slice(-MSG_PAGE);
  try {
    localStorage.setItem(msgCacheKey(kind, id), JSON.stringify({
      messages: slice,
      hasMore: hasMore !== false,
      savedAt: Date.now(),
    }));
  } catch {}
}
function appendMsgCache(kind, id, msg) {
  if (!msg?.id || String(msg.id).startsWith('local_')) return;
  const cur = readMsgCache(kind, id) || { messages: [], hasMore: true };
  if (cur.messages.some((m) => m.id === msg.id)) return;
  cur.messages.push(msg);
  writeMsgCache(kind, id, cur.messages, cur.hasMore);
}

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
  // PWA share_target / file_handlers giriş noktaları
  if (pathname === '/share' || pathname === '/open-file') {
    const q = new URLSearchParams(location.search);
    const shared = q.get('text') || q.get('url') || q.get('title');
    history.replaceState({}, '', '/channels/@me');
    goHome(false);
    if (shared) {
      try { sessionStorage.setItem('muck_share_draft', shared); } catch {}
      setTimeout(() => toast('Paylaşılan içerik alındı — bir sohbete yapıştırabilirsin'), 400);
    }
    return;
  }
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

const settings = { theme: 'dark', accent: 'blue', animations: true, developer: false };

/* ================= Utils ================= */
function initials(name) { return (name || '?').slice(0, 2).toUpperCase(); }
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Avatar + durum noktası (+ isteğe bağlı alt yazı) — sol alt profil stili */
function userChipHtml(username, online, { subtitle, size = 'sm', showSub = true } = {}) {
  const status = online ? 'Çevrimiçi' : 'Çevrimdışı';
  const sub = subtitle !== undefined ? subtitle : status;
  return `
    <span class="user-chip-avatar user-chip-avatar--${size}">${escapeHtml(initials(username))}
      <span class="user-chip-dot ${online ? 'on' : ''}"></span>
    </span>
    <span class="user-chip-meta">
      <span class="user-chip-name">${escapeHtml(username)}</span>
      ${showSub && sub ? `<span class="user-chip-sub">${escapeHtml(sub)}</span>` : ''}
    </span>`;
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
    settings.developer = (localStorage.getItem('muck_developer') || 'off') === 'on';
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
  const td = $('toggle-developer'); if (td) td.checked = settings.developer;
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
function showApp() {
  $('auth-view')?.classList.add('hidden');
  $('app')?.classList.remove('hidden');
  hideSplash();
}
function showAuth() { location.href = '/login'; }
function accessToken() {
  return getCookie('muck_access') || getCookie('muck_token') || getCookie('streamuck_token');
}

function setMainView(view) {
  activeView = view;
  ['view-friends', 'view-empty', 'view-chat', 'view-dm', 'view-voice'].forEach((id) => $(id).classList.add('hidden'));
  if (view === 'empty') $('view-empty').classList.remove('hidden');
  else $(`view-${view}`)?.classList.remove('hidden');

  ['friends', 'chat', 'dm', 'voice', 'empty'].forEach((v) => {
    $(`head-${v}`)?.classList.toggle('hidden', v !== view);
  });

  $('btn-friends-nav')?.classList.toggle('active', view === 'friends' && !activeDmFriendId && !activeGroupId);
  updatePanel();
}

/* ================= Right panel (üyeler / profil / şimdi aktif) ================= */
function updatePanel() {
  const app = $('app');
  const members = $('panel-members');
  const profile = $('panel-profile');
  const active = $('panel-active');
  const searchPanel = $('panel-dm-search');
  const pinsPanel = $('panel-dm-pins');
  members?.classList.add('hidden');
  profile?.classList.add('hidden');
  active?.classList.add('hidden');
  searchPanel?.classList.add('hidden');
  pinsPanel?.classList.add('hidden');

  if (activeView === 'friends') {
    renderActiveNow();
    active?.classList.remove('hidden');
    app.classList.add('with-panel');
  } else if (activeServer && (activeView === 'chat' || activeView === 'voice' || activeView === 'empty')) {
    renderMembers();
    members?.classList.remove('hidden');
    app.classList.add('with-panel');
  } else if (activeView === 'dm' && (activeDmFriendId || activeGroupId)) {
    if (dmPanelMode === 'search') {
      searchPanel?.classList.remove('hidden');
      app.classList.add('with-panel');
    } else if (dmPanelMode === 'pins') {
      pinsPanel?.classList.remove('hidden');
      app.classList.add('with-panel');
    } else if (dmProfileOpen) {
      if (activeGroupId) {
        renderGroupPanel();
        members?.classList.remove('hidden');
      } else {
        renderProfile();
        profile?.classList.remove('hidden');
      }
      app.classList.add('with-panel');
    } else {
      app.classList.remove('with-panel');
    }
  } else {
    app.classList.remove('with-panel');
  }
}

let friendsVoice = {}; // userId -> activity

function renderActiveNow() {
  const list = $('active-now-list');
  const empty = $('active-now-empty');
  if (!list) return;
  list.innerHTML = '';

  // Aynı kanalda birden fazla arkadaş varsa kartları kanal bazında birleştir
  const byChannel = new Map();
  for (const act of Object.values(friendsVoice || {})) {
    if (!act?.channelId) continue;
    if (!byChannel.has(act.channelId)) byChannel.set(act.channelId, act);
  }

  for (const act of byChannel.values()) {
    const friendIds = new Set(
      (act.participants || [])
        .map((p) => p.userId)
        .filter((id) => id !== currentUser?.id && friends.some((f) => f.id === id))
    );
    // Tek arkadaş yoksa ama snapshot’ta kayıt varsa yine göster
    const names = [...friendIds]
      .map((id) => friends.find((f) => f.id === id)?.username || friendsVoice[id]?.username)
      .filter(Boolean);
    if (!names.length && act.username) names.push(act.username);
    if (!names.length) continue;

    const title = names.length <= 2
      ? names.join(' ve ')
      : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;

    const peers = (act.participants || [])
      .filter((p) => p.userId !== currentUser?.id)
      .slice(0, 4);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'active-card';
    btn.innerHTML = `
      <span class="user-chip-avatar user-chip-avatar--md">${escapeHtml(initials(names[0]))}
        <span class="user-chip-dot on"></span>
      </span>
      <span class="active-card-body">
        <div class="active-card-title">${escapeHtml(title)}</div>
        <div class="active-card-sub">${escapeHtml(act.serverName)} · ${escapeHtml(act.channelName)}</div>
      </span>
      <span class="active-card-peers">
        ${peers.map((p) => `<span class="active-card-peer" title="${escapeHtml(p.username)}">${escapeHtml(initials(p.username))}</span>`).join('')}
      </span>`;
    btn.addEventListener('click', () => {
      selectServer(act.serverId, act.channelId, true);
    });
    list.appendChild(btn);
  }

  empty?.classList.toggle('hidden', list.children.length > 0);
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
    li.innerHTML = userChipHtml(m.username, online, { size: 'md' });
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
  document.querySelectorAll('.rail-server').forEach((el) => el.classList.remove('active'));
}

/* ================= Sidebar ================= */
function showSidebarHome() {
  $('sidebar-home').classList.remove('hidden');
  $('sidebar-server').classList.add('hidden');
  $('sidebar-title').textContent = 'Ana Sayfa';
  $('btn-add-friend-head')?.classList.add('hidden');
  $('btn-server-settings').classList.add('hidden');
  setRailActive('home');
}

function showSidebarServer() {
  $('sidebar-home').classList.add('hidden');
  $('sidebar-server').classList.remove('hidden');
  $('sidebar-title').textContent = activeServer?.name || 'Sunucu';
  $('btn-add-friend-head')?.classList.add('hidden');
  $('btn-server-settings').classList.toggle('hidden', activeServer?.ownerId !== currentUser?.id);
  document.querySelectorAll('.rail-server').forEach((el) => {
    el.classList.toggle('active', el.title === activeServer?.name);
  });
}

function pendingCount() {
  return friendRequests?.incoming?.length || 0;
}

function updateFriendsBadge() {
  const n = pendingCount();
  for (const id of ['friends-badge', 'pending-tab-badge']) {
    const el = $(id);
    if (!el) continue;
    el.textContent = String(n);
    el.classList.toggle('hidden', n <= 0);
  }
}

function renderGroupPanel() {
  const list = $('member-list');
  if (!list) return;
  list.innerHTML = '';
  const g = groupDms.find((x) => x.id === activeGroupId);
  const members = g?.members || [];
  $('member-count').textContent = members.length || g?.memberCount || 0;
  for (const m of members) {
    const online = isMemberOnline(m.id);
    const li = document.createElement('li');
    li.className = `member-row${online ? '' : ' offline'}`;
    li.innerHTML = userChipHtml(m.username, online, { size: 'md' });
    list.appendChild(li);
  }
}

function renderFriends() {
  // Sidebar: Direkt Mesajlar = arkadaşlar + gruplar
  const list = $('dm-list');
  if (!list) return;
  list.innerHTML = '';

  const friendRows = [...friends].filter((f) => !f.closed);
  const groupRows = [...groupDms].filter((g) => !g.closed);

  const items = [
    ...friendRows.map((f) => ({
      kind: 'dm',
      id: f.id,
      sortPinned: f.pinned ? 1 : 0,
      lastMessageAt: f.lastMessageAt || 0,
      f,
    })),
    ...groupRows.map((g) => ({
      kind: 'group',
      id: g.id,
      sortPinned: g.pinned ? 1 : 0,
      lastMessageAt: g.lastMessageAt || 0,
      g,
    })),
  ];
  items.sort((a, b) => b.sortPinned - a.sortPinned || b.lastMessageAt - a.lastMessageAt);

  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.dataset.allowMenu = '1';
    if (item.kind === 'dm') {
      const f = item.f;
      const unread = !!f.unread;
      btn.className = 'sidebar-item sidebar-item--user'
        + (activeDmFriendId === f.id && !activeGroupId ? ' active' : '')
        + (unread ? ' unread' : '')
        + (f.pinned ? ' pinned' : '');
      btn.dataset.friendId = f.id;
      btn.innerHTML = userChipHtml(f.username, !!f.online, { size: 'sm' });
      btn.addEventListener('click', () => openDM(f.id));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDmContextMenu(e.clientX, e.clientY, f);
      });
    } else {
      const g = item.g;
      btn.className = 'sidebar-item sidebar-item--user sidebar-item--group'
        + (activeGroupId === g.id ? ' active' : '')
        + (g.unread ? ' unread' : '')
        + (g.pinned ? ' pinned' : '');
      const label = g.name || g.title || 'Grup';
      btn.innerHTML = userChipHtml(label, false, {
        size: 'sm',
        subtitle: `${g.memberCount || g.users?.length || 0} üye`,
      });
      btn.addEventListener('click', () => openGroupChannel(g));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openGroupContextMenu(e.clientX, e.clientY, g);
      });
    }
    li.appendChild(btn);
    list.appendChild(li);
  }
  $('dm-empty')?.classList.toggle('hidden', items.length > 0);
  updateFriendsBadge();
  if (activeView === 'friends') renderFriendsMain();
}

function setFriendsTab(tab) {
  friendsTab = tab;
  document.querySelectorAll('.friends-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.friendsTab === tab);
  });
  const addPanel = $('friends-add-panel');
  const searchWrap = $('friends-search')?.parentElement;
  const list = $('friends-main-list');
  const label = $('friends-list-label');
  const empty = $('friends-main-empty');
  const isAdd = tab === 'add';
  addPanel?.classList.toggle('hidden', !isAdd);
  searchWrap?.classList.toggle('hidden', isAdd);
  list?.classList.toggle('hidden', isAdd);
  label?.classList.toggle('hidden', isAdd);
  empty?.classList.toggle('hidden', isAdd);
  if (!isAdd) renderFriendsMain();
  else {
    $('friends-add-status').textContent = '';
    $('friends-add-status').className = 'friends-add-status';
    $('friends-add-input')?.focus();
  }
}

function renderFriendsMain() {
  const list = $('friends-main-list');
  const label = $('friends-list-label');
  const empty = $('friends-main-empty');
  if (!list || friendsTab === 'add') return;

  const q = ($('friends-search')?.value || '').trim().toLowerCase();
  list.innerHTML = '';

  if (friendsTab === 'pending') {
    label.classList.add('hidden');
    const incoming = (friendRequests.incoming || []).filter((r) => !q || r.user.username.toLowerCase().includes(q));
    const outgoing = (friendRequests.outgoing || []).filter((r) => !q || r.user.username.toLowerCase().includes(q));

    if (incoming.length) {
      list.appendChild(makeFriendsSectionHeader('Alındı', incoming.length, {
        actionLabel: 'Tümünü temizle',
        onAction: () => clearIncomingRequests(),
      }));
      for (const r of incoming) list.appendChild(makePendingRow(r, 'incoming'));
    }
    if (outgoing.length) {
      list.appendChild(makeFriendsSectionHeader('Gönderildi', outgoing.length));
      for (const r of outgoing) list.appendChild(makePendingRow(r, 'outgoing'));
    }

    empty.classList.toggle('hidden', incoming.length + outgoing.length > 0);
    empty.textContent = 'Bekleyen istek yok.';
    return;
  }

  label.classList.remove('hidden');
  let rows = [...friends];
  if (friendsTab === 'online') rows = rows.filter((f) => f.online);
  if (q) rows = rows.filter((f) => f.username.toLowerCase().includes(q));
  rows.sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));

  label.textContent = friendsTab === 'online'
    ? `Çevrimiçi — ${rows.length}`
    : `Tümü — ${rows.length}`;

  for (const f of rows) {
    list.appendChild(makeFriendListRow(f));
  }
  empty.classList.toggle('hidden', rows.length > 0);
  empty.textContent = friendsTab === 'online' ? 'Çevrimiçi arkadaş yok.' : 'Henüz arkadaşın yok.';
}

function makeFriendsSectionHeader(title, count, { actionLabel, onAction } = {}) {
  const li = document.createElement('li');
  li.className = 'friends-section-head';
  const left = document.createElement('span');
  left.textContent = `${title} — ${count}`;
  li.appendChild(left);
  if (actionLabel && onAction) {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'friends-section-action';
    a.textContent = actionLabel;
    a.addEventListener('click', onAction);
    li.appendChild(a);
  }
  return li;
}

function clearIncomingRequests() {
  const list = [...(friendRequests.incoming || [])];
  if (!list.length) return;
  let left = list.length;
  for (const r of list) {
    socket.emit('friend-decline', { requestId: r.id }, () => {
      left -= 1;
      if (left <= 0) toast('Gelen istekler temizlendi');
    });
  }
}

function friendIconBtn(title, svg, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'friend-icon-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(e, b);
  });
  return b;
}

const ICON_MSG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>`;
const ICON_MORE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5 10 17l9-10"/></svg>`;
const ICON_X = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M7 7l10 10M17 7 7 17"/></svg>`;

function makeFriendListRow(f) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'friend-row';
  row.dataset.allowMenu = '1';
  row.innerHTML = `${userChipHtml(f.username, !!f.online, { size: 'md' })}<span class="friend-row-actions"></span>`;
  const actions = row.querySelector('.friend-row-actions');
  actions.append(
    friendIconBtn('Mesaj', ICON_MSG, () => openDM(f.id)),
    friendIconBtn('Diğer', ICON_MORE, (e, btn) => openFriendMoreMenu(btn, f)),
  );
  row.addEventListener('click', (e) => {
    if (e.target.closest('.friend-row-actions')) return;
    openDM(f.id);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openFriendsListContextMenu(e.clientX, e.clientY, f);
  });
  li.appendChild(row);
  return li;
}

function makePendingRow(r, kind) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'friend-row friend-row--pending';
  row.dataset.allowMenu = '1';
  row.innerHTML = `
    ${userChipHtml(r.user.username, false, {
      subtitle: kind === 'incoming' ? 'Gelen istek' : 'Giden istek',
      size: 'md',
    })}
    <span class="friend-row-actions"></span>`;
  const actions = row.querySelector('.friend-row-actions');
  if (kind === 'incoming') {
    actions.append(
      friendIconBtn('Kabul et', ICON_CHECK, () => acceptFriendRequest(r)),
      friendIconBtn('Reddet', ICON_X, () => declineFriendRequest(r, 'İstek reddedildi')),
    );
  } else {
    actions.append(
      friendIconBtn('İptal', ICON_X, () => declineFriendRequest(r, 'İstek iptal edildi')),
    );
  }
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPendingContextMenu(e.clientX, e.clientY, r, kind);
  });
  li.appendChild(row);
  return li;
}

function acceptFriendRequest(r) {
  socket.emit('friend-accept', { requestId: r.id }, (res) => {
    if (res.error) { toast(res.error); return; }
    if (res.friend) {
      const idx = friends.findIndex((f) => f.id === res.friend.id);
      if (idx >= 0) friends[idx] = { ...friends[idx], ...res.friend };
      else friends.push(res.friend);
    }
    toast(`${r.user.username} arkadaş eklendi`);
    renderFriends();
  });
}

function declineFriendRequest(r, okMsg) {
  socket.emit('friend-decline', { requestId: r.id }, (res) => {
    if (res.error) { toast(res.error); return; }
    toast(okMsg || 'İstek güncellendi');
  });
}

function appendInviteSubmenu(parentBtn, targetId, onDone) {
  openSubmenu(parentBtn, (sub) => {
    if (!servers.length) {
      sub.appendChild(ctxItem({ label: 'Sunucu yok', disabled: true }));
      return;
    }
    for (const s of servers) {
      sub.appendChild(ctxItem({
        label: s.name,
        onClick: () => {
          socket.emit('invite-to-server', { serverId: s.id, targetId }, (res) => {
            closeCtxMenu();
            if (res?.error) toast(res.error);
            else toast('Davet gönderildi');
            onDone?.();
          });
        },
      }));
    }
  });
}

function openFriendMoreMenu(anchorBtn, friend) {
  const menu = $('ctx-menu');
  closeCtxMenu();
  menu.appendChild(ctxItem({
    label: 'Görüntülü Arama Başlat',
    disabled: true,
  }));
  menu.appendChild(ctxItem({
    label: 'Sesli Arama Başlat',
    disabled: true,
  }));
  menu.appendChild(ctxItem({
    label: 'Arkadaşı Çıkar',
    danger: true,
    onClick: () => {
      closeCtxMenu();
      confirmRemoveFriend(friend);
    },
  }));
  const rect = anchorBtn.getBoundingClientRect();
  placeCtxMenu(menu, rect.right - 200, rect.bottom + 4);
}

function openFriendsListContextMenu(x, y, friend) {
  const menu = $('ctx-menu');
  closeCtxMenu();
  menu.appendChild(ctxItem({
    label: 'Profil',
    onClick: () => { closeCtxMenu(); openUserProfile(friend.id); },
  }));
  menu.appendChild(ctxItem({
    label: 'Mesaj Gönder',
    onClick: () => { closeCtxMenu(); openDM(friend.id); },
  }));
  menu.appendChild(ctxItem({ label: 'Bir Arama Başlat', disabled: true }));
  menu.appendChild(ctxItem({
    label: 'Not Ekle',
    sub: 'Sadece sana görünür',
    onClick: () => { closeCtxMenu(); openUserProfile(friend.id); },
  }));
  menu.appendChild(ctxSep());
  const inviteBtn = ctxItem({ label: 'Sunucuya Davet Et', right: '›' });
  inviteBtn.addEventListener('mouseenter', () => appendInviteSubmenu(inviteBtn, friend.id));
  menu.appendChild(inviteBtn);
  menu.appendChild(ctxItem({
    label: 'Arkadaşı Çıkar',
    onClick: () => { closeCtxMenu(); confirmRemoveFriend(friend); },
  }));
  menu.appendChild(ctxItem({
    label: friend.ignored ? 'Yoksaymayı Kaldır' : 'Yok Say',
    onClick: () => {
      socket.emit('user-ignore', { targetId: friend.id, ignored: !friend.ignored }, () => closeCtxMenu());
    },
  }));
  menu.appendChild(ctxItem({
    label: friend.blocked ? 'Engeli kaldır' : 'Engelle',
    danger: !friend.blocked,
    onClick: () => {
      closeCtxMenu();
      if (friend.blocked) {
        socket.emit('user-block', { targetId: friend.id, blocked: false });
        return;
      }
      showModal('Engelle', `<p><strong>${escapeHtml(friend.username)}</strong> engellenecek. Bu kişiden gelen mesajlar gizlenir ve ona mesaj gönderemezsin.</p>`, [
        { label: 'İptal', className: 'btn-secondary', onClick: closeModal },
        {
          label: 'Engelle', className: 'btn-danger', onClick: () => {
            closeModal();
            socket.emit('user-block', { targetId: friend.id, blocked: true });
          },
        },
      ]);
    },
  }));
  if (settings.developer) {
    menu.appendChild(ctxSep());
    menu.appendChild(ctxItem({
      label: 'Kullanıcı ID\'sini Kopyala',
      right: 'ID',
      onClick: async () => {
        closeCtxMenu();
        try { await navigator.clipboard.writeText(String(friend.id)); toast('Kullanıcı ID kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    }));
  }
  placeCtxMenu(menu, x, y);
}

function openPendingContextMenu(x, y, request, kind) {
  const menu = $('ctx-menu');
  const user = request.user;
  closeCtxMenu();
  menu.appendChild(ctxItem({
    label: 'Profil',
    onClick: () => { closeCtxMenu(); openUserProfile(user.id); },
  }));
  menu.appendChild(ctxItem({
    label: 'Mesaj Gönder',
    onClick: () => {
      closeCtxMenu();
      toast('Mesaj göndermek için önce arkadaş olmalısınız.');
    },
  }));
  menu.appendChild(ctxItem({ label: 'Bir Arama Başlat', disabled: true }));
  menu.appendChild(ctxItem({
    label: 'Not Ekle',
    sub: 'Sadece sana görünür',
    onClick: () => { closeCtxMenu(); openUserProfile(user.id); },
  }));
  menu.appendChild(ctxSep());
  const inviteBtn = ctxItem({ label: 'Sunucuya Davet Et', right: '›' });
  inviteBtn.addEventListener('mouseenter', () => appendInviteSubmenu(inviteBtn, user.id));
  menu.appendChild(inviteBtn);
  if (kind === 'incoming') {
    menu.appendChild(ctxItem({
      label: 'Arkadaşlık İsteğini Kabul Et',
      onClick: () => { closeCtxMenu(); acceptFriendRequest(request); },
    }));
  }
  menu.appendChild(ctxItem({
    label: kind === 'incoming' ? 'Yok Say' : 'İsteği İptal Et',
    onClick: () => {
      closeCtxMenu();
      declineFriendRequest(request, kind === 'incoming' ? 'İstek yoksayıldı' : 'İstek iptal edildi');
    },
  }));
  menu.appendChild(ctxItem({
    label: 'Engelle',
    danger: true,
    onClick: () => {
      closeCtxMenu();
      showModal('Engelle', `<p><strong>${escapeHtml(user.username)}</strong> engellenecek.</p>`, [
        { label: 'İptal', className: 'btn-secondary', onClick: closeModal },
        {
          label: 'Engelle', className: 'btn-danger', onClick: () => {
            closeModal();
            socket.emit('user-block', { targetId: user.id, blocked: true }, () => {
              declineFriendRequest(request, 'Engellendi');
            });
          },
        },
      ]);
    },
  }));
  if (settings.developer) {
    menu.appendChild(ctxSep());
    menu.appendChild(ctxItem({
      label: 'Kullanıcı ID\'sini Kopyala',
      right: 'ID',
      onClick: async () => {
        closeCtxMenu();
        try { await navigator.clipboard.writeText(String(user.id)); toast('Kullanıcı ID kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    }));
  }
  placeCtxMenu(menu, x, y);
}

function openFriendsView(tab = friendsTab, push = true) {
  activeServer = null;
  activeChannelId = null;
  activeDmFriendId = null;
  activeDmChannelId = null;
  activeGroupId = null;
  activeGroupTitle = '';
  endDmCall();
  showSidebarHome();
  renderFriends();
  setMainView('friends');
  setFriendsTab(tab);
  setRailActive('home');
  closeDrawers();
  if (push) navTo('/channels/@me');
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
    // Aynı kullanıcı birden fazla cihazdan: tek satır, ikonları birleştir.
    const byUser = new Map();
    for (const p of presence) {
      const cur = byUser.get(p.userId);
      if (!cur) {
        byUser.set(p.userId, {
          userId: p.userId,
          username: p.username,
          muted: !!p.muted,
          deafened: !!p.deafened,
          camera: !!p.camera,
          screen: !!p.screen,
        });
      } else {
        cur.muted = cur.muted && !!p.muted;
        cur.deafened = cur.deafened || !!p.deafened;
        cur.camera = cur.camera || !!p.camera;
        cur.screen = cur.screen || !!p.screen;
      }
    }
    if (byUser.size) {
      const ul = document.createElement('ul');
      ul.className = 'voice-users';
      for (const p of byUser.values()) {
        ul.appendChild(makeVoiceUserRow(p));
      }
      li.appendChild(ul);
    }
  }
}

const VU_ICONS = {
  cam: '<svg class="vu-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10l4 3V5L14 8H4Z"/></svg>',
  screen: '<svg class="vu-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h7v2H8v2h8v-2h-3v-2h7a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H4Z"/></svg>',
  mic: '<svg class="vu-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V20H9v2h6v-2h-2v-2.08A7 7 0 0 0 19 11h-2Z"/></svg>',
  micOff: '<svg class="vu-icon off" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.1 18.3 4.7 3.9 3.3 5.3l5.2 5.2V11a3.5 3.5 0 0 0 4.9 3.2l1.5 1.5A5.5 5.5 0 0 1 7 11H5a7.5 7.5 0 0 0 6 7.4V21H9v2h6v-2h-2v-2.6c1.1-.2 2.1-.7 3-1.3l3.5 3.5 1.6-1.6ZM12 3a3 3 0 0 0-3 3v.2l8.4 8.4A5 5 0 0 0 17 11h2a7 7 0 0 1-.7 3L14 9.7V6a3 3 0 0 0-2-3Z"/></svg>',
  headphone: '<svg class="vu-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 0 0-9 9v4a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H5.07A7 7 0 0 1 12 5a7 7 0 0 1 6.93 6H17a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a3 3 0 0 0 3-3v-4a9 9 0 0 0-9-9Z"/></svg>',
  headphoneOff: '<svg class="vu-icon off" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m3.3 2 18 18-1.4 1.4-3.2-3.2A3 3 0 0 1 18 21h-1a2 2 0 0 1-2-2v-3c0-.3.1-.6.2-.8L3.3 3.4 4.7 2Zm8.7 1a9 9 0 0 1 9 9v4c0 .5-.1 1-.3 1.4l-1.5-1.5.01-.2a1 1 0 0 0-1-1h-1.9A7 7 0 0 0 12 5a7 7 0 0 0-6.7 5H7a2 2 0 0 1 1.8 1.1L7.2 9.5A9 9 0 0 1 12 3ZM5.07 13H7a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3v-4c0-.34.03-.67.07-1Z"/></svg>',
};

function makeVoiceUserRow(p) {
  const vu = document.createElement('li');
  vu.className = 'voice-user';
  const media = [];
  if (p.camera) media.push(VU_ICONS.cam);
  if (p.screen) media.push(VU_ICONS.screen);
  const audio = [
    p.muted ? VU_ICONS.micOff : VU_ICONS.mic,
    p.deafened ? VU_ICONS.headphoneOff : VU_ICONS.headphone,
  ];
  vu.innerHTML = `
    ${userChipHtml(p.username, true, { showSub: false, size: 'xs' })}
    <span class="voice-user-media">${media.join('')}</span>
    <span class="voice-user-audio">${audio.join('')}</span>`;
  return vu;
}

/* ================= Navigation ================= */
function goHome(push = true) {
  openFriendsView('online', push);
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
    activeGroupId = null;
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
function isAuthorBlocked(authorId) {
  if (!authorId || authorId === currentUser?.id) return false;
  if ((social.blocked || []).includes(authorId)) return true;
  const f = friends.find((x) => x.id === authorId);
  return !!f?.blocked;
}

function makeMsgEl(author, text, ts, msgId = null, extra = {}) {
  const div = document.createElement('div');
  div.className = 'msg';
  if (msgId) div.dataset.msgId = msgId;
  if (ts) div.dataset.ts = String(ts);
  if (extra.pending) div.dataset.pending = '1';
  if (extra.localId) div.dataset.localId = extra.localId;
  const reply = extra.replyTo;
  const reactions = extra.reactions || {};
  let replyHtml = '';
  if (reply) {
    replyHtml = `<div class="msg-reply"><span class="msg-reply-author">${escapeHtml(reply.username || '—')}</span> ${escapeHtml(reply.text || '')}</div>`;
  }
  const reactionEntries = Object.entries(reactions).filter(([, users]) => users?.length);
  let reactHtml = '';
  if (reactionEntries.length) {
    reactHtml = `<div class="msg-reactions">${reactionEntries.map(([emoji, users]) => {
      const mine = users.includes(currentUser?.id);
      return `<button type="button" class="msg-reaction${mine ? ' mine' : ''}" data-emoji="${escapeHtml(emoji)}" data-msg="${escapeHtml(msgId || '')}">${emoji} <span>${users.length}</span></button>`;
    }).join('')}</div>`;
  }
  div.innerHTML = `
    <span class="msg-avatar">${escapeHtml(initials(author))}</span>
    <div class="msg-body">
      <span class="msg-author">${escapeHtml(author || '—')}</span>
      <span class="msg-time">${formatTime(ts)}</span>
      ${replyHtml}
      <div class="msg-text">${escapeHtml(text)}</div>
      ${reactHtml}
    </div>`;
  if (msgId && !extra.pending && activeView === 'dm' && activeDmChannelId) {
    div.dataset.allowMenu = '1';
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dmFeatures?.openMessageMenu?.(e.clientX, e.clientY, {
        id: msgId, text, fromId: extra.fromId || null, ts, username: author, author,
      }, activeDmChannelId);
    });
    div.querySelectorAll('.msg-reaction').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('react-dm-message', {
          channelId: activeDmChannelId,
          messageId: msgId,
          emoji: btn.dataset.emoji,
        });
      });
    });
  }
  return div;
}

function blockedToggleLabel(n, expanded) {
  const verb = expanded ? 'Gizle' : 'Göster';
  return `${n} engellenen mesaj — <span class="blocked-msg-show">${verb}</span>`;
}

function createBlockedGroup(msgs, resolve) {
  const wrap = document.createElement('div');
  wrap.className = 'blocked-msg-group';
  wrap.dataset.count = String(msgs.length);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'blocked-msg-toggle';
  toggle.innerHTML = `
    <svg class="blocked-msg-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M7 7l10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <span class="blocked-msg-label">${blockedToggleLabel(msgs.length, false)}</span>`;

  const body = document.createElement('div');
  body.className = 'blocked-msg-body hidden';
  for (const msg of msgs) {
    const meta = resolve(msg);
    body.appendChild(makeMsgEl(meta.author, meta.text, meta.ts, meta.id, meta));
  }

  let expanded = false;
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    wrap.dataset.expanded = expanded ? '1' : '0';
    body.classList.toggle('hidden', !expanded);
    toggle.querySelector('.blocked-msg-label').innerHTML = blockedToggleLabel(
      Number(wrap.dataset.count) || body.children.length,
      expanded
    );
  });

  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

function pushIntoBlockedGroup(group, msg, resolve) {
  const body = group.querySelector('.blocked-msg-body');
  const meta = resolve(msg);
  body.appendChild(makeMsgEl(meta.author, meta.text, meta.ts, meta.id, meta));
  const count = body.children.length;
  group.dataset.count = String(count);
  const expanded = group.dataset.expanded === '1';
  const label = group.querySelector('.blocked-msg-label');
  if (label) label.innerHTML = blockedToggleLabel(count, expanded);
}

function appendResolvedMessage(container, msg, resolve) {
  if (msg?.id && container.querySelector(`[data-msg-id="${CSS.escape(String(msg.id))}"]`)) {
    return;
  }
  // Optimistic pending mesajı sessizce gerçek id ile bağla (yeniden çizme)
  if (msg?.id && confirmPendingMessage(container, msg, resolve)) return;

  const meta = resolve(msg);
  if (isAuthorBlocked(meta.authorId)) {
    const last = container.lastElementChild;
    if (last?.classList.contains('blocked-msg-group')) {
      pushIntoBlockedGroup(last, msg, resolve);
    } else {
      container.appendChild(createBlockedGroup([msg], resolve));
    }
  } else {
    container.appendChild(makeMsgEl(meta.author, meta.text, meta.ts, meta.id, meta));
  }
  container.scrollTop = container.scrollHeight;
}

function localMsgId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Pending balonu gerçek mesajla eşleştir — DOM’u bozmadan id güncelle */
function confirmPendingMessage(container, realMsg, resolve) {
  const meta = resolve(realMsg);
  const text = String(meta.text || '').trim();
  const authorId = meta.authorId;
  const pending = [...container.querySelectorAll('.msg[data-pending="1"]')];
  const match = pending.find((el) => {
    const t = el.querySelector('.msg-text')?.textContent || '';
    if (t.trim() !== text) return false;
    const from = el.dataset.fromId || '';
    if (authorId && from && from !== String(authorId)) return false;
    const ts = Number(el.dataset.ts || 0);
    return !ts || Date.now() - ts < 30000;
  }); // ilk eşleşen = en eski pending (FIFO)
  if (!match) return false;
  match.dataset.msgId = String(realMsg.id);
  match.dataset.pending = '0';
  delete match.dataset.pending;
  match.classList.remove('msg-pending');
  if (meta.ts) {
    match.dataset.ts = String(meta.ts);
    const timeEl = match.querySelector('.msg-time');
    if (timeEl) timeEl.textContent = formatTime(meta.ts);
  }
  // Menü bağla (DM)
  if (activeView === 'dm' && activeDmChannelId && !match.dataset.allowMenu) {
    match.dataset.allowMenu = '1';
    const author = match.querySelector('.msg-author')?.textContent || '';
    const bodyText = match.querySelector('.msg-text')?.textContent || '';
    match.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dmFeatures?.openMessageMenu?.(e.clientX, e.clientY, {
        id: realMsg.id,
        text: bodyText,
        fromId: authorId,
        ts: meta.ts,
        username: author,
        author,
      }, activeDmChannelId);
    });
  }
  return true;
}

function appendOptimistic(container, msg, resolve) {
  const meta = resolve(msg);
  const el = makeMsgEl(meta.author, meta.text, meta.ts, msg.id, {
    ...meta,
    pending: true,
    localId: msg.id,
  });
  el.dataset.fromId = String(meta.authorId || '');
  el.dataset.ts = String(meta.ts || Date.now());
  el.classList.add('msg-pending');
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function failOptimistic(container, localId) {
  const el = container.querySelector(`[data-local-id="${CSS.escape(localId)}"]`);
  el?.remove();
}

function renderMessageList(container, messages, resolve) {
  const loaderHtml = `<div class="msg-history-loader hidden" aria-hidden="true">
    <div class="msg-history-spinner"></div>
    <span>Eski mesajlar yükleniyor…</span>
  </div>`;
  container.innerHTML = loaderHtml;
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const meta = resolve(msg);
    if (isAuthorBlocked(meta.authorId)) {
      const group = [];
      while (i < messages.length && isAuthorBlocked(resolve(messages[i]).authorId)) {
        group.push(messages[i++]);
      }
      container.appendChild(createBlockedGroup(group, resolve));
    } else {
      container.appendChild(makeMsgEl(meta.author, meta.text, meta.ts, meta.id, meta));
      i += 1;
    }
  }
  container.scrollTop = container.scrollHeight;
  bindHistoryScroll(container);
}

function ensureHistoryLoader(container) {
  let el = container.querySelector('.msg-history-loader');
  if (!el) {
    el = document.createElement('div');
    el.className = 'msg-history-loader hidden';
    el.innerHTML = `<div class="msg-history-spinner"></div><span>Eski mesajlar yükleniyor…</span>`;
    container.prepend(el);
  }
  return el;
}

function getOldestMessageTs(container) {
  let oldest = null;
  container.querySelectorAll('.msg[data-ts], .msg[data-msg-id]').forEach((el) => {
    const ts = Number(el.dataset.ts || 0);
    if (ts && (oldest == null || ts < oldest)) oldest = ts;
  });
  // data-ts olmayabilir — time text'ten değil, msg listesinden
  if (oldest == null) {
    container.querySelectorAll('.msg').forEach((el) => {
      const t = el.querySelector('.msg-time');
      // fallback: skip
    });
  }
  return oldest;
}

function prependMessageList(container, messages, resolve) {
  if (!messages?.length) return;
  const loader = ensureHistoryLoader(container);
  const prevHeight = container.scrollHeight;
  const prevTop = container.scrollTop;
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg?.id && container.querySelector(`[data-msg-id="${CSS.escape(String(msg.id))}"]`)) {
      i += 1;
      continue;
    }
    const meta = resolve(msg);
    if (isAuthorBlocked(meta.authorId)) {
      const group = [];
      while (i < messages.length && isAuthorBlocked(resolve(messages[i]).authorId)) {
        const m = messages[i++];
        if (m?.id && container.querySelector(`[data-msg-id="${CSS.escape(String(m.id))}"]`)) continue;
        group.push(m);
      }
      if (group.length) frag.appendChild(createBlockedGroup(group, resolve));
    } else {
      const el = makeMsgEl(meta.author, meta.text, meta.ts, meta.id, meta);
      if (meta.ts) el.dataset.ts = String(meta.ts);
      frag.appendChild(el);
      i += 1;
    }
  }
  loader.after(frag);
  container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
}

function bindHistoryScroll(container) {
  if (container.dataset.historyScroll === '1') return;
  container.dataset.historyScroll = '1';
  container.addEventListener('scroll', () => {
    if (container.scrollTop > 60) return;
    if (container === $('chat-messages')) loadOlderChatMessages();
    else if (container === $('dm-messages')) loadOlderDmMessages();
  });
}

function loadOlderChatMessages() {
  if (loadingOlderMsgs || !chatHasMore || !activeChannelId || activeView !== 'chat') return;
  const container = $('chat-messages');
  const beforeTs = getOldestMessageTs(container);
  if (!beforeTs) { chatHasMore = false; return; }
  loadingOlderMsgs = true;
  const loader = ensureHistoryLoader(container);
  loader.classList.remove('hidden');
  loader.setAttribute('aria-hidden', 'false');
  socket.emit('load-messages', { channelId: activeChannelId, beforeTs }, (res) => {
    loadingOlderMsgs = false;
    loader.classList.add('hidden');
    loader.setAttribute('aria-hidden', 'true');
    if (res?.error) { toast(res.error); return; }
    chatHasMore = !!res.hasMore;
    if ((res.messages || []).length) chatHistoryExpanded = true;
    prependMessageList(container, res.messages || [], resolveChannelMsg);
    if (!(res.messages || []).length) chatHasMore = false;
  });
}

function loadOlderDmMessages() {
  if (loadingOlderMsgs || !dmHasMore || !activeDmChannelId || activeView !== 'dm') return;
  const container = $('dm-messages');
  const beforeTs = getOldestMessageTs(container);
  if (!beforeTs) { dmHasMore = false; return; }
  loadingOlderMsgs = true;
  const loader = ensureHistoryLoader(container);
  loader.classList.remove('hidden');
  loader.setAttribute('aria-hidden', 'false');
  const friendId = activeDmFriendId;
  socket.emit('load-dm-messages', { channelId: activeDmChannelId, beforeTs }, (res) => {
    loadingOlderMsgs = false;
    loader.classList.add('hidden');
    loader.setAttribute('aria-hidden', 'true');
    if (res?.error) { toast(res.error); return; }
    dmHasMore = !!res.hasMore;
    if ((res.messages || []).length) dmHistoryExpanded = true;
    prependMessageList(container, res.messages || [], (m) => resolveDmMsg(m, friendId));
    if (!(res.messages || []).length) dmHasMore = false;
  });
}

function resolveChannelMsg(msg) {
  return {
    authorId: msg.userId,
    author: msg.username || '—',
    text: msg.text,
    ts: msg.ts,
    id: msg.id,
    fromId: msg.userId,
    reactions: msg.reactions || {},
    replyTo: msg.replyTo || null,
  };
}

function resolveDmMsg(msg, friendId) {
  const isMe = msg.fromId === currentUser?.id;
  let author = currentUser?.username || '—';
  if (!isMe) {
    if (activeGroupId) {
      const g = groupDms.find((x) => x.id === activeGroupId);
      author = g?.members?.find((m) => m.id === msg.fromId)?.username
        || friends.find((f) => f.id === msg.fromId)?.username
        || '—';
    } else {
      author = friends.find((f) => f.id === friendId)?.username || '—';
    }
  }
  return {
    authorId: msg.fromId,
    author,
    text: msg.text,
    ts: msg.ts,
    id: msg.id,
    fromId: msg.fromId,
    reactions: msg.reactions || {},
    replyTo: msg.replyTo || null,
  };
}

function openTextChannel(channelId, name, push = true) {
  activeChannelId = channelId;
  activeDmFriendId = null;
  activeDmChannelId = null;
  loadingOlderMsgs = false;
  chatHistoryExpanded = false;
  $('chat-title').textContent = `# ${name}`;
  setMainView('chat');
  renderChannels();

  const cached = readMsgCache('chan', channelId);
  if (cached?.messages?.length) {
    chatHasMore = cached.hasMore !== false;
    renderMessageList($('chat-messages'), cached.messages, resolveChannelMsg);
  } else {
    $('chat-messages').innerHTML = '';
    ensureHistoryLoader($('chat-messages'));
    chatHasMore = true;
  }

  socket.emit('open-text-channel', { channelId }, (res) => {
    if (res.error) { toast(res.error); return; }
    if (activeChannelId !== channelId) return;
    writeMsgCache('chan', channelId, res.messages || [], res.hasMore);
    if (chatHistoryExpanded) {
      // Kullanıcı eski sayfaları açtıysa listeyi silme; hasMore'u sadece cache için tut
      return;
    }
    chatHasMore = !!res.hasMore;
    renderMessageList($('chat-messages'), res.messages || [], resolveChannelMsg);
  });
  if (push && activeServer) navTo(`/channels/${activeServer.id}/${channelId}`);
  closeDrawers();
}

function appendMessage(container, msg) {
  appendResolvedMessage(container, msg, resolveChannelMsg);
}

function updateDmComposer() {
  const form = $('dm-form');
  const bar = $('dm-blocked-bar');
  const unblockBtn = $('dm-unblock-btn');
  if (!form || !bar) return;
  if (activeGroupId) {
    form.classList.remove('hidden');
    bar.classList.add('hidden');
    return;
  }
  const f = friends.find((x) => x.id === activeDmFriendId);
  const blockedByMe = !!(f?.blocked || (activeDmFriendId && (social.blocked || []).includes(activeDmFriendId)));
  const blockedByThem = !!f?.blockedByThem;
  const locked = blockedByMe || blockedByThem;
  form.classList.toggle('hidden', locked);
  bar.classList.toggle('hidden', !locked);
  if (!locked) return;
  if (blockedByMe) {
    $('dm-blocked-text').textContent = 'Engellediğin bir kullanıcıya mesaj gönderemezsin.';
    unblockBtn?.classList.remove('hidden');
  } else {
    $('dm-blocked-text').textContent = 'Bu kullanıcıya mesaj gönderemezsin.';
    unblockBtn?.classList.add('hidden');
  }
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !activeChannelId) return;
  input.value = '';
  const localId = localMsgId();
  const optimistic = {
    id: localId,
    userId: currentUser?.id,
    username: currentUser?.username,
    text,
    ts: Date.now(),
  };
  appendOptimistic($('chat-messages'), optimistic, resolveChannelMsg);
  socket.emit('send-message', { channelId: activeChannelId, text, clientId: localId }, (res) => {
    if (res?.error) {
      failOptimistic($('chat-messages'), localId);
      toast(res.error);
      return;
    }
    if (res?.message) {
      appendMessage($('chat-messages'), res.message);
      appendMsgCache('chan', activeChannelId, res.message);
    }
  });
});

/* ================= DM ================= */
function openDM(friendId, push = true) {
  const friend = friends.find((f) => f.id === friendId);
  if (!friend) return;
  activeServer = null;
  activeDmFriendId = friendId;
  activeGroupId = null;
  activeGroupTitle = '';
  activeChannelId = null;
  loadingOlderMsgs = false;
  friend.unread = false;
  friend.closed = false;
  showSidebarHome();
  setRailActive('home');
  $('dm-title').textContent = `@ ${friend.username}`;
  dmFeatures?.closeSearchPanel?.();
  dmFeatures?.closePinsPanel?.();
  dmFeatures?.updateCallStage?.(friend.username);
  setMainView('dm');
  updateDmComposer();
  renderFriends();
  dmHistoryExpanded = false;

  const cacheId = friend.dmChannelId || activeDmChannelId;
  const cached = cacheId ? readMsgCache('dm', cacheId) : null;
  if (cached?.messages?.length) {
    dmHasMore = cached.hasMore !== false;
    renderDMMessages(cached.messages, friendId);
  } else {
    $('dm-messages').innerHTML = '';
    ensureHistoryLoader($('dm-messages'));
    dmHasMore = true;
  }

  socket.emit('open-dm', { friendId }, (res) => {
    if (res.error) { toast(res.error); return; }
    if (activeDmFriendId !== friendId) return;
    activeDmChannelId = res.dmChannelId;
    dmPins = res.pins || [];
    if (res.social) social = res.social;
    if (friend) {
      friend.blocked = !!res.blockedByMe;
      friend.blockedByThem = !!res.blockedByThem;
      friend.dmChannelId = res.dmChannelId;
    }
    updateDmComposer();
    writeMsgCache('dm', res.dmChannelId, res.messages || [], res.hasMore);
    if (!dmHistoryExpanded) {
      dmHasMore = !!res.hasMore;
      renderDMMessages(res.messages, friendId);
    }
    if (push) navTo(`/channels/@me/${res.dmChannelId}`);
  });
  closeDrawers();
}

function openGroupChannel(channel, push = true) {
  if (!channel?.id) return;
  activeServer = null;
  activeDmFriendId = null;
  activeGroupId = channel.id;
  activeGroupTitle = channel.name || channel.title || 'Grup';
  activeDmChannelId = channel.id;
  activeChannelId = null;
  loadingOlderMsgs = false;
  dmHistoryExpanded = false;
  showSidebarHome();
  setRailActive('home');
  $('dm-title').textContent = activeGroupTitle;
  dmFeatures?.closeSearchPanel?.();
  dmFeatures?.closePinsPanel?.();
  dmFeatures?.updateCallStage?.(activeGroupTitle);
  setMainView('dm');
  updateDmComposer();
  renderFriends();

  const cached = readMsgCache('dm', channel.id);
  if (cached?.messages?.length) {
    dmHasMore = cached.hasMore !== false;
    renderDMMessages(cached.messages, null);
  } else {
    $('dm-messages').innerHTML = '';
    ensureHistoryLoader($('dm-messages'));
    dmHasMore = true;
  }

  socket.emit('get-dm-by-channel', { dmChannelId: channel.id }, (res) => {
    if (res.error) { toast(res.error); return; }
    if (activeGroupId !== channel.id) return;
    if (res.channel) {
      const idx = groupDms.findIndex((g) => g.id === res.channel.id);
      if (idx >= 0) groupDms[idx] = { ...groupDms[idx], ...res.channel };
      else groupDms.push(res.channel);
      activeGroupTitle = res.channel.name || res.channel.title || activeGroupTitle;
      $('dm-title').textContent = activeGroupTitle;
    }
    dmPins = res.pins || [];
    if (res.social) social = res.social;
    writeMsgCache('dm', channel.id, res.messages || [], res.hasMore);
    if (!dmHistoryExpanded) {
      dmHasMore = !!res.hasMore;
      renderDMMessages(res.messages, null);
    }
    updatePanel();
    if (push) navTo(`/channels/@me/${channel.id}`);
  });
  closeDrawers();
}

function openDMByChannel(dmChannelId, push = false) {
  const cached = readMsgCache('dm', dmChannelId);
  if (cached?.messages?.length) {
    // Hızlı önizleme — tip bilinmiyor, DM olarak çiz; sunucu düzeltir
    activeServer = null;
    activeChannelId = null;
    activeDmChannelId = dmChannelId;
    setMainView('dm');
    dmHasMore = cached.hasMore !== false;
    renderDMMessages(cached.messages, activeDmFriendId);
  }

  socket.emit('get-dm-by-channel', { dmChannelId }, (res) => {
    if (res.error) { toast(res.error); goHome(false); navTo('/channels/@me'); return; }
    if (res.type === 'group' || res.channel?.type === 'group') {
      openGroupChannel(res.channel || { id: dmChannelId }, push);
      return;
    }
    activeServer = null;
    activeChannelId = null;
    activeGroupId = null;
    activeDmFriendId = res.friendId;
    activeDmChannelId = res.dmChannelId;
    loadingOlderMsgs = false;
    if (res.social) social = res.social;
    const friend = friends.find((f) => f.id === res.friendId);
    if (friend) {
      friend.blocked = !!res.blockedByMe;
      friend.blockedByThem = !!res.blockedByThem;
      friend.dmChannelId = res.dmChannelId;
    }
    showSidebarHome();
    setRailActive('home');
    renderFriends();
    $('dm-title').textContent = `@ ${res.friend.username}`;
    dmFeatures?.updateCallStage?.(res.friend.username);
    setMainView('dm');
    updateDmComposer();
    dmPins = res.pins || [];
    writeMsgCache('dm', res.dmChannelId, res.messages || [], res.hasMore);
    if (!dmHistoryExpanded) {
      dmHasMore = !!res.hasMore;
      renderDMMessages(res.messages, res.friendId);
    }
    if (push) navTo(`/channels/@me/${res.dmChannelId}`);
    closeDrawers();
  });
}

function renderDMMessages(messages, friendId) {
  renderMessageList($('dm-messages'), messages || [], (msg) => resolveDmMsg(msg, friendId));
}

$('dm-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('dm-input');
  const text = input.value.trim();
  if (!text || (!activeDmFriendId && !activeGroupId)) return;
  const replyTo = dmFeatures?.getReplyDraft?.() || dmReply;
  const payload = replyTo ? {
    replyTo: {
      id: replyTo.id,
      fromId: replyTo.fromId,
      text: replyTo.text,
      username: replyTo.username,
    },
  } : {};
  const localId = localMsgId();
  const optimistic = {
    id: localId,
    fromId: currentUser?.id,
    text,
    ts: Date.now(),
    replyTo: payload.replyTo || null,
    reactions: {},
  };
  const resolve = (m) => resolveDmMsg(m, activeGroupId ? null : activeDmFriendId);

  if (activeGroupId) {
    input.value = '';
    dmFeatures?.clearReply?.();
    appendOptimistic($('dm-messages'), optimistic, resolve);
    socket.emit('send-dm', { channelId: activeGroupId, text, clientId: localId, ...payload }, (res) => {
      if (res.error) {
        failOptimistic($('dm-messages'), localId);
        toast(res.error);
        return;
      }
      if (res.message) {
        appendResolvedMessage($('dm-messages'), res.message, resolve);
        appendMsgCache('dm', activeGroupId, res.message);
      }
    });
    return;
  }
  const f = friends.find((x) => x.id === activeDmFriendId);
  if (f?.blocked || f?.blockedByThem) {
    toast(f.blocked ? 'Engellediğin bir kullanıcıya mesaj gönderemezsin.' : 'Bu kullanıcıya mesaj gönderemezsin.');
    updateDmComposer();
    return;
  }
  input.value = '';
  dmFeatures?.clearReply?.();
  appendOptimistic($('dm-messages'), optimistic, resolve);
  const dmPayload = activeDmChannelId
    ? { channelId: activeDmChannelId, text, clientId: localId, ...payload }
    : { friendId: activeDmFriendId, text, clientId: localId, ...payload };
  socket.emit('send-dm', dmPayload, (res) => {
    if (res.error) {
      failOptimistic($('dm-messages'), localId);
      toast(res.error);
      return;
    }
    if (res.message) {
      appendResolvedMessage($('dm-messages'), res.message, resolve);
      appendMsgCache('dm', activeDmChannelId, res.message);
    }
  });
});

$('dm-unblock-btn')?.addEventListener('click', () => {
  if (!activeDmFriendId) return;
  socket.emit('user-block', { targetId: activeDmFriendId, blocked: false }, () => {
    openDM(activeDmFriendId, false);
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

let lastSpeakingFlags = {};
function applySpeakingUi(flags) {
  const grids = [$('voice-grid'), $('dm-voice-grid')].filter(Boolean);
  for (const grid of grids) {
    for (const tile of grid.querySelectorAll('.voice-tile')) {
      if (tile.classList.contains('voice-tile--screen')) {
        tile.classList.remove('speaking');
        continue;
      }
      tile.classList.toggle('speaking', !!flags[tile.dataset.key]);
    }
  }
}

function makeVoiceTile(t) {
  const tile = document.createElement('div');
  const speaking = !t.isScreen && !!lastSpeakingFlags[t.key];
  tile.className = 'voice-tile'
    + (t.isScreen ? ' voice-tile--screen' : '')
    + (speaking ? ' speaking' : '');
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

function voiceUiActive() {
  return activeView === 'voice' || dmCallActive || dmCallRinging;
}

function getActiveVoiceGrid() {
  if (dmCallActive || dmCallRinging) return $('dm-voice-grid');
  return $('voice-grid');
}

function emptyVoiceState() {
  return {
    local: {
      muted: !!voiceManager?.isMuted?.(),
      deafened: !!voiceManager?.isDeafened?.(),
      cameraOn: !!voiceManager?.isCameraOn?.(),
      screenOn: !!voiceManager?.isScreenOn?.(),
      cameraStream: voiceManager?.isCameraOn?.() ? voiceManager.getCameraStream?.() : null,
      screenStream: voiceManager?.isScreenOn?.() ? voiceManager.getScreenStream?.() : null,
    },
    remote: [],
  };
}

function paintVoiceGrid(state = null) {
  const next = state || lastVoiceState || emptyVoiceState();
  renderVoiceGrid(next);
  // Layout henüz ölçülmediyse bir kare sonra yeniden çiz (DM stage açılınca 0x0 kalmasın)
  requestAnimationFrame(() => {
    if (!voiceUiActive()) return;
    const grid = getActiveVoiceGrid();
    if (!grid) return;
    if (!grid.querySelector('.voice-tile') || grid.clientWidth < 40) {
      renderVoiceGrid(lastVoiceState || next);
    }
  });
}

function renderVoiceGrid(state) {
  lastVoiceState = state;
  if (!voiceResizeBound) {
    voiceResizeBound = true;
    let rt = null;
    window.addEventListener('resize', () => {
      if (document.fullscreenElement) return; // tam ekranda yeniden çizme
      clearTimeout(rt);
      rt = setTimeout(() => { if (lastVoiceState && voiceUiActive()) renderVoiceGrid(lastVoiceState); }, 120);
    });
    // Tam ekrandan çıkınca (gerekiyorsa) ızgarayı tazele.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && pendingVoiceRender && lastVoiceState && voiceUiActive()) {
        pendingVoiceRender = false;
        renderVoiceGrid(lastVoiceState);
      }
    });
  }
  // Tam ekran açıkken DOM'u yeniden kurma (video kaldırılırsa tam ekran kapanır).
  if (document.fullscreenElement) { pendingVoiceRender = true; return; }
  const grid = getActiveVoiceGrid();
  if (!grid) return;
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
  const n = Math.max(1, tiles.length);
  const cols = Math.ceil(Math.sqrt(n));
  grid.style.gridTemplateRows = '';
  // Kutu boyutunu, hem genişliğe hem yüksekliğe sığacak şekilde sınırla.
  const gap = 0.6 * 16; // rem -> px
  const pad = 0.8 * 16 * 2;
  const availW = Math.max(160, (grid.clientWidth || grid.parentElement?.clientWidth || 320) - pad);
  const availH = Math.max(120, (grid.clientHeight || 200) - pad);
  const rows = Math.ceil(n / cols);
  const wByCols = (availW - gap * (cols - 1)) / cols;
  const hByRows = (availH - gap * (rows - 1)) / rows;
  const wByRows = hByRows * (16 / 9); // yüksekliğe göre izin verilen genişlik
  let tileW = Math.floor(Math.min(wByCols, wByRows));
  if (!Number.isFinite(tileW) || tileW < 120) tileW = 160;
  grid.style.gridTemplateColumns = `repeat(${cols}, ${tileW}px)`;
  if (!tiles.length) {
    grid.appendChild(makeVoiceTile({
      key: 'self',
      label: `${currentUser?.username || 'Sen'} (sen)`,
      initials: initials(currentUser?.username),
      stream: null,
      isScreen: false,
      muted: false,
      self: true,
    }));
  } else {
    for (const t of tiles) grid.appendChild(makeVoiceTile(t));
  }
}

function showVoiceFooter(channelName) {
  $('voice-conn').classList.remove('hidden');
  $('voice-conn-channel').textContent = channelName || '—';
  $('voice-conn-title').textContent = 'Ses Bağlantısı Kuruldu';
  $('app').classList.add('voice-connected');
  startPingMonitor();
}

function hideVoiceFooter() {
  $('voice-conn').classList.add('hidden');
  $('app').classList.remove('voice-connected');
  stopPingMonitor();
  const ping = $('voice-ping');
  ping.textContent = '—';
  ping.className = 'voice-ping';
  $('vc-mic').classList.remove('off');
  $('vc-deafen').classList.remove('off');
  $('vc-cam').classList.remove('on');
  $('vc-screen').classList.remove('on');
}

let pingTimer = null;
function updatePingUi(ms) {
  const el = $('voice-ping');
  if (!el || $('voice-conn').classList.contains('hidden')) return;
  el.textContent = `${ms} ms`;
  el.className = 'voice-ping' + (ms > 200 ? ' bad' : ms > 100 ? ' mid' : '');
  el.title = `Gecikme: ${ms} ms`;
}

function startPingMonitor() {
  stopPingMonitor();
  const tick = () => {
    if (!socket?.connected) return;
    const t0 = performance.now();
    socket.emit('latency-ping', Date.now(), () => {
      updatePingUi(Math.max(1, Math.round(performance.now() - t0)));
    });
  };
  tick();
  pingTimer = setInterval(tick, 4000);
}

function stopPingMonitor() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function leaveVoiceChannel() {
  voiceManager?.leave();
  voiceManager = null;
  maximizedTile = null;
  lastVoiceState = null;
  lastSpeakingFlags = {};
  hideVoiceFooter();
  setMainView('empty');
  $('empty-hint').textContent = 'Bir kanal seç.';
  renderChannels();
  if (activeServer) navTo(`/channels/${activeServer.id}`);
}

async function joinVoiceChannel(channelId, name, push = true) {
  await ensureAppModules();
  if (!createVoiceManager) { toast('Ses modülü yüklenemedi.'); return; }
  if (voiceManager) voiceManager.leave();
  dmCallActive = false;
  dmCallRinging = false;
  dmFeatures?.showCallStage?.(false);
  hideIncomingDmCall();
  activeChannelId = null;
  activeDmFriendId = null;
  activeDmChannelId = null;
  activeGroupId = null;
  maximizedTile = null;
  voiceManager = createVoiceManager({
    socket, username: currentUser.username,
    onUpdate: (state) => {
      renderVoiceGrid(state);
      $('voice-count').textContent = `${(state.remote?.length || 0) + 1} katılımcı`;
      $('vc-mic').classList.toggle('off', voiceManager.isMuted());
      $('vc-deafen').classList.toggle('off', voiceManager.isDeafened());
      $('vc-cam').classList.toggle('on', voiceManager.isCameraOn());
      $('vc-screen').classList.toggle('on', voiceManager.isScreenOn());
    },
    onSpeaking: (flags) => {
      lastSpeakingFlags = flags || {};
      applySpeakingUi(lastSpeakingFlags);
    },
  });

  $('voice-title').textContent = `🔊 ${name}`;
  showVoiceFooter(name);
  setMainView('voice');
  renderChannels();

  socket.emit('join-voice', { channelId }, async (res) => {
    if (res.error) {
      toast(res.error);
      voiceManager = null;
      hideVoiceFooter();
      setMainView('empty');
      return;
    }
    await voiceManager.join(channelId, res.participants);
  });
  if (push && activeServer) navTo(`/channels/${activeServer.id}/${channelId}`);
  closeDrawers();
}

$('vc-mic').addEventListener('click', () => {
  if (!voiceManager) { toast('Önce bir ses kanalına gir.'); return; }
  voiceManager.toggleMic();
});
$('vc-deafen').addEventListener('click', () => {
  if (!voiceManager) { toast('Önce bir ses kanalına gir.'); return; }
  voiceManager.toggleDeafen();
});
$('vc-cam').addEventListener('click', () => voiceManager?.toggleCamera());
$('vc-screen').addEventListener('click', () => voiceManager?.toggleScreen());
$('vc-leave').addEventListener('click', () => {
  if (dmCallActive || dmCallRinging) endDmCall();
  else leaveVoiceChannel();
});
$('user-panel-info').addEventListener('click', openSettings);

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
function sendFriendRequestFromInput(username, statusEl) {
  if (!username) return;
  socket.emit('friend-request', { username }, (res) => {
    if (res.error) {
      if (statusEl) { statusEl.textContent = res.error; statusEl.className = 'friends-add-status err'; }
      else toast(res.error);
      return;
    }
    if (res.accepted && res.friend) {
      const idx = friends.findIndex((f) => f.id === res.friend.id);
      if (idx >= 0) friends[idx] = res.friend; else friends.push(res.friend);
      renderFriends();
      const msg = `${res.friend.username} arkadaş eklendi`;
      if (statusEl) { statusEl.textContent = msg; statusEl.className = 'friends-add-status ok'; }
      else toast(msg);
      return;
    }
    const msg = 'Arkadaşlık isteği gönderildi';
    if (statusEl) { statusEl.textContent = msg; statusEl.className = 'friends-add-status ok'; }
    else toast(msg);
    // outgoing list socket üzerinden friend-requests ile güncellenir
  });
}

function openAddFriendModal() {
  showModal('Arkadaş Ekle', `<input class="modal-input" id="friend-input" placeholder="Kullanıcı adı" />`, [
    { label: 'İptal', onClick: closeModal },
    { label: 'İstek Gönder', className: 'btn-primary', onClick: () => {
      const username = $('friend-input').value.trim();
      if (!username) return;
      sendFriendRequestFromInput(username);
      closeModal();
    }},
  ]);
  $('friend-input').focus();
}

$('btn-add-friend')?.addEventListener('click', openAddFriendModal);
$('btn-friends-nav')?.addEventListener('click', () => openFriendsView(friendsTab === 'add' ? 'online' : friendsTab));
document.querySelector('.friends-tabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-friends-tab]');
  if (!tab) return;
  setFriendsTab(tab.dataset.friendsTab);
});
$('friends-search')?.addEventListener('input', () => renderFriendsMain());
$('friends-add-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  sendFriendRequestFromInput($('friends-add-input').value.trim(), $('friends-add-status'));
  $('friends-add-input').value = '';
});

/* ================= Auth ================= */
$('btn-logout')?.addEventListener('click', doLogout);
function doLogout() {
  voiceManager?.leave();
  closeSettings();
  fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  deleteCookie('muck_access');
  deleteCookie('muck_refresh');
  deleteCookie('muck_token');
  socket?.disconnect();
  currentUser = null;
  location.href = '/login';
}

/* ================= DM context menu + profil popup ================= */
const MUTE_OPTIONS = [
  { label: '15 Dakika', ms: 15 * 60 * 1000 },
  { label: '1 Saat', ms: 60 * 60 * 1000 },
  { label: '3 Saat', ms: 3 * 60 * 60 * 1000 },
  { label: '8 Saat', ms: 8 * 60 * 60 * 1000 },
  { label: '24 Saat', ms: 24 * 60 * 60 * 1000 },
  { label: 'Ben tekrar açana kadar', ms: 0 },
];

function formatDateTr(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

function isFriendMuted(f) {
  if (!f || f.mutedUntil == null) return false;
  if (f.mutedUntil === 0) return true;
  return Date.now() < f.mutedUntil;
}

function closeCtxMenu() {
  const menu = $('ctx-menu');
  if (!menu) return;
  menu.classList.add('hidden');
  menu.innerHTML = '';
  menu.style.left = '';
  menu.style.top = '';
}

function placeCtxMenu(el, x, y) {
  el.classList.remove('hidden');
  const pad = 8;
  const rect = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
  if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function ctxItem({ label, sub, danger, disabled, right, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-item' + (danger ? ' danger' : '') + (sub ? ' ctx-item--stacked' : '');
  btn.disabled = !!disabled;
  btn.innerHTML = `
    <span class="ctx-item-text">
      <span class="ctx-item-label">${escapeHtml(label)}</span>
      ${sub ? `<span class="ctx-item-sub">${escapeHtml(sub)}</span>` : ''}
    </span>
    ${right ? `<span class="ctx-right">${escapeHtml(right)}</span>` : ''}`;
  if (onClick && !disabled) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
  }
  return btn;
}

function ctxSep() {
  const d = document.createElement('div');
  d.className = 'ctx-sep';
  return d;
}

function openSubmenu(anchorBtn, build) {
  document.querySelectorAll('.ctx-sub').forEach((n) => n.remove());
  const sub = document.createElement('div');
  sub.className = 'ctx-sub';
  build(sub);
  $('ctx-menu').appendChild(sub);
  const r = anchorBtn.getBoundingClientRect();
  const menu = $('ctx-menu').getBoundingClientRect();
  let left = r.right - menu.left + 4;
  let top = r.top - menu.top;
  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
  // Viewport dışına taşarsa sola aç
  requestAnimationFrame(() => {
    const sr = sub.getBoundingClientRect();
    if (sr.right > window.innerWidth - 8) sub.style.left = `${r.left - menu.left - sr.width - 4}px`;
    if (sr.bottom > window.innerHeight - 8) sub.style.top = `${Math.max(0, top - (sr.bottom - window.innerHeight + 8))}px`;
  });
}

function openDmContextMenu(x, y, friend) {
  const menu = $('ctx-menu');
  if (!menu || !friend) return;
  closeCtxMenu();
  const muted = isFriendMuted(friend);

  menu.appendChild(ctxItem({
    label: 'Okunmuş Olarak İşaretle',
    disabled: !friend.unread,
    onClick: () => {
      socket.emit('dm-read', { friendId: friend.id }, () => closeCtxMenu());
    },
  }));
  menu.appendChild(ctxSep());
  menu.appendChild(ctxItem({
    label: friend.pinned ? 'Sabiti Kaldır' : 'Sabitle',
    onClick: () => {
      socket.emit('dm-pin', { friendId: friend.id, pinned: !friend.pinned }, () => closeCtxMenu());
    },
  }));
  menu.appendChild(ctxSep());
  menu.appendChild(ctxItem({
    label: 'Profil',
    onClick: () => { closeCtxMenu(); openUserProfile(friend.id); },
  }));
  menu.appendChild(ctxItem({
    label: 'DM\'yi Kapat',
    onClick: () => {
      socket.emit('dm-close', { friendId: friend.id }, () => {
        closeCtxMenu();
        if (activeDmFriendId === friend.id) {
          activeDmFriendId = null;
          activeDmChannelId = null;
          openFriendsView();
        }
      });
    },
  }));
  menu.appendChild(ctxSep());

  const inviteBtn = ctxItem({ label: 'Sunucuya Davet Et', right: '›' });
  inviteBtn.addEventListener('mouseenter', () => {
    openSubmenu(inviteBtn, (sub) => {
      for (const s of servers) {
        sub.appendChild(ctxItem({
          label: s.name,
          onClick: () => {
            socket.emit('invite-to-server', { serverId: s.id, targetId: friend.id }, (res) => {
              closeCtxMenu();
              if (res?.error) toast(res.error);
              else toast(`${friend.username} sunucuya davet edildi`);
            });
          },
        }));
      }
      if (!servers.length) sub.appendChild(ctxItem({ label: 'Sunucu yok', disabled: true }));
    });
  });
  menu.appendChild(inviteBtn);

  menu.appendChild(ctxItem({
    label: 'Arkadaşı Çıkar',
    onClick: () => {
      closeCtxMenu();
      confirmRemoveFriend(friend);
    },
  }));
  menu.appendChild(ctxItem({
    label: friend.ignored ? 'Yoksaymayı Kaldır' : 'Yok Say',
    onClick: () => {
      socket.emit('user-ignore', { targetId: friend.id, ignored: !friend.ignored }, () => closeCtxMenu());
    },
  }));
  menu.appendChild(ctxItem({
    label: friend.blocked ? 'Engeli kaldır' : 'Engelle',
    danger: !friend.blocked,
    onClick: () => {
      closeCtxMenu();
      if (friend.blocked) {
        socket.emit('user-block', { targetId: friend.id, blocked: false }, () => {
          if (activeDmFriendId === friend.id) openDM(friend.id, false);
        });
        return;
      }
      showModal('Engelle', `<p><strong>${escapeHtml(friend.username)}</strong> engellenecek. Bu kişiden gelen mesajlar gizlenir ve ona mesaj gönderemezsin.</p>`, [
        { label: 'İptal', className: 'btn-secondary', onClick: closeModal },
        {
          label: 'Engelle', className: 'btn-danger', onClick: () => {
            closeModal();
            socket.emit('user-block', { targetId: friend.id, blocked: true }, () => {
              if (activeDmFriendId === friend.id) openDM(friend.id, false);
            });
          },
        },
      ]);
    },
  }));
  menu.appendChild(ctxSep());

  const muteBtn = ctxItem({
    label: muted ? `@${friend.username} susturmayı kaldır` : `@${friend.username} kanalını sustur`,
    right: muted ? '' : '›',
  });
  if (muted) {
    muteBtn.addEventListener('click', () => {
      socket.emit('dm-mute', { friendId: friend.id, until: null }, () => closeCtxMenu());
    });
  } else {
    muteBtn.addEventListener('mouseenter', () => {
      openSubmenu(muteBtn, (sub) => {
        for (const opt of MUTE_OPTIONS) {
          sub.appendChild(ctxItem({
            label: opt.label,
            onClick: () => {
              const until = opt.ms === 0 ? 0 : Date.now() + opt.ms;
              socket.emit('dm-mute', { friendId: friend.id, until }, () => closeCtxMenu());
            },
          }));
        }
      });
    });
  }
  menu.appendChild(muteBtn);

  if (settings.developer) {
    menu.appendChild(ctxSep());
    menu.appendChild(ctxItem({
      label: 'Kullanıcı ID\'sini Kopyala',
      right: 'ID',
      onClick: async () => {
        closeCtxMenu();
        try { await navigator.clipboard.writeText(String(friend.id)); toast('Kullanıcı ID kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    }));
    menu.appendChild(ctxItem({
      label: 'Kanal ID\'sini Kopyala',
      right: 'ID',
      onClick: async () => {
        closeCtxMenu();
        const id = friend.dmChannelId || activeDmChannelId;
        if (!id) { toast('Kanal ID yok'); return; }
        try { await navigator.clipboard.writeText(String(id)); toast('Kanal ID kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    }));
  }

  placeCtxMenu(menu, x, y);
}

function openGroupContextMenu(x, y, group) {
  const menu = $('ctx-menu');
  closeCtxMenu();
  menu.appendChild(ctxItem({
    label: 'Okunmuş Olarak İşaretle',
    disabled: !group.unread,
    onClick: () => socket.emit('group-dm-read', { channelId: group.id }, () => closeCtxMenu()),
  }));
  menu.appendChild(ctxSep());
  menu.appendChild(ctxItem({
    label: group.pinned ? 'Sabiti Kaldır' : 'Sabitle',
    onClick: () => socket.emit('group-dm-pin', { channelId: group.id, pinned: !group.pinned }, () => closeCtxMenu()),
  }));
  menu.appendChild(ctxSep());
  menu.appendChild(ctxItem({
    label: 'Grubu Düzenle',
    onClick: () => {
      closeCtxMenu();
      showModal('Grubu Düzenle',
        `<input class="modal-input" id="group-rename-input" placeholder="Grup adı" value="${escapeHtml(group.name || '')}" maxlength="100" />`,
        [
          { label: 'İptal', className: 'btn-secondary', onClick: closeModal },
          {
            label: 'Kaydet', className: 'btn-primary', onClick: () => {
              const name = $('group-rename-input')?.value || '';
              closeModal();
              socket.emit('update-group-dm', { channelId: group.id, name }, (res) => {
                if (res?.error) toast(res.error);
                else if (res.channel && activeGroupId === group.id) {
                  activeGroupTitle = res.channel.name || res.channel.title;
                  $('dm-title').textContent = activeGroupTitle;
                }
              });
            },
          },
        ]);
    },
  }));
  menu.appendChild(ctxSep());
  const muteBtn = ctxItem({
    label: 'Konuşmayı Sustur',
    right: '›',
  });
  muteBtn.addEventListener('mouseenter', () => {
    openSubmenu(muteBtn, (sub) => {
      for (const opt of MUTE_OPTIONS) {
        sub.appendChild(ctxItem({
          label: opt.label,
          onClick: () => {
            const until = opt.ms === 0 ? 0 : Date.now() + opt.ms;
            socket.emit('group-dm-mute', { channelId: group.id, until }, () => closeCtxMenu());
          },
        }));
      }
      sub.appendChild(ctxItem({
        label: 'Susturmayı Kaldır',
        onClick: () => socket.emit('group-dm-mute', { channelId: group.id, until: null }, () => closeCtxMenu()),
      }));
    });
  });
  menu.appendChild(muteBtn);
  menu.appendChild(ctxSep());
  menu.appendChild(ctxItem({
    label: 'Gruptan Ayrıl',
    danger: true,
    onClick: () => {
      closeCtxMenu();
      showModal('Gruptan ayrıl', '<p>Bu gruptan ayrılmak istediğine emin misin?</p>', [
        { label: 'İptal', className: 'btn-secondary', onClick: closeModal },
        {
          label: 'Ayrıl', className: 'btn-danger', onClick: () => {
            closeModal();
            socket.emit('leave-group-dm', { channelId: group.id }, () => {
              groupDms = groupDms.filter((g) => g.id !== group.id);
              if (activeGroupId === group.id) openFriendsView();
              else renderFriends();
            });
          },
        },
      ]);
    },
  }));
  if (settings.developer) {
    menu.appendChild(ctxSep());
    menu.appendChild(ctxItem({
      label: "Kanal ID'sini Kopyala",
      right: 'ID',
      onClick: async () => {
        closeCtxMenu();
        try { await navigator.clipboard.writeText(String(group.id)); toast('Kanal ID kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    }));
  }
  placeCtxMenu(menu, x, y);
}

function confirmRemoveFriend(friend) {
  showModal('Arkadaşı çıkar', `<p><strong>${escapeHtml(friend.username)}</strong> arkadaşlık listenden çıkarılacak.</p>`, [
    { label: 'İptal', className: 'btn-secondary', onClick: closeModal },
    {
      label: 'Çıkar', className: 'btn-danger', onClick: () => {
        closeModal();
        socket.emit('remove-friend', { friendId: friend.id }, () => {
          friends = friends.filter((f) => f.id !== friend.id);
          if (activeDmFriendId === friend.id) {
            activeDmFriendId = null;
            activeDmChannelId = null;
            openFriendsView();
          } else renderFriends();
          closeUserProfile();
        });
      },
    },
  ]);
}

function openUserProfile(userId) {
  if (!socket) return;
  socket.emit('get-profile', { userId }, (res) => {
    if (res?.error) { toast(res.error); return; }
    profileTarget = res;
    profileMutualTab = 'friends';
    renderProfileModal();
    $('profile-overlay')?.classList.remove('hidden');
  });
}

function closeUserProfile() {
  $('profile-overlay')?.classList.add('hidden');
  profileTarget = null;
  closeCtxMenu();
}

function renderProfileModal() {
  const p = profileTarget;
  if (!p?.user) return;
  const u = p.user;
  $('pm-avatar').textContent = initials(u.username);
  $('pm-name').textContent = u.username;
  $('pm-username').textContent = `@${u.username}`;
  $('pm-dot').classList.toggle('on', !!p.online);
  $('pm-member-since').textContent = formatDateTr(u.createdAt);
  const hasFriend = !!p.isFriend;
  $('pm-friend-since-label').classList.toggle('hidden', !hasFriend);
  $('pm-friend-since').classList.toggle('hidden', !hasFriend);
  $('pm-friend-since').textContent = formatDateTr(p.friendSince);
  $('pm-unfriend').classList.toggle('hidden', !hasFriend);
  $('pm-note').value = p.note || '';
  $('pm-tab-friends').textContent = `${p.mutualFriends?.length || 0} Ortak Arkadaş`;
  $('pm-tab-servers').textContent = `${p.mutualServers?.length || 0} Ortak Sunucu`;
  document.querySelectorAll('.profile-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.ptab === profileMutualTab);
  });
  const list = $('pm-mutual-list');
  list.innerHTML = '';
  if (profileMutualTab === 'friends') {
    for (const f of p.mutualFriends || []) {
      const li = document.createElement('li');
      li.innerHTML = userChipHtml(f.username, false, { size: 'sm' });
      list.appendChild(li);
    }
    if (!(p.mutualFriends || []).length) {
      const li = document.createElement('li');
      li.style.color = 'var(--muted)';
      li.textContent = 'Ortak arkadaş yok.';
      list.appendChild(li);
    }
  } else {
    for (const s of p.mutualServers || []) {
      const li = document.createElement('li');
      li.textContent = s.name;
      list.appendChild(li);
    }
    if (!(p.mutualServers || []).length) {
      const li = document.createElement('li');
      li.style.color = 'var(--muted)';
      li.textContent = 'Ortak sunucu yok.';
      list.appendChild(li);
    }
  }
}

function openProfileMoreMenu(btn) {
  const p = profileTarget;
  if (!p?.user) return;
  const menu = $('ctx-menu');
  closeCtxMenu();
  const inviteBtn = ctxItem({ label: 'Sunucuya Davet Et', right: '›' });
  inviteBtn.addEventListener('mouseenter', () => {
    openSubmenu(inviteBtn, (sub) => {
      for (const s of servers) {
        sub.appendChild(ctxItem({
          label: s.name,
          onClick: () => {
            socket.emit('invite-to-server', { serverId: s.id, targetId: p.user.id }, (res) => {
              closeCtxMenu();
              if (res?.error) toast(res.error);
              else toast('Davet gönderildi');
            });
          },
        }));
      }
      if (!servers.length) sub.appendChild(ctxItem({ label: 'Sunucu yok', disabled: true }));
    });
  });
  menu.appendChild(inviteBtn);
  menu.appendChild(ctxSep());
  menu.appendChild(ctxItem({
    label: p.ignored ? 'Yoksaymayı Kaldır' : 'Yok Say',
    onClick: () => {
      socket.emit('user-ignore', { targetId: p.user.id, ignored: !p.ignored }, (res) => {
        closeCtxMenu();
        if (!res?.error) {
          p.ignored = !p.ignored;
        }
      });
    },
  }));
  menu.appendChild(ctxItem({
    label: p.blocked ? 'Engeli kaldır' : 'Engelle',
    danger: !p.blocked,
    onClick: () => {
      closeCtxMenu();
      socket.emit('user-block', { targetId: p.user.id, blocked: !p.blocked }, () => {
        p.blocked = !p.blocked;
        if (activeDmFriendId === p.user.id) openDM(p.user.id, false);
        else renderProfileModal();
      });
    },
  }));
  if (settings.developer) {
    menu.appendChild(ctxSep());
    menu.appendChild(ctxItem({
      label: 'Kullanıcı ID\'sini Kopyala',
      right: 'ID',
      onClick: async () => {
        closeCtxMenu();
        try { await navigator.clipboard.writeText(String(p.user.id)); toast('Kullanıcı ID kopyalandı'); }
        catch { toast('Kopyalanamadı'); }
      },
    }));
  }
  const rect = btn.getBoundingClientRect();
  placeCtxMenu(menu, rect.left, rect.bottom + 4);
}

$('profile-modal-close')?.addEventListener('click', closeUserProfile);
$('profile-overlay')?.addEventListener('click', (e) => {
  if (e.target === $('profile-overlay')) closeUserProfile();
});
$('pm-msg')?.addEventListener('click', () => {
  const id = profileTarget?.user?.id;
  if (!id) return;
  closeUserProfile();
  openDM(id);
});
$('pm-unfriend')?.addEventListener('click', () => {
  const u = profileTarget?.user;
  if (!u) return;
  confirmRemoveFriend(u);
});
$('pm-more')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openProfileMoreMenu(e.currentTarget);
});
document.querySelectorAll('.profile-tab').forEach((t) => {
  t.addEventListener('click', () => {
    profileMutualTab = t.dataset.ptab;
    renderProfileModal();
  });
});
let noteTimer = null;
$('pm-note')?.addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    const id = profileTarget?.user?.id;
    if (!id) return;
    const note = $('pm-note').value;
    socket.emit('friend-note', { friendId: id, note });
    if (profileTarget) profileTarget.note = note;
  }, 400);
});

document.addEventListener('click', () => closeCtxMenu());
$('ctx-menu')?.addEventListener('click', (e) => e.stopPropagation());
$('ctx-menu')?.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCtxMenu();
    if (!$('profile-overlay')?.classList.contains('hidden')) closeUserProfile();
  }
});

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
    if (err.message === 'unauthorized') {
      deleteCookie('muck_access');
      deleteCookie('muck_token');
      hideSplash();
      showAuth();
      return;
    }
    setSplashStatus('Bağlantı yeniden deneniyor…');
  });

  socket.on('connect', () => {
    setSplashStatus('Veriler yükleniyor…');
  });

  socket.on('init', async ({ user, friends: fr, friendRequests: frReq, servers: srv, social: soc, friendsVoice: fv, groupDms: gd }) => {
    setSplashStatus('Arayüz hazırlanıyor…');
    currentUser = user;
    friends = fr || [];
    friendRequests = frReq || { incoming: [], outgoing: [] };
    social = soc || social;
    friendsVoice = fv || {};
    groupDms = gd || [];
    servers = srv;
    $('user-name').textContent = user.username;
    $('user-avatar').textContent = initials(user.username);
    $('user-status-text').textContent = 'Çevrimiçi';
    $('user-status-dot').classList.add('on');
    $('settings-username').textContent = user.username;
    renderRail();
    renderFriends();
    updateFriendsBadge();
    showApp();
    applyRoute();
    // Ağır modüller arayüz açıldıktan sonra
    ensureAppModules().then(() => setupDeferredModules()).catch(() => {});
  });

  socket.on('social-update', ({ social: soc, friends: fr, groupDms: gd }) => {
    if (soc) social = soc;
    if (fr) friends = fr;
    if (gd) groupDms = gd;
    renderFriends();
    if (activeView === 'dm' && activeDmFriendId) {
      renderProfile();
      updateDmComposer();
    }
    if (activeView === 'dm' && activeGroupId) updatePanel();
  });

  socket.on('friend-update', (f) => {
    const idx = friends.findIndex((x) => x.id === f.id);
    if (idx >= 0) friends[idx] = { ...friends[idx], ...f };
    else if (f.username) friends.push(f);
    if (f.online) onlineMembers.add(f.id); else onlineMembers.delete(f.id);
    renderFriends();
    if (activeServer) renderMembers();
    if (activeView === 'dm' && activeDmFriendId === f.id) renderProfile();
  });

  socket.on('friend-requests', (payload) => {
    friendRequests = payload || { incoming: [], outgoing: [] };
    updateFriendsBadge();
    renderFriends();
  });

  socket.on('friend-request-received', ({ user }) => {
    toast(`${user?.username || 'Birisi'} sana arkadaşlık isteği gönderdi`);
  });

  socket.on('message', ({ channelId, message }) => {
    if (channelId === activeChannelId && activeView === 'chat') {
      appendMessage($('chat-messages'), message);
    }
    if (channelId) appendMsgCache('chan', channelId, message);
  });

  socket.on('dm', ({ friendId, username, message, muted, ignored, blocked, channelId, type }) => {
    const isGroupView = type === 'group' || (channelId && activeGroupId === channelId);
    const isDmView = !isGroupView && activeDmFriendId === friendId && activeView === 'dm';
    if (channelId) appendMsgCache('dm', channelId, message);
    if (activeView === 'dm' && (isDmView || (isGroupView && activeGroupId === channelId))) {
      appendResolvedMessage($('dm-messages'), message, (m) => resolveDmMsg(m, friendId));
      if (!blocked) {
        if (isGroupView) socket.emit('group-dm-read', { channelId });
        else socket.emit('dm-read', { friendId });
      }
    } else {
      const localMuted = type === 'group'
        ? (() => {
          const until = social.mutedGroups?.[channelId];
          if (until === undefined || until === null) return false;
          if (until === 0) return true;
          return Date.now() <= until;
        })()
        : (() => {
          const until = social.mutedDms?.[friendId];
          if (until === undefined || until === null) return false;
          if (until === 0) return true;
          return Date.now() <= until;
        })();
      const localIgnored = !!(social.ignored || []).includes(friendId);
      const localBlocked = !!(social.blocked || []).includes(friendId)
        || !!friends.find((f) => f.id === friendId)?.blocked;
      if (!muted && !ignored && !blocked && !localMuted && !localIgnored && !localBlocked) {
        toast(`${username}: yeni mesaj`);
      }
    }
  });

  socket.on('dm-pins-updated', ({ channelId, pins }) => {
    if (channelId === activeDmChannelId) {
      dmPins = pins || [];
      if (dmPanelMode === 'pins') dmFeatures?.renderPins?.(dmPins);
    }
  });

  socket.on('dm-reaction', ({ channelId, messageId, reactions }) => {
    if (channelId !== activeDmChannelId || activeView !== 'dm') return;
    const el = document.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!el) return;
    // Mesajı yeniden çizmek için channel geçmişini tazelemek yerine tepki satırını güncelle
    const body = el.querySelector('.msg-body');
    if (!body) return;
    body.querySelector('.msg-reactions')?.remove();
    const entries = Object.entries(reactions || {}).filter(([, users]) => users?.length);
    if (!entries.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg-reactions';
    wrap.innerHTML = entries.map(([emoji, users]) => {
      const mine = users.includes(currentUser?.id);
      return `<button type="button" class="msg-reaction${mine ? ' mine' : ''}" data-emoji="${escapeHtml(emoji)}">${emoji} <span>${users.length}</span></button>`;
    }).join('');
    wrap.querySelectorAll('.msg-reaction').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('react-dm-message', {
          channelId: activeDmChannelId,
          messageId,
          emoji: btn.dataset.emoji,
        });
      });
    });
    body.appendChild(wrap);
  });

  socket.on('dm-call-update', ({ channelId, participants }) => {
    if (channelId !== activeDmChannelId) return;
    if (dmCallActive) {
      voiceManager?.onPresence?.(participants || []);
      const others = (participants || []).filter((p) => p.userId !== currentUser?.id);
      if (dmCallRinging && others.length) {
        dmCallRinging = false;
        dmFeatures?.setCallRinging?.(false, 'Arama sürüyor');
      }
    }
  });

  socket.on('dm-call-incoming', ({ channelId, fromId, fromUsername, ringMs }) => {
    if (!channelId || fromId === currentUser?.id) return;
    if (dmCallActive || dmCallRinging) return;
    showIncomingDmCall({ channelId, fromId, fromUsername, ringMs });
  });

  socket.on('dm-call-ring-ended', ({ channelId, reason }) => {
    if (dmIncoming?.channelId === channelId) hideIncomingDmCall();
    if (channelId !== activeDmChannelId && !(dmCallActive || dmCallRinging)) return;
    if (reason === 'timeout' || reason === 'reject' || reason === 'cancel' || reason === 'ended') {
      if (dmCallRinging || dmCallActive) {
        const msg = reason === 'timeout' ? 'Arama yanıtlanmadı'
          : reason === 'reject' ? 'Arama reddedildi'
          : reason === 'ended' ? 'Arama sona erdi'
          : 'Arama iptal edildi';
        cleanupDmCallUi();
        toast(msg);
      }
    } else if (reason === 'accepted') {
      dmCallRinging = false;
      dmFeatures?.setCallRinging?.(false, 'Arama sürüyor');
      if ($('voice-conn-title')) $('voice-conn-title').textContent = 'Ses Bağlantısı Kuruldu';
    }
  });

  socket.on('dm-call-alone-timeout', ({ channelId }) => {
    if (channelId && channelId !== activeDmChannelId && !dmCallActive) return;
    cleanupDmCallUi();
    toast('2 dakika yalnız kaldığın için aramadan ayrıldın');
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

  socket.on('server-invited', ({ server }) => {
    if (!servers.find((s) => s.id === server.id)) servers.push(server);
    renderRail();
    toast(`${server.name} sunucusuna eklendin`);
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
  socket.on('friends-voice', ({ activities }) => {
    friendsVoice = activities || {};
    if (activeView === 'friends') renderActiveNow();
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
$('toggle-developer')?.addEventListener('change', (e) => saveSetting('developer', 'muck_developer', e.target.checked));

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

/* Varsayılan sağ tık kapalı; özel menülü yerlerde biz açarız */
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-allow-menu]')) return;
  e.preventDefault();
});

/* ================= DM call + toolbar ================= */
function dmCallPeerName() {
  return activeGroupTitle || friends.find((f) => f.id === activeDmFriendId)?.username || 'DM';
}

function syncDmCallControls() {
  if (!voiceManager) return;
  $('dm-call-mic')?.classList.toggle('off', voiceManager.isMuted());
  $('dm-call-deafen')?.classList.toggle('off', voiceManager.isDeafened());
  $('dm-call-cam')?.classList.toggle('off', !voiceManager.isCameraOn());
  $('dm-call-cam')?.classList.toggle('on', voiceManager.isCameraOn());
  $('dm-call-screen')?.classList.toggle('on', voiceManager.isScreenOn());
  $('vc-mic')?.classList.toggle('off', voiceManager.isMuted());
  $('vc-deafen')?.classList.toggle('off', voiceManager.isDeafened());
  $('vc-cam')?.classList.toggle('on', voiceManager.isCameraOn());
  $('vc-screen')?.classList.toggle('on', voiceManager.isScreenOn());
}

async function ensureVoiceManagerForDm() {
  if (voiceManager) return voiceManager;
  await ensureAppModules();
  if (!createVoiceManager) return null;
  voiceManager = createVoiceManager({
    socket,
    username: currentUser?.username,
    onUpdate: (state) => {
      if (dmCallActive || dmCallRinging) paintVoiceGrid(state);
      syncDmCallControls();
    },
    onSpeaking: (flags) => {
      lastSpeakingFlags = flags || {};
      applySpeakingUi(lastSpeakingFlags);
    },
  });
  return voiceManager;
}

function cleanupDmCallUi() {
  const hadManager = !!voiceManager && (dmCallActive || dmCallRinging);
  dmCallActive = false;
  dmCallRinging = false;
  maximizedTile = null;
  lastVoiceState = null;
  lastSpeakingFlags = {};
  const grid = $('dm-voice-grid');
  if (grid) grid.innerHTML = '';
  dmFeatures?.showCallStage?.(false);
  dmFeatures?.setCallRinging?.(false);
  hideVoiceFooter();
  hideIncomingDmCall();
  if (hadManager) {
    voiceManager?.leave();
    voiceManager = null;
  }
}

function showIncomingDmCall({ channelId, fromId, fromUsername, ringMs }) {
  dmIncoming = { channelId, fromId, fromUsername };
  const overlay = $('dm-incoming-overlay');
  if (!overlay) return;
  $('dm-incoming-name').textContent = fromUsername || 'Birisi';
  $('dm-incoming-avatar').textContent = initials(fromUsername || '?');
  $('dm-incoming-sub').textContent = 'Gelen arama · 20 sn';
  overlay.classList.remove('hidden');
  clearTimeout(showIncomingDmCall._t);
  showIncomingDmCall._t = setTimeout(() => {
    if (dmIncoming?.channelId === channelId) hideIncomingDmCall();
  }, Math.min(ringMs || 20000, 21000));
}

function hideIncomingDmCall() {
  clearTimeout(showIncomingDmCall._t);
  dmIncoming = null;
  $('dm-incoming-overlay')?.classList.add('hidden');
}

async function enterDmCallMedia({ ringing = false } = {}) {
  if (!activeDmChannelId) return;
  if (voiceManager && !dmCallActive && !dmCallRinging) {
    voiceManager.leave();
    voiceManager = null;
  }
  await ensureVoiceManagerForDm();

  // join() onUpdate tetikler — bayraklar ve sahne ÖNCE açık olmalı, yoksa ızgara boş kalır
  dmCallActive = true;
  dmCallRinging = !!ringing;
  const name = dmCallPeerName();
  dmFeatures?.updateCallStage?.(name);
  dmFeatures?.showCallStage?.(true);
  dmFeatures?.setCallRinging?.(!!ringing, ringing ? 'Aranıyor…' : 'Arama sürüyor');
  showVoiceFooter(name);
  if ($('voice-conn-title')) {
    $('voice-conn-title').textContent = ringing ? 'Aranıyor…' : 'Ses Bağlantısı Kuruldu';
  }
  paintVoiceGrid(emptyVoiceState());

  return new Promise((resolve) => {
    socket.emit('join-dm-call', { channelId: activeDmChannelId }, async (res) => {
      if (res?.error) {
        toast(res.error);
        cleanupDmCallUi();
        resolve(false);
        return;
      }
      try {
        await voiceManager.join(activeDmChannelId, res.participants || []);
        if (voiceManager.isCameraOn()) {
          try { await voiceManager.toggleCamera(); } catch {}
        }
        syncDmCallControls();
        $('dm-call-cam')?.classList.add('off');
        paintVoiceGrid(lastVoiceState || emptyVoiceState());
        resolve(true);
      } catch (err) {
        toast(err?.message || 'Arama başlatılamadı');
        cleanupDmCallUi();
        resolve(false);
      }
    });
  });
}

async function startDmCall() {
  if (!activeDmChannelId) { toast('Önce bir DM aç.'); return; }
  if (dmCallActive || dmCallRinging) return;
  if (dmIncoming?.channelId === activeDmChannelId) {
    await acceptIncomingDmCall();
    return;
  }

  socket.emit('dm-call-ring', { channelId: activeDmChannelId }, async (res) => {
    if (res?.error) { toast(res.error); return; }
    if (res.joinDirect) {
      await enterDmCallMedia({ ringing: false });
      return;
    }
    await enterDmCallMedia({ ringing: true });
  });
}

function endDmCall() {
  const channelId = activeDmChannelId;
  if (dmCallRinging && channelId) {
    socket.emit('dm-call-cancel', { channelId });
  }
  if (!dmCallActive && !dmCallRinging && !voiceManager) {
    dmFeatures?.showCallStage?.(false);
    hideIncomingDmCall();
    return;
  }
  cleanupDmCallUi();
}

async function acceptIncomingDmCall() {
  const incoming = dmIncoming;
  if (!incoming?.channelId) return;
  hideIncomingDmCall();
  const channelId = incoming.channelId;
  if (activeDmChannelId !== channelId) {
    activeDmChannelId = channelId;
    openDMByChannel(channelId, true);
    await new Promise((r) => setTimeout(r, 120));
  }
  await enterDmCallMedia({ ringing: false });
}

function rejectIncomingDmCall() {
  const channelId = dmIncoming?.channelId;
  hideIncomingDmCall();
  if (channelId) socket.emit('dm-call-reject', { channelId });
}

function toggleDmMic() { voiceManager?.toggleMic(); }
function toggleDmDeafen() { voiceManager?.toggleDeafen(); }
function toggleDmCam() { voiceManager?.toggleCamera(); }
function toggleDmScreen() { voiceManager?.toggleScreen(); }

$('dm-incoming-accept')?.addEventListener('click', () => acceptIncomingDmCall());
$('dm-incoming-reject')?.addEventListener('click', () => rejectIncomingDmCall());

function setupDeferredModules() {
  if (!initDmFeatures || dmFeatures) return;
  dmFeatures = initDmFeatures({
    $, toast, escapeHtml, initials, formatTime, userChipHtml,
    getSocket: () => socket,
    getState: () => ({
      friends, settings, activeDmFriendId, activeDmChannelId, activeGroupId, activeGroupTitle,
      dmProfileOpen, dmPins,
      activeDmFriendName: friends.find((f) => f.id === activeDmFriendId)?.username,
    }),
    setState: (patch) => {
      if ('dmProfileOpen' in patch) dmProfileOpen = patch.dmProfileOpen;
      if ('dmPins' in patch) dmPins = patch.dmPins;
      if ('dmPanelMode' in patch) dmPanelMode = patch.dmPanelMode;
    },
    openGroupChannel,
    openDM,
    startDmCall,
    endDmCall,
    toggleDmMic,
    toggleDmDeafen,
    toggleDmCam,
    toggleDmScreen,
    updatePanel,
    closeCtxMenu,
    placeCtxMenu,
    ctxItem,
    ctxSep,
    showModal,
    closeModal,
    markReply: (draft) => { dmReply = draft; },
  });
}

/* ================= PWA ================= */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.catch(() => {});
}

/* ================= Boot ================= */
(async function boot() {
  startSplashTips();
  loadSettings();
  applySettings();
  const token = accessToken();
  if (!token) {
    hideSplash();
    showAuth();
    return;
  }
  setSplashStatus('Oturum doğrulanıyor…');
  // /api/me turunu atla — socket auth + init tek seferde yeter
  connectSocket(token);
  setSplashStatus('Sunucuya bağlanılıyor…');
  // Bağlantı takılırsa kullanıcıyı bilgilendir
  setTimeout(() => {
    if ($('splash') && !$('splash').classList.contains('splash-hide') && !$('app')?.classList.contains('hidden') === false) {
      /* app still hidden */
    }
    if ($('app')?.classList.contains('hidden') && !$('splash')?.classList.contains('hidden')) {
      setSplashStatus('Bağlantı bekleniyor…');
    }
  }, 4000);
})();
