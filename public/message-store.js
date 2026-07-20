/**
 * Discord-style messaging engine
 *
 * Open: cache → paint bottom → fetch → reconcile once
 * Live: append + persist last 30
 * History: scrollTop near 0 → load older page
 */

export const PAGE = 30;

let userId = null;
const mem = { dm: new Map(), chan: new Map() };
const profiles = new Map();
const seq = { dm: 0, chan: 0 };
const loadingOlder = { dm: false, chan: false };
const hasMore = { dm: new Map(), chan: new Map() };

/* ---------- storage ---------- */

function uid() {
  return userId || localStorage.getItem('muck_uid') || 'anon';
}

function kMsg(kind, id) {
  return `muck_v4_${uid()}_m_${kind}_${id}`;
}
function kFriend(fid) {
  return `muck_v4_${uid()}_f_${fid}`;
}
function kProfile(id) {
  return `muck_v4_${uid()}_p_${id}`;
}
function kIndex() {
  return `muck_v4_${uid()}_idx`;
}

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch { /* quota */ }
}

function sort(list) {
  return (list || []).slice().sort((a, b) => {
    const d = Number(a.ts || 0) - Number(b.ts || 0);
    return d || String(a.id).localeCompare(String(b.id));
  });
}

function tail(list) {
  const s = sort(list);
  const last = s[s.length - 1];
  return { lastId: last?.id != null ? String(last.id) : null, lastTs: Number(last?.ts || 0) };
}

function trim(list) {
  return sort(list).filter((m) => m?.id && !String(m.id).startsWith('local_')).slice(-PAGE);
}

function indexGet() {
  return read(kIndex()) || { dm: [], chan: [], profiles: [] };
}

function indexTrack(kind, channelId) {
  if (!channelId) return;
  const idx = indexGet();
  const arr = kind === 'dm' ? idx.dm : idx.chan;
  const id = String(channelId);
  if (!arr.includes(id)) {
    arr.push(id);
    write(kIndex(), idx);
  }
}

function indexTrackProfile(id) {
  if (!id) return;
  const idx = indexGet();
  const s = String(id);
  if (!idx.profiles.includes(s)) {
    idx.profiles.push(s);
    write(kIndex(), idx);
  }
}

/* ---------- public: user / hydrate ---------- */

export function setUser(id) {
  userId = id || null;
  if (id) try { localStorage.setItem('muck_uid', String(id)); } catch {}
}

export function hydrate(id = null) {
  setUser(id || localStorage.getItem('muck_uid'));
  mem.dm.clear();
  mem.chan.clear();
  profiles.clear();
  if (!userId) return { dm: 0, chan: 0, profiles: 0 };
  const idx = indexGet();
  for (const cid of idx.dm || []) {
    const e = read(kMsg('dm', cid));
    if (e?.messages?.length) mem.dm.set(String(cid), e);
  }
  for (const cid of idx.chan || []) {
    const e = read(kMsg('chan', cid));
    if (e?.messages?.length) mem.chan.set(String(cid), e);
  }
  for (const pid of idx.profiles || []) {
    const e = read(kProfile(pid));
    if (e?.data) profiles.set(String(pid), e);
  }
  return { dm: mem.dm.size, chan: mem.chan.size, profiles: profiles.size };
}

export function purgeLegacy() {
  try {
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k?.startsWith('muck_msgs_')
        || k?.startsWith('muck_lastread_')
        || k?.startsWith('muck_cache_v2_')
        || k?.startsWith('muck_msg_v3_')
        || k?.startsWith('muck_cache_uid')
      ) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  } catch {}
}

/* ---------- cache ---------- */

export function getCached(kind, channelId) {
  if (!channelId) return null;
  const id = String(channelId);
  const map = mem[kind];
  if (map.has(id)) return map.get(id);
  const e = read(kMsg(kind, id));
  if (e) map.set(id, e);
  return e;
}

export function linkFriend(friendId, channelId) {
  if (!friendId || !channelId) return;
  write(kFriend(friendId), { channelId: String(channelId) });
}

export function channelForFriend(friendId) {
  if (!friendId) return null;
  return read(kFriend(friendId))?.channelId || null;
}

export function resolveDm(friendId, channelId) {
  const cid = channelId || channelForFriend(friendId);
  if (!cid) return { channelId: null, entry: null };
  return { channelId: String(cid), entry: getCached('dm', cid) };
}

export function save(kind, channelId, messages, more = true, friendId = null) {
  if (!channelId) return null;
  const entry = {
    messages: trim(messages),
    hasMore: more !== false,
    ...tail(messages),
    updatedAt: Date.now(),
  };
  const id = String(channelId);
  mem[kind].set(id, entry);
  write(kMsg(kind, id), entry);
  indexTrack(kind, id);
  hasMore[kind].set(id, entry.hasMore);
  if (kind === 'dm' && friendId) linkFriend(friendId, id);
  return entry;
}

export function appendLive(kind, channelId, msg, friendIdOrOpts = null) {
  if (!channelId || !msg?.id || String(msg.id).startsWith('local_')) return null;
  const friendId = friendIdOrOpts && typeof friendIdOrOpts === 'object'
    ? friendIdOrOpts.friendId
    : friendIdOrOpts;
  const cur = getCached(kind, channelId);
  const list = cur?.messages || [];
  const id = String(msg.id);
  const next = list.some((m) => String(m.id) === id)
    ? list.map((m) => (String(m.id) === id ? { ...m, ...msg } : m))
    : [...list, msg];
  return save(kind, channelId, next, cur?.hasMore !== false, friendId);
}

