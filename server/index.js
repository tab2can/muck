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
// DM arama zili: channelId -> { fromId, fromUsername, timer }
const dmCallRings = new Map();
// DM yalnız kalma: channelId -> timeout
const dmAloneTimers = new Map();
const DM_RING_MS = 20_000;
const DM_ALONE_MS = 2 * 60_000;

function clearDmRing(channelId, reason = 'cancel') {
  const ring = dmCallRings.get(channelId);
  if (!ring) return null;
  clearTimeout(ring.timer);
  dmCallRings.delete(channelId);
  const channel = store.getDMChannelById(channelId);
  if (channel) {
    emitToChannelUsers(channel, 'dm-call-ring-ended', {
      channelId,
      reason,
      fromId: ring.fromId,
      fromUsername: ring.fromUsername,
    });
  }
  return ring;
}

function refreshDmAloneTimer(channelId) {
  const prev = dmAloneTimers.get(channelId);
  if (prev) {
    clearTimeout(prev);
    dmAloneTimers.delete(channelId);
  }
  const channel = store.getDMChannelById(channelId);
  if (!channel) return;
  const map = voiceParticipants.get(channelId);
  if (!map || map.size !== 1) return;
  const [sid] = map.keys();
  const sock = io.sockets.sockets.get(sid);
  if (!sock?.data?.dmCall) return;

  dmAloneTimers.set(channelId, setTimeout(() => {
    dmAloneTimers.delete(channelId);
    const still = voiceParticipants.get(channelId);
    if (!still || still.size !== 1) return;
    for (const [aloneSid] of still) {
      const s = io.sockets.sockets.get(aloneSid);
      if (!s?.data?.dmCall) continue;
      s.emit('dm-call-alone-timeout', { channelId });
      leaveVoice(s);
    }
  }, DM_ALONE_MS));
}

function kickDmCallParticipants(channelId) {
  const map = voiceParticipants.get(channelId);
  if (!map) return;
  for (const sid of [...map.keys()]) {
    const s = io.sockets.sockets.get(sid);
    if (s?.data?.dmCall) leaveVoice(s);
  }
}

function isOnline(userId) { return onlineUsers.has(userId); }

function friendsSnapshot(userId) {
  const social = store.getSocial(userId) || {};
  return store.getFriends(userId).map((f) => {
    const act = store.getDmActivity(userId, f.id);
    const mutedUntil = social.mutedDms?.[f.id];
    const bs = store.blockState(userId, f.id);
    return {
      id: f.id,
      username: f.username,
      online: isOnline(f.id),
      pinned: (social.pinnedDms || []).includes(f.id),
      closed: (social.closedDms || []).includes(f.id),
      unread: !!social.unreadDms?.[f.id],
      ignored: (social.ignored || []).includes(f.id),
      blocked: bs.blockedByMe,
      blockedByThem: bs.blockedByThem,
      mutedUntil: mutedUntil === undefined ? null : mutedUntil,
      lastMessageAt: act.lastMessageAt || 0,
      dmChannelId: act.dmChannelId,
    };
  });
}

function emitSocial(userId) {
  const social = store.getSocial(userId);
  const sockets = onlineUsers.get(userId);
  if (sockets) {
    for (const sid of sockets) {
      io.to(sid).emit('social-update', {
        social,
        friends: friendsSnapshot(userId),
        groupDms: store.getUserGroupDMs(userId),
      });
    }
  }
}

