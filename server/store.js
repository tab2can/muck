/**
 * Muck store — Supabase Postgres (secret client, RLS bypass).
 * Tüm export'lar async; index.js await kullanmalı.
 */
import crypto from 'crypto';
import { supabase } from './supabase.js';

const MAX_MESSAGES = 200;
const MAX_GROUP_MEMBERS = 10;
const PAGE_SIZE = 20;
const EPOCH = 1420070400000;
let lastTs = 0;
let seq = 0;

function snowflake() {
  let ts = Date.now();
  if (ts <= lastTs) {
    seq = (seq + 1) & 4095;
    if (seq === 0) ts = ++lastTs;
  } else {
    seq = 0;
    lastTs = ts;
  }
  const rand = BigInt(Math.floor(Math.random() * 1024));
  const id = (BigInt(ts - EPOCH) << 22n) | (rand << 12n) | BigInt(seq);
  return id.toString();
}

function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function emptySocial() {
  return {
    pinnedDms: [], closedDms: [], mutedDms: {}, unreadDms: {},
    ignored: [], blocked: [], friendSince: {}, notes: {},
    pinnedGroups: [], closedGroups: [], mutedGroups: {}, unreadGroups: {},
  };
}

function rowToSocial(row) {
  if (!row) return emptySocial();
  return {
    pinnedDms: row.pinned_dms || [],
    closedDms: row.closed_dms || [],
    mutedDms: row.muted_dms || {},
    unreadDms: row.unread_dms || {},
    ignored: row.ignored || [],
    blocked: row.blocked || [],
    friendSince: row.friend_since || {},
    notes: row.notes || {},
    pinnedGroups: row.pinned_groups || [],
    closedGroups: row.closed_groups || [],
    mutedGroups: row.muted_groups || {},
    unreadGroups: row.unread_groups || {},
  };
}

function socialToRow(s) {
  return {
    pinned_dms: s.pinnedDms || [],
    closed_dms: s.closedDms || [],
    muted_dms: s.mutedDms || {},
    unread_dms: s.unreadDms || {},
    ignored: s.ignored || [],
    blocked: s.blocked || [],
    friend_since: s.friendSince || {},
    notes: s.notes || {},
    pinned_groups: s.pinnedGroups || [],
    closed_groups: s.closedGroups || [],
    muted_groups: s.mutedGroups || {},
    unread_groups: s.unreadGroups || {},
    updated_at: new Date().toISOString(),
  };
}

function profileToUser(p) {
  if (!p) return null;
  return {
    id: p.id,
    username: p.username,
    displayName: p.display_name || null,
    email: p.email || null,
    birthDate: p.birth_date || null,
    createdAt: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
  };
}

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username };
}

export async function findByUsername(username) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('username_lower', String(username || '').toLowerCase())
    .maybeSingle();
  return profileToUser(data);
}

const profileCache = new Map(); // id -> { user, expires }
const PROFILE_TTL_MS = 60_000;

export async function findById(id) {
  if (!id) return null;
  const hit = profileCache.get(id);
  if (hit && hit.expires > Date.now()) return hit.user;
  const { data } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
  const user = profileToUser(data);
  if (user) profileCache.set(id, { user, expires: Date.now() + PROFILE_TTL_MS });
  return user;
}

export async function findByEmail(email) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', String(email || '').toLowerCase())
    .maybeSingle();
  return profileToUser(data);
}

/** Auth sonrası profil — trigger oluşturur; bu sadece kontrol / bekleme */
export async function waitForProfile(userId, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const u = await findById(userId);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

export async function isUsernameTaken(username) {
  const u = await findByUsername(username);
  return !!u;
}

export async function getUserByAccessToken(accessToken) {
  if (!accessToken) return null;
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user) return null;
  const profile = await findById(data.user.id);
  if (!profile) return null;
  return { ...profile, email: data.user.email || profile.email, emailConfirmed: !!data.user.email_confirmed_at };
}

// ---- Social ----
async function ensureSocialRow(userId) {
  const { data } = await supabase.from('user_social').select('*').eq('user_id', userId).maybeSingle();
  if (data) return data;
  const { data: created } = await supabase
    .from('user_social')
    .insert({ user_id: userId })
    .select('*')
    .single();
  return created;
}

export async function getSocial(userId) {
  const row = await ensureSocialRow(userId);
  return rowToSocial(row);
}

async function saveSocial(userId, social) {
  await supabase.from('user_social').upsert({ user_id: userId, ...socialToRow(social) });
}

export async function setDmPinned(userId, friendId, pinned) {
  const s = await getSocial(userId);
  s.pinnedDms = s.pinnedDms.filter((id) => id !== friendId);
  if (pinned) s.pinnedDms.unshift(friendId);
  await saveSocial(userId, s);
  return { social: s };
}

export async function closeDm(userId, friendId) {
  const s = await getSocial(userId);
  if (!s.closedDms.includes(friendId)) s.closedDms.push(friendId);
  s.pinnedDms = s.pinnedDms.filter((id) => id !== friendId);
  await saveSocial(userId, s);
  return { social: s };
}

export async function reopenDm(userId, friendId) {
  const s = await getSocial(userId);
  s.closedDms = s.closedDms.filter((id) => id !== friendId);
  await saveSocial(userId, s);
  return { social: s };
}

export async function markDmRead(userId, friendId) {
  const s = await getSocial(userId);
  delete s.unreadDms[friendId];
  await saveSocial(userId, s);
  return { social: s };
}

