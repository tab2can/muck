import { createVoiceManager } from './voice.js';

const $ = (id) => document.getElementById(id);
const THEME_COLORS = { dark: '#0f1117', black: '#000000', light: '#f3f5f9' };

// State
let socket = null;
let currentUser = null;
let friends = [];
let friendRequests = { incoming: [], outgoing: [] };
let friendsTab = 'online'; // online | all | pending | add
let social = { pinnedDms: [], closedDms: [], mutedDms: {}, ignored: [], blocked: [], unreadDms: {}, friendSince: {}, notes: {} };
let profileTarget = null;
let profileMutualTab = 'friends';
let servers = [];
let activeServer = null; // full server object from get-server
let activeView = 'friends'; // friends | empty | chat | dm | voice | settings
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
function showApp() { $('auth-view').classList.add('hidden'); $('app').classList.remove('hidden'); }
function showAuth() { $('auth-view').classList.remove('hidden'); $('app').classList.add('hidden'); }

function setMainView(view) {
  activeView = view;
  ['view-friends', 'view-empty', 'view-chat', 'view-dm', 'view-voice'].forEach((id) => $(id).classList.add('hidden'));
  if (view === 'empty') $('view-empty').classList.remove('hidden');
  else $(`view-${view}`)?.classList.remove('hidden');
  $('btn-friends-nav')?.classList.toggle('active', view === 'friends' && !activeDmFriendId);
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

function renderFriends() {
  // Sidebar: Direkt Mesajlar
  const list = $('dm-list');
  if (!list) return;
  list.innerHTML = '';
  const visible = [...friends].filter((f) => !f.closed && !f.blocked);
  visible.sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.lastMessageAt || 0) - (a.lastMessageAt || 0) || a.username.localeCompare(b.username);
  });
  for (const f of visible) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const unread = !!f.unread;
    btn.className = 'sidebar-item sidebar-item--user'
      + (activeDmFriendId === f.id ? ' active' : '')
      + (unread ? ' unread' : '')
      + (f.pinned ? ' pinned' : '');
    btn.dataset.allowMenu = '1';
    btn.dataset.friendId = f.id;
    btn.innerHTML = userChipHtml(f.username, !!f.online, { size: 'sm' });
    btn.addEventListener('click', () => openDM(f.id));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDmContextMenu(e.clientX, e.clientY, f);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  $('dm-empty')?.classList.toggle('hidden', visible.length > 0);
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
    label.textContent = `Bekleyen — ${pendingCount() + (friendRequests.outgoing?.length || 0)}`;
    for (const r of friendRequests.incoming || []) {
      if (q && !r.user.username.toLowerCase().includes(q)) continue;
      list.appendChild(makePendingRow(r, 'incoming'));
    }
    for (const r of friendRequests.outgoing || []) {
      if (q && !r.user.username.toLowerCase().includes(q)) continue;
      list.appendChild(makePendingRow(r, 'outgoing'));
    }
    empty.classList.toggle('hidden', list.children.length > 0);
    empty.textContent = 'Bekleyen istek yok.';
    return;
  }

  let rows = [...friends];
  if (friendsTab === 'online') rows = rows.filter((f) => f.online);
  if (q) rows = rows.filter((f) => f.username.toLowerCase().includes(q));
  rows.sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));

  label.textContent = friendsTab === 'online'
    ? `Çevrimiçi — ${rows.length}`
    : `Tümü — ${rows.length}`;

  for (const f of rows) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'friend-row';
    btn.innerHTML = `
      ${userChipHtml(f.username, !!f.online, { size: 'md' })}`;
    btn.addEventListener('click', () => openDM(f.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
  empty.classList.toggle('hidden', rows.length > 0);
  empty.textContent = friendsTab === 'online' ? 'Çevrimiçi arkadaş yok.' : 'Henüz arkadaşın yok.';
}

function makePendingRow(r, kind) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'friend-row';
  row.style.cursor = 'default';
  row.innerHTML = `
    ${userChipHtml(r.user.username, false, {
      subtitle: kind === 'incoming' ? 'Gelen istek' : 'Giden istek',
      size: 'md',
    })}
    <span class="friend-row-actions"></span>`;
  const actions = row.querySelector('.friend-row-actions');
  if (kind === 'incoming') {
    const accept = document.createElement('button');
    accept.className = 'friend-action accept';
    accept.textContent = 'Kabul';
    accept.addEventListener('click', () => {
      socket.emit('friend-accept', { requestId: r.id }, (res) => {
        if (res.error) { toast(res.error); return; }
        if (res.friend) {
          const idx = friends.findIndex((f) => f.id === res.friend.id);
          if (idx >= 0) friends[idx] = res.friend; else friends.push(res.friend);
        }
        toast(`${r.user.username} arkadaş eklendi`);
        renderFriends();
      });
    });
    const decline = document.createElement('button');
    decline.className = 'friend-action decline';
    decline.textContent = 'Reddet';
    decline.addEventListener('click', () => {
      socket.emit('friend-decline', { requestId: r.id }, (res) => {
        if (res.error) { toast(res.error); return; }
        toast('İstek reddedildi');
      });
    });
    actions.append(accept, decline);
  } else {
    const cancel = document.createElement('button');
    cancel.className = 'friend-action decline';
    cancel.textContent = 'İptal';
    cancel.addEventListener('click', () => {
      socket.emit('friend-decline', { requestId: r.id }, (res) => {
        if (res.error) { toast(res.error); return; }
        toast('İstek iptal edildi');
      });
    });
    actions.append(cancel);
  }
  li.appendChild(row);
  return li;
}

