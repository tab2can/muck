/** Yerel önbellek — son 30 mesaj / profil (localStorage; HTTP çerezi boyutu yetmez) */
export const CACHE_MSG_LIMIT = 30;
export const HISTORY_CHUNK = 30;
/** 15., 45., 75. mesaj görününce (0-based: 14, 44, 74…) */
export const HISTORY_TRIGGER_INDEX = 14;

let userId = null;
/** Bellek: hızlı erişim — splash'ta localStorage'dan doldurulur */
const memMsgs = { dm: new Map(), chan: new Map() };
const memProfiles = new Map();

function uidKey() {
  return userId || localStorage.getItem('muck_cache_uid') || 'anon';
}

function msgKey(kind, channelId) {
  return `muck_cache_v2_${uidKey()}_msg_${kind}_${channelId}`;
}

function profileKey(targetId) {
  return `muck_cache_v2_${uidKey()}_profile_${targetId}`;
}

function indexKey() {
  return `muck_cache_v2_${uidKey()}_index`;
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* quota */
  }
}

function sortMsgs(list) {
  return (list || []).slice().sort((a, b) => {
    const ta = Number(a.ts || 0);
    const tb = Number(b.ts || 0);
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function trimMsgs(messages) {
  return sortMsgs(messages)
    .filter((m) => m?.id && !String(m.id).startsWith('local_'))
    .slice(-CACHE_MSG_LIMIT);
}

function tailMeta(messages) {
  const sorted = sortMsgs(messages);
  const last = sorted[sorted.length - 1];
  return {
    lastId: last?.id ? String(last.id) : null,
    lastTs: Number(last?.ts || 0),
  };
}

function readIndex() {
  return readJson(indexKey()) || { dm: [], chan: [], profiles: [] };
}

function writeIndex(index) {
  writeJson(indexKey(), index);
}

function trackChannel(kind, channelId) {
  if (!channelId) return;
  const idx = readIndex();
  const list = kind === 'dm' ? idx.dm : idx.chan;
  const id = String(channelId);
  if (!list.includes(id)) {
    list.push(id);
    writeIndex(idx);
  }
}

function trackProfile(targetId) {
  if (!targetId) return;
  const idx = readIndex();
  const id = String(targetId);
  if (!idx.profiles.includes(id)) {
    idx.profiles.push(id);
    writeIndex(idx);
  }
}

export function setCacheUser(id) {
  userId = id || null;
  if (id) {
    try { localStorage.setItem('muck_cache_uid', String(id)); } catch {}
  }
}

/** Splash — oturum açılmadan önce (son bilinen kullanıcı) */
export function hydrateFromStorage(preloadUserId = null) {
  if (preloadUserId) userId = preloadUserId;
  else userId = localStorage.getItem('muck_cache_uid') || null;
  if (!userId) return { dm: 0, chan: 0, profiles: 0 };

  memMsgs.dm.clear();
  memMsgs.chan.clear();
  memProfiles.clear();

  const idx = readIndex();
  for (const id of idx.dm || []) {
    const data = readJson(msgKey('dm', id));
    if (data?.messages?.length) memMsgs.dm.set(id, data);
  }
  for (const id of idx.chan || []) {
    const data = readJson(msgKey('chan', id));
    if (data?.messages?.length) memMsgs.chan.set(id, data);
  }
  for (const id of idx.profiles || []) {
    const data = readJson(profileKey(id));
    if (data?.data) memProfiles.set(id, data);
  }
  return {
    dm: memMsgs.dm.size,
    chan: memMsgs.chan.size,
    profiles: memProfiles.size,
  };
}

export function getCachedMessages(kind, channelId) {
  const id = String(channelId);
  const mem = kind === 'dm' ? memMsgs.dm : memMsgs.chan;
  if (mem.has(id)) return mem.get(id);
  const data = readJson(msgKey(kind, id));
  if (data) mem.set(id, data);
  return data;
}

export function saveMessages(kind, channelId, messages, hasMore = true) {
  if (!channelId) return null;
  const trimmed = trimMsgs(messages);
  const meta = tailMeta(trimmed);
  const entry = {
    messages: trimmed,
    hasMore: hasMore !== false,
    ...meta,
    updatedAt: Date.now(),
  };
  const id = String(channelId);
  (kind === 'dm' ? memMsgs.dm : memMsgs.chan).set(id, entry);
  writeJson(msgKey(kind, id), entry);
  trackChannel(kind, id);
  return entry;
}

export function appendMessage(kind, channelId, msg) {
  if (!channelId || !msg?.id || String(msg.id).startsWith('local_')) return;
  const cur = getCachedMessages(kind, channelId);
  const list = cur?.messages || [];
  const id = String(msg.id);
  if (list.some((m) => String(m.id) === id)) {
    return saveMessages(kind, channelId, list.map((m) => (String(m.id) === id ? { ...m, ...msg } : m)), cur?.hasMore);
  }
  return saveMessages(kind, channelId, [...list, msg], cur?.hasMore !== false);
}

export function patchMessage(kind, channelId, messageId, patch) {
  const cur = getCachedMessages(kind, channelId);
  if (!cur?.messages?.length) return;
  saveMessages(
    kind,
    channelId,
    cur.messages.map((m) => (String(m.id) === String(messageId) ? { ...m, ...patch } : m)),
    cur.hasMore
  );
}

export function removeMessage(kind, channelId, messageId) {
  const cur = getCachedMessages(kind, channelId);
  if (!cur?.messages?.length) return;
  saveMessages(
    kind,
    channelId,
    cur.messages.filter((m) => String(m.id) !== String(messageId)),
    cur.hasMore
  );
}

export function mergeMessageLists(cachedMsgs, serverMsgs) {
  const byId = new Map();
  for (const m of cachedMsgs || []) byId.set(String(m.id), m);
  for (const m of serverMsgs || []) {
    const id = String(m.id);
    byId.set(id, byId.has(id) ? { ...byId.get(id), ...m } : m);
  }
  return sortMsgs([...byId.values()]);
}

/** Sunucu snapshot cache'ten farklı mı */
export function messagesNeedSync(cached, serverMsgs) {
  if (!serverMsgs?.length) return false;
  if (!cached?.messages?.length) return true;
  const serverTail = tailMeta(serverMsgs);
  if (cached.lastId && serverTail.lastId && cached.lastId !== serverTail.lastId) return true;
  if (cached.lastTs && serverTail.lastTs && serverTail.lastTs > cached.lastTs) return true;
  if (serverMsgs.length !== cached.messages.length) return true;
  return false;
}

export function sameMessageTail(a, b) {
  const ta = tailMeta(a || []);
  const tb = tailMeta(b || []);
  return ta.lastId === tb.lastId && ta.lastTs === tb.lastTs;
}

export function getCachedProfile(targetId) {
  const id = String(targetId);
  if (memProfiles.has(id)) return memProfiles.get(id)?.data || null;
  const data = readJson(profileKey(id));
  if (data) memProfiles.set(id, data);
  return data?.data || null;
}

export function saveProfile(targetId, profileData) {
  if (!targetId || !profileData) return;
  const id = String(targetId);
  const entry = { data: profileData, updatedAt: Date.now() };
  memProfiles.set(id, entry);
  writeJson(profileKey(id), entry);
  trackProfile(id);
}

export function hydrateProfilesTo(targetObj) {
  for (const [id, entry] of memProfiles) {
    if (entry?.data) targetObj[id] = entry.data;
  }
}

export function listCachedChannels() {
  const idx = readIndex();
  return [
    ...(idx.dm || []).map((id) => ({ kind: 'dm', id })),
    ...(idx.chan || []).map((id) => ({ kind: 'chan', id })),
  ];
}

/** Init sonrası — arka planda sunucu ile karşılaştır */
export function syncAllWithServer(socket) {
  if (!socket?.connected) return;
  const channels = listCachedChannels();
  for (const { kind, id } of channels) {
    if (kind === 'dm') {
      socket.emit('load-dm-messages', { channelId: id }, (res) => {
        if (res?.error || !res?.messages) return;
        const cached = getCachedMessages('dm', id);
        if (messagesNeedSync(cached, res.messages)) {
          const merged = mergeMessageLists(cached?.messages, res.messages);
          saveMessages('dm', id, merged.slice(-CACHE_MSG_LIMIT), res.hasMore);
        }
      });
    } else {
      socket.emit('load-messages', { channelId: id }, (res) => {
        if (res?.error || !res?.messages) return;
        const cached = getCachedMessages('chan', id);
        if (messagesNeedSync(cached, res.messages)) {
          const merged = mergeMessageLists(cached?.messages, res.messages);
          saveMessages('chan', id, merged.slice(-CACHE_MSG_LIMIT), res.hasMore);
        }
      });
    }
  }
  const idx = readIndex();
  for (const pid of idx.profiles || []) {
    socket.emit('get-profile', { userId: pid }, (res) => {
      if (res?.error) return;
      const prev = getCachedProfile(pid);
      const prevTs = prev?.user?.updatedAt || prev?.user?.createdAt || 0;
      const nextTs = res?.user?.createdAt || 0;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(res) || nextTs !== prevTs) {
        saveProfile(pid, res);
      }
    });
  }
}

export function purgeLegacyCaches() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('muck_msgs_') || k?.startsWith('muck_lastread_')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {}
}
