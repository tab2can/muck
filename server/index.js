import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import * as store from './store.js';
import { supabaseAuth, publicAppUrl } from './supabase.js';
import { startRealtime, noteBroadcast } from './realtime.js';

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
  path: '/',
};

function setAuthCookies(res, session) {
  if (!session?.access_token) return;
  res.cookie('muck_access', session.access_token, {
    ...COOKIE_OPTS,
    maxAge: (session.expires_in || 3600) * 1000,
  });
  if (session.refresh_token) {
    res.cookie('muck_refresh', session.refresh_token, {
      ...COOKIE_OPTS,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
  }
}

function clearAuthCookies(res) {
  res.clearCookie('muck_access', { path: '/' });
  res.clearCookie('muck_refresh', { path: '/' });
  res.clearCookie('muck_token', { path: '/' });
  res.clearCookie('streamuck_token', { path: '/' });
}

function tokenFromReq(req) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return req.cookies?.muck_access || null;
}

app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const {
      email, password, username, displayName, birthDate, marketingOptIn,
    } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'E-posta gerekli.' });
    }
    if (!store.validUsername(username)) {
      return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter, harf/rakam/alt çizgi olmalı.' });
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı.' });
    }
    const age = store.calcAge(birthDate);
    if (age === null) return res.status(400).json({ error: 'Geçerli bir doğum tarihi seç.' });
    if (age < 13) return res.status(400).json({ error: 'Muck kullanmak için en az 13 yaşında olmalısın.' });
    const nowY = new Date().getFullYear();
    const y = Number(String(birthDate).slice(0, 4));
    if (!y || y < nowY - 100 || y > nowY) {
      return res.status(400).json({ error: 'Doğum yılı geçersiz.' });
    }
    if (await store.isUsernameTaken(username)) {
      return res.status(409).json({ error: 'Bu kullanıcı adı zaten alınmış.' });
    }

    const { data, error } = await supabaseAuth.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        emailRedirectTo: `${publicAppUrl()}/login?confirmed=1`,
        data: {
          username: username.trim(),
          display_name: displayName ? String(displayName).trim().slice(0, 32) : null,
          birth_date: birthDate,
          marketing_opt_in: !!marketingOptIn,
        },
      },
    });
    if (error) return res.status(400).json({ error: error.message });

    const userId = data.user?.id;
    if (userId) await store.waitForProfile(userId);
    const profile = userId ? await store.findById(userId) : null;

    if (data.session) setAuthCookies(res, data.session);
    res.json({
      user: profile ? store.publicUser(profile) : null,
      session: data.session ? {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
      } : null,
      needsEmailConfirmation: !data.session,
    });
  } catch (err) {
    console.error('register', err);
    res.status(500).json({ error: 'Kayıt başarısız.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'E-posta ve şifre gerekli.' });
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email: String(email).trim().toLowerCase(),
      password,
    });
    if (error) {
      const msg = /confirm|verified|doğrul/i.test(error.message)
        ? 'E-posta adresini doğrulaman gerekiyor. Gelen kutunu kontrol et.'
        : 'E-posta veya şifre hatalı.';
      return res.status(401).json({ error: msg });
    }
    if (!data.user?.email_confirmed_at && data.user?.confirmed_at == null) {
      // bazı projelerde confirmed_at kullanılır
    }
    const profile = await store.waitForProfile(data.user.id);
    if (!profile) return res.status(400).json({ error: 'Profil bulunamadı. Destek ile iletişime geç.' });
    setAuthCookies(res, data.session);
    res.json({
      user: store.publicUser(profile),
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
      },
    });
  } catch (err) {
    console.error('login', err);
    res.status(500).json({ error: 'Giriş başarısız.' });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'E-posta gerekli.' });
    const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, {
      redirectTo: `${publicAppUrl()}/login`,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Gönderilemedi.' });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    const token = tokenFromReq(req);
    if (token) await supabaseAuth.auth.admin?.signOut?.(token).catch?.(() => {});
  } catch {}
  clearAuthCookies(res);
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  const user = await store.getUserByAccessToken(tokenFromReq(req));
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
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
    if (filePath.endsWith('web-app-origin-association') || filePath.includes(`${path.sep}.well-known${path.sep}`)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
  },
}));
app.get('/service-worker.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});
app.get(['/privacy', '/privacy.html', '/gizlilik'], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'privacy.html'));
});
app.get(['/terms', '/terms.html'], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'terms.html'));
});
app.get(['/login', '/login.html'], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.get(['/register', '/register.html'], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'register.html'));
});
app.get(['/forgot-password', '/forgot-password.html'], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'forgot-password.html'));
});
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
// DM arama sohbet kaydı: channelId -> { messageId, startedAt, fromId, fromUsername }
const dmCallLogs = new Map();
const DM_RING_MS = 20_000;
const DM_ALONE_MS = 2 * 60_000;

function formatCallDurationTr(ms) {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (sec < 60) return 'birkaç saniye';
  const min = Math.round(sec / 60);
  if (min === 1) return '1 dakika';
  return `${min} dakika`;
}

