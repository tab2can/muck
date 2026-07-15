import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_MESSAGES = 200;

let data = { users: {}, tokens: {}, servers: {}, messages: {}, dms: {}, dmChannels: {}, friendRequests: {} };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      if (!data.users) data.users = {};
      if (!data.tokens) data.tokens = {};
      if (!data.servers) data.servers = {};
      if (!data.messages) data.messages = {};
      if (!data.dms) data.dms = {};
      if (!data.dmChannels) data.dmChannels = {};
      if (!data.friendRequests) data.friendRequests = {};
      for (const u of Object.values(data.users)) {
        if (!u.friends) u.friends = [];
        if (!u.servers) u.servers = [];
      }
      migrateToSnowflake();
    }
  } catch (err) {
    console.error('data.json okunamadı:', err.message);
    data = { users: {}, tokens: {}, servers: {}, messages: {}, dms: {}, dmChannels: {}, friendRequests: {} };
  }
}

// ---- Snowflake ID üreteci (Discord tarzı sayısal id) ----
const EPOCH = 1420070400000; // 2015-01-01
let lastTs = 0;
let seq = 0;
function snowflake() {
  let ts = Date.now();
  if (ts <= lastTs) { seq = (seq + 1) & 4095; if (seq === 0) ts = ++lastTs; } else { seq = 0; lastTs = ts; }
  const rand = BigInt(Math.floor(Math.random() * 1024));
  const id = (BigInt(ts - EPOCH) << 22n) | (rand << 12n) | BigInt(seq);
  return id.toString();
}

// Eski UUID tabanlı sunucu/kanal id'lerini snowflake'e çevir (bir kez).
function migrateToSnowflake() {
  if (data.idFormat === 'snowflake') return;
  const serverIdMap = {};
  const channelIdMap = {};
  const newServers = {};
  for (const [oldId, server] of Object.entries(data.servers)) {
    const newId = snowflake();
    serverIdMap[oldId] = newId;
    server.id = newId;
    for (const ch of server.channels) {
      const newCh = snowflake();
      channelIdMap[ch.id] = newCh;
      ch.id = newCh;
    }
    newServers[newId] = server;
  }
  data.servers = newServers;
  for (const u of Object.values(data.users)) {
    if (Array.isArray(u.servers)) u.servers = u.servers.map((id) => serverIdMap[id] || id);
  }
  const newMessages = {};
  for (const [chId, msgs] of Object.entries(data.messages)) {
    newMessages[channelIdMap[chId] || chId] = msgs;
  }
  data.messages = newMessages;
  data.idFormat = 'snowflake';
  save();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
      if (err) console.error('data.json yazılamadı:', err.message);
    });
  }, 200);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function uniqueInviteCode() {
  let code;
  do { code = generateInviteCode(); } while (Object.values(data.servers).some((s) => s.inviteCode === code));
  return code;
}

function dmKey(a, b) {
  return [a, b].sort().join(':');
}

// ---- Users ----
export function findByUsername(username) {
  const lower = username.toLowerCase();
  return Object.values(data.users).find((u) => u.usernameLower === lower) || null;
}

export function findById(id) {
  return data.users[id] || null;
}

export function createUser(username, password) {
  if (findByUsername(username)) return { error: 'Bu kullanıcı adı zaten alınmış.' };
  const id = crypto.randomUUID();
  const { salt, hash } = hashPassword(password);
  data.users[id] = {
    id, username, usernameLower: username.toLowerCase(),
    salt, hash, friends: [], servers: [], createdAt: Date.now(),
  };
  save();
  return { user: data.users[id] };
}

export function verifyPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return safeEqual(hash, user.hash);
}

export function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  data.tokens[token] = userId;
  save();
  return token;
}

export function getUserByToken(token) {
  if (!token) return null;
  const userId = data.tokens[token];
  if (!userId) return null;
  return findById(userId);
}

export function deleteToken(token) {
  if (token && data.tokens[token]) { delete data.tokens[token]; save(); }
}

export function publicUser(user) {
  return { id: user.id, username: user.username };
}

// ---- Friends ----
export function addFriend(userId, friendUsername) {
  // Geriye dönük: doğrudan arkadaş eklemek yerine istek gönder.
  return sendFriendRequest(userId, friendUsername);
}

