import { supabase } from './supabase.js';
import { invalidateProfileCache } from './store.js';

/**
 * Supabase Realtime → sunucu cache invalidation + Socket.IO fanout.
 * Tarayıcıya doğrudan Realtime vermiyoruz; mevcut mimari (secret key + Socket.IO) korunuyor.
 */
export function startRealtime({ io, onlineUsers }) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.warn('[realtime] Supabase yapılandırması yok — atlanıyor.');
    return null;
  }

  const emitToUser = (userId, event, payload) => {
    const sockets = onlineUsers.get(userId);
    if (!sockets) return;
    for (const sid of sockets) io.to(sid).emit(event, payload);
  };

  const channel = supabase
    .channel('muck-cache')
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
      if (a) emitToUser(a, 'profile-updated', { userId: b, reason: 'friendship' });
      if (b) emitToUser(b, 'profile-updated', { userId: a, reason: 'friendship' });
      if (a) emitToUser(a, 'social-invalidate', { reason: 'friendship' });
      if (b) emitToUser(b, 'social-invalidate', { reason: 'friendship' });
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
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('[realtime] Supabase Realtime bağlı (cache invalidation)');
      else if (status === 'CHANNEL_ERROR') console.warn('[realtime] kanal hatası — migration 006 uygulandı mı?');
      else if (status === 'TIMED_OUT') console.warn('[realtime] bağlantı zaman aşımı');
    });

  return channel;
}