function getDmCallState(channelId, userId) {
  if (!channelId) return null;
  const ring = dmCallRings.get(channelId);
  const log = dmCallLogs.get(channelId);
  const participants = getVoiceList(channelId);
  const inCall = participants.some((p) => p.userId === userId);

  if (ring) {
    return {
      status: 'ringing',
      channelId,
      fromId: ring.fromId,
      fromUsername: ring.fromUsername,
      startedAt: log?.startedAt || Date.now(),
      messageId: log?.messageId || null,
      ringMs: DM_RING_MS,
      participants,
      inCall,
    };
  }

  if (log) {
    return {
      status: 'active',
      channelId,
      fromId: log.fromId,
      fromUsername: log.fromUsername,
      startedAt: log.startedAt,
      messageId: log.messageId,
      participants,
      inCall,
    };
  }

  // Log yok ama odada biri var — katılmaya açık
  if (participants.length > 0) {
    const starter = participants[0];
    return {
      status: 'active',
      channelId,
      fromId: starter.userId,
      fromUsername: starter.username,
      startedAt: Date.now(),
      messageId: null,
      participants,
      inCall,
    };
  }

  return null;
}

function emitDmMessage(channel, message, fromId, fromUsername) {
  if (!channel || !message) return;
  const payload = {
    channelId: channel.id,
    type: channel.type,
    fromId,
    username: fromUsername,
    message,
    friendId: channel.type === 'dm' ? fromId : null,
    muted: false,
    ignored: false,
    blocked: false,
  };
  for (const uid of channel.users) {
    const sockets = onlineUsers.get(uid);
    if (!sockets) continue;
    for (const sid of sockets) io.to(sid).emit('dm', payload);
  }
}

async function startDmCallLog(channel, fromId, fromUsername) {
  if (!channel || dmCallLogs.has(channel.id)) return dmCallLogs.get(channel.id);
  const startedAt = Date.now();
  const metadata = {
    type: 'dm_call',
    status: 'active',
    startedBy: fromId,
    startedByName: fromUsername,
    startedAt,
  };
  const result = await store.pushDmMetaMessage(
    channel.id,
    fromId,
    `${fromUsername} bir arama başlattı.`,
    metadata,
    channel
  );
  if (result.error) return null;
  const log = {
    messageId: result.id,
    startedAt,
    fromId,
    fromUsername,
  };
  dmCallLogs.set(channel.id, log);
  delete result._channel;
  noteBroadcast(`dm:${result.id}`);
  emitDmMessage(channel, result, fromId, fromUsername);
  return log;
}

async function endDmCallLog(channelId, reason = 'ended') {
  const log = dmCallLogs.get(channelId);
  if (!log) return null;
  dmCallLogs.delete(channelId);
  const channel = await store.getDMChannelById(channelId);
  if (!channel) return null;
  const durationMs = Math.max(0, Date.now() - log.startedAt);
  const durationLabel = formatCallDurationTr(durationMs);
  const name = log.fromUsername || 'Birisi';
  const text = `${name}, ${durationLabel} süren bir arama başlattı.`;
  const metadata = {
    type: 'dm_call',
    status: 'ended',
    startedBy: log.fromId,
    startedByName: name,
    startedAt: log.startedAt,
    endedAt: Date.now(),
    durationMs,
    reason,
  };
  const updated = await store.updateDmMessageMeta(channelId, log.messageId, metadata, text);
  if (updated.error) return null;
  noteBroadcast(`dm-call-log:${log.messageId}`);
  noteBroadcast(`dm-edit:${log.messageId}`);
  emitToChannelUsers(channel, 'dm-call-log', {
    channelId,
    message: updated,
  });
  return updated;
}

async function clearDmRing(channelId, reason = 'cancel') {
  const ring = dmCallRings.get(channelId);
  if (!ring) return null;
  clearTimeout(ring.timer);
  dmCallRings.delete(channelId);
  const channel = await store.getDMChannelById(channelId);
  if (channel) {
    emitToChannelUsers(channel, 'dm-call-ring-ended', {
      channelId,
      reason,
      fromId: ring.fromId,
      fromUsername: ring.fromUsername,
    });
  }
  // Bağlantı kurulmadan bittiyse veya herkes çıktıysa kaydı kapat
  const still = voiceParticipants.get(channelId);
  if (!still || still.size === 0) {
    await endDmCallLog(channelId, reason);
  }
  return ring;
}