export function sendFriendRequest(userId, friendUsername) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  const friend = findByUsername(friendUsername);
  if (!friend) return { error: 'Kullanıcı bulunamadı.' };
  if (friend.id === userId) return { error: 'Kendinize istek gönderemezsiniz.' };
  if (user.friends.includes(friend.id)) return { error: 'Bu kişi zaten arkadaş listenizde.' };

  // Karşı tarafın size bekleyen isteği varsa otomatik kabul et.
  const reverse = Object.values(data.friendRequests).find(
    (r) => r.fromId === friend.id && r.toId === userId
  );
  if (reverse) {
    return acceptFriendRequest(userId, reverse.id);
  }

  const existing = Object.values(data.friendRequests).find(
    (r) => (r.fromId === userId && r.toId === friend.id) || (r.fromId === friend.id && r.toId === userId)
  );
  if (existing) return { error: 'Zaten bekleyen bir arkadaşlık isteği var.' };

  const id = snowflake();
  const request = { id, fromId: userId, toId: friend.id, createdAt: Date.now() };
  data.friendRequests[id] = request;
  save();
  return {
    request,
    from: { id: user.id, username: user.username },
    to: { id: friend.id, username: friend.username },
  };
}

export function acceptFriendRequest(userId, requestId) {
  const req = data.friendRequests[requestId];
  if (!req) return { error: 'İstek bulunamadı.' };
  if (req.toId !== userId) return { error: 'Bu isteği kabul edemezsiniz.' };
  const user = findById(userId);
  const other = findById(req.fromId);
  if (!user || !other) return { error: 'Kullanıcı bulunamadı.' };

  if (!user.friends.includes(other.id)) user.friends.push(other.id);
  if (!other.friends.includes(user.id)) other.friends.push(user.id);
  const now = Date.now();
  ensureSocial(user).friendSince[other.id] = now;
  ensureSocial(other).friendSince[user.id] = now;
  // Kapalı DM listesindeyse yeniden göster
  ensureSocial(user).closedDms = ensureSocial(user).closedDms.filter((id) => id !== other.id);
  ensureSocial(other).closedDms = ensureSocial(other).closedDms.filter((id) => id !== user.id);
  delete data.friendRequests[requestId];
  // İkisinin diğer yönlü bekleyen isteklerini de temizle
  for (const [id, r] of Object.entries(data.friendRequests)) {
    if (
      (r.fromId === userId && r.toId === other.id) ||
      (r.fromId === other.id && r.toId === userId)
    ) {
      delete data.friendRequests[id];
    }
  }
  save();
  return {
    friend: other,
    fromId: req.fromId,
    toId: req.toId,
  };
}

export function declineFriendRequest(userId, requestId) {
  const req = data.friendRequests[requestId];
  if (!req) return { error: 'İstek bulunamadı.' };
  // Alıcı reddeder veya gönderen iptal eder
  if (req.toId !== userId && req.fromId !== userId) {
    return { error: 'Bu isteği silemezsiniz.' };
  }
  delete data.friendRequests[requestId];
  save();
  return { success: true, request: req };
}

export function removeFriend(userId, friendId) {
  const user = findById(userId);
  const friend = findById(friendId);
  if (user) {
    user.friends = user.friends.filter((f) => f !== friendId);
    const s = ensureSocial(user);
    delete s.friendSince[friendId];
    s.pinnedDms = s.pinnedDms.filter((id) => id !== friendId);
    s.closedDms = s.closedDms.filter((id) => id !== friendId);
    delete s.mutedDms[friendId];
    delete s.unreadDms[friendId];
    delete s.notes[friendId];
  }
  if (friend) {
    friend.friends = friend.friends.filter((f) => f !== userId);
    const s = ensureSocial(friend);
    delete s.friendSince[userId];
    s.pinnedDms = s.pinnedDms.filter((id) => id !== userId);
    delete s.mutedDms[userId];
    delete s.unreadDms[userId];
    delete s.notes[userId];
  }
  save();
  return { success: true };
}