export function patch(kind, channelId, messageId, patchObj) {
  const cur = getCached(kind, channelId);
  if (!cur?.messages?.length) return;
  save(
    kind,
    channelId,
    cur.messages.map((m) => (String(m.id) === String(messageId) ? { ...m, ...patchObj } : m)),
    cur.hasMore
  );
}

export function remove(kind, channelId, messageId) {
  const cur = getCached(kind, channelId);
  if (!cur?.messages?.length) return;
  save(kind, channelId, cur.messages.filter((m) => String(m.id) !== String(messageId)), cur.hasMore);
}

export function sameTail(a, b) {
  const ta = tail(a || []);
  const tb = tail(b || []);
  return ta.lastId === tb.lastId && ta.lastTs === tb.lastTs;
}

export function getHasMore(kind, channelId) {
  if (hasMore[kind].has(String(channelId))) return hasMore[kind].get(String(channelId));
  return getCached(kind, channelId)?.hasMore !== false;
}

/* ---------- profiles ---------- */

export function getProfile(id) {
  const s = String(id);
  if (profiles.has(s)) return profiles.get(s)?.data || null;
  const e = read(kProfile(s));
  if (e) profiles.set(s, e);
  return e?.data || null;
}

export function saveProfile(id, data) {
  if (!id || !data) return;
  const s = String(id);
  const e = { data, updatedAt: Date.now() };
  profiles.set(s, e);
  write(kProfile(s), e);
  indexTrackProfile(s);
}

export function hydrateProfilesTo(obj) {
  for (const [id, e] of profiles) {
    if (e?.data) obj[id] = e.data;
  }
}

/* ---------- open / older (Discord pipeline) ---------- */

/**
 * Open a conversation Discord-style.
 *
 * @param {object} opts
 * @param {'dm'|'chan'} opts.kind
 * @param {string|null} opts.channelId
 * @param {string|null} [opts.friendId]
 * @param {HTMLElement} opts.container
 * @param {(messages: any[]) => void} opts.paint  full replace + scroll bottom
 * @param {() => void} opts.paintLoading
 * @param {() => Promise<{error?: string, messages?: any[], hasMore?: boolean, channelId?: string}>} opts.fetch
 * @param {(channelId: string) => void} [opts.onChannel]
 * @returns {{ seq: number, fromCache: boolean }}
 */
export function open({
  kind,
  channelId,
  friendId = null,
  container,
  paint,
  paintLoading,
  fetch,
  onChannel,
}) {
  const mySeq = ++seq[kind];
  let cid = channelId ? String(channelId) : null;
  if (!cid && kind === 'dm' && friendId) cid = channelForFriend(friendId);

  const cached = cid ? getCached(kind, cid) : null;
  let fromCache = false;

  if (cached?.messages?.length) {
    fromCache = true;
    hasMore[kind].set(cid, cached.hasMore !== false);
    paint(cached.messages);
  } else {
    paintLoading();
  }

  fetch().then((res) => {
    if (seq[kind] !== mySeq) return;
    if (res?.error) {
      if (!fromCache) {
        container.innerHTML = '';
      }
      return;
    }
    const nextId = res.channelId ? String(res.channelId) : cid;
    if (nextId && nextId !== cid) {
      cid = nextId;
      onChannel?.(cid);
    }
    const fid = friendId || res.friendId || null;
    if (kind === 'dm' && fid && cid) linkFriend(fid, cid);

    const serverMsgs = res.messages || [];
    save(kind, cid, serverMsgs, res.hasMore !== false, fid);

    if (!fromCache || !sameTail(cached?.messages, serverMsgs)) {
      paint(serverMsgs);
    }
  }).catch(() => {
    if (seq[kind] !== mySeq) return;
    if (!fromCache) container.innerHTML = '';
  });

  return { seq: mySeq, fromCache, channelId: cid };
}

export function isCurrent(kind, s) {
  return seq[kind] === s;
}

/**
 * Load older messages when scrolled near top.
 */
export function loadOlder({
  kind,
  channelId,
  container,
  getBeforeTs,
  fetch,
  prepend,
}) {
  if (!channelId) return;
  if (loadingOlder[kind]) return;
  if (getHasMore(kind, channelId) === false) return;
  if (container.scrollTop > 80) return;

  const beforeTs = getBeforeTs();
  if (!beforeTs) {
    hasMore[kind].set(String(channelId), false);
    return;
  }

  loadingOlder[kind] = true;
  fetch(beforeTs).then((res) => {
    loadingOlder[kind] = false;
    if (res?.error) return;
    const msgs = res.messages || [];
    hasMore[kind].set(String(channelId), !!res.hasMore);
    if (!msgs.length) {
      hasMore[kind].set(String(channelId), false);
      return;
    }
    prepend(msgs);
  }).catch(() => {
    loadingOlder[kind] = false;
  });
}

/** Bind Discord-style top-scroll history once per container */
export function bindTopScroll(container, onNearTop) {
  if (!container || container.dataset.msgScroll === '1') return;
  container.dataset.msgScroll = '1';
  container.addEventListener('scroll', () => {
    if (container.scrollTop > 80) return;
    onNearTop();
  }, { passive: true });
}
