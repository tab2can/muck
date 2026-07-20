import { supabase } from './supabase.js';
import { invalidateProfileCache } from './store.js';

/**
 * Supabase Realtime (postgres_changes) → sunucu cache invalidation + Socket.IO.
 * Tabloların `supabase_realtime` publication'ında olması gerekir (migration 006).
 */
export function startRealtime({ io, onlineUsers }) {
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

  // Secret key ile Realtime auth (RLS bypass / tüm değişiklikler)
  try {
    supabase.realtime.setAuth(process.env.SUPABASE_SECRET_KEY);
  } catch (err) {
    console.warn('[realtime] setAuth:', err?.message || err);
  }

  const channel = supabase
    .channel('muck-server-cache', { config: { private: false } })
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'server_members' }, (payload) => {
      const id = payload.new?.user_id || payload.old?.user_id;
      if (!id) return;
      invalidateProfileCache(id);
      emitToUser(id, 'profile-updated', { userId: id, reason: 'servers' });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'servers' }, (payload) => {
      const id = payload.new?.id || payload.old?.id;
      if (!id) return;
      // Üyelik listesini bilmediğimiz için profil önbelleğini genel temizle
      invalidateProfileCache();
      io.emit('social-invalidate', { reason: 'server', serverId: id });
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('[realtime] Supabase Realtime aktif — postgres_changes dinleniyor');
        return;
      }
      if (status === 'CHANNEL_ERROR') {
        console.warn(
          '[realtime] Kanal hatası. SQL Editor’da migration 006_realtime_publication.sql çalıştırıldığından emin ol.',
          err?.message || err || ''
        );
        return;
      }
      if (status === 'TIMED_OUT') {
        console.warn('[realtime] Bağlantı zaman aşımı — yeniden denenecek');
        return;
      }
      if (status === 'CLOSED') {
        console.warn('[realtime] Kanal kapandı');
      }
    });

  return channel;
}