function ensureSocial(user) {
  if (!user?.social) user.social = {};
  const s = user.social;
  if (!Array.isArray(s.pinnedDms)) s.pinnedDms = [];
  if (!Array.isArray(s.closedDms)) s.closedDms = [];
  if (!s.mutedDms || typeof s.mutedDms !== 'object') s.mutedDms = {};
  if (!Array.isArray(s.ignored)) s.ignored = [];
  if (!Array.isArray(s.blocked)) s.blocked = [];
  if (!s.unreadDms || typeof s.unreadDms !== 'object') s.unreadDms = {};
  if (!s.friendSince || typeof s.friendSince !== 'object') s.friendSince = {};
  if (!s.notes || typeof s.notes !== 'object') s.notes = {};
  if (!Array.isArray(s.pinnedGroups)) s.pinnedGroups = [];
  if (!Array.isArray(s.closedGroups)) s.closedGroups = [];
  if (!s.mutedGroups || typeof s.mutedGroups !== 'object') s.mutedGroups = {};
  if (!s.unreadGroups || typeof s.unreadGroups !== 'object') s.unreadGroups = {};
  return s;
}

export function getSocial(userId) {
  const user = findById(userId);
  if (!user) return null;
  return { ...ensureSocial(user) };
}

export function setDmPinned(userId, friendId, pinned) {
  const user = findById(userId);
  if (!user?.friends.includes(friendId)) return { error: 'Arkadaş bulunamadı.' };
  const s = ensureSocial(user);
  s.pinnedDms = s.pinnedDms.filter((id) => id !== friendId);
  if (pinned) s.pinnedDms.unshift(friendId);
  s.closedDms = s.closedDms.filter((id) => id !== friendId);
  save();
  return { social: getSocial(userId) };
}

export function closeDm(userId, friendId) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  const s = ensureSocial(user);
  if (!s.closedDms.includes(friendId)) s.closedDms.push(friendId);
  s.pinnedDms = s.pinnedDms.filter((id) => id !== friendId);
  delete s.unreadDms[friendId];
  save();
  return { social: getSocial(userId) };
}

export function reopenDm(userId, friendId) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  const s = ensureSocial(user);
  s.closedDms = s.closedDms.filter((id) => id !== friendId);
  save();
  return { social: getSocial(userId) };
}

export function markDmRead(userId, friendId) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  delete ensureSocial(user).unreadDms[friendId];
  save();
  return { social: getSocial(userId) };
}

export function setDmMuted(userId, friendId, until) {
  const user = findById(userId);
  if (!user?.friends.includes(friendId)) return { error: 'Arkadaş bulunamadı.' };
  const s = ensureSocial(user);
  if (until === null || until === undefined) delete s.mutedDms[friendId];
  else s.mutedDms[friendId] = until; // 0 = sonsuza kadar
  save();
  return { social: getSocial(userId) };
}

export function setIgnored(userId, targetId, ignored) {
  const user = findById(userId);
  if (!user || targetId === userId) return { error: 'Geçersiz.' };
  const s = ensureSocial(user);
  s.ignored = s.ignored.filter((id) => id !== targetId);
  if (ignored) s.ignored.push(targetId);
  save();
  return { social: getSocial(userId) };
}

export function setBlocked(userId, targetId, blocked) {
  const user = findById(userId);
  if (!user || targetId === userId) return { error: 'Geçersiz.' };
  const s = ensureSocial(user);
  s.blocked = s.blocked.filter((id) => id !== targetId);
  if (blocked) {
    s.blocked.push(targetId);
  }
  save();
  return { social: getSocial(userId) };
}

export function isBlockedBy(blockerId, targetId) {
  const user = findById(blockerId);
  if (!user) return false;
  return ensureSocial(user).blocked.includes(targetId);
}

export function blockState(viewerId, targetId) {
  return {
    blockedByMe: isBlockedBy(viewerId, targetId),
    blockedByThem: isBlockedBy(targetId, viewerId),
  };
}

export function setFriendNote(userId, friendId, note) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  ensureSocial(user).notes[friendId] = String(note || '').slice(0, 500);
  save();
  return { social: getSocial(userId) };
}

export function isBlockedEither(a, b) {
  const ua = findById(a);
  const ub = findById(b);
  if (!ua || !ub) return true;
  return ensureSocial(ua).blocked.includes(b) || ensureSocial(ub).blocked.includes(a);
}

export function isDmMuted(userId, friendId) {
  const user = findById(userId);
  if (!user) return false;
  const until = ensureSocial(user).mutedDms[friendId];
  if (until === undefined) return false;
  if (until === 0) return true;
  if (Date.now() > until) {
    delete ensureSocial(user).mutedDms[friendId];
    save();
    return false;
  }
  return true;
}