async function refreshDmAloneTimer(channelId) {
  const prev = dmAloneTimers.get(channelId);
  if (prev) {
    clearTimeout(prev);
    dmAloneTimers.delete(channelId);
  }
  const channel = await store.getDMChannelById(channelId);
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

async function friendsSnapshot(userId, socialPreload = null) {
  const social = socialPreload || (await store.getSocial(userId)) || {};
  const friends = await store.getFriends(userId);
  if (!friends.length) return [];
  const ids = friends.map((f) => f.id);
  const [actMap, blockedByThem] = await Promise.all([
    store.getFriendsDmActivityMap(userId, ids),
    store.getBlockedByThemSet(userId, ids),
  ]);
  const blockedMine = new Set(social.blocked || []);
  const ignored = new Set(social.ignored || []);
  const pinned = new Set(social.pinnedDms || []);
  const closed = new Set(social.closedDms || []);
  return friends.map((f) => {
    const act = actMap.get(f.id) || {};
    const mutedUntil = social.mutedDms?.[f.id];
    return {
      id: f.id,
      username: f.username,
      online: isOnline(f.id),
      pinned: pinned.has(f.id),
      closed: closed.has(f.id),
      unread: !!social.unreadDms?.[f.id],
      ignored: ignored.has(f.id),
      blocked: blockedMine.has(f.id),
      blockedByThem: blockedByThem.has(f.id),
      mutedUntil: mutedUntil === undefined ? null : mutedUntil,
      lastMessageAt: act.lastMessageAt || 0,
      dmChannelId: act.dmChannelId || null,
    };
  });
}

async function emitSocial(userId) {
  const social = await store.getSocial(userId);
  const sockets = onlineUsers.get(userId);
  if (sockets) {
    const friends = await friendsSnapshot(userId);
    const groupDms = await store.getUserGroupDMs(userId);
    for (const sid of sockets) {
      io.to(sid).emit('social-update', { social, friends, groupDms });
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

async function notifyFriendsOfChange(userId) {
  const user = await store.findById(userId);
  if (!user) return;
  const payload = { id: user.id, username: user.username, online: isOnline(userId) };
  const friends = await store.getFriends(userId);
  for (const friend of friends) {
    const sockets = onlineUsers.get(friend.id);
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

async function findUserVoice(userId) {
  for (const [channelId, map] of voiceParticipants) {
    for (const v of map.values()) {
      if (v.userId === userId) {
        const found = await store.findChannel(channelId);
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

async function friendsVoiceSnapshot(forUserId) {
  const out = {};
  for (const f of await store.getFriends(forUserId)) {
    const loc = await findUserVoice(f.id);
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

async function emitFriendsVoice(forUserId) {
  const sockets = onlineUsers.get(forUserId);
  if (!sockets) return;
  const payload = await friendsVoiceSnapshot(forUserId);
  for (const sid of sockets) io.to(sid).emit('friends-voice', { activities: payload });
}

async function notifyFriendsVoiceOfUser(userId) {
  const friends = await store.getFriends(userId);
  for (const friend of friends) await emitFriendsVoice(friend.id);
  await emitFriendsVoice(userId);
}

async function broadcastVoicePresence(channelId) {
  io.to(`voice:${channelId}`).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
  const found = await store.findChannel(channelId);
  if (found) {
    for (const memberId of found.server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
    }
  }
  const seen = new Set();
  for (const p of getVoiceList(channelId)) {
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    await notifyFriendsVoiceOfUser(p.userId);
  }
}

async function leaveVoice(socket) {
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
    const channel = await store.getDMChannelById(channelId);
    io.to(`voice:${channelId}`).emit('voice-presence', { channelId, participants: getVoiceList(channelId) });
    if (channel) {
      emitToChannelUsers(channel, 'dm-call-update', {
        channelId,
        participants: getVoiceList(channelId),
        fromId: uid,
      });
    }
    const remaining = voiceParticipants.get(channelId);
    if (!remaining || remaining.size === 0) {
      await clearDmRing(channelId, 'ended');
      // clearDmRing zaten log'u kapatır; ring yoksa yine de kapat
      if (dmCallLogs.has(channelId)) await endDmCallLog(channelId, 'ended');
    }
    refreshDmAloneTimer(channelId);
  } else {
    await broadcastVoicePresence(channelId);
    await notifyFriendsVoiceOfUser(uid);
  }
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const user = await store.getUserByAccessToken(token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    socket.data.username = user.username;
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', async (socket) => {
  const userId = socket.data.userId;
  const wasOffline = !onlineUsers.has(userId);
  if (wasOffline) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);

  const social = await store.getSocial(userId);
  const [friends, friendRequests, servers, friendsVoice, groupDms] = await Promise.all([
    friendsSnapshot(userId, social),
    store.getFriendRequests(userId),
    store.getUserServers(userId),
    friendsVoiceSnapshot(userId),
    store.getUserGroupDMs(userId),
  ]);
  socket.emit('init', {
    user: { id: userId, username: socket.data.username },
    friends,
    friendRequests,
    social,
    servers,
    friendsVoice,
    groupDms,
  });
  if (wasOffline) await notifyFriendsOfChange(userId);

  // ---- Friends ----
  async function emitFriendRequestsTo(uid) {
    const payload = await store.getFriendRequests(uid);
    const sockets = onlineUsers.get(uid);
    if (sockets) for (const sid of sockets) io.to(sid).emit('friend-requests', payload);
  }

  socket.on('friend-request', async ({ username }, cb) => {
    const result = await store.sendFriendRequest(userId, username);
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
        user: result.request.to,
        createdAt: result.request.createdAt,
      },
    });
    await emitFriendRequestsTo(userId);
    await emitFriendRequestsTo(result.request.to.id);
    // Hedefe bildirim
    const tsockets = onlineUsers.get(result.request.to.id);
    if (tsockets) {
      for (const sid of tsockets) {
        io.to(sid).emit('friend-request-received', {
          id: result.request.id,
          user: result.request.from,
          createdAt: result.request.createdAt,
        });
      }
    }
  });

  socket.on('friend-accept', async ({ requestId }, cb) => {
    const result = await store.acceptFriendRequest(userId, requestId);
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

  socket.on('friend-decline', async ({ requestId }, cb) => {
    const result = await store.declineFriendRequest(userId, requestId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ success: true });
    emitFriendRequestsTo(userId);
    if (result.request) {
      const otherId = result.request.fromId === userId ? result.request.toId : result.request.fromId;
      emitFriendRequestsTo(otherId);
    }
  });

  // Eski istemci uyumu → friend-request
  socket.on('add-friend', async ({ username }, cb) => {
    const result = await store.sendFriendRequest(userId, username);
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

  socket.on('remove-friend', async ({ friendId }, cb) => {
    await store.removeFriend(userId, friendId);
    cb?.({ success: true });
    emitSocial(userId);
    emitSocial(friendId);
    notifyFriendsOfChange(userId);
    notifyFriendsOfChange(friendId);
  });

  // ---- Servers ----
  socket.on('create-server', async ({ name }, cb) => {
    const result = await store.createServer(userId, name);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
  });

  socket.on('join-server', async ({ code }, cb) => {
    const result = await store.joinServerByCode(userId, code);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
    for (const memberId of await store.getServer(result.server.id).members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  socket.on('leave-server', async ({ serverId }, cb) => {
    const result = await store.leaveServer(userId, serverId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ success: true });
  });

  socket.on('get-server', async ({ serverId }, cb) => {
    const server = await store.getServer(serverId);
    if (!server || !store.isMember(server, userId)) return cb?.({ error: 'Sunucu bulunamadı.' });
    cb?.({
      server: {
        id: server.id, name: server.name, ownerId: server.ownerId,
        inviteCode: server.inviteCode,
        channels: server.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        members: await store.getServerMembers(serverId),
      },
      // Ses kanallarındaki mevcut katılımcılar (sayfa yenilenince de görünsün).
      voice: server.channels
        .filter((c) => c.type === 'voice')
        .map((c) => ({ channelId: c.id, participants: getVoiceList(c.id) })),
    });
  });

  socket.on('update-server', async ({ serverId, name }, cb) => {
    const result = await store.updateServer(userId, serverId, { name });
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
    const server = await store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  socket.on('delete-server', async ({ serverId }, cb) => {
    const server = await store.getServer(serverId);
    if (!server) return cb?.({ error: 'Sunucu bulunamadı.' });
    const members = [...server.members];
    const result = await store.deleteServer(userId, serverId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ success: true });
    for (const memberId of members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-deleted', { serverId });
    }
  });

  socket.on('create-channel', async ({ serverId, name, type }, cb) => {
    const result = await store.addChannel(userId, serverId, { name, type });
    if (result.error) return cb?.({ error: result.error });
    cb?.({ channel: result.channel, server: result.server });
    const server = await store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  socket.on('delete-channel', async ({ serverId, channelId }, cb) => {
    const result = await store.deleteChannel(userId, serverId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ server: result.server });
    const server = await store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  socket.on('rename-channel', async ({ serverId, channelId, name }, cb) => {
    const result = await store.renameChannel(userId, serverId, channelId, name);
    if (result.error) return cb?.({ error: result.error });
    cb?.({ channel: result.channel, server: result.server });
    const server = await store.getServer(serverId);
    for (const memberId of server.members) {
      const sockets = onlineUsers.get(memberId);
      if (sockets) for (const sid of sockets) io.to(sid).emit('server-updated', { server: result.server });
    }
  });

  // ---- Text channels ----
  socket.on('open-text-channel', async ({ channelId }, cb) => {
    const found = await store.findChannel(channelId);
    if (!found) return cb?.({ error: 'Kanal bulunamadı.' });
    if (!store.isMember(found.server, userId)) return cb?.({ error: 'Yetkiniz yok.' });
    if (found.channel.type !== 'text') return cb?.({ error: 'Metin kanalı değil.' });
    if (socket.data.textChannelId) socket.leave(`chan:${socket.data.textChannelId}`);
    socket.join(`chan:${channelId}`);
    socket.data.textChannelId = channelId;
    const [page, pinRes] = await Promise.all([
      store.getMessages(channelId, { limit: 20 }),
      store.getChannelPins(userId, channelId),
    ]);
    cb?.({
      messages: page.messages,
      hasMore: page.hasMore,
      pins: pinRes.pins || [],
    });
  });

  socket.on('load-messages', async ({ channelId, beforeTs }, cb) => {
    const found = await store.findChannel(channelId);
    if (!found || !store.isMember(found.server, userId)) return cb?.({ error: 'Yetkiniz yok.' });
    if (found.channel.type !== 'text') return cb?.({ error: 'Metin kanalı değil.' });
    const page = await store.getMessages(channelId, { limit: 20, beforeTs });
    cb?.({ messages: page.messages, hasMore: page.hasMore });
  });

  socket.on('send-message', async ({ channelId, text, replyTo }, cb) => {
    if (!text?.trim()) return cb?.({ error: 'Boş mesaj.' });
    if (socket.data.textChannelId !== channelId) {
      const found = await store.findChannel(channelId);
      if (!found || !store.isMember(found.server, userId)) return cb?.({ error: 'Yetkiniz yok.' });
      if (socket.data.textChannelId) socket.leave(`chan:${socket.data.textChannelId}`);
      socket.join(`chan:${channelId}`);
      socket.data.textChannelId = channelId;
    }
    try {
      const msg = await store.pushMessage(channelId, userId, socket.data.username, text, replyTo || null);
      cb?.({ success: true, message: msg });
      noteBroadcast(`msg:${msg.id}`);
      socket.to(`chan:${channelId}`).emit('message', { channelId, message: msg });
    } catch (err) {
      cb?.({ error: err.message || 'Mesaj gönderilemedi.' });
    }
  });

  socket.on('search-channel', async ({ channelId, query }, cb) => {
    cb?.(await store.searchChannel(userId, channelId, query));
  });

  socket.on('pin-channel-message', async ({ channelId, messageId, pinned }, cb) => {
    const result = await store.pinChannelMessage(userId, channelId, messageId, pinned !== false);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    noteBroadcast(`chan-pins:${channelId}`);
    io.to(`chan:${channelId}`).emit('channel-pins-updated', { channelId, pins: result.pins });
  });

  socket.on('get-channel-pins', async ({ channelId }, cb) => {
    cb?.(await store.getChannelPins(userId, channelId));
  });

  socket.on('react-channel-message', async ({ channelId, messageId, emoji }, cb) => {
    const result = await store.reactChannelMessage(userId, channelId, messageId, emoji);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    noteBroadcast(`msg-react:${result.messageId}`);
    io.to(`chan:${channelId}`).emit('channel-reaction', {
      channelId,
      messageId: result.messageId,
      reactions: result.reactions,
    });
  });

  socket.on('edit-message', async ({ channelId, messageId, text }, cb) => {
    const result = await store.editChannelMessage(userId, channelId, messageId, text);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    noteBroadcast(`msg-edit:${messageId}`);
    io.to(`chan:${channelId}`).emit('message-edited', { channelId, ...result });
  });

  socket.on('delete-message', async ({ channelId, messageId }, cb) => {
    const result = await store.deleteChannelMessage(userId, channelId, messageId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    noteBroadcast(`msg-del:${messageId}`);
    io.to(`chan:${channelId}`).emit('message-deleted', { channelId, messageId });
  });

  socket.on('edit-dm-message', async ({ channelId, messageId, text }, cb) => {
    const result = await store.editDmMessage(userId, channelId, messageId, text);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    noteBroadcast(`dm-edit:${messageId}`);
    const channel = await store.getDMChannelById(channelId);
    if (channel) emitToChannelUsers(channel, 'dm-edited', { channelId, ...result });
  });

  socket.on('delete-dm-message', async ({ channelId, messageId }, cb) => {
    const result = await store.deleteDmMessage(userId, channelId, messageId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    noteBroadcast(`dm-del:${messageId}`);
    const channel = await store.getDMChannelById(channelId);
    if (channel) emitToChannelUsers(channel, 'dm-deleted', { channelId, messageId });
  });

  // ---- DMs ----
  socket.on('dm-viewing', ({ channelId }) => {
    socket.data.viewingDmChannelId = channelId || null;
  });

  socket.on('open-dm', async ({ friendId }, cb) => {
    const [friend, friends] = await Promise.all([
      store.findById(friendId),
      store.getFriends(userId),
    ]);
    if (!friend || !friends.some((f) => f.id === friendId)) return cb?.({ error: 'Arkadaş bulunamadı.' });
    const channel = await store.getOrCreateDMChannel(userId, friendId);
    socket.data.viewingDmChannelId = channel.id;

    const [bs, pinRes, page, social, pubChannel] = await Promise.all([
      store.blockState(userId, friendId),
      store.getDmPins(userId, channel.id),
      store.getDMs(userId, friendId, { limit: 20 }),
      store.getSocial(userId),
      store.publicDmChannel(channel, userId),
      store.reopenDm(userId, friendId),
      store.markDmRead(userId, friendId),
    ]);

    if (!socket.data.dmChannelCache) socket.data.dmChannelCache = {};
    socket.data.dmChannelCache[channel.id] = channel;
    if (!socket.data.blockCache) socket.data.blockCache = {};
    socket.data.blockCache[friendId] = {
      blocked: !!bs.blockedByMe,
      blockedByThem: !!bs.blockedByThem,
    };

    cb?.({
      messages: page.messages,
      hasMore: page.hasMore,
      friend: { id: friend.id, username: friend.username },
      dmChannelId: channel.id,
      channel: pubChannel,
      pins: pinRes.pins || [],
      social,
      activeCall: getDmCallState(channel.id, userId),
      ...bs,
    });
    setImmediate(() => { emitSocial(userId).catch(() => {}); });
  });

  socket.on('get-dm-by-channel', async ({ dmChannelId }, cb) => {
    const channel = await store.getDMChannelById(dmChannelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });

    if (!socket.data.dmChannelCache) socket.data.dmChannelCache = {};
    socket.data.dmChannelCache[channel.id] = channel;
    socket.data.viewingDmChannelId = channel.id;

    if (channel.type === 'group') {
      const [pinRes, page, social, pubChannel] = await Promise.all([
        store.getDmPins(userId, channel.id),
        store.getDmChannelMessages(channel.id, { limit: 20 }),
        store.getSocial(userId),
        store.publicDmChannel(channel, userId),
        store.markGroupRead(userId, channel.id),
      ]);
      cb?.({
        type: 'group',
        messages: page.messages,
        hasMore: page.hasMore,
        channel: pubChannel,
        dmChannelId: channel.id,
        pins: pinRes.pins || [],
        social,
        activeCall: getDmCallState(channel.id, userId),
      });
      setImmediate(() => { emitSocial(userId).catch(() => {}); });
      return;
    }

    const friendId = channel.users.find((u) => u !== userId);
    const [friend, friends] = await Promise.all([
      store.findById(friendId),
      store.getFriends(userId),
    ]);
    if (!friend || !friends.some((f) => f.id === friendId)) return cb?.({ error: 'Arkadaş bulunamadı.' });

    const [bs, pinRes, page, social] = await Promise.all([
      store.blockState(userId, friendId),
      store.getDmPins(userId, channel.id),
      store.getDMs(userId, friendId, { limit: 20 }),
      store.getSocial(userId),
      store.reopenDm(userId, friendId),
      store.markDmRead(userId, friendId),
    ]);

    if (!socket.data.blockCache) socket.data.blockCache = {};
    socket.data.blockCache[friendId] = {
      blocked: !!bs.blockedByMe,
      blockedByThem: !!bs.blockedByThem,
    };

    cb?.({
      type: 'dm',
      messages: page.messages,
      hasMore: page.hasMore,
      friend: { id: friend.id, username: friend.username },
      friendId,
      dmChannelId: channel.id,
      pins: pinRes.pins || [],
      social,
      activeCall: getDmCallState(channel.id, userId),
      ...bs,
    });
    setImmediate(() => { emitSocial(userId).catch(() => {}); });
  });

  socket.on('load-dm-messages', async ({ channelId, beforeTs }, cb) => {
    const channel = await store.getDMChannelById(channelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'Yetkiniz yok.' });
    const page = await store.getDmChannelMessages(channelId, { limit: 20, beforeTs });
    cb?.({ messages: page.messages, hasMore: page.hasMore });
  });

  socket.on('send-dm', async ({ friendId, text, channelId, replyTo }, cb) => {
    if (!text?.trim()) return cb?.({ error: 'Boş mesaj.' });

    function usersViewingDmChannel(channelId) {
      const viewing = [];
      if (!channelId) return viewing;
      for (const [uid, sockets] of onlineUsers) {
        if (!sockets?.size) continue;
        for (const sid of sockets) {
          const s = io.sockets.sockets.get(sid);
          if (s?.data?.viewingDmChannelId && String(s.data.viewingDmChannelId) === String(channelId)) {
            viewing.push(uid);
            break;
          }
        }
      }
      return viewing;
    }

    async function broadcastDmFast(channel, msg) {
      const payload = {
        channelId: channel.id,
        type: channel.type,
        fromId: userId,
        username: socket.data.username,
        message: msg,
        friendId: channel.type === 'dm' ? userId : null,
        // Mute/block client tarafında da kontrol edilir — emit'i bekletme
        muted: false,
        ignored: false,
        blocked: false,
      };
      const recipients = channel.users.filter((uid) => uid !== userId);
      const viewing = new Set(usersViewingDmChannel(channel.id).map(String));
      for (const uid of recipients) {
        const sockets = onlineUsers.get(uid);
        if (!sockets?.size) continue;
        for (const sid of sockets) io.to(sid).emit('dm', payload);
      }
      // Sohbeti açık görenlere unread yazma (görünen mesaj + okunmadı yarışı)
      const skipUserIds = recipients.filter((uid) => viewing.has(String(uid)));
      setImmediate(() => {
        store.markDmRecipientsUnread(channel, userId, { skipUserIds })
          .then(() => Promise.all([
            ...recipients
              .filter((uid) => !viewing.has(String(uid)))
              .map((uid) => emitSocial(uid).catch(() => {})),
            emitSocial(userId).catch(() => {}),
          ]))
          .catch(() => {});
      });
    }

    if (channelId) {
      let channel = socket.data.dmChannelCache?.[channelId];
      if (!channel || !channel.users?.includes(userId)) {
        channel = await store.getDMChannelById(channelId);
        if (channel) {
          if (!socket.data.dmChannelCache) socket.data.dmChannelCache = {};
          socket.data.dmChannelCache[channelId] = channel;
        }
      }
      if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'Kanal bulunamadı.' });
      // Engeli client zaten kontrol ediyor; DB engel kontrolünü arka planda tut (hız)
      if (channel.type === 'dm') {
        const otherId = channel.users.find((id) => id !== userId);
        if (otherId) {
          const bc = socket.data.blockCache?.[otherId];
          if (bc?.blocked) return cb?.({ error: 'Engellediğin bir kullanıcıya mesaj gönderemezsin.' });
          if (bc?.blockedByThem) return cb?.({ error: 'Bu kullanıcıya mesaj gönderemezsin.' });
        }
      }
      const result = replyTo
        ? await store.setDmReply(channelId, userId, text, replyTo, channel)
        : await store.pushDmChannelMessage(channelId, userId, text, channel);
      if (result.error) return cb?.({ error: result.error });
      const ch = result._channel || channel;
      delete result._channel;
      if (!socket.data.dmChannelCache) socket.data.dmChannelCache = {};
      socket.data.dmChannelCache[ch.id] = ch;
      cb?.({ message: result });
      noteBroadcast(`dm:${result.id}`);
      broadcastDmFast(ch, result);
      return;
    }

    const friends = await store.getFriends(userId);
    if (!friends.some((f) => f.id === friendId)) return cb?.({ error: 'Arkadaş değil.' });
    const bs = await store.blockState(userId, friendId);
    if (bs.blockedByMe) return cb?.({ error: 'Engellediğin bir kullanıcıya mesaj gönderemezsin.' });
    if (bs.blockedByThem) return cb?.({ error: 'Bu kullanıcıya mesaj gönderemezsin.' });
    const channel = await store.getOrCreateDMChannel(userId, friendId);
    const result = replyTo
      ? await store.setDmReply(channel.id, userId, text, replyTo)
      : await store.pushDM(userId, friendId, text);
    if (result.error) return cb?.({ error: result.error });
    const ch = result._channel || channel;
    delete result._channel;
    cb?.({ message: result });
    noteBroadcast(`dm:${result.id}`);
    broadcastDmFast(ch, result).catch(() => {});
  });

  socket.on('create-group-dm', async ({ memberIds, name }, cb) => {
    const result = await store.createGroupDM(userId, memberIds || [], name);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    for (const uid of result.channel.users) emitSocial(uid);
  });

  socket.on('update-group-dm', async ({ channelId, name }, cb) => {
    const result = await store.updateGroupDM(userId, channelId, { name });
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitToChannelUsers(await store.getDMChannelById(channelId), 'group-dm-updated', { channel: result.channel });
    for (const uid of result.channel.users) emitSocial(uid);
  });

  socket.on('leave-group-dm', async ({ channelId }, cb) => {
    const channel = await store.getDMChannelById(channelId);
    const result = await store.leaveGroupDM(userId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
    if (channel) {
      for (const uid of channel.users) {
        if (uid !== userId) emitSocial(uid);
      }
    }
  });

  socket.on('group-dm-pin', async ({ channelId, pinned }, cb) => {
    const result = await store.setGroupPinned(userId, channelId, !!pinned);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('group-dm-close', async ({ channelId }, cb) => {
    const result = await store.closeGroupDm(userId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('group-dm-read', async ({ channelId }, cb) => {
    const result = await store.markGroupRead(userId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('group-dm-mute', async ({ channelId, until }, cb) => {
    const result = await store.setGroupMuted(userId, channelId, until);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });

  socket.on('search-dm', async ({ channelId, query }, cb) => {
    cb?.(await store.searchDmChannel(userId, channelId, query));
  });

  socket.on('pin-dm-message', async ({ channelId, messageId, pinned }, cb) => {
    const result = await store.pinDmMessage(userId, channelId, messageId, pinned !== false);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    noteBroadcast(`dm-pins:${channelId}`);
    const channel = await store.getDMChannelById(channelId);
    if (channel) emitToChannelUsers(channel, 'dm-pins-updated', { channelId, pins: result.pins });
  });

  socket.on('get-dm-pins', async ({ channelId }, cb) => {
    cb?.(await store.getDmPins(userId, channelId));
  });

  socket.on('react-dm-message', async ({ channelId, messageId, emoji }, cb) => {
    const result = await store.reactDmMessage(userId, channelId, messageId, emoji);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    noteBroadcast(`dm-react:${result.messageId}`);
    const channel = await store.getDMChannelById(channelId);
    if (channel) {
      emitToChannelUsers(channel, 'dm-reaction', {
        channelId,
        messageId: result.messageId,
        reactions: result.reactions,
      });
    }
  });

  socket.on('dm-unread', async ({ friendId }, cb) => {
    const result = await store.markDmUnread(userId, friendId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });

  socket.on('group-unread', async ({ channelId }, cb) => {
    const result = await store.markGroupUnread(userId, channelId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });

  socket.on('dm-pin', async ({ friendId, pinned }, cb) => {
    const result = await store.setDmPinned(userId, friendId, !!pinned);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('dm-close', async ({ friendId }, cb) => {
    const result = await store.closeDm(userId, friendId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('dm-read', async ({ friendId }, cb) => {
    const result = await store.markDmRead(userId, friendId);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('dm-mute', async ({ friendId, until }, cb) => {
    const result = await store.setDmMuted(userId, friendId, until);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('user-ignore', async ({ targetId, ignored }, cb) => {
    const result = await store.setIgnored(userId, targetId, !!ignored);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
  });
  socket.on('user-block', async ({ targetId, blocked }, cb) => {
    const result = await store.setBlocked(userId, targetId, !!blocked);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
    emitSocial(userId);
    emitSocial(targetId);
  });
  socket.on('friend-note', async ({ friendId, note }, cb) => {
    const result = await store.setFriendNote(userId, friendId, note);
    if (result.error) return cb?.({ error: result.error });
    cb?.(result);
  });
  socket.on('get-profile', async ({ userId: targetId }, cb) => {
    const [result, act] = await Promise.all([
      store.getUserProfile(userId, targetId),
      store.getDmActivity(userId, targetId).catch(() => null),
    ]);
    if (result.error) return cb?.({ error: result.error });
    cb?.({
      ...result,
      online: isOnline(targetId),
      dmChannelId: act?.dmChannelId || null,
    });
  });
  socket.on('invite-to-server', async ({ serverId, targetId }, cb) => {
    const result = await store.inviteToServer(userId, serverId, targetId);
    if (result.error) return cb?.({ error: result.error });
    const { channel, message, server, alreadyMember } = result;
    cb?.({ server, channelId: channel.id, message, alreadyMember });

    const payload = {
      channelId: channel.id,
      type: 'dm',
      fromId: userId,
      username: socket.data.username,
      message,
      friendId: userId,
      muted: false,
      ignored: false,
      blocked: false,
    };
    socket.emit('dm-invite-sent', {
      channelId: channel.id,
      targetId,
      message,
    });
    noteBroadcast(`dm:${message.id}`);
    for (const uid of channel.users) {
      if (uid === userId) continue;
      const sockets = onlineUsers.get(uid);
      if (sockets) for (const sid of sockets) io.to(sid).emit('dm', payload);
    }
    setImmediate(() => {
      const viewing = new Set();
      for (const [uid, sockets] of onlineUsers) {
        if (!sockets?.size) continue;
        for (const sid of sockets) {
          const s = io.sockets.sockets.get(sid);
          if (s?.data?.viewingDmChannelId && String(s.data.viewingDmChannelId) === String(channel.id)) {
            viewing.add(String(uid));
            break;
          }
        }
      }
      const skipUserIds = channel.users.filter((uid) => uid !== userId && viewing.has(String(uid)));
      store.markDmRecipientsUnread(channel, userId, { skipUserIds })
        .then(() => Promise.all([
          ...channel.users
            .filter((uid) => uid !== userId && !viewing.has(String(uid)))
            .map((uid) => emitSocial(uid).catch(() => {})),
          emitSocial(userId).catch(() => {}),
        ]))
        .catch(() => {});
    });
  });

  // ---- DM araması (zil + mesh, kanal = dmChannelId) ----
  socket.on('dm-call-ring', async ({ channelId }, cb) => {
    const channel = await store.getDMChannelById(channelId);
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

    const timer = setTimeout(async () => {
      // Önce odadakileri çıkar, sonra zili/kayıtı kapat — stale "Aramaya katıl" kalmasın
      await Promise.all(
        [...(voiceParticipants.get(channelId)?.keys() || [])].map(async (sid) => {
          const s = io.sockets.sockets.get(sid);
          if (s?.data?.dmCall) await leaveVoice(s);
        })
      );
      clearDmRing(channelId, 'timeout');
      if (dmCallLogs.has(channelId)) await endDmCallLog(channelId, 'timeout');
    }, DM_RING_MS);

    dmCallRings.set(channelId, {
      fromId: userId,
      fromUsername: socket.data.username,
      timer,
    });

    // Sohbet geçmişine aktif arama satırı
    await startDmCallLog(channel, userId, socket.data.username);

    emitToChannelUsers(channel, 'dm-call-incoming', {
      channelId,
      fromId: userId,
      fromUsername: socket.data.username,
      ringMs: DM_RING_MS,
    }, userId);

    cb?.({ ok: true, ringing: true, ringMs: DM_RING_MS });
  });

  socket.on('dm-call-cancel', async ({ channelId }, cb) => {
    const channel = await store.getDMChannelById(channelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });
    const ring = dmCallRings.get(channelId);
    if (ring && ring.fromId !== userId) return cb?.({ error: 'Bu aramayı iptal edemezsiniz.' });
    clearDmRing(channelId, 'cancel');
    if (socket.data.voiceChannelId === channelId && socket.data.dmCall) leaveVoice(socket);
    cb?.({ ok: true });
  });

  socket.on('dm-call-reject', async ({ channelId }, cb) => {
    const channel = await store.getDMChannelById(channelId);
    if (!channel || !channel.users.includes(userId)) return cb?.({ error: 'DM bulunamadı.' });
    const ring = dmCallRings.get(channelId);
    if (!ring) return cb?.({ ok: true });
    clearDmRing(channelId, 'reject');
    kickDmCallParticipants(channelId);
    cb?.({ ok: true });
  });

  socket.on('join-dm-call', async ({ channelId }, cb) => {
    const channel = await store.getDMChannelById(channelId);
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
  socket.on('join-voice', async ({ channelId }, cb) => {
    const found = await store.findChannel(channelId);
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

  socket.on('leave-voice', async () => {
    leaveVoice(socket);
  });

  // İstemci gecikme ölçümü (ping göstergesi)
  socket.on('latency-ping', async (sentAt, cb) => {
    if (typeof cb === 'function') cb({ sentAt, serverAt: Date.now() });
  });

  socket.on('voice-state', async ({ muted, deafened, camera, screen, camId, screenId }) => {
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

  socket.on('voice-offer', async ({ targetId, offer }) => {
    io.to(targetId).emit('voice-offer', { fromId: socket.id, userId, username: socket.data.username, offer });
  });
  socket.on('voice-answer', async ({ targetId, answer }) => {
    io.to(targetId).emit('voice-answer', { fromId: socket.id, answer });
  });
  socket.on('voice-ice', async ({ targetId, candidate }) => {
    io.to(targetId).emit('voice-ice', { fromId: socket.id, candidate });
  });

  socket.on('disconnect', async () => {
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
  startRealtime({ io, onlineUsers, emitToChannelUsers });
});