export async function markDmUnread(userId, friendId) {
  const s = await getSocial(userId);
  s.unreadDms[friendId] = true;
  s.closedDms = s.closedDms.filter((id) => id !== friendId);
  await saveSocial(userId, s);
  return { social: s };
}

export async function setDmMuted(userId, friendId, until) {
  const s = await getSocial(userId);
  if (until === null || until === undefined) delete s.mutedDms[friendId];
  else s.mutedDms[friendId] = until;
  await saveSocial(userId, s);
  return { social: s };
}

export async function setIgnored(userId, targetId, ignored) {
  const s = await getSocial(userId);
  s.ignored = s.ignored.filter((id) => id !== targetId);
  if (ignored) s.ignored.push(targetId);
  await saveSocial(userId, s);
  return { social: s };
}

export async function setBlocked(userId, targetId, blocked) {
  const s = await getSocial(userId);
  s.blocked = s.blocked.filter((id) => id !== targetId);
  if (blocked) {
    s.blocked.push(targetId);
    s.ignored = s.ignored.filter((id) => id !== targetId);
  }
  await saveSocial(userId, s);
  return { social: s };
}

export async function isBlockedBy(blockerId, targetId) {
  const s = await getSocial(blockerId);
  return s.blocked.includes(targetId);
}

export async function blockState(viewerId, targetId) {
  return {
    blockedByMe: await isBlockedBy(viewerId, targetId),
    blockedByThem: await isBlockedBy(targetId, viewerId),
  };
}

export async function isBlockedEither(a, b) {
  return (await isBlockedBy(a, b)) || (await isBlockedBy(b, a));
}

export async function setFriendNote(userId, friendId, note) {
  const s = await getSocial(userId);
  const t = String(note || '').slice(0, 500);
  if (!t) delete s.notes[friendId];
  else s.notes[friendId] = t;
  await saveSocial(userId, s);
  return { social: s };
}

export async function isDmMuted(userId, friendId) {
  const s = await getSocial(userId);
  const until = s.mutedDms[friendId];
  if (until === undefined || until === null) return false;
  if (until === 0) return true;
  if (Date.now() > until) {
    delete s.mutedDms[friendId];
    await saveSocial(userId, s);
    return false;
  }
  return true;
}

// ---- Friends ----
function pairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

export async function getFriends(userId) {
  const { data } = await supabase
    .from('friendships')
    .select('user_a, user_b')
    .or(`user_a.eq.${userId},user_b.eq.${userId}`);
  const ids = (data || []).map((r) => (r.user_a === userId ? r.user_b : r.user_a));
  if (!ids.length) return [];
  const { data: profiles } = await supabase.from('profiles').select('*').in('id', ids);
  return (profiles || []).map(profileToUser);
}

export async function getFriendRequests(userId) {
  const { data: incoming } = await supabase
    .from('friend_requests')
    .select('*')
    .eq('to_id', userId);
  const { data: outgoing } = await supabase
    .from('friend_requests')
    .select('*')
    .eq('from_id', userId);

  async function enrich(rows, otherKey) {
    const out = [];
    for (const r of rows || []) {
      const other = await findById(r[otherKey]);
      if (!other) continue;
      out.push({ id: r.id, user: publicUser(other), createdAt: new Date(r.created_at).getTime() });
    }
    return out;
  }
  return {
    incoming: await enrich(incoming, 'from_id'),
    outgoing: await enrich(outgoing, 'to_id'),
  };
}

export async function sendFriendRequest(userId, friendUsername) {
  const friend = await findByUsername(friendUsername);
  if (!friend) return { error: 'Kullanıcı bulunamadı.' };
  if (friend.id === userId) return { error: 'Kendine istek gönderemezsin.' };
  const friends = await getFriends(userId);
  if (friends.some((f) => f.id === friend.id)) return { error: 'Bu kişi zaten arkadaş listenizde.' };

  const { data: reverse } = await supabase
    .from('friend_requests')
    .select('*')
    .eq('from_id', friend.id)
    .eq('to_id', userId)
    .maybeSingle();
  if (reverse) return acceptFriendRequest(userId, reverse.id);

  const { data: existing } = await supabase
    .from('friend_requests')
    .select('id')
    .eq('from_id', userId)
    .eq('to_id', friend.id)
    .maybeSingle();
  if (existing) return { error: 'Zaten bir istek gönderilmiş.' };

  if (await isBlockedEither(userId, friend.id)) return { error: 'Engel nedeniyle istek gönderilemez.' };

  const id = snowflake();
  await supabase.from('friend_requests').insert({ id, from_id: userId, to_id: friend.id });
  const me = await findById(userId);
  return {
    request: {
      id,
      from: publicUser(me),
      to: publicUser(friend),
      createdAt: Date.now(),
    },
  };
}

export async function addFriend(userId, friendUsername) {
  return sendFriendRequest(userId, friendUsername);
}

export async function acceptFriendRequest(userId, requestId) {
  const { data: req } = await supabase.from('friend_requests').select('*').eq('id', requestId).maybeSingle();
  if (!req) return { error: 'İstek bulunamadı.' };
  if (req.to_id !== userId && req.from_id !== userId) return { error: 'Yetkiniz yok.' };

  const [a, b] = pairKey(req.from_id, req.to_id);
  await supabase.from('friendships').upsert({ user_a: a, user_b: b });
  await supabase.from('friend_requests').delete().or(
    `and(from_id.eq.${req.from_id},to_id.eq.${req.to_id}),and(from_id.eq.${req.to_id},to_id.eq.${req.from_id})`
  );

  const now = Date.now();
  for (const uid of [req.from_id, req.to_id]) {
    const other = uid === req.from_id ? req.to_id : req.from_id;
    const s = await getSocial(uid);
    s.friendSince[other] = now;
    s.closedDms = s.closedDms.filter((id) => id !== other);
    await saveSocial(uid, s);
  }

  const friendId = req.from_id === userId ? req.to_id : req.from_id;
  const friend = await findById(friendId);
  return { friend: publicUser(friend) };
}

