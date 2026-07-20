import { supabase } from './supabase.js';
import { invalidateProfileCache } from './store.js';
import * as store from './store.js';

/** Aynı olayın Socket.IO + Realtime çift yayınını engelle (ms) */
const recentBroadcasts = new Map();

export function noteBroadcast(key, ttlMs = 3000) {
  if (!key) return;
  recentBroadcasts.set(String(key), Date.now() + ttlMs);
  if (recentBroadcasts.size > 2000) {
    const now = Date.now();
    for (const [k, exp] of recentBroadcasts) {
      if (exp < now) recentBroadcasts.delete(k);
    }
  }
}

function isDup(key) {
  const exp = recentBroadcasts.get(String(key));
  if (!exp) return false;
  if (Date.now() > exp) {
    recentBroadcasts.delete(String(key));
    return false;
  }
  return true;
}

function dmRowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromId: row.author_id,
    text: row.content,
    ts: new Date(row.created_at).getTime(),
    reactions: row.reactions || {},
    replyTo: row.reply_to || null,
    edited: !!row.edited_at,
    metadata: row.metadata || null,
    mediaUrls: row.media_urls || [],
  };
}

function channelRowToMessage(row, username) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.author_id,
    username: username || '—',
    text: row.content,
    ts: new Date(row.created_at).getTime(),
    reactions: row.reactions || {},
    replyTo: row.reply_to || null,
    edited: !!row.edited_at,
    metadata: row.metadata || null,
    mediaUrls: row.media_urls || [],
  };
}

function reactionsChanged(a, b) {
  return JSON.stringify(a?.reactions ?? {}) !== JSON.stringify(b?.reactions ?? {});
}

function metadataChanged(a, b) {
  return JSON.stringify(a?.metadata ?? null) !== JSON.stringify(b?.metadata ?? null);
}

/**
 * Supabase Realtime → cache invalidation + Socket.IO fanout.
 * Migration 006 ile tüm tablolar publication'da olmalı.
 */
