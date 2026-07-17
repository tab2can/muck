/**
 * Eski JSON + Supabase verisini sıfırlar (temiz başlangıç).
 *
 * Sunucuda:
 *   cd /home/muck && node deploy/wipe-fresh.js && pm2 restart muck
 *
 * Local:
 *   node deploy/wipe-fresh.js
 *
 * .env: SUPABASE_URL + SUPABASE_SECRET_KEY gerekli.
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

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** FK sırasına göre (önce çocuk tablolar) */
const TABLES = [
  { table: 'dm_pins', col: 'pinned_at' },
  { table: 'dm_messages', col: 'created_at' },
  { table: 'dm_members', col: 'user_id' },
  { table: 'dm_channels', col: 'created_at' },
  { table: 'messages', col: 'created_at' },
  { table: 'member_roles', col: 'role_id' },
  { table: 'role_permissions', col: 'permission' },
  { table: 'roles', col: 'created_at' },
  { table: 'channels', col: 'created_at' },
  { table: 'server_members', col: 'joined_at' },
  { table: 'servers', col: 'created_at' },
  { table: 'friendships', col: 'created_at' },
  { table: 'friend_requests', col: 'created_at' },
  { table: 'user_social', col: 'updated_at' },
  { table: 'profiles', col: 'created_at' },
];

async function wipeTables() {
  console.log('==> Supabase tabloları temizleniyor...');
  for (const { table, col } of TABLES) {
    const { error, count } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .gte(col, '1970-01-01');
    if (error) {
      // Bazı tablolarda tarih kolonu yoksa id ile dene
      const retry = await supabase.from(table).delete({ count: 'exact' }).neq('id', '');
      if (retry.error) {
        const retry2 = await supabase.from(table).delete({ count: 'exact' }).not(col, 'is', null);
        if (retry2.error) console.warn(`  ! ${table}: ${error.message}`);
        else console.log(`  ✓ ${table} (${retry2.count ?? '?'} satır)`);
      } else {
        console.log(`  ✓ ${table} (${retry.count ?? '?'} satır)`);
      }
    } else {
      console.log(`  ✓ ${table} (${count ?? '?'} satır)`);
    }
  }
}

async function wipeAuthUsers() {
  console.log('==> Auth kullanıcıları siliniyor...');
  let page = 1;
  let total = 0;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) {
      console.error('  Auth list hatası:', error.message);
      console.error('  (Secret key ile admin API gerekli — .env kontrol et)');
      break;
    }
    const users = data?.users || [];
    if (!users.length) break;
    for (const u of users) {
      const { error: delErr } = await supabase.auth.admin.deleteUser(u.id);
      if (delErr) console.warn(`  ! ${u.email || u.id}: ${delErr.message}`);
      else {
        total += 1;
        console.log(`  ✓ ${u.email || u.id}`);
      }
    }
    if (users.length < 100) break;
    page += 1;
  }
  console.log(`  Toplam silinen auth kullanıcısı: ${total}`);
}

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

async function main() {
  console.log('Muck — temiz başlangıç (wipe)');
  console.log('Bu işlem GERİ ALINAMAZ.\n');
  wipeLegacyJson();
  await wipeTables();
  await wipeAuthUsers();
  console.log('\nTamam. Şimdi: pm2 restart muck');
  console.log('Tarayıcıda Ctrl+F5 yap ve çerezleri temizle (eski muck_token kalmasın).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
