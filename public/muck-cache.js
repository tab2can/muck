/** Yerel önbellek — son 30 mesaj / profil (localStorage) */
export const CACHE_MSG_LIMIT = 30;
export const HISTORY_CHUNK = 30;
/** 15., 45., 75. mesaj görününce (0-based: 14, 44, 74…) */
export const HISTORY_TRIGGER_INDEX = 14;

let userId = null;
const memMsgs = { dm: new Map(), chan: new Map() };
const memProfiles = new Map();

function uidKey() {
  return userId || localStorage.getItem('muck_cache_uid') || 'anon';
}

function msgKey(kind, channelId) {
  return `muck_cache_v2_${uidKey()}_msg_${kind}_${channelId}`;
}

function friendDmKey(friendId) {
  return `muck_cache_v2_${uidKey()}_friend_dm_${friendId}`;
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

export function linkFriendToDmChannel(friendId, channelId) {
  if (!friendId || !channelId) return;
  writeJson(friendDmKey(friendId), { channelId: String(channelId), updatedAt: Date.now() });
}

export function getDmChannelForFriend(friendId) {
  if (!friendId) return null;
  const link = readJson(friendDmKey(friendId));
  return link?.channelId || null;
}

export function getCachedDmByFriend(friendId) {
  const channelId = getDmChannelForFriend(friendId);
  if (!channelId) return { channelId: null, entry: null };
  return { channelId, entry: getCachedMessages('dm', channelId) };
}

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
  if (!channelId) return null;
  const id = String(channelId);
  const mem = kind === 'dm' ? memMsgs.dm : memMsgs.chan;
  if (mem.has(id)) return mem.get(id);
  const data = readJson(msgKey(kind, id));
  if (data) mem.set(id, data);
  return data;
}

export function saveMessages(kind, channelId, messages, hasMore = true, { friendId = null } = {}) {
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
  if (kind === 'dm' && friendId) linkFriendToDmChannel(friendId, id);
  return entry;
}

export function appendMessage(kind, channelId, msg, { friendId = null } = {}) {
  if (!channelId || !msg?.id || String(msg.id).startsWith('local_')) return;
  const cur = getCachedMessages(kind, channelId);
  const list = cur?.messages || [];
  const id = String(msg.id);
  if (list.some((m) => String(m.id) === id)) {
    return saveMessages(kind, channelId, list.map((m) => (String(m.id) === id ? { ...m, ...msg } : m)), cur?.hasMore, { friendId });
  }
  return saveMessages(kind, channelId, [...list, msg], cur?.hasMore !== false, { friendId });
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

export function messagesNeedSync(cached, serverMsgs) {
  if (!serverMsgs?.length) return false;
  if (!cached?.messages?.length) return true;
  const serverTail = tailMeta(serverMsgs);
  if (cached.lastId && serverTail.lastId && cached.lastId !== serverTail.lastId) return true;
  if (serverTail.lastTs > (cached.lastTs || 0)) return true;
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

function emitOnce(socket, event, payload) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    socket.emit(event, payload, (res) => finish(res || {}));
    setTimeout(() => finish({ error: 'timeout' }), 12000);
  });
}

/**
 * Splash — sunucu ile karşılaştır, güncelle, bitince resolve.
 * Arayüz bu tamamlanmadan açılmamalı.
 */
export function syncAllWithServer(socket, { friends = [], groupDms = [], profileIds = [] } = {}) {
  return new Promise((resolve) => {
    if (!socket?.connected) {
      resolve({ updated: 0, errors: 0 });
      return;
    }

    const channelMap = new Map();
    for (const { kind, id } of listCachedChannels()) {
      channelMap.set(`${kind}:${id}`, { kind, id });
    }
    for (const f of friends) {
      const cid = f?.dmChannelId || getDmChannelForFriend(f?.id);
      if (cid) channelMap.set(`dm:${cid}`, { kind: 'dm', id: String(cid), friendId: f.id });
    }
    for (const g of groupDms || []) {
      if (g?.id) channelMap.set(`dm:${g.id}`, { kind: 'dm', id: String(g.id) });
    }

    const profileSet = new Set(profileIds.map(String));
    for (const f of friends) if (f?.id) profileSet.add(String(f.id));
    readIndex().profiles?.forEach((id) => profileSet.add(String(id)));

    const jobs = [];

    for (const ch of channelMap.values()) {
      jobs.push((async () => {
        const res = ch.kind === 'dm'
          ? await emitOnce(socket, 'load-dm-messages', { channelId: ch.id })
          : await emitOnce(socket, 'load-messages', { channelId: ch.id });
        if (res?.error || !res?.messages) return false;
        const cached = getCachedMessages(ch.kind, ch.id);
        if (messagesNeedSync(cached, res.messages)) {
          const merged = mergeMessageLists(cached?.messages, res.messages);
          saveMessages(ch.kind, ch.id, merged, res.hasMore, { friendId: ch.friendId || null });
          return true;
        }
        return false;
      })());
    }

    for (const pid of profileSet) {
      jobs.push((async () => {
        const res = await emitOnce(socket, 'get-profile', { userId: pid });
        if (res?.error || !res?.user) return false;
        const prev = getCachedProfile(pid);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(res)) {
          saveProfile(pid, res);
          return true;
        }
        return false;
      })());
    }

    const maxWait = setTimeout(() => resolve({ updated: -1, errors: 0 }), 15000);

    Promise.allSettled(jobs).then((results) => {
      clearTimeout(maxWait);
      const updated = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
      resolve({ updated, errors: results.filter((r) => r.status === 'rejected').length });
    });
  });
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