export function startRealtime({ io, onlineUsers, emitToChannelUsers }) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.warn('[realtime] Supabase yapılandırması yok — atlanıyor.');
    return null;
  }

  const emitToUser = (userId, event, payload) => {
    if (!userId) return;
    const sockets = onlineUsers.get(userId);
    if (!sockets) return;
    for (const sid of sockets) io.to(sid).emit(event, payload);
  };

  try {
    supabase.realtime.setAuth(process.env.SUPABASE_SECRET_KEY);
  } catch (err) {
    console.warn('[realtime] setAuth:', err?.message || err);
  }

  const onDmMessage = async (payload) => {
    const row = payload.new || payload.old;
    if (!row?.id) return;
    const channelId = row.channel_id;

    if (payload.eventType === 'INSERT') {
      if (isDup(`dm:${row.id}`)) return;
      noteBroadcast(`dm:${row.id}`);
      const [channel, author] = await Promise.all([
        store.getDMChannelById(channelId),
        store.findById(row.author_id),
      ]);
      if (!channel) return;
      const message = dmRowToMessage(row);
      const fromId = row.author_id;
      const username = author?.username || '—';
      emitToChannelUsers(channel, 'dm', {
        channelId,
        type: channel.type,
        fromId,
        username,
        message,
        friendId: channel.type === 'dm' ? fromId : null,
        muted: false,
        ignored: false,
        blocked: false,
      });
      return;
    }

    if (payload.eventType === 'UPDATE') {
      const message = dmRowToMessage(payload.new);
      const channel = await store.getDMChannelById(channelId);
      if (!channel || !message) return;

      // Arama kaydı güncellemesi
      if (metadataChanged(payload.old, payload.new) && payload.new?.metadata?.type === 'dm_call') {
        if (isDup(`dm-call-log:${row.id}`)) return;
        noteBroadcast(`dm-call-log:${row.id}`);
        emitToChannelUsers(channel, 'dm-call-log', { channelId, message });
      }

      // Tepki
      if (reactionsChanged(payload.old, payload.new)) {
        if (isDup(`dm-react:${row.id}:${JSON.stringify(payload.new.reactions)}`)) return;
        noteBroadcast(`dm-react:${row.id}`);
        emitToChannelUsers(channel, 'dm-reaction', {
          channelId,
          messageId: row.id,
          reactions: payload.new.reactions || {},
        });
      }

      // Düzenleme
      if (payload.old?.content !== payload.new?.content || (!!payload.old?.edited_at) !== (!!payload.new?.edited_at)) {
        if (isDup(`dm-edit:${row.id}`)) return;
        noteBroadcast(`dm-edit:${row.id}`);
        emitToChannelUsers(channel, 'dm-edited', {
          channelId,
          messageId: row.id,
          text: payload.new.content,
        });
      }
      return;
    }

    if (payload.eventType === 'DELETE') {
      if (isDup(`dm-del:${row.id}`)) return;
      noteBroadcast(`dm-del:${row.id}`);
      const channel = await store.getDMChannelById(channelId);
      if (!channel) return;
      emitToChannelUsers(channel, 'dm-deleted', { channelId, messageId: row.id });
    }
  };

  const onChannelMessage = async (payload) => {
    const row = payload.new || payload.old;
    if (!row?.id) return;
    const channelId = row.channel_id;

    if (payload.eventType === 'INSERT') {
      if (isDup(`msg:${row.id}`)) return;
      noteBroadcast(`msg:${row.id}`);
      const author = await store.findById(row.author_id);
      const message = channelRowToMessage(row, author?.username);
      io.to(`chan:${channelId}`).emit('message', { channelId, message });
      return;
    }

    if (payload.eventType === 'UPDATE') {
      if (reactionsChanged(payload.old, payload.new)) {
        if (isDup(`msg-react:${row.id}`)) return;
        noteBroadcast(`msg-react:${row.id}`);
        io.to(`chan:${channelId}`).emit('channel-reaction', {
          channelId,
          messageId: row.id,
          reactions: payload.new.reactions || {},
        });
      }
      if (payload.old?.content !== payload.new?.content || (!!payload.old?.edited_at) !== (!!payload.new?.edited_at)) {
        if (isDup(`msg-edit:${row.id}`)) return;
        noteBroadcast(`msg-edit:${row.id}`);
        io.to(`chan:${channelId}`).emit('message-edited', {
          channelId,
          messageId: row.id,
          text: payload.new.content,
        });
      }
      return;
    }

    if (payload.eventType === 'DELETE') {
      if (isDup(`msg-del:${row.id}`)) return;
      noteBroadcast(`msg-del:${row.id}`);
      io.to(`chan:${channelId}`).emit('message-deleted', { channelId, messageId: row.id });
    }
  };

  const onDmPins = async (payload) => {
    const channelId = payload.new?.channel_id || payload.old?.channel_id;
    if (!channelId || isDup(`dm-pins:${channelId}`)) return;
    noteBroadcast(`dm-pins:${channelId}`);
    const channel = await store.getDMChannelById(channelId);
    if (!channel?.users?.length) return;
    const pinRes = await store.getDmPins(channel.users[0], channelId);
    emitToChannelUsers(channel, 'dm-pins-updated', {
      channelId,
      pins: pinRes.pins || [],
    });
  };

  const onChannelPins = async (payload) => {
    const channelId = payload.new?.channel_id || payload.old?.channel_id;
    if (!channelId || isDup(`chan-pins:${channelId}`)) return;
    noteBroadcast(`chan-pins:${channelId}`);
    const found = await store.findChannel(channelId);
    if (!found) return;
    const memberId = found.server.members?.[0];
    if (!memberId) return;
    const pinRes = await store.getChannelPins(memberId, channelId);
    io.to(`chan:${channelId}`).emit('channel-pins-updated', {
      channelId,
      pins: pinRes.pins || [],
    });
  };

  const channel = supabase
    .channel('muck-server-all', { config: { private: false } })
    // ---- profiller / sosyal ----
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
      const id = payload.new?.id || payload.old?.id;
      if (!id) return;
      invalidateProfileCache(id);
      io.emit('profile-updated', { userId: id, reason: 'profile' });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, (payload) => {
      const a = payload.new?.user_a || payload.old?.user_a;
      const b = payload.new?.user_b || payload.old?.user_b;
      if (a) invalidateProfileCache(a);
      if (b) invalidateProfileCache(b);
      if (a) {
        emitToUser(a, 'profile-updated', { userId: b, reason: 'friendship' });
        emitToUser(a, 'social-invalidate', { reason: 'friendship' });
      }
      if (b) {
        emitToUser(b, 'profile-updated', { userId: a, reason: 'friendship' });
        emitToUser(b, 'social-invalidate', { reason: 'friendship' });
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, (payload) => {
      const fromId = payload.new?.from_id || payload.old?.from_id;
      const toId = payload.new?.to_id || payload.old?.to_id;
      if (fromId) emitToUser(fromId, 'social-invalidate', { reason: 'friend_request' });
      if (toId) emitToUser(toId, 'social-invalidate', { reason: 'friend_request' });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_social' }, (payload) => {
      const id = payload.new?.user_id || payload.old?.user_id;
      if (!id) return;
      invalidateProfileCache(id);
      emitToUser(id, 'profile-updated', { userId: id, reason: 'social' });
      emitToUser(id, 'social-invalidate', { reason: 'social' });
    })
    // ---- sunucular ----
    .on('postgres_changes', { event: '*', schema: 'public', table: 'server_members' }, (payload) => {
      const id = payload.new?.user_id || payload.old?.user_id;
      const serverId = payload.new?.server_id || payload.old?.server_id;
      if (id) {
        invalidateProfileCache(id);
        emitToUser(id, 'profile-updated', { userId: id, reason: 'servers' });
        emitToUser(id, 'social-invalidate', { reason: 'server_members', serverId });
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'servers' }, (payload) => {
      const id = payload.new?.id || payload.old?.id;
      invalidateProfileCache();
      io.emit('social-invalidate', { reason: 'server', serverId: id });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'channels' }, (payload) => {
      const serverId = payload.new?.server_id || payload.old?.server_id;
      if (serverId) io.emit('social-invalidate', { reason: 'channels', serverId });
    })
    // ---- mesajlar ----
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_messages' }, (payload) => {
      onDmMessage(payload).catch((e) => console.warn('[realtime] dm_messages', e?.message || e));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (payload) => {
      onChannelMessage(payload).catch((e) => console.warn('[realtime] messages', e?.message || e));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_pins' }, (payload) => {
      onDmPins(payload).catch((e) => console.warn('[realtime] dm_pins', e?.message || e));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'channel_pins' }, (payload) => {
      onChannelPins(payload).catch((e) => console.warn('[realtime] channel_pins', e?.message || e));
    })
    // ---- DM kanalları ----
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_channels' }, (payload) => {
      const id = payload.new?.id || payload.old?.id;
      if (!id || isDup(`dm-ch:${id}:${payload.eventType}`)) return;
      noteBroadcast(`dm-ch:${id}:${payload.eventType}`);
      store.getDMChannelById(id).then((ch) => {
        if (!ch) return;
        for (const uid of ch.users) emitToUser(uid, 'social-invalidate', { reason: 'dm_channel', channelId: id });
      }).catch(() => {});
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_members' }, (payload) => {
      const uid = payload.new?.user_id || payload.old?.user_id;
      const channelId = payload.new?.channel_id || payload.old?.channel_id;
      if (uid) emitToUser(uid, 'social-invalidate', { reason: 'dm_members', channelId });
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('[realtime] Aktif — mesajlar + profil + sosyal + pinler dinleniyor');
        return;
      }
      if (status === 'CHANNEL_ERROR') {
        console.warn(
          '[realtime] Kanal hatası. SQL Editor’da 006_realtime_publication.sql çalıştır.',
          err?.message || err || ''
        );
        return;
      }
      if (status === 'TIMED_OUT') console.warn('[realtime] Zaman aşımı');
      if (status === 'CLOSED') console.warn('[realtime] Kanal kapandı');
    });

  return channel;
}
