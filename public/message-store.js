/**
 * Discord-style message store
 * - Last 30 messages per channel in memory + localStorage
 * - Friend ↔ DM channel link
 * - Profiles cache (lightweight)
 * - No splash-blocking full sync
 */

export const CACHE_MSG_LIMIT = 30;
export const PAGE_SIZE = 30;

let userId = null;
const memMsgs = { dm: new Map(), chan: new Map() };
const memProfiles = new Map();
const openSeq = { dm: 0, chan: 0 };

function uidKey() {
  return userId || (typeof localStorage !== 'undefined' && localStorage.getItem('muck_cache_uid')) || 'anon';
}

function msgKey(kind, channelId) {
  return `muck_msg_v3_${uidKey()}_${kind}_${channelId}`;
}

function friendDmKey(friendId) {
  return `muck_msg_v3_${uidKey()}_friend_${friendId}`;
}

function profileKey(targetId) {
  return `muck_msg_v3_${uidKey()}_profile_${targetId}`;
}

function indexKey() {
  return `muck_msg_v3_${uidKey()}_index`;
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

export function sortMsgs(list) {
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
    count: sorted.length,
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

export function setUser(id) {
  userId = id || null;
  if (id) {
    try { localStorage.setItem('muck_cache_uid', String(id)); } catch {}
  }
}

export function nextOpenSeq(kind) {
  openSeq[kind] = (openSeq[kind] || 0) + 1;
  return openSeq[kind];
}

export function isOpenSeqCurrent(kind, seq) {
  return openSeq[kind] === seq;
}

export function linkFriendChannel(friendId, channelId) {
  if (!friendId || !channelId) return;
  writeJson(friendDmKey(friendId), { channelId: String(channelId), updatedAt: Date.now() });
}

export function getChannelForFriend(friendId) {
  if (!friendId) return null;
  return readJson(friendDmKey(friendId))?.channelId || null;
}

export function hydrate(preloadUserId = null) {
  if (preloadUserId) userId = preloadUserId;
  else userId = (typeof localStorage !== 'undefined' && localStorage.getItem('muck_cache_uid')) || null;
  if (!userId) return { dm: 0, chan: 0, profiles: 0 };

  memMsgs.dm.clear();
  memMsgs.chan.clear();
  memProfiles.clear();

  const idx = readIndex();
  for (const id of idx.dm || []) {
    const data = readJson(msgKey('dm', id));
    if (data?.messages?.length) memMsgs.dm.set(String(id), data);
  }
  for (const id of idx.chan || []) {
    const data = readJson(msgKey('chan', id));
    if (data?.messages?.length) memMsgs.chan.set(String(id), data);
  }
  for (const id of idx.profiles || []) {
    const data = readJson(profileKey(id));
    if (data?.data) memProfiles.set(String(id), data);
  }
  return { dm: memMsgs.dm.size, chan: memMsgs.chan.size, profiles: memProfiles.size };
}

export function getCached(kind, channelId) {
  if (!channelId) return null;
  const id = String(channelId);
  const mem = kind === 'dm' ? memMsgs.dm : memMsgs.chan;
  if (mem.has(id)) return mem.get(id);
  const data = readJson(msgKey(kind, id));
  if (data) mem.set(id, data);
  return data;
}

export function resolveDmCache(friendId, channelId) {
  const cid = channelId || getChannelForFriend(friendId);
  if (!cid) return { channelId: null, cached: null };
  return { channelId: String(cid), cached: getCached('dm', cid) };
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
  if (kind === 'dm' && friendId) linkFriendChannel(friendId, id);
  return entry;
}

/** Merge server page into cache; keep only last 30. Returns merged list (full for render of latest page). */
export function applyServerPage(kind, channelId, serverMsgs, hasMore, { friendId = null } = {}) {
  const cached = getCached(kind, channelId);
  const merged = mergeLists(cached?.messages, serverMsgs);
  // For open: render the server page (latest), but cache only last 30 of merge
  const forRender = sortMsgs(serverMsgs || []);
  saveMessages(kind, channelId, merged, hasMore, { friendId });
  return { messages: forRender.length ? forRender : trimMsgs(merged), hasMore: hasMore !== false, cached };
}

export function appendLive(kind, channelId, msg, { friendId = null } = {}) {
  if (!channelId || !msg?.id || String(msg.id).startsWith('local_')) return null;
  const cur = getCached(kind, channelId);
  const list = cur?.messages || [];
  const id = String(msg.id);
  if (list.some((m) => String(m.id) === id)) {
    return saveMessages(
      kind,
      channelId,
      list.map((m) => (String(m.id) === id ? { ...m, ...msg } : m)),
      cur?.hasMore,
      { friendId }
    );
  }
  return saveMessages(kind, channelId, [...list, msg], cur?.hasMore !== false, { friendId });
}

export function patchMessage(kind, channelId, messageId, patch) {
  const cur = getCached(kind, channelId);
  if (!cur?.messages?.length) return;
  saveMessages(
    kind,
    channelId,
    cur.messages.map((m) => (String(m.id) === String(messageId) ? { ...m, ...patch } : m)),
    cur.hasMore
  );
}

export function removeMessage(kind, channelId, messageId) {
  const cur = getCached(kind, channelId);
  if (!cur?.messages?.length) return;
  saveMessages(
    kind,
    channelId,
    cur.messages.filter((m) => String(m.id) !== String(messageId)),
    cur.hasMore
  );
}

export function mergeLists(a, b) {
  const byId = new Map();
  for (const m of a || []) if (m?.id) byId.set(String(m.id), m);
  for (const m of b || []) {
    if (!m?.id) continue;
    const id = String(m.id);
    byId.set(id, byId.has(id) ? { ...byId.get(id), ...m } : m);
  }
  return sortMsgs([...byId.values()]);
}

/** True if both lists end with the same message (no DOM flash needed). */
export function sameTail(a, b) {
  const ta = tailMeta(a || []);
  const tb = tailMeta(b || []);
  if (!ta.lastId && !tb.lastId) return true;
  return ta.lastId === tb.lastId && ta.lastTs === tb.lastTs;
}

export function messageIdsEqual(a, b) {
  const aa = (a || []).map((m) => String(m.id));
  const bb = (b || []).map((m) => String(m.id));
  if (aa.length !== bb.length) return false;
  return aa.every((id, i) => id === bb[i]);
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

export function purgeLegacy() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k?.startsWith('muck_msgs_')
        || k?.startsWith('muck_lastread_')
        || k?.startsWith('muck_cache_v2_')
      ) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {}
}
