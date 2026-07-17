/**
 * Eski JSON + Supabase verisini sıfırlar.
 *
 * Önce bir kez (Supabase SQL Editor):
 *   supabase/migrations/002_grants_and_wipe.sql
 *
 * Sonra sunucuda:
 *   cd /home/muck && node deploy/wipe-fresh.js && pm2 restart muck --update-env
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dataJson = path.join(root, 'server', 'data.json');

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

if (!url || !secret) {
  console.error('HATA: SUPABASE_URL ve SUPABASE_SECRET_KEY .env içinde tanımlı olmalı.');
  process.exit(1);
}

if (!String(secret).startsWith('sb_secret_') && !String(secret).includes('service_role')) {
  console.warn('UYARI: SUPABASE_SECRET_KEY genelde sb_secret_... ile başlar. Publishable key kullanma.');
}

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function wipeLegacyJson() {
  console.log('==> Eski data.json temizleniyor...');
  if (fs.existsSync(dataJson)) {
    fs.unlinkSync(dataJson);
    console.log('  ✓ server/data.json silindi');
  } else {
    console.log('  · server/data.json yok (zaten temiz)');
  }
  const dataDir = path.join(root, 'server', 'data');
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('  ✓ server/data/ silindi');
  }
}

async function wipeViaRpc() {
  console.log('==> Supabase wipe_muck_data() çağrılıyor...');
  const { data, error } = await supabase.rpc('wipe_muck_data');
  if (error) {
    console.error('  ! RPC hatası:', error.message);
    console.error('');
    console.error('Önce Supabase Dashboard → SQL Editor\'da şunu çalıştır:');
    console.error('  supabase/migrations/002_grants_and_wipe.sql');
    console.error('');
    console.error('Veya SQL Editor\'da doğrudan:');
    console.error(`
truncate table
  public.dm_pins, public.channel_pins, public.dm_messages, public.dm_members, public.dm_channels,
  public.messages, public.member_roles, public.role_permissions, public.roles,
  public.channels, public.server_members, public.servers, public.friendships,
  public.friend_requests, public.user_social, public.profiles
cascade;
delete from auth.users;
`);
    process.exit(1);
  }
  console.log('  ✓', JSON.stringify(data));
}

async function main() {
  console.log('Muck — temiz başlangıç (wipe)');
  console.log('Bu işlem GERİ ALINAMAZ.\n');
  wipeLegacyJson();
  await wipeViaRpc();
  console.log('\nTamam. Şimdi: pm2 restart muck --update-env');
  console.log('Tarayıcıda Ctrl+F5 + çerezleri temizle.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