export function inviteToServer(inviterId, serverId, targetUserId) {
  const server = getServer(serverId);
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isMember(server, inviterId)) return { error: 'Yetkiniz yok.' };
  const target = findById(targetUserId);
  if (!target) return { error: 'Kullanıcı bulunamadı.' };
  if (isBlockedEither(inviterId, targetUserId)) return { error: 'Bu kullanıcıya davet gönderilemez.' };
  if (isMember(server, targetUserId)) return { error: 'Kullanıcı zaten sunucuda.' };
  server.members.push(targetUserId);
  if (!target.servers.includes(serverId)) target.servers.push(serverId);
  save();
  return { server: publicServer(server) };
}

export function getUserProfile(viewerId, targetId) {
  const target = findById(targetId);
  const viewer = findById(viewerId);
  if (!target || !viewer) return { error: 'Kullanıcı bulunamadı.' };
  const vs = ensureSocial(viewer);
  const mutualFriends = viewer.friends
    .filter((id) => target.friends.includes(id))
    .map((id) => findById(id))
    .filter(Boolean)
    .map((u) => ({ id: u.id, username: u.username }));
  const viewerServers = new Set(viewer.servers || []);
  const mutualServers = (target.servers || [])
    .filter((id) => viewerServers.has(id))
    .map((id) => getServer(id))
    .filter(Boolean)
    .map((s) => ({ id: s.id, name: s.name }));
  return {
    user: { id: target.id, username: target.username, createdAt: target.createdAt },
    isFriend: viewer.friends.includes(targetId),
    friendSince: vs.friendSince[targetId] || null,
    note: vs.notes[targetId] || '',
    ignored: vs.ignored.includes(targetId),
    blocked: vs.blocked.includes(targetId),
    mutualFriends,
    mutualServers,
  };
}

export function getFriends(userId) {
  const user = findById(userId);
  if (!user) return [];
  return user.friends.map((id) => findById(id)).filter(Boolean).map((f) => ({ id: f.id, username: f.username }));
}

export function getFriendRequests(userId) {
  const incoming = [];
  const outgoing = [];
  for (const r of Object.values(data.friendRequests)) {
    if (r.toId === userId) {
      const from = findById(r.fromId);
      if (from) incoming.push({ id: r.id, user: { id: from.id, username: from.username }, createdAt: r.createdAt });
    } else if (r.fromId === userId) {
      const to = findById(r.toId);
      if (to) outgoing.push({ id: r.id, user: { id: to.id, username: to.username }, createdAt: r.createdAt });
    }
  }
  return { incoming, outgoing };
}

// ---- Servers ----
function publicServer(server) {
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

export function getUserServers(userId) {
  const user = findById(userId);
  if (!user) return [];
  return user.servers.map((id) => data.servers[id]).filter(Boolean).map(publicServer);
}

export function getServer(serverId) {
  return data.servers[serverId] || null;
}

export function isMember(server, userId) {
  return server.members.includes(userId);
}

export function isOwner(server, userId) {
  return server.ownerId === userId;
}

export function createServer(userId, name) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  if (!name || name.trim().length < 2 || name.trim().length > 32) {
    return { error: 'Sunucu adı 2-32 karakter olmalı.' };
  }
  const id = snowflake();
  const generalText = { id: snowflake(), name: 'genel', type: 'text', createdAt: Date.now() };
  const generalVoice = { id: snowflake(), name: 'Sesli', type: 'voice', createdAt: Date.now() };
  data.servers[id] = {
    id,
    name: name.trim(),
    ownerId: userId,
    members: [userId],
    channels: [generalText, generalVoice],
    inviteCode: uniqueInviteCode(),
    createdAt: Date.now(),
  };
  if (!user.servers.includes(id)) user.servers.push(id);
  save();
  return { server: publicServer(data.servers[id]) };
}

export function joinServerByCode(userId, code) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  const server = Object.values(data.servers).find((s) => s.inviteCode === (code || '').toUpperCase());
  if (!server) return { error: 'Geçersiz davet kodu.' };
  if (server.members.includes(userId)) return { server: publicServer(server) };
  server.members.push(userId);
  if (!user.servers.includes(server.id)) user.servers.push(server.id);
  save();
  return { server: publicServer(server) };
}

export function leaveServer(userId, serverId) {
  const server = data.servers[serverId];
  const user = findById(userId);
  if (!server || !user) return { error: 'Sunucu bulunamadı.' };
  if (server.ownerId === userId) return { error: 'Sahip sunucudan ayrılamaz. Önce sunucuyu silin.' };
  server.members = server.members.filter((m) => m !== userId);
  user.servers = user.servers.filter((s) => s !== serverId);
  save();
  return { success: true };
}

