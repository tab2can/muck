import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

const COOKIE_OPTS = {
  httpOnly: false,
  sameSite: 'lax',
  secure: isProduction,
  maxAge: 1000 * 60 * 60 * 24 * 365,
  path: '/',
};

function validUsername(u) { return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u); }
function validPassword(p) { return typeof p === 'string' && p.length >= 4 && p.length <= 100; }

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter, harf/rakam/alt çizgi olmalı.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı.' });
  const result = store.createUser(username, password);
  if (result.error) return res.status(409).json({ error: result.error });
  const token = store.createToken(result.user.id);
  res.cookie('muck_token', token, COOKIE_OPTS);
  res.json({ token, user: store.publicUser(result.user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.findByUsername(username || '');
  if (!user || !store.verifyPassword(user, password || '')) {
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  }
  const token = store.createToken(user.id);
  res.cookie('muck_token', token, COOKIE_OPTS);
  res.json({ token, user: store.publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  store.deleteToken(req.cookies?.muck_token || req.cookies?.streamuck_token);
  res.clearCookie('muck_token', { path: '/' });
  res.clearCookie('streamuck_token', { path: '/' });
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const user = store.getUserByToken(req.cookies?.muck_token || req.cookies?.streamuck_token);
  if (!user) return res.status(401).json({ error: 'Oturum yok.' });
  res.json({ user: store.publicUser(user) });
});

// WebRTC ICE/TURN kimlik bilgisi (zaman sınırlı, coturn use-auth-secret)
app.get('/api/ice', (req, res) => {
  const stun = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const enabled = process.env.TURN_ENABLED === '1' || process.env.TURN_ENABLED === 'true';
  const host = process.env.TURN_HOST || 'muck.tr';
  const secret = process.env.TURN_SECRET;

  if (!enabled || !secret) {
    return res.json({ iceServers: stun, turn: false });
  }

  const ttl = 12 * 3600; // 12 saat
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:muck`;
  const credential = crypto
    .createHmac('sha1', secret)
    .update(username)
    .digest('base64');

  res.json({
    turn: true,
    iceServers: [
      ...stun,
      { urls: `stun:${host}:3478` },
      {
        urls: [
          `turn:${host}:3478?transport=udp`,
          `turn:${host}:3478?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
  });
});

const PUBLIC_DIR = path.join(__dirname, '../public');
app.use(express.static(PUBLIC_DIR));
app.get(/^(?!\/api\/|\/socket\.io\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---- Runtime state ----
// userId -> Set<socketId>
const onlineUsers = new Map();
// channelId -> Map<socketId, { userId, username, muted, camera, screen }>
const voiceParticipants = new Map();

function isOnline(userId) { return onlineUsers.has(userId); }

function friendsSnapshot(userId) {
  return store.getFriends(userId).map((f) => ({
    id: f.id, username: f.username, online: isOnline(f.id),
  }));
}

function notifyFriendsOfChange(userId) {
  const user = store.findById(userId);
  if (!user) return;
  const payload = { id: user.id, username: user.username, online: isOnline(userId) };
  for (const friendId of user.friends) {
    const sockets = onlineUsers.get(friendId);
    if (sockets) for (const sid of sockets) io.to(sid).emit('friend-update', payload);
  }
}

function getVoiceList(channelId) {
  const map = voiceParticipants.get(channelId);
  if (!map) return [];
  return [...map.entries()].map(([sid, v]) => ({
    socketId: sid, userId: v.userId, username: v.username,
    muted: !!v.muted, deafened: !!v.deafened, camera: !!v.camera, screen: !!v.screen,
    camId: v.camId || null, screenId: v.screenId || null,
  }));
}

function broadcastVoicePresence(channelId) {
  io.to(`voice:${channelId}`).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
  // Sunucu üyelerine de bildir (sidebar'da göstermek için)
  const found = store.findChannel(channelId);
  if (found) {
    for (const memberId of found.server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
    }
  }
}

function leaveVoice(socket) {
  const channelId = socket.data.voiceChannelId;
  if (!channelId) return;
  const map = voiceParticipants.get(channelId);
  if (map) {
    map.delete(socket.id);
    if (map.size === 0) voiceParticipants.delete(channelId);
  }
  socket.to(`voice:${channelId}`).emit('voice-peer-left', { userId: socket.data.userId, socketId: socket.id });
  socket.leave(`voice:${channelId}`);
  socket.data.voiceChannelId = null;
  broadcastVoicePresence(channelId);
}

io.use((socket, next) => {
  const user = store.getUserByToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  socket.data.username = user.username;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  const wasOffline = !onlineUsers.has(userId);
  if (wasOffline) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);

  socket.emit('init', {
    user: { id: userId, username: socket.data.username },
    friends: friendsSnapshot(userId),
    servers: store.getUserServers(userId),
  });
  if (wasOffline) notifyFriendsOfChange(userId);

  // ---- Friends ----
  socket.on('add-friend', ({ username }, cb) => {
    const result = store.addFriend(userId, username);
    if (result.error) return cb?.({ error: result.error });
    const friend = result.friend;
    cb?.({ friend: { id: friend.id, username: friend.username, online: isOnline(friend.id) } });
    notifyFriendsOfChange(userId);
    notifyFriendsOfChange(friend.id);
  });

  socket.on('remove-friend', ({ friendId }, cb) => {
    store.removeFriend(userId, friendId);
    cb?.({ success: true });
    notifyFriendsOfChange(userId);
    notifyFriendsOfChange(friendId);
  });

  // ---- Servers ----
  socket.on('create-server', ({ name }, cb) => {
    const result = store.createServer(userId, name);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
  });

  socket.on('join-server', ({ code }, cb) => {
    const result = store.joinServerByCode(userId, code);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
    for (const memberId of store.getServer(result.server.id).members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  socket.on('leave-server', ({ serverId }, cb) => {
    const result = store.leaveServer(userId, serverId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ success: true });
  });

  socket.on('get-server', ({ serverId }, cb) => {
    const server = store.getServer(serverId);
    if (!server || !store.isMember(server, userId)) return cb?.({ error: 'Sunucu bulunamadı.' });
    cb?.({
      server: {
        id: server.id, name: server.name, ownerId: server.ownerId,
        inviteCode: server.inviteCode,
        channels: server.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        members: store.getServerMembers(serverId),
      },
      // Ses kanallarındaki mevcut katılımcılar (sayfa yenilenince de görünsün).
      voice: server.channels
        .filter((c) => c.type === 'voice')
        .map((c) => ({ channelId: c.id, participants: getVoiceList(c.id) })),
    });
  });

  socket.on('update-server', ({ serverId, name }, cb) => {
    const result = store.updateServer(userId, serverId, { name });
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
    const server = store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  socket.on('delete-server', ({ serverId }, cb) => {
    const server = store.getServer(serverId);
    if (!server) return cb?.({ error: 'Sunucu bulunamadı.' });
    const members = [...server.members];
    const result = store.deleteServer(userId, serverId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ success: true });
    for (const memberId of members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-deleted', { serverId });
    }
  });

  socket.on('create-channel', ({ serverId, name, type }, cb) => {
    const result = store.addChannel(userId, serverId, { name, type });
    if (result.error) return cb?.({ error: result.error });
    cb?.({ channel: result.channel, server: result.server });
    const server = store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  socket.on('delete-channel', ({ serverId, channelId }, cb) => {
    const result = store.deleteChannel(userId, serverId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
    const server = store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  socket.on('rename-channel', ({ serverId, channelId, name }, cb) => {
    const result = store.renameChannel(userId, serverId, channelId, name);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ channel: result.channel, server: result.server });
    const server = store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  // ---- Text channels ----
  socket.on('open-text-channel', ({ channelId }, cb) => {
    const found = store.findChannel(channelId);
    if (!found) return cb?.({ error: 'Kanal bulunamadı.' });
    if (!store.isMember(found.server, userId)) return cb?.({ error: 'Yetkiniz yok.' });
    if (found.channel.type !== 'text') return cb?.({ error: 'Metin kanalı değil.' });
    if (socket.data.textChannelId) socket.leave(`chan:${socket.data.textChannelId}`);
    socket.join(`chan:${channelId}`);
    socket.data.textChannelId = channelId;
    cb?.({ messages: store.getMessages(channelId) });
  });

  socket.on('send-message', ({ channelId, text }, cb) => {
    if (!text?.trim()) return cb?.({ error: 'Boş mesaj.' });
    const found = store.findChannel(channelId);
    if (!found || !store.isMember(found.server, userId)) return cb?.({ error: 'Yetkiniz yok.' });
    const msg = store.pushMessage(channelId, userId, socket.data.username, text);
    io.to(`chan:${channelId}`).emit('message', { channelId, message: msg });
    cb?.({ success: true });
  });

  // ---- DMs ----
  socket.on('open-dm', ({ friendId }, cb) => {
    const friend = store.findById(friendId);
    const user = store.findById(userId);
    if (!friend || !user?.friends.includes(friendId)) return cb?.({ error: 'Arkadaş bulunamadı.' });
    const channel = store.getOrCreateDMChannel(userId, friendId);
    cb?.({
      messages: store.getDMs(userId, friendId),
      friend: { id: friend.id, username: friend.username },
      dmChannelId: channel.id,
    });
  });

  socket.on('get-dm-by-channel', ({ dmChannelId }, cb) => {
    const channel = store.getDMChannelById(dmChannelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });
    const friendId = channel.users.find((u) => u !== userId);
    const friend = store.findById(friendId);
    const user = store.findById(userId);
    if (!friend || !user?.friends.includes(friendId)) return cb?.({ error: 'Arkadaş bulunamadı.' });
    cb?.({
      messages: store.getDMs(userId, friendId),
      friend: { id: friend.id, username: friend.username },
      friendId,
      dmChannelId: channel.id,
    });
  });

  socket.on('send-dm', ({ friendId, text }, cb) => {
    if (!text?.trim()) return cb?.({ error: 'Boş mesaj.' });
    const user = store.findById(userId);
    if (!user?.friends.includes(friendId)) return cb?.({ error: 'Arkadaş değil.' });
    const msg = store.pushDM(userId, friendId, text);
    const payload = { fromId: userId, username: socket.data.username, message: msg };
    const sockets = onlineUsers.get(friendId);
    if (sockets) for (const sid of sockets) io.to(sid).emit('dm', { friendId: userId, ...payload });
    cb?.({ message: msg });
  });

  // ---- Voice channels (mesh signaling) ----
  socket.on('join-voice', ({ channelId }, cb) => {
    const found = store.findChannel(channelId);
    if (!found) return cb?.({ error: 'Kanal bulunamadı.' });
    if (!store.isMember(found.server, userId)) return cb?.({ error: 'Yetkiniz yok.' });
    if (found.channel.type !== 'voice') return cb?.({ error: 'Ses kanalı değil.' });

    // Önceki ses kanalından ayrıl
    if (socket.data.voiceChannelId && socket.data.voiceChannelId !== channelId) leaveVoice(socket);

    if (!voiceParticipants.has(channelId)) voiceParticipants.set(channelId, new Map());
    const map = voiceParticipants.get(channelId);
    const existing = [...map.entries()].filter(([sid]) => sid !== socket.id);

    map.set(socket.id, {
      userId, username: socket.data.username,
      muted: false, deafened: false, camera: false, screen: false, camId: null, screenId: null,
    });
    socket.join(`voice:${channelId}`);
    socket.data.voiceChannelId = channelId;

    cb?.({
      participants: existing.map(([sid, v]) => ({
        socketId: sid, userId: v.userId, username: v.username,
        muted: !!v.muted, deafened: !!v.deafened, camera: !!v.camera, screen: !!v.screen,
        camId: v.camId || null, screenId: v.screenId || null,
      })),
    });

    socket.to(`voice:${channelId}`).emit('voice-peer-joined', {
      userId, username: socket.data.username, socketId: socket.id,
    });
    broadcastVoicePresence(channelId);
  });

  socket.on('leave-voice', () => {
    leaveVoice(socket);
  });

  socket.on('voice-state', ({ muted, deafened, camera, screen, camId, screenId }) => {
    const channelId = socket.data.voiceChannelId;
    if (!channelId) return;
    const map = voiceParticipants.get(channelId);
    const entry = map?.get(socket.id);
    if (!entry) return;
    if (muted !== undefined) entry.muted = muted;
    if (deafened !== undefined) entry.deafened = deafened;
    if (camera !== undefined) entry.camera = camera;
    if (screen !== undefined) entry.screen = screen;
    if (camId !== undefined) entry.camId = camId;
    if (screenId !== undefined) entry.screenId = screenId;
    broadcastVoicePresence(channelId);
  });

  socket.on('voice-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('voice-offer', { fromId: socket.id, userId, username: socket.data.username, offer });
  });
  socket.on('voice-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('voice-answer', { fromId: socket.id, answer });
  });
  socket.on('voice-ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('voice-ice', { fromId: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    leaveVoice(socket);
    if (socket.data.textChannelId) socket.leave(`chan:${socket.data.textChannelId}`);

    const set = onlineUsers.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(userId);
        notifyFriendsOfChange(userId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Muck çalışıyor: http://localhost:${PORT}`);
});