export async function declineFriendRequest(userId, requestId) {
  const { data: req } = await supabase.from('friend_requests').select('*').eq('id', requestId).maybeSingle();
  if (!req) return { error: 'İstek bulunamadı.' };
  if (req.to_id !== userId && req.from_id !== userId) return { error: 'Yetkiniz yok.' };
  await supabase.from('friend_requests').delete().eq('id', requestId);
  return { success: true };
}

export async function removeFriend(userId, friendId) {
  const [a, b] = pairKey(userId, friendId);
  await supabase.from('friendships').delete().eq('user_a', a).eq('user_b', b);
  for (const uid of [userId, friendId]) {
    const other = uid === userId ? friendId : userId;
    const s = await getSocial(uid);
    s.pinnedDms = s.pinnedDms.filter((id) => id !== other);
    delete s.friendSince[other];
    delete s.notes[other];
    delete s.mutedDms[other];
    delete s.unreadDms[other];
    await saveSocial(uid, s);
  }
  return { success: true };
}

export async function getUserProfile(viewerId, targetId) {
  const target = await findById(targetId);
  if (!target) return { error: 'Kullanıcı bulunamadı.' };
  const friends = await getFriends(viewerId);
  const isFriend = friends.some((f) => f.id === targetId);
  const s = await getSocial(viewerId);
  const bs = await blockState(viewerId, targetId);
  const myFriends = await getFriends(viewerId);
  const theirFriends = await getFriends(targetId);
  const theirSet = new Set(theirFriends.map((f) => f.id));
  const mutualFriends = myFriends.filter((f) => theirSet.has(f.id)).map(publicUser);

  const myServers = await getUserServers(viewerId);
  const theirServers = await getUserServers(targetId);
  const theirServerIds = new Set(theirServers.map((x) => x.id));
  const mutualServers = myServers.filter((x) => theirServerIds.has(x.id)).map((x) => ({ id: x.id, name: x.name }));

  return {
    user: { id: target.id, username: target.username, createdAt: target.createdAt },
    isFriend,
    friendSince: s.friendSince[targetId] || null,
    note: s.notes[targetId] || '',
    ignored: s.ignored.includes(targetId),
    blocked: bs.blockedByMe,
    mutualFriends,
    mutualServers,
  };
}

export async function inviteToServer(inviterId, serverId, targetUserId) {
  const server = await getServer(serverId);
  if (!server || !isMember(server, inviterId)) return { error: 'Yetkiniz yok.' };
  const target = await findById(targetUserId);
  if (!target) return { error: 'Kullanıcı bulunamadı.' };
  if (isMember(server, targetUserId)) return { server: await publicServerAsync(serverId) };
  await supabase.from('server_members').insert({ server_id: serverId, user_id: targetUserId });
  return { server: await publicServerAsync(serverId) };
}

// ---- Servers ----
async function loadServerBundle(serverId) {
  const { data: server } = await supabase.from('servers').select('*').eq('id', serverId).maybeSingle();
  if (!server) return null;
  const { data: members } = await supabase.from('server_members').select('user_id').eq('server_id', serverId);
  const { data: channels } = await supabase.from('channels').select('*').eq('server_id', serverId).order('created_at');
  return {
    id: server.id,
    name: server.name,
    ownerId: server.owner_id,
    inviteCode: server.invite_code,
    members: (members || []).map((m) => m.user_id),
    channels: (channels || []).map((c) => ({
      id: c.id, name: c.name, type: c.type, createdAt: new Date(c.created_at).getTime(),
    })),
    createdAt: new Date(server.created_at).getTime(),
  };
}

function publicServerObj(server) {
  return {
    id: server.id,
    name: server.name,
    ownerId: server.ownerId,
    inviteCode: server.inviteCode,
    memberCount: server.members.length,
    channels: server.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    createdAt: server.createdAt,
  };
}

async function publicServerAsync(serverId) {
  const s = await loadServerBundle(serverId);
  return s ? publicServerObj(s) : null;
}

export async function getServer(serverId) {
  return loadServerBundle(serverId);
}

export function isMember(server, userId) {
  return !!server?.members?.includes(userId);
}

export function isOwner(server, userId) {
  return server?.ownerId === userId;
}

export async function getUserServers(userId) {
  const { data: mem } = await supabase.from('server_members').select('server_id').eq('user_id', userId);
  const out = [];
  for (const m of mem || []) {
    const pub = await publicServerAsync(m.server_id);
    if (pub) out.push(pub);
  }
  return out;
}

export async function createServer(userId, name) {
  const user = await findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  if (!name || name.trim().length < 2 || name.trim().length > 32) {
    return { error: 'Sunucu adı 2-32 karakter olmalı.' };
  }
  const id = snowflake();
  let code = inviteCode();
  for (let i = 0; i < 5; i++) {
    const { data: clash } = await supabase.from('servers').select('id').eq('invite_code', code).maybeSingle();
    if (!clash) break;
    code = inviteCode();
  }
  const textId = snowflake();
  const voiceId = snowflake();
  const { error } = await supabase.from('servers').insert({
    id, name: name.trim(), owner_id: userId, invite_code: code,
  });
  if (error) return { error: error.message };
  await supabase.from('server_members').insert({ server_id: id, user_id: userId });
  await supabase.from('channels').insert([
    { id: textId, server_id: id, name: 'genel', type: 'text' },
    { id: voiceId, server_id: id, name: 'Sesli', type: 'voice' },
  ]);
  return { server: await publicServerAsync(id) };
}