export function updateServer(userId, serverId, { name }) {
  const server = data.servers[serverId];
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  if (name) {
    if (name.trim().length < 2 || name.trim().length > 32) return { error: 'Ad 2-32 karakter olmalı.' };
    server.name = name.trim();
  }
  save();
  return { server: publicServer(server) };
}

export function deleteServer(userId, serverId) {
  const server = data.servers[serverId];
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  for (const memberId of server.members) {
    const u = findById(memberId);
    if (u) u.servers = u.servers.filter((s) => s !== serverId);
    for (const ch of server.channels) delete data.messages[ch.id];
  }
  delete data.servers[serverId];
  save();
  return { success: true };
}

export function findChannel(channelId) {
  for (const server of Object.values(data.servers)) {
    const ch = server.channels.find((c) => c.id === channelId);
    if (ch) return { server, channel: ch };
  }
  return null;
}

export function addChannel(userId, serverId, { name, type }) {
  const server = data.servers[serverId];
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  if (!name || name.trim().length < 1 || name.trim().length > 32) return { error: 'Kanal adı 1-32 karakter.' };
  if (!['text', 'voice'].includes(type)) return { error: 'Geçersiz kanal tipi.' };
  const channel = { id: snowflake(), name: name.trim(), type, createdAt: Date.now() };
  server.channels.push(channel);
  save();
  return { channel: { id: channel.id, name: channel.name, type: channel.type }, server: publicServer(server) };
}

export function deleteChannel(userId, serverId, channelId) {
  const server = data.servers[serverId];
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  if (server.channels.length <= 1) return { error: 'Son kanal silinemez.' };
  server.channels = server.channels.filter((c) => c.id !== channelId);
  delete data.messages[channelId];
  save();
  return { server: publicServer(server) };
}

export function renameChannel(userId, serverId, channelId, name) {
  const server = data.servers[serverId];
  if (!server) return { error: 'Sunucu bulunamadı.' };
  if (!isOwner(server, userId)) return { error: 'Yetkiniz yok.' };
  const ch = server.channels.find((c) => c.id === channelId);
  if (!ch) return { error: 'Kanal bulunamadı.' };
  if (!name || name.trim().length < 1 || name.trim().length > 32) return { error: 'Ad 1-32 karakter.' };
  ch.name = name.trim();
  save();
  return { channel: { id: ch.id, name: ch.name, type: ch.type }, server: publicServer(server) };
}

export function getServerMembers(serverId) {
  const server = data.servers[serverId];
  if (!server) return [];
  return server.members.map((id) => findById(id)).filter(Boolean).map(publicUser);
}

// ---- Messages ----
export function pushMessage(channelId, userId, username, text) {
  if (!data.messages[channelId]) data.messages[channelId] = [];
  const msg = { id: crypto.randomUUID(), userId, username, text: text.trim(), ts: Date.now() };
  data.messages[channelId].push(msg);
  if (data.messages[channelId].length > MAX_MESSAGES) {
    data.messages[channelId] = data.messages[channelId].slice(-MAX_MESSAGES);
  }
  save();
  return msg;
}

export function getMessages(channelId, limit = 50) {
  const msgs = data.messages[channelId] || [];
  return msgs.slice(-limit);
}

// ---- DMs ----
const MAX_GROUP_MEMBERS = 10;

function ensureDmChannelShape(ch) {
  if (!ch.type) ch.type = ch.users?.length > 2 ? 'group' : 'dm';
  if (!Array.isArray(ch.pins)) ch.pins = [];
  if (ch.name == null) ch.name = null;
  if (!ch.ownerId && ch.users?.[0]) ch.ownerId = ch.users[0];
  return ch;
}

function dmMsgKey(channel) {
  if (channel.type === 'group') return `g:${channel.id}`;
  return dmKey(channel.users[0], channel.users[1]);
}

export function pushDM(fromId, toId, text) {
  const channel = getOrCreateDMChannel(fromId, toId);
  return pushDmChannelMessage(channel.id, fromId, text);
}

