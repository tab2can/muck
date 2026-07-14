import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_MESSAGES = 200;

let data = { users: {}, tokens: {}, servers: {}, messages: {}, dms: {}, dmChannels: {} };

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
      for (const u of Object.values(data.users)) {
        if (!u.friends) u.friends = [];
        if (!u.servers) u.servers = [];
      }
      migrateToSnowflake();
    }
  } catch (err) {
    console.error('data.json okunamadı:', err.message);
    data = { users: {}, tokens: {}, servers: {}, messages: {}, dms: {}, dmChannels: {} };
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
  const user = findById(userId);
  if (!user) return { error: 'Oturum geçersiz.' };
  const friend = findByUsername(friendUsername);
  if (!friend) return { error: 'Kullanıcı bulunamadı.' };
  if (friend.id === userId) return { error: 'Kendinizi ekleyemezsiniz.' };
  if (user.friends.includes(friend.id)) return { error: 'Bu kişi zaten arkadaş listenizde.' };
  user.friends.push(friend.id);
  friend.friends.push(user.id);
  save();
  return { friend };
}

export function removeFriend(userId, friendId) {
  const user = findById(userId);
  const friend = findById(friendId);
  if (user) user.friends = user.friends.filter((f) => f !== friendId);
  if (friend) friend.friends = friend.friends.filter((f) => f !== userId);
  save();
  return { success: true };
}

export function getFriends(userId) {
  const user = findById(userId);
  if (!user) return [];
  return user.friends.map((id) => findById(id)).filter(Boolean).map((f) => ({ id: f.id, username: f.username }));
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
export function pushDM(fromId, toId, text) {
  const key = dmKey(fromId, toId);
  if (!data.dms[key]) data.dms[key] = [];
  const msg = { id: crypto.randomUUID(), fromId, text: text.trim(), ts: Date.now() };
  data.dms[key].push(msg);
  if (data.dms[key].length > MAX_MESSAGES) data.dms[key] = data.dms[key].slice(-MAX_MESSAGES);
  save();
  return msg;
}

export function getDMs(userId, friendId, limit = 50) {
  const key = dmKey(userId, friendId);
  const msgs = data.dms[key] || [];
  return msgs.slice(-limit);
}

// ---- DM Channels (URL için kalıcı sayısal id) ----
export function getOrCreateDMChannel(a, b) {
  const key = dmKey(a, b);
  let found = Object.values(data.dmChannels).find((c) => dmKey(c.users[0], c.users[1]) === key);
  if (!found) {
    const id = snowflake();
    found = { id, users: [a, b], createdAt: Date.now() };
    data.dmChannels[id] = found;
    save();
  }
  return found;
}

export function getDMChannelById(id) {
  return data.dmChannels[id] || null;
}

load();