function openFriendsView(tab = friendsTab, push = true) {
  activeServer = null;
  activeChannelId = null;
  activeDmFriendId = null;
  activeDmChannelId = null;
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
  // Açınca okundu + closed kaldırılır (server emitSocial)
  friend.unread = false;
  friend.closed = false;
  showSidebarHome();
  setRailActive('home');
  $('dm-title').textContent = `@ ${friend.username}`;
  $('dm-messages').innerHTML = '';
  setMainView('dm');
  renderFriends();
  socket.emit('open-dm', { friendId }, (res) => {
    if (res.error) { toast(res.error); return; }
    activeDmChannelId = res.dmChannelId;
    if (res.social) social = res.social;
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

let lastSpeakingFlags = {};
function applySpeakingUi(flags) {
  const grid = $('voice-grid');
  if (!grid) return;
  for (const tile of grid.querySelectorAll('.voice-tile')) {
    if (tile.classList.contains('voice-tile--screen')) {
      tile.classList.remove('speaking');
      continue;
    }
    tile.classList.toggle('speaking', !!flags[tile.dataset.key]);
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
$('vc-leave').addEventListener('click', () => leaveVoiceChannel());
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

function ctxItem({ label, danger, disabled, right, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-item' + (danger ? ' danger' : '');
  btn.disabled = !!disabled;
  btn.innerHTML = `<span>${escapeHtml(label)}</span>${right ? `<span class="ctx-right">${escapeHtml(right)}</span>` : ''}`;
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
    label: friend.blocked ? 'Engeli Kaldır' : 'Engelle',
    danger: true,
    onClick: () => {
      closeCtxMenu();
      if (friend.blocked) {
        socket.emit('user-block', { targetId: friend.id, blocked: false });
        return;
      }
      showModal('Engelle', `<p><strong>${escapeHtml(friend.username)}</strong> engellenecek. Arkadaşlıktan çıkarılır ve mesajlaşamazsınız.</p>`, [
        { label: 'İptal', className: 'btn-secondary', onClick: closeModal },
        {
          label: 'Engelle', className: 'btn-danger', onClick: () => {
            closeModal();
            socket.emit('user-block', { targetId: friend.id, blocked: true }, () => {
              if (activeDmFriendId === friend.id) openFriendsView();
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
    label: p.blocked ? 'Engeli Kaldır' : 'Engelle',
    danger: true,
    onClick: () => {
      closeCtxMenu();
      socket.emit('user-block', { targetId: p.user.id, blocked: !p.blocked }, () => {
        closeUserProfile();
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
    if (err.message === 'unauthorized') { deleteCookie('muck_token'); showAuth(); }
  });

  socket.on('init', ({ user, friends: fr, friendRequests: frReq, servers: srv, social: soc }) => {
    currentUser = user;
    friends = fr || [];
    friendRequests = frReq || { incoming: [], outgoing: [] };
    social = soc || social;
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
  });

  socket.on('social-update', ({ social: soc, friends: fr }) => {
    if (soc) social = soc;
    if (fr) friends = fr;
    renderFriends();
    if (activeView === 'dm' && activeDmFriendId) renderProfile();
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
  });

  socket.on('dm', ({ friendId, username, message, muted, ignored }) => {
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
      socket.emit('dm-read', { friendId });
    } else if (!muted && !ignored) {
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