export function pushDmChannelMessage(channelId, fromId, text) {
  const channel = getDMChannelById(channelId);
  if (!channel) return { error: 'Kanal bulunamadı.' };
  if (!channel.users.includes(fromId)) return { error: 'Yetkiniz yok.' };
  const key = dmMsgKey(channel);
  if (!data.dms[key]) data.dms[key] = [];
  const msg = { id: crypto.randomUUID(), fromId, text: text.trim(), ts: Date.now(), reactions: {}, replyTo: null };
  data.dms[key].push(msg);
  if (data.dms[key].length > MAX_MESSAGES) data.dms[key] = data.dms[key].slice(-MAX_MESSAGES);
  channel.lastMessageAt = msg.ts;
  channel.lastFromId = fromId;
  for (const uid of channel.users) {
    if (uid === fromId) continue;
    const user = findById(uid);
    if (!user) continue;
    const s = ensureSocial(user);
    if (channel.type === 'group') {
      s.closedGroups = (s.closedGroups || []).filter((id) => id !== channelId);
      if (!s.unreadGroups) s.unreadGroups = {};
      s.unreadGroups[channelId] = true;
    } else {
      const other = channel.users.find((u) => u !== uid);
      s.closedDms = s.closedDms.filter((id) => id !== other);
      s.unreadDms[other] = true;
    }
  }
  save();
  return { message: msg, channel: publicDmChannel(channel, fromId) };
}

export function getDMs(userId, friendId, limit = 50) {
  const channel = getOrCreateDMChannel(userId, friendId);
  return getDmChannelMessages(channel.id, limit);
}

export function getDmChannelMessages(channelId, limit = 50) {
  const channel = getDMChannelById(channelId);
  if (!channel) return [];
  const msgs = data.dms[dmMsgKey(channel)] || [];
  return msgs.slice(-limit);
}

export function searchDmChannel(userId, channelId, query, limit = 50) {
  const channel = getDMChannelById(channelId);
  if (!channel || !channel.users.includes(userId)) return { error: 'Kanal bulunamadı.' };
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 1) return { results: [] };
  const msgs = data.dms[dmMsgKey(channel)] || [];
  const results = [];
  for (let i = msgs.length - 1; i >= 0 && results.length < limit; i--) {
    const m = msgs[i];
    if ((m.text || '').toLowerCase().includes(q)) {
      const author = findById(m.fromId);
      results.push({
        ...m,
        username: author?.username || '—',
      });
    }
  }
  return { results, channelId, query: q };
}

export function pinDmMessage(userId, channelId, messageId, pinned = true) {
  const channel = getDMChannelById(channelId);
  if (!channel || !channel.users.includes(userId)) return { error: 'Kanal bulunamadı.' };
  ensureDmChannelShape(channel);
  const msgs = data.dms[dmMsgKey(channel)] || [];
  const msg = msgs.find((m) => m.id === messageId);
  if (!msg && pinned) return { error: 'Mesaj bulunamadı.' };
  channel.pins = channel.pins.filter((p) => p.messageId !== messageId);
  if (pinned && msg) {
    channel.pins.unshift({
      messageId: msg.id,
      fromId: msg.fromId,
      text: msg.text,
      ts: msg.ts,
      pinnedBy: userId,
      pinnedAt: Date.now(),
    });
    if (channel.pins.length > 50) channel.pins = channel.pins.slice(0, 50);
  }
  save();
  return { pins: channel.pins.map(enrichPin), channelId };
}

function enrichPin(p) {
  const author = findById(p.fromId);
  return { ...p, username: author?.username || '—' };
}

export function getDmPins(userId, channelId) {
  const channel = getDMChannelById(channelId);
  if (!channel || !channel.users.includes(userId)) return { error: 'Kanal bulunamadı.' };
  ensureDmChannelShape(channel);
  return { pins: channel.pins.map(enrichPin) };
}

export function reactDmMessage(userId, channelId, messageId, emoji) {
  const channel = getDMChannelById(channelId);
  if (!channel || !channel.users.includes(userId)) return { error: 'Kanal bulunamadı.' };
  const em = String(emoji || '').trim().slice(0, 16);
  if (!em) return { error: 'Emoji gerekli.' };
  const msgs = data.dms[dmMsgKey(channel)] || [];
  const msg = msgs.find((m) => m.id === messageId);
  if (!msg) return { error: 'Mesaj bulunamadı.' };
  if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
  if (!Array.isArray(msg.reactions[em])) msg.reactions[em] = [];
  const list = msg.reactions[em];
  const idx = list.indexOf(userId);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(userId);
  if (list.length === 0) delete msg.reactions[em];
  save();
  return { messageId, reactions: msg.reactions, channelId };
}