function emitToChannelUsers(channel, event, payload, exceptUserId = null) {
  for (const uid of channel.users) {
    if (exceptUserId && uid === exceptUserId) continue;
    const sockets = onlineUsers.get(uid);
    if (sockets) for (const sid of sockets) io.to(sid).emit(event, payload);
  }
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

function findUserVoice(userId) {
  for (const [channelId, map] of voiceParticipants) {
    for (const v of map.values()) {
      if (v.userId === userId) {
        const found = store.findChannel(channelId);
        if (!found) return null;
        return {
          channelId,
          channelName: found.channel.name,
          serverId: found.server.id,
          serverName: found.server.name,
          participants: getVoiceList(channelId),
        };
      }
    }
  }
  return null;
}

function friendsVoiceSnapshot(forUserId) {
  const out = {};
  for (const f of store.getFriends(forUserId)) {
    const loc = findUserVoice(f.id);
    if (loc) {
      out[f.id] = {
        userId: f.id,
        username: f.username,
        ...loc,
      };
    }
  }
  return out;
}

function emitFriendsVoice(forUserId) {
  const sockets = onlineUsers.get(forUserId);
  if (!sockets) return;
  const payload = friendsVoiceSnapshot(forUserId);
  for (const sid of sockets) io.to(sid).emit('friends-voice', { activities: payload });
}

function notifyFriendsVoiceOfUser(userId) {
  const user = store.findById(userId);
  if (!user) return;
  // Kullanıcının arkadaşlarına kendi ses durumunu yansıt
  for (const friendId of user.friends || []) emitFriendsVoice(friendId);
  // Kendine de güncel liste
  emitFriendsVoice(userId);
}

function broadcastVoicePresence(channelId) {
  io.to(`voice:${channelId}`).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
  const found = store.findChannel(channelId);
  if (found) {
    for (const memberId of found.server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
    }
  }
  // Kanaldaki herkesin arkadaşlarına Şimdi Aktif güncelle
  const seen = new Set();
  for (const p of getVoiceList(channelId)) {
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    notifyFriendsVoiceOfUser(p.userId);
  }
}

function leaveVoice(socket) {
  const channelId = socket.data.voiceChannelId;
  if (!channelId) return;
  const uid = socket.data.userId;
  const wasDmCall = !!socket.data.dmCall;
  const map = voiceParticipants.get(channelId);
  if (map) {
    map.delete(socket.id);
    if (map.size === 0) voiceParticipants.delete(channelId);
  }
  socket.to(`voice:${channelId}`).emit('voice-peer-left', { userId: uid, socketId: socket.id });
  socket.leave(`voice:${channelId}`);
  socket.data.voiceChannelId = null;
  socket.data.dmCall = false;
  if (wasDmCall) {
    const channel = store.getDMChannelById(channelId);
    io.to(`voice:${channelId}`).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
    if (channel) {
      emitToChannelUsers(channel, 'dm-call-update', {
        channelId,
        participants: getVoiceList(channelId),
        fromId: uid,
      });
    }
    const remaining = voiceParticipants.get(channelId);
    if (!remaining || remaining.size === 0) clearDmRing(channelId, 'ended');
    refreshDmAloneTimer(channelId);
  } else {
    broadcastVoicePresence(channelId);
    notifyFriendsVoiceOfUser(uid);
  }
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
    friendRequests: store.getFriendRequests(userId),
    social: store.getSocial(userId),
    servers: store.getUserServers(userId),
    friendsVoice: friendsVoiceSnapshot(userId),
    groupDms: store.getUserGroupDMs(userId),
  });
  if (wasOffline) notifyFriendsOfChange(userId);

  // ---- Friends ----
  function emitFriendRequestsTo(uid) {
    const payload = store.getFriendRequests(uid);
    const sockets = onlineUsers.get(uid);
    if (sockets) for (const sid of sockets) io.to(sid).emit('friend-requests', payload);
  }

  socket.on('friend-request', ({ username }, cb) => {
    const result = store.sendFriendRequest(userId, username);
    if (result.error) return cb?.({ error: result.error });

    // Otomatik kabul (ters istek vardı)
    if (result.friend) {
      const friend = result.friend;
      cb?.({
        accepted: true,
        friend: { id: friend.id, username: friend.username, online: isOnline(friend.id) },
      });
      notifyFriendsOfChange(userId);
      notifyFriendsOfChange(friend.id);
      emitFriendRequestsTo(userId);
      emitFriendRequestsTo(friend.id);
      emitSocial(userId);
      emitSocial(friend.id);
      return;
    }

    cb?.({
      request: {
        id: result.request.id,
        user: result.to,
        createdAt: result.request.createdAt,
      },
    });
    emitFriendRequestsTo(userId);
    emitFriendRequestsTo(result.to.id);
    // Hedefe bildirim
    const tsockets = onlineUsers.get(result.to.id);
    if (tsockets) {
      for (const sid of tsockets) {
        io.to(sid).emit('friend-request-received', {
          id: result.request.id,
          user: result.from,
          createdAt: result.request.createdAt,
        });
      }
    }
  });

  socket.on('friend-accept', ({ requestId }, cb) => {
    const result = store.acceptFriendRequest(userId, requestId);
    if (result.error) return cb?.({ error: result.error });
    const friend = result.friend;
    cb?.({ friend: { id: friend.id, username: friend.username, online: isOnline(friend.id) } });
    notifyFriendsOfChange(userId);
    notifyFriendsOfChange(friend.id);
    emitFriendRequestsTo(userId);
    emitFriendRequestsTo(friend.id);
    emitSocial(userId);
    emitSocial(friend.id);
  });

  socket.on('friend-decline', ({ requestId }, cb) => {
    const result = store.declineFriendRequest(userId, requestId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ success: true });
    emitFriendRequestsTo(userId);
    if (result.request) {
      const otherId = result.request.fromId === userId ? result.request.toId : result.request.fromId;
      emitFriendRequestsTo(otherId);
    }
  });

  // Eski istemci uyumu → friend-request
  socket.on('add-friend', ({ username }, cb) => {
    const result = store.sendFriendRequest(userId, username);
    if (result.error) return cb?.({ error: result.error });
    if (result.friend) {
      const friend = result.friend;
      cb?.({ friend: { id: friend.id, username: friend.username, online: isOnline(friend.id) } });
      notifyFriendsOfChange(userId);
      notifyFriendsOfChange(friend.id);
      emitFriendRequestsTo(userId);
      emitFriendRequestsTo(friend.id);
      return;
    }
    cb?.({ pending: true, message: 'Arkadaşlık isteği gönderildi.' });
    emitFriendRequestsTo(userId);
    emitFriendRequestsTo(result.to.id);
    const tsockets = onlineUsers.get(result.to.id);
    if (tsockets) {
      for (const sid of tsockets) {
        io.to(sid).emit('friend-request-received', {
          id: result.request.id,
          user: result.from,
          createdAt: result.request.createdAt,
        });
      }
    }
  });

  socket.on('remove-friend', ({ friendId }, cb) => {
    store.removeFriend(userId, friendId);
    cb?.({ success: true });
    emitSocial(userId);
    emitSocial(friendId);
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
    store.reopenDm(userId, friendId);
    store.markDmRead(userId, friendId);
    const bs = store.blockState(userId, friendId);
    cb?.({
      messages: store.getDMs(userId, friendId),
      friend: { id: friend.id, username: friend.username },
      dmChannelId: channel.id,
      channel: store.publicDmChannel(channel, userId),
      pins: channel.pins || [],
      social: store.getSocial(userId),
      ...bs,
    });
    emitSocial(userId);
  });

  socket.on('get-dm-by-channel', ({ dmChannelId }, cb) => {
    const channel = store.getDMChannelById(dmChannelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });

    if (channel.type === 'group') {
      store.markGroupRead(userId, channel.id);
      cb?.({
        type: 'group',
        messages: store.getDmChannelMessages(channel.id),
        channel: store.publicDmChannel(channel, userId),
        dmChannelId: channel.id,
        pins: (channel.pins || []).map((p) => {
          const author = store.findById(p.fromId);
          return { ...p, username: author?.username || '—' };
        }),
        social: store.getSocial(userId),
      });
      emitSocial(userId);
      return;
    }

    const friendId = channel.users.find((u) => u !== userId);
    const friend = store.findById(friendId);
    const user = store.findById(userId);
    if (!friend || !user?.friends.includes(friendId)) return cb?.({ error: 'Arkadaş bulunamadı.' });
    store.reopenDm(userId, friendId);
    store.markDmRead(userId, friendId);
    const bs = store.blockState(userId, friendId);
    cb?.({
      type: 'dm',
      messages: store.getDMs(userId, friendId),
      friend: { id: friend.id, username: friend.username },
      friendId,
      dmChannelId: channel.id,
      channel: store.publicDmChannel(channel, userId),
      pins: channel.pins || [],
      social: store.getSocial(userId),
      ...bs,
    });
    emitSocial(userId);
  });

  socket.on('send-dm', ({ friendId, text, channelId, replyTo }, cb) => {
    if (!text?.trim()) return cb?.({ error: 'Boş mesaj.' });

    function broadcastDm(channel, msg) {
      const payload = {
        channelId: channel.id,
        type: channel.type,
        fromId: userId,
        username: socket.data.username,
        message: msg,
      };
      for (const uid of channel.users) {
        if (uid === userId) continue;
        const sockets = onlineUsers.get(uid);
        if (!sockets) continue;
        for (const sid of sockets) {
          io.to(sid).emit('dm', {
            ...payload,
            friendId: channel.type === 'dm' ? userId : null,
            muted: channel.type === 'group'
              ? store.isGroupMuted(uid, channel.id)
              : store.isDmMuted(uid, userId),
            ignored: channel.type === 'dm'
              ? !!store.getSocial(uid)?.ignored?.includes(userId)
              : false,
            blocked: channel.type === 'dm' ? store.isBlockedBy(uid, userId) : false,
          });
        }
        emitSocial(uid);
      }
    }

    // Grup / kanallı DM
    if (channelId) {
      const channel = store.getDMChannelById(channelId);
      if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'Kanal bulunamadı.' });
      const result = replyTo
        ? store.setDmReply(channelId, userId, text, replyTo)
        : store.pushDmChannelMessage(channelId, userId, text);
      if (result.error) return cb?.({ error: result.error });
      broadcastDm(channel, result.message);
      cb?.({ message: result.message, channel: result.channel });
      emitSocial(userId);
      return;
    }

    const user = store.findById(userId);
    if (!user?.friends.includes(friendId)) return cb?.({ error: 'Arkadaş değil.' });
    const bs = store.blockState(userId, friendId);
    if (bs.blockedByMe) return cb?.({ error: 'Engellediğin bir kullanıcıya mesaj gönderemezsin.' });
    if (bs.blockedByThem) return cb?.({ error: 'Bu kullanıcıya mesaj gönderemezsin.' });
    const channel = store.getOrCreateDMChannel(userId, friendId);
    const result = replyTo
      ? store.setDmReply(channel.id, userId, text, replyTo)
      : store.pushDM(userId, friendId, text);
    if (result.error) return cb?.({ error: result.error });
    broadcastDm(channel, result.message);
    cb?.({ message: result.message });
    emitSocial(userId);
  });

  socket.on('create-group-dm', ({ memberIds, name }, cb) => {
    const result = store.createGroupDM(userId, memberIds || [], name);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    for (const uid of result.channel.users) emitSocial(uid);
  });

  socket.on('update-group-dm', ({ channelId, name }, cb) => {
    const result = store.updateGroupDM(userId, channelId, { name });
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitToChannelUsers(store.getDMChannelById(channelId), 'group-dm-updated', { channel: result.channel });
    for (const uid of result.channel.users) emitSocial(uid);
  });

  socket.on('leave-group-dm', ({ channelId }, cb) => {
    const channel = store.getDMChannelById(channelId);
    const result = store.leaveGroupDM(userId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
    if (channel) {
      for (const uid of channel.users) {
        if (uid !== userId) emitSocial(uid);
      }
    }
  });

  socket.on('group-dm-pin', ({ channelId, pinned }, cb) => {
    const result = store.setGroupPinned(userId, channelId, !!pinned);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('group-dm-close', ({ channelId }, cb) => {
    const result = store.closeGroupDm(userId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('group-dm-read', ({ channelId }, cb) => {
    const result = store.markGroupRead(userId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('group-dm-mute', ({ channelId, until }, cb) => {
    const result = store.setGroupMuted(userId, channelId, until);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });

  socket.on('search-dm', ({ channelId, query }, cb) => {
    cb?.(store.searchDmChannel(userId, channelId, query));
  });

  socket.on('pin-dm-message', ({ channelId, messageId, pinned }, cb) => {
    const result = store.pinDmMessage(userId, channelId, messageId, pinned !== false);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    const channel = store.getDMChannelById(channelId);
    if (channel) emitToChannelUsers(channel, 'dm-pins-updated', { channelId, pins: result.pins });
  });

  socket.on('get-dm-pins', ({ channelId }, cb) => {
    cb?.(store.getDmPins(userId, channelId));
  });

  socket.on('react-dm-message', ({ channelId, messageId, emoji }, cb) => {
    const result = store.reactDmMessage(userId, channelId, messageId, emoji);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    const channel = store.getDMChannelById(channelId);
    if (channel) {
      emitToChannelUsers(channel, 'dm-reaction', {
        channelId,
        messageId: result.messageId,
        reactions: result.reactions,
      });
    }
  });

  socket.on('dm-unread', ({ friendId }, cb) => {
    const result = store.markDmUnread(userId, friendId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });

  socket.on('dm-pin', ({ friendId, pinned }, cb) => {
    const result = store.setDmPinned(userId, friendId, !!pinned);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('dm-close', ({ friendId }, cb) => {
    const result = store.closeDm(userId, friendId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('dm-read', ({ friendId }, cb) => {
    const result = store.markDmRead(userId, friendId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('dm-mute', ({ friendId, until }, cb) => {
    const result = store.setDmMuted(userId, friendId, until);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('user-ignore', ({ targetId, ignored }, cb) => {
    const result = store.setIgnored(userId, targetId, !!ignored);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('user-block', ({ targetId, blocked }, cb) => {
    const result = store.setBlocked(userId, targetId, !!blocked);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
    emitSocial(targetId);
  });
  socket.on('friend-note', ({ friendId, note }, cb) => {
    const result = store.setFriendNote(userId, friendId, note);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
  });
  socket.on('get-profile', ({ userId: targetId }, cb) => {
    const result = store.getUserProfile(userId, targetId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({
      ...result,
      online: isOnline(targetId),
      dmChannelId: store.getDmActivity(userId, targetId).dmChannelId,
    });
  });
  socket.on('invite-to-server', ({ serverId, targetId }, cb) => {
    const result = store.inviteToServer(userId, serverId, targetId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
    const server = store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
    // Hedefe sunucu listesi güncellemesi
    const ts = onlineUsers.get(targetId);
    if (ts) {
      for (const sid of ts) {
        io.to(sid).emit('server-invited', { server: result.server });
      }
    }
  });

  // ---- DM araması (zil + mesh, kanal = dmChannelId) ----
  socket.on('dm-call-ring', ({ channelId }, cb) => {
    const channel = store.getDMChannelById(channelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });

    const existing = getVoiceList(channelId).filter((p) => p.userId !== userId);
    if (existing.length > 0) {
      return cb?.({ ok: true, joinDirect: true });
    }

    const prev = dmCallRings.get(channelId);
    if (prev && prev.fromId !== userId) {
      return cb?.({ error: 'Bu sohbette zaten bir arama var.' });
    }
    if (prev && prev.fromId === userId) {
      return cb?.({ ok: true, ringing: true });
    }

    const timer = setTimeout(() => {
      clearDmRing(channelId, 'timeout');
      kickDmCallParticipants(channelId);
    }, DM_RING_MS);

    dmCallRings.set(channelId, {
      fromId: userId,
      fromUsername: socket.data.username,
      timer,
    });

    emitToChannelUsers(channel, 'dm-call-incoming', {
      channelId,
      fromId: userId,
      fromUsername: socket.data.username,
      ringMs: DM_RING_MS,
    }, userId);

    cb?.({ ok: true, ringing: true, ringMs: DM_RING_MS });
  });

  socket.on('dm-call-cancel', ({ channelId }, cb) => {
    const channel = store.getDMChannelById(channelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });
    const ring = dmCallRings.get(channelId);
    if (ring && ring.fromId !== userId) return cb?.({ error: 'Bu aramayı iptal edemezsiniz.' });
    clearDmRing(channelId, 'cancel');
    if (socket.data.voiceChannelId === channelId && socket.data.dmCall) leaveVoice(socket);
    cb?.({ ok: true });
  });

  socket.on('dm-call-reject', ({ channelId }, cb) => {
    const channel = store.getDMChannelById(channelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });
    const ring = dmCallRings.get(channelId);
    if (!ring) return cb?.({ ok: true });
    clearDmRing(channelId, 'reject');
    kickDmCallParticipants(channelId);
    cb?.({ ok: true });
  });

  socket.on('join-dm-call', ({ channelId }, cb) => {
    const channel = store.getDMChannelById(channelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });
    if (socket.data.voiceChannelId && socket.data.voiceChannelId !== channelId) leaveVoice(socket);

    const ring = dmCallRings.get(channelId);
    if (ring && ring.fromId !== userId) {
      // Karşı taraf kabul etti — zili kapat
      clearTimeout(ring.timer);
      dmCallRings.delete(channelId);
      emitToChannelUsers(channel, 'dm-call-ring-ended', {
        channelId,
        reason: 'accepted',
        fromId: ring.fromId,
        fromUsername: ring.fromUsername,
        accepterId: userId,
      });
    }

    if (!voiceParticipants.has(channelId)) voiceParticipants.set(channelId, new Map());
    const map = voiceParticipants.get(channelId);
    const existing = [...map.entries()].filter(([sid]) => sid !== socket.id);

    map.set(socket.id, {
      userId, username: socket.data.username,
      muted: false, deafened: false, camera: false, screen: false, camId: null, screenId: null,
    });
    socket.join(`voice:${channelId}`);
    socket.data.voiceChannelId = channelId;
    socket.data.dmCall = true;

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
    io.to(`voice:${channelId}`).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
    emitToChannelUsers(channel, 'dm-call-update', {
      channelId,
      participants: getVoiceList(channelId),
      fromId: userId,
      username: socket.data.username,
    }, null);
    refreshDmAloneTimer(channelId);
  });

  // ---- Voice channels (mesh signaling) ----
  socket.on('join-voice', ({ channelId }, cb) => {
    const found = store.findChannel(channelId);
    if (!found) return cb?.({ error: 'Kanal bulunamadı.' });
    if (!store.isMember(found.server, userId)) return cb?.({ error: 'Yetkiniz yok.' });
    if (found.channel.type !== 'voice') return cb?.({ error: 'Ses kanalı değil.' });

    // Önceki ses kanalından ayrıl
    if (socket.data.voiceChannelId && socket.data.voiceChannelId !== channelId) leaveVoice(socket);
    socket.data.dmCall = false;

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

  // İstemci gecikme ölçümü (ping göstergesi)
  socket.on('latency-ping', (sentAt, cb) => {
    if (typeof cb === 'function') cb({ sentAt, serverAt: Date.now() });
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
