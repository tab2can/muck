import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SRC = 'muck-logo.png';
const OUT = 'public/icons';
mkdirSync(OUT, { recursive: true });

// 44/50/71/150/310 = Microsoft Store (Square44x44, StoreLogo, Square71x71, Square150x150, Square310x310)
const sizes = [44, 48, 50, 71, 72, 96, 128, 144, 150, 152, 180, 192, 256, 310, 384, 512];
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

for (const s of sizes) {
  await sharp(SRC)
    .resize(s, s, { fit: 'contain', background: transparent })
    .png()
    .toFile(path.join(OUT, `icon-${s}.png`));
  console.log(`icon-${s}.png`);
}

// Maskable: %80 güvenli alan, arka plan şeffaf
for (const s of [192, 512]) {
  const inner = Math.round(s * 0.8);
  const pad = Math.round((s - inner) / 2);
  const logo = await sharp(SRC)
    .resize(inner, inner, { fit: 'contain', background: transparent })
    .png()
    .toBuffer();
  await sharp({ create: { width: s, height: s, channels: 4, background: transparent } })
    .composite([{ input: logo, top: pad, left: pad }])
    .png()
    .toFile(path.join(OUT, `maskable-${s}.png`));
  console.log(`maskable-${s}.png`);
}

// Ana ikon (favicon / auth logo / boş ekran)
await sharp(SRC)
  .resize(512, 512, { fit: 'contain', background: transparent })
  .png()
  .toFile('public/icon.png');
console.log('icon.png');

// Şeffaflık doğrulaması
const meta = await sharp('public/icons/icon-512.png').metadata();
console.log('hasAlpha:', meta.hasAlpha, 'channels:', meta.channels);