export function markDmUnread(userId, friendId) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  ensureSocial(user).unreadDms[friendId] = true;
  save();
  return { social: getSocial(userId) };
}

export function setDmReply(channelId, fromId, text, replyTo) {
  const result = pushDmChannelMessage(channelId, fromId, text);
  if (result.error) return result;
  if (replyTo && result.message) {
    const channel = getDMChannelById(channelId);
    const msgs = data.dms[dmMsgKey(channel)] || [];
    const msg = msgs.find((m) => m.id === result.message.id);
    if (msg) {
      msg.replyTo = {
        id: replyTo.id,
        fromId: replyTo.fromId,
        text: String(replyTo.text || '').slice(0, 200),
        username: replyTo.username || null,
      };
      result.message = msg;
      save();
    }
  }
  return result;
}

// ---- DM Channels (URL için kalıcı sayısal id) ----
export function getOrCreateDMChannel(a, b) {
  const key = dmKey(a, b);
  let found = Object.values(data.dmChannels).find((c) => {
    ensureDmChannelShape(c);
    return c.type === 'dm' && c.users.length === 2 && dmKey(c.users[0], c.users[1]) === key;
  });
  if (!found) {
    const id = snowflake();
    found = {
      id, type: 'dm', name: null, ownerId: a,
      users: [a, b], createdAt: Date.now(), lastMessageAt: 0, lastFromId: null, pins: [],
    };
    data.dmChannels[id] = found;
    save();
  }
  return ensureDmChannelShape(found);
}

export function getDMChannelById(id) {
  const ch = data.dmChannels[id] || null;
  return ch ? ensureDmChannelShape(ch) : null;
}