export async function joinServerByCode(userId, code) {
  const user = await findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  const { data: server } = await supabase
    .from('servers')
    .select('*')
    .eq('invite_code', String(code || '').toUpperCase())
    .maybeSingle();
  if (!server) return { error: 'Geçersiz davet kodu.' };
  await supabase.from('server_members').upsert({ server_id: server.id, user_id: userId });
  return { server: await publicServerAsync(server.id) };
}

export async function leaveServer(userId, serverId) {
  const server = await getServer(serverId);
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (server.ownerId === userId) return { error: 'Sahip sunucudan ayrılamaz. Önce sunucuyu silin.' };
  await supabase.from('server_members').delete().eq('server_id', serverId).eq('user_id', userId);
  return { success: true };
}

export async function updateServer(userId, serverId, { name }) {
  const server = await getServer(serverId);
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  if (name) {
    if (name.trim().length < 2 || name.trim().length > 32) return { error: 'Ad 2-32 karakter olmalı.' };
    await supabase.from('servers').update({ name: name.trim() }).eq('id', serverId);
  }
  return { server: await publicServerAsync(serverId) };
}

export async function deleteServer(userId, serverId) {
  const server = await getServer(serverId);
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  await supabase.from('servers').delete().eq('id', serverId);
  return { success: true };
}

export async function findChannel(channelId) {
  const { data: ch } = await supabase.from('channels').select('*').eq('id', channelId).maybeSingle();
  if (!ch) return null;
  const server = await getServer(ch.server_id);
  if (!server) return null;
  const channel = server.channels.find((c) => c.id === channelId);
  return channel ? { server, channel } : null;
}

export async function addChannel(userId, serverId, { name, type }) {
  const server = await getServer(serverId);
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  if (!name || name.trim().length < 1 || name.trim().length > 32) return { error: 'Kanal adı 1-32 karakter.' };
  if (!['text', 'voice'].includes(type)) return { error: 'Geçersiz kanal tipi.' };
  const id = snowflake();
  await supabase.from('channels').insert({ id, server_id: serverId, name: name.trim(), type });
  return {
    channel: { id, name: name.trim(), type },
    server: await publicServerAsync(serverId),
  };
}

export async function deleteChannel(userId, serverId, channelId) {
  const server = await getServer(serverId);
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  if (server.channels.length <= 1) return { error: 'Son kanal silinemez.' };
  await supabase.from('channels').delete().eq('id', channelId);
  return { server: await publicServerAsync(serverId) };
}

export async function renameChannel(userId, serverId, channelId, name) {
  const server = await getServer(serverId);
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  const ch = server.channels.find((c) => c.id === channelId);
  if (!ch) return { error: 'Kanal bulunamadı.' };
  if (!name || name.trim().length < 1 || name.trim().length > 32) return { error: 'Ad 1-32 karakter.' };
  await supabase.from('channels').update({ name: name.trim() }).eq('id', channelId);
  return {
    channel: { id: channelId, name: name.trim(), type: ch.type },
    server: await publicServerAsync(serverId),
  };
}

export async function getServerMembers(serverId) {
  const server = await getServer(serverId);
  if (!server) return [];
  const out = [];
  for (const id of server.members) {
    const u = await findById(id);
    if (u) out.push(publicUser(u));
  }
  return out;
}

// ---- Messages ----
async function trimOldChannelMessages(channelId) {
  const { data: old } = await supabase
    .from('messages')
    .select('id')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .range(MAX_MESSAGES, MAX_MESSAGES + 50);
  if (old?.length) {
    await supabase.from('messages').delete().in('id', old.map((m) => m.id));
  }
}

export async function pushMessage(channelId, userId, username, text, replyTo = null) {
  const payload = replyTo ? {
    id: replyTo.id,
    fromId: replyTo.fromId || replyTo.userId,
    text: String(replyTo.text || '').slice(0, 200),
    username: replyTo.username || null,
  } : null;
  const row = {
    channel_id: channelId,
    author_id: userId,
    content: text.trim(),
  };
  if (payload) row.reply_to = payload;
  const { data, error } = await supabase
    .from('messages')
    .insert(row)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  trimOldChannelMessages(channelId).catch(() => {});
  return {
    id: data.id,
    userId: data.author_id,
    username,
    text: data.content,
    ts: new Date(data.created_at).getTime(),
    mediaUrls: data.media_urls || [],
    reactions: data.reactions || {},
    replyTo: data.reply_to || null,
  };
}

export async function getMessages(channelId, { limit = PAGE_SIZE, beforeTs = null } = {}) {
  let q = supabase
    .from('messages')
    .select('*')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (beforeTs) q = q.lt('created_at', new Date(beforeTs).toISOString());
  const { data } = await q;
  const rows = data || [];
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
  const authorIds = [...new Set(page.map((m) => m.author_id))];
  const authors = await Promise.all(authorIds.map((id) => findById(id)));
  const byId = new Map(authors.filter(Boolean).map((u) => [u.id, u]));
  return {
    messages: page.map((m) => ({
      id: m.id,
      userId: m.author_id,
      username: byId.get(m.author_id)?.username || '—',
      text: m.content,
      ts: new Date(m.created_at).getTime(),
      mediaUrls: m.media_urls || [],
      reactions: m.reactions || {},
      replyTo: m.reply_to || null,
    })),
    hasMore,
  };
}