export function publicDmChannel(channel, viewerId = null) {
  ensureDmChannelShape(channel);
  const members = channel.users.map((id) => {
    const u = findById(id);
    return u ? { id: u.id, username: u.username } : { id, username: '—' };
  });
  let title = channel.name;
  if (!title) {
    if (channel.type === 'group') title = members.map((m) => m.username).join(', ');
    else {
      const other = channel.users.find((id) => id !== viewerId) || channel.users[0];
      title = findById(other)?.username || 'DM';
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

export function createGroupDM(creatorId, memberIds = [], name = null) {
  const creator = findById(creatorId);
  if (!creator) return { error: 'Oturum geçersiz.' };
  const ids = [...new Set([creatorId, ...memberIds.map(String)])];
  if (ids.length < 2) return { error: 'En az bir kişi seçmelisin.' };
  if (ids.length > MAX_GROUP_MEMBERS) return { error: `En fazla ${MAX_GROUP_MEMBERS} kişi olabilir.` };
  for (const id of ids) {
    if (id === creatorId) continue;
    if (!creator.friends.includes(id)) return { error: 'Sadece arkadaşlarını ekleyebilirsin.' };
    const other = findById(id);
    if (!other) return { error: 'Kullanıcı bulunamadı.' };
    if (isBlockedEither(creatorId, id)) return { error: 'Engelli kullanıcı eklenemez.' };
  }
  // Tamamen aynı üyelerle mevcut grup varsa onu aç
  const sorted = [...ids].sort().join(':');
  const existing = Object.values(data.dmChannels).find((c) => {
    ensureDmChannelShape(c);
    return c.type === 'group' && [...c.users].sort().join(':') === sorted;
  });
  if (existing) return { channel: publicDmChannel(existing, creatorId) };

  const id = snowflake();
  const channel = {
    id,
    type: 'group',
    name: name ? String(name).trim().slice(0, 100) || null : null,
    ownerId: creatorId,
    users: ids,
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    lastFromId: null,
    pins: [],
  };
  data.dmChannels[id] = channel;
  save();
  return { channel: publicDmChannel(channel, creatorId) };
}

export function updateGroupDM(userId, channelId, { name } = {}) {
  const channel = getDMChannelById(channelId);
  if (!channel || channel.type !== 'group') return { error: 'Grup bulunamadı.' };
  if (!channel.users.includes(userId)) return { error: 'Yetkiniz yok.' };
  if (name !== undefined) channel.name = String(name || '').trim().slice(0, 100) || null;
  save();
  return { channel: publicDmChannel(channel, userId) };
}

export function leaveGroupDM(userId, channelId) {
  const channel = getDMChannelById(channelId);
  if (!channel || channel.type !== 'group') return { error: 'Grup bulunamadı.' };
  if (!channel.users.includes(userId)) return { error: 'Zaten üye değilsin.' };
  channel.users = channel.users.filter((id) => id !== userId);
  const u = findById(userId);
  if (u) {
    const s = ensureSocial(u);
    s.pinnedGroups = s.pinnedGroups.filter((id) => id !== channelId);
    s.closedGroups = s.closedGroups.filter((id) => id !== channelId);
    delete s.unreadGroups[channelId];
    delete s.mutedGroups[channelId];
  }
  if (channel.users.length < 2) {
    delete data.dmChannels[channelId];
    delete data.dms[`g:${channelId}`];
  } else if (channel.ownerId === userId) {
    channel.ownerId = channel.users[0];
  }
  save();
  return { success: true, channel: channel.users.length >= 2 ? publicDmChannel(channel, userId) : null };
}

export function getUserGroupDMs(userId) {
  const social = getSocial(userId) || {};
  return Object.values(data.dmChannels)
    .map(ensureDmChannelShape)
    .filter((c) => c.type === 'group' && c.users.includes(userId))
    .map((c) => {
      const pub = publicDmChannel(c, userId);
      return {
        ...pub,
        pinned: (social.pinnedGroups || []).includes(c.id),
        closed: (social.closedGroups || []).includes(c.id),
        unread: !!(social.unreadGroups || {})[c.id],
        mutedUntil: (social.mutedGroups || {})[c.id] ?? null,
      };
    });
}

export function setGroupPinned(userId, channelId, pinned) {
  const user = findById(userId);
  const channel = getDMChannelById(channelId);
  if (!user || !channel || channel.type !== 'group' || !channel.users.includes(userId)) {
    return { error: 'Grup bulunamadı.' };
  }
  const s = ensureSocial(user);
  if (!Array.isArray(s.pinnedGroups)) s.pinnedGroups = [];
  s.pinnedGroups = s.pinnedGroups.filter((id) => id !== channelId);
  if (pinned) s.pinnedGroups.unshift(channelId);
  if (!Array.isArray(s.closedGroups)) s.closedGroups = [];
  s.closedGroups = s.closedGroups.filter((id) => id !== channelId);
  save();
  return { social: getSocial(userId) };
}

export function closeGroupDm(userId, channelId) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  const s = ensureSocial(user);
  if (!Array.isArray(s.closedGroups)) s.closedGroups = [];
  if (!s.closedGroups.includes(channelId)) s.closedGroups.push(channelId);
  if (s.pinnedGroups) s.pinnedGroups = s.pinnedGroups.filter((id) => id !== channelId);
  if (s.unreadGroups) delete s.unreadGroups[channelId];
  save();
  return { social: getSocial(userId) };
}

export function markGroupRead(userId, channelId) {
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  const s = ensureSocial(user);
  if (s.unreadGroups) delete s.unreadGroups[channelId];
  save();
  return { social: getSocial(userId) };
}

export function setGroupMuted(userId, channelId, until) {
  const user = findById(userId);
  const channel = getDMChannelById(channelId);
  if (!user || !channel?.users.includes(userId)) return { error: 'Grup bulunamadı.' };
  const s = ensureSocial(user);
  if (!s.mutedGroups) s.mutedGroups = {};
  if (until === null || until === undefined) delete s.mutedGroups[channelId];
  else s.mutedGroups[channelId] = until;
  save();
  return { social: getSocial(userId) };
}

export function isGroupMuted(userId, channelId) {
  const user = findById(userId);
  if (!user) return false;
  const until = ensureSocial(user).mutedGroups?.[channelId];
  if (until === undefined) return false;
  if (until === 0) return true;
  if (Date.now() > until) {
    delete ensureSocial(user).mutedGroups[channelId];
    save();
    return false;
  }
  return true;
}

export function getDmActivity(userId, friendId) {
  const channel = Object.values(data.dmChannels).find((c) => {
    ensureDmChannelShape(c);
    return c.type === 'dm' && c.users.includes(userId) && c.users.includes(friendId);
  });
  if (channel?.lastMessageAt) return { lastMessageAt: channel.lastMessageAt, lastFromId: channel.lastFromId || null, dmChannelId: channel.id };
  const msgs = getDMs(userId, friendId, 1);
  const last = msgs[msgs.length - 1];
  return { lastMessageAt: last?.ts || 0, lastFromId: last?.fromId || null, dmChannelId: channel?.id || null };
}

load();