async function enrichSearchRows(rows) {
  const authorIds = [...new Set((rows || []).map((m) => m.author_id))];
  const authors = await Promise.all(authorIds.map((id) => findById(id)));
  const byId = new Map(authors.filter(Boolean).map((u) => [u.id, u]));
  return (rows || []).map((m) => ({
    id: m.id,
    fromId: m.author_id,
    userId: m.author_id,
    username: byId.get(m.author_id)?.username || '—',
    text: m.content,
    ts: new Date(m.created_at).getTime(),
    reactions: m.reactions || {},
    replyTo: m.reply_to || null,
  }));
}

export async function searchDmChannel(userId, channelId, query, limit = 50) {
  const channel = await getDMChannelById(channelId);
  if (!channel || !channel.users.includes(userId)) return { error: 'Yetkiniz yok.' };
  const q = String(query || '').trim();
  if (!q) return { results: [], messages: [] };
  const { data, error } = await supabase
    .from('dm_messages')
    .select('*')
    .eq('channel_id', channelId)
    .ilike('content', `%${q}%`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { error: error.message };
  const results = await enrichSearchRows(data || []);
  return { results, messages: results };
}

export async function searchChannel(userId, channelId, query, limit = 50) {
  const found = await findChannel(channelId);
  if (!found || !isMember(found.server, userId)) return { error: 'Yetkiniz yok.' };
  if (found.channel.type !== 'text') return { error: 'Metin kanalı değil.' };
  const q = String(query || '').trim();
  if (!q) return { results: [], messages: [] };
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('channel_id', channelId)
    .ilike('content', `%${q}%`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { error: error.message };
  const results = await enrichSearchRows(data || []);
  return { results, messages: results };
}

// ---- DMs ----
export async function getDMChannelById(id) {
  const { data: ch } = await supabase.from('dm_channels').select('*').eq('id', id).maybeSingle();
  if (!ch) return null;
  const { data: mem } = await supabase.from('dm_members').select('user_id').eq('channel_id', id);
  return {
    id: ch.id,
    type: ch.type,
    name: ch.name,
    ownerId: ch.owner_id,
    users: (mem || []).map((m) => m.user_id),
    createdAt: new Date(ch.created_at).getTime(),
    lastMessageAt: ch.last_message_at ? new Date(ch.last_message_at).getTime() : 0,
    lastFromId: ch.last_from_id,
  };
}

export async function publicDmChannel(channel, viewerId = null) {
  if (!channel) return null;
  if (typeof channel === 'string') channel = await getDMChannelById(channel);
  if (!channel) return null;
  const members = [];
  for (const id of channel.users) {
    const u = await findById(id);
    members.push(u ? { id: u.id, username: u.username } : { id, username: '—' });
  }
  let title = channel.name;
  if (!title) {
    if (channel.type === 'group') title = members.map((m) => m.username).join(', ');
    else {
      const other = channel.users.find((id) => id !== viewerId) || channel.users[0];
      title = (await findById(other))?.username || 'DM';
    }
  }
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    title,
    ownerId: channel.ownerId,
    users: channel.users.slice(),
    members,
    memberCount: channel.users.length,
    lastMessageAt: channel.lastMessageAt || 0,
    lastFromId: channel.lastFromId || null,
    createdAt: channel.createdAt,
  };
}

export async function getOrCreateDMChannel(a, b) {
  const { data: myChannels } = await supabase.from('dm_members').select('channel_id').eq('user_id', a);
  for (const row of myChannels || []) {
    const ch = await getDMChannelById(row.channel_id);
    if (ch?.type === 'dm' && ch.users.includes(b) && ch.users.length === 2) return ch;
  }
  const id = snowflake();
  await supabase.from('dm_channels').insert({ id, type: 'dm', owner_id: a });
  await supabase.from('dm_members').insert([
    { channel_id: id, user_id: a },
    { channel_id: id, user_id: b },
  ]);
  return getDMChannelById(id);
}

/** Okunmamış işaretleme — mesaj emit'inden sonra arka planda */
export async function markDmRecipientsUnread(channel, fromId) {
  if (!channel?.users?.length) return;
  await Promise.all(
    channel.users
      .filter((uid) => uid !== fromId)
      .map(async (uid) => {
        const s = await getSocial(uid);
        if (channel.type === 'group') {
          s.unreadGroups[channel.id] = true;
          s.closedGroups = s.closedGroups.filter((id) => id !== channel.id);
        } else {
          s.unreadDms[fromId] = true;
          s.closedDms = s.closedDms.filter((id) => id !== fromId);
        }
        await saveSocial(uid, s);
      })
  );
}

export async function pushDmChannelMessage(channelId, fromId, text, preloadedChannel = null) {
  const channel = preloadedChannel || await getDMChannelById(channelId);
  if (!channel) return { error: 'Kanal bulunamadı.' };
  if (!channel.users.includes(fromId)) return { error: 'Yetkiniz yok.' };
  const { data, error } = await supabase
    .from('dm_messages')
    .insert({ channel_id: channelId, author_id: fromId, content: text.trim() })
    .select('*')
    .single();
  if (error) return { error: error.message };
  const ts = new Date(data.created_at).getTime();
  supabase.from('dm_channels').update({
    last_message_at: data.created_at,
    last_from_id: fromId,
  }).eq('id', channelId).then(() => {}).catch(() => {});

  return {
    id: data.id,
    fromId: data.author_id,
    text: data.content,
    ts,
    reactions: data.reactions || {},
    replyTo: data.reply_to || null,
    mediaUrls: data.media_urls || [],
    _channel: channel,
  };
}

export async function pushDM(fromId, toId, text) {
  const channel = await getOrCreateDMChannel(fromId, toId);
  return pushDmChannelMessage(channel.id, fromId, text);
}

export async function setDmReply(channelId, fromId, text, replyTo, preloadedChannel = null) {
  const channel = preloadedChannel || await getDMChannelById(channelId);
  if (!channel) return { error: 'Kanal bulunamadı.' };
  if (!channel.users.includes(fromId)) return { error: 'Yetkiniz yok.' };
  const payload = replyTo ? {
    id: replyTo.id,
    fromId: replyTo.fromId,
    text: String(replyTo.text || '').slice(0, 200),
    username: replyTo.username || null,
  } : null;
  const { data, error } = await supabase
    .from('dm_messages')
    .insert({
      channel_id: channelId,
      author_id: fromId,
      content: text.trim(),
      reply_to: payload,
    })
    .select('*')
    .single();
  if (error) return { error: error.message };
  supabase.from('dm_channels').update({
    last_message_at: data.created_at,
    last_from_id: fromId,
  }).eq('id', channelId).then(() => {}).catch(() => {});
  return {
    id: data.id,
    fromId: data.author_id,
    text: data.content,
    ts: new Date(data.created_at).getTime(),
    reactions: {},
    replyTo: data.reply_to,
    mediaUrls: [],
    _channel: channel,
  };
}

export async function getDmChannelMessages(channelId, { limit = PAGE_SIZE, beforeTs = null } = {}) {
  let q = supabase
    .from('dm_messages')
    .select('*')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (beforeTs) q = q.lt('created_at', new Date(beforeTs).toISOString());
  const { data } = await q;
  const rows = data || [];
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
  return {
    messages: page.map((m) => ({
      id: m.id,
      fromId: m.author_id,
      text: m.content,
      ts: new Date(m.created_at).getTime(),
      reactions: m.reactions || {},
      replyTo: m.reply_to || null,
      mediaUrls: m.media_urls || [],
    })),
    hasMore,
  };
}

export async function getDMs(userId, friendId, opts = {}) {
  const channel = await getOrCreateDMChannel(userId, friendId);
  return getDmChannelMessages(channel.id, opts);
}

export async function pinDmMessage(userId, channelId, messageId, pinned = true) {
  const channel = await getDMChannelById(channelId);
  if (!channel || !channel.users.includes(userId)) return { error: 'Yetkiniz yok.' };
  if (!pinned) {
    await supabase.from('dm_pins').delete().eq('channel_id', channelId).eq('message_id', messageId);
    return { pins: await getDmPins(userId, channelId).then((r) => r.pins || r) };
  }
  const { data: msg } = await supabase.from('dm_messages').select('*').eq('id', messageId).maybeSingle();
  if (!msg || msg.channel_id !== channelId) return { error: 'Mesaj bulunamadı.' };
  const { count } = await supabase
    .from('dm_pins')
    .select('*', { count: 'exact', head: true })
    .eq('channel_id', channelId);
  if ((count || 0) >= 50) return { error: 'En fazla 50 sabitlenmiş mesaj.' };
  await supabase.from('dm_pins').upsert({
    channel_id: channelId,
    message_id: messageId,
    from_id: msg.author_id,
    text: msg.content,
    ts: msg.created_at,
    pinned_by: userId,
  });
  return { pins: (await getDmPins(userId, channelId)).pins };
}

export async function getDmPins(userId, channelId) {
  const channel = await getDMChannelById(channelId);
  if (!channel || !channel.users.includes(userId)) return { error: 'Yetkiniz yok.' };
  const { data } = await supabase
    .from('dm_pins')
    .select('*')
    .eq('channel_id', channelId)
    .order('pinned_at', { ascending: false });
  const pins = [];
  for (const p of data || []) {
    const author = await findById(p.from_id);
    pins.push({
      id: p.message_id,
      messageId: p.message_id,
      fromId: p.from_id,
      text: p.text,
      ts: p.ts ? new Date(p.ts).getTime() : null,
      pinnedBy: p.pinned_by,
      pinnedAt: new Date(p.pinned_at).getTime(),
      username: author?.username || '—',
    });
  }
  return { pins };
}

export async function reactDmMessage(userId, channelId, messageId, emoji) {
  const channel = await getDMChannelById(channelId);
  if (!channel || !channel.users.includes(userId)) return { error: 'Yetkiniz yok.' };
  const e = String(emoji || '').slice(0, 16);
  if (!e) return { error: 'Emoji gerekli.' };
  const { data: msg } = await supabase.from('dm_messages').select('*').eq('id', messageId).maybeSingle();
  if (!msg || msg.channel_id !== channelId) return { error: 'Mesaj bulunamadı.' };
  const reactions = { ...(msg.reactions || {}) };
  const list = Array.isArray(reactions[e]) ? [...reactions[e]] : [];
  const idx = list.indexOf(userId);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(userId);
  if (list.length) reactions[e] = list;
  else delete reactions[e];
  await supabase.from('dm_messages').update({ reactions }).eq('id', messageId);
  return { messageId, reactions };
}

export async function pinChannelMessage(userId, channelId, messageId, pinned = true) {
  const found = await findChannel(channelId);
  if (!found || !isMember(found.server, userId)) return { error: 'Yetkiniz yok.' };
  if (found.channel.type !== 'text') return { error: 'Metin kanalı değil.' };
  if (!pinned) {
    await supabase.from('channel_pins').delete().eq('channel_id', channelId).eq('message_id', messageId);
    return { pins: (await getChannelPins(userId, channelId)).pins };
  }
  const { data: msg } = await supabase.from('messages').select('*').eq('id', messageId).maybeSingle();
  if (!msg || msg.channel_id !== channelId) return { error: 'Mesaj bulunamadı.' };
  const { count } = await supabase
    .from('channel_pins')
    .select('*', { count: 'exact', head: true })
    .eq('channel_id', channelId);
  if ((count || 0) >= 50) return { error: 'En fazla 50 sabitlenmiş mesaj.' };
  await supabase.from('channel_pins').upsert({
    channel_id: channelId,
    message_id: messageId,
    from_id: msg.author_id,
    text: msg.content,
    ts: msg.created_at,
    pinned_by: userId,
  });
  return { pins: (await getChannelPins(userId, channelId)).pins };
}

export async function getChannelPins(userId, channelId) {
  const found = await findChannel(channelId);
  if (!found || !isMember(found.server, userId)) return { error: 'Yetkiniz yok.' };
  const { data } = await supabase
    .from('channel_pins')
    .select('*')
    .eq('channel_id', channelId)
    .order('pinned_at', { ascending: false });
  const pins = [];
  for (const p of data || []) {
    const author = await findById(p.from_id);
    pins.push({
      id: p.message_id,
      messageId: p.message_id,
      fromId: p.from_id,
      text: p.text,
      ts: p.ts ? new Date(p.ts).getTime() : null,
      pinnedBy: p.pinned_by,
      pinnedAt: new Date(p.pinned_at).getTime(),
      username: author?.username || '—',
    });
  }
  return { pins };
}

export async function reactChannelMessage(userId, channelId, messageId, emoji) {
  const found = await findChannel(channelId);
  if (!found || !isMember(found.server, userId)) return { error: 'Yetkiniz yok.' };
  if (found.channel.type !== 'text') return { error: 'Metin kanalı değil.' };
  const e = String(emoji || '').slice(0, 16);
  if (!e) return { error: 'Emoji gerekli.' };
  const { data: msg } = await supabase.from('messages').select('*').eq('id', messageId).maybeSingle();
  if (!msg || msg.channel_id !== channelId) return { error: 'Mesaj bulunamadı.' };
  const reactions = { ...(msg.reactions || {}) };
  const list = Array.isArray(reactions[e]) ? [...reactions[e]] : [];
  const idx = list.indexOf(userId);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(userId);
  if (list.length) reactions[e] = list;
  else delete reactions[e];
  await supabase.from('messages').update({ reactions }).eq('id', messageId);
  return { messageId, reactions };
}

export async function createGroupDM(creatorId, memberIds = [], name = null) {
  const ids = [...new Set([creatorId, ...(memberIds || [])])];
  if (ids.length < 2 || ids.length > MAX_GROUP_MEMBERS) {
    return { error: `Grup 2-${MAX_GROUP_MEMBERS} kişi olmalı.` };
  }
  for (const id of ids) {
    if (id === creatorId) continue;
    const friends = await getFriends(creatorId);
    if (!friends.some((f) => f.id === id)) return { error: 'Yalnızca arkadaşlar eklenebilir.' };
    if (await isBlockedEither(creatorId, id)) return { error: 'Engel nedeniyle grup oluşturulamaz.' };
  }
  const id = snowflake();
  await supabase.from('dm_channels').insert({
    id,
    type: 'group',
    name: name ? String(name).slice(0, 100) : null,
    owner_id: creatorId,
  });
  await supabase.from('dm_members').insert(ids.map((user_id) => ({ channel_id: id, user_id })));
  const channel = await getDMChannelById(id);
  return { channel: await publicDmChannel(channel, creatorId) };
}

export async function updateGroupDM(userId, channelId, { name } = {}) {
  const channel = await getDMChannelById(channelId);
  if (!channel || channel.type !== 'group') return { error: 'Grup bulunamadı.' };
  if (!channel.users.includes(userId)) return { error: 'Yetkiniz yok.' };
  if (name !== undefined) {
    await supabase.from('dm_channels').update({ name: name ? String(name).slice(0, 100) : null }).eq('id', channelId);
  }
  return { channel: await publicDmChannel(await getDMChannelById(channelId), userId) };
}

export async function leaveGroupDM(userId, channelId) {
  const channel = await getDMChannelById(channelId);
  if (!channel || channel.type !== 'group') return { error: 'Grup bulunamadı.' };
  if (!channel.users.includes(userId)) return { error: 'Yetkiniz yok.' };
  await supabase.from('dm_members').delete().eq('channel_id', channelId).eq('user_id', userId);
  const left = await getDMChannelById(channelId);
  if (!left || left.users.length < 2) {
    await supabase.from('dm_channels').delete().eq('id', channelId);
    return { deleted: true };
  }
  if (channel.ownerId === userId) {
    await supabase.from('dm_channels').update({ owner_id: left.users[0] }).eq('id', channelId);
  }
  return { channel: await publicDmChannel(await getDMChannelById(channelId), userId) };
}

export async function getUserGroupDMs(userId) {
  const { data: mem } = await supabase.from('dm_members').select('channel_id').eq('user_id', userId);
  const social = await getSocial(userId);
  const out = [];
  for (const m of mem || []) {
    const ch = await getDMChannelById(m.channel_id);
    if (!ch || ch.type !== 'group') continue;
    const pub = await publicDmChannel(ch, userId);
    out.push({
      ...pub,
      pinned: social.pinnedGroups.includes(ch.id),
      closed: social.closedGroups.includes(ch.id),
      unread: !!social.unreadGroups[ch.id],
      mutedUntil: social.mutedGroups[ch.id] ?? null,
    });
  }
  return out;
}

export async function setGroupPinned(userId, channelId, pinned) {
  const s = await getSocial(userId);
  s.pinnedGroups = s.pinnedGroups.filter((id) => id !== channelId);
  if (pinned) s.pinnedGroups.unshift(channelId);
  await saveSocial(userId, s);
  return { social: s };
}

export async function closeGroupDm(userId, channelId) {
  const s = await getSocial(userId);
  if (!s.closedGroups.includes(channelId)) s.closedGroups.push(channelId);
  s.pinnedGroups = s.pinnedGroups.filter((id) => id !== channelId);
  await saveSocial(userId, s);
  return { social: s };
}

export async function markGroupRead(userId, channelId) {
  const s = await getSocial(userId);
  delete s.unreadGroups[channelId];
  await saveSocial(userId, s);
  return { social: s };
}

export async function setGroupMuted(userId, channelId, until) {
  const s = await getSocial(userId);
  if (until === null || until === undefined) delete s.mutedGroups[channelId];
  else s.mutedGroups[channelId] = until;
  await saveSocial(userId, s);
  return { social: s };
}

export async function isGroupMuted(userId, channelId) {
  const s = await getSocial(userId);
  const until = s.mutedGroups[channelId];
  if (until === undefined || until === null) return false;
  if (until === 0) return true;
  if (Date.now() > until) {
    delete s.mutedGroups[channelId];
    await saveSocial(userId, s);
    return false;
  }
  return true;
}

export async function findExistingDMChannel(a, b) {
  const { data: myChannels } = await supabase.from('dm_members').select('channel_id').eq('user_id', a);
  if (!myChannels?.length) return null;
  const ids = myChannels.map((r) => r.channel_id);
  const { data: channels } = await supabase
    .from('dm_channels')
    .select('*')
    .in('id', ids)
    .eq('type', 'dm');
  for (const ch of channels || []) {
    const { data: mem } = await supabase.from('dm_members').select('user_id').eq('channel_id', ch.id);
    const users = (mem || []).map((m) => m.user_id);
    if (users.includes(b) && users.length === 2) {
      return {
        id: ch.id,
        type: ch.type,
        name: ch.name,
        ownerId: ch.owner_id,
        users,
        createdAt: new Date(ch.created_at).getTime(),
        lastMessageAt: ch.last_message_at ? new Date(ch.last_message_at).getTime() : 0,
        lastFromId: ch.last_from_id,
      };
    }
  }
  return null;
}

/** Tüm arkadaşlar için DM aktivitesi — N+1 yerine toplu */
export async function getFriendsDmActivityMap(userId, friendIds) {
  const map = new Map();
  for (const id of friendIds) map.set(id, { lastMessageAt: 0, lastFromId: null, dmChannelId: null });
  if (!friendIds?.length) return map;

  const { data: myMemberships } = await supabase.from('dm_members').select('channel_id').eq('user_id', userId);
  const channelIds = (myMemberships || []).map((r) => r.channel_id);
  if (!channelIds.length) return map;

  const [{ data: channels }, { data: allMem }] = await Promise.all([
    supabase.from('dm_channels').select('id, last_message_at, last_from_id').in('id', channelIds).eq('type', 'dm'),
    supabase.from('dm_members').select('channel_id, user_id').in('channel_id', channelIds),
  ]);
  if (!channels?.length) return map;

  const membersByChan = new Map();
  for (const m of allMem || []) {
    if (!membersByChan.has(m.channel_id)) membersByChan.set(m.channel_id, []);
    membersByChan.get(m.channel_id).push(m.user_id);
  }
  const friendSet = new Set(friendIds);
  for (const ch of channels) {
    const users = membersByChan.get(ch.id) || [];
    if (users.length !== 2) continue;
    const other = users.find((id) => id !== userId);
    if (!other || !friendSet.has(other)) continue;
    map.set(other, {
      lastMessageAt: ch.last_message_at ? new Date(ch.last_message_at).getTime() : 0,
      lastFromId: ch.last_from_id || null,
      dmChannelId: ch.id,
    });
  }
  return map;
}

export async function getBlockedByThemSet(viewerId, otherIds) {
  if (!otherIds?.length) return new Set();
  const { data } = await supabase
    .from('user_social')
    .select('user_id, blocked')
    .in('user_id', otherIds);
  const set = new Set();
  for (const row of data || []) {
    if ((row.blocked || []).includes(viewerId)) set.add(row.user_id);
  }
  return set;
}

export async function getDmActivity(userId, friendId) {
  const channel = await findExistingDMChannel(userId, friendId);
  if (!channel) return { lastMessageAt: 0, lastFromId: null, dmChannelId: null };
  return {
    lastMessageAt: channel.lastMessageAt || 0,
    lastFromId: channel.lastFromId || null,
    dmChannelId: channel.id,
  };
}

/** Yaş hesabı (kayıt) */
export function calcAge(birthDateStr) {
  const d = new Date(birthDateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age -= 1;
  return age;
}

export function validUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
}
