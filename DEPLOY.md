# Muck — Sunucu Kurulum Rehberi

Domain: **https://muck.tr**  
Sunucu klasörü: **`/home/muck`**

## Gereksinimler

- Ubuntu 22.04 / Debian 12
- `muck.tr` ve `www.muck.tr` → A kaydı (sunucu IP)
- HTTPS zorunlu (ekran paylaşımı + PWA)

---

## 1. DNS

| Kayıt | Tip | Değer |
|--------|-----|--------|
| `muck.tr` | A | Sunucu IP |
| `www.muck.tr` | A veya CNAME | Aynı IP / `muck.tr` |

Kontrol:

```bash
nslookup muck.tr 8.8.8.8
```

---

## 2. Dosyaları yükle

Projeyi sunucuda `/home/muck` altına koy (git, scp, rsync vb.):

```bash
mkdir -p /home/muck
cd /home/muck
# dosyalar burada olmalı: package.json, server/, public/, deploy/, ...
```

---

## 3. Sıfırdan kurulum (otomatik)

```bash
cd /home/muck
sed -i 's/\r$//' deploy/install.sh
chmod +x deploy/install.sh
sudo ./deploy/install.sh
```

Bu script: Node.js (yoksa), `npm install`, PM2 ve uygulamayı başlatır.

---

## 4. Nginx

```bash
cd /home/muck
sudo cp deploy/nginx-muck.conf /etc/nginx/sites-available/muck
sudo ln -sf /etc/nginx/sites-available/muck /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 5. SSL (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d muck.tr -d www.muck.tr
```

Tarayıcı: **https://muck.tr**

---

## 6. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Port **3000** dışarıya açılmamalı (sadece Nginx 80/443).

---

## 7. Kontrol

```bash
pm2 status
pm2 logs muck
curl -I http://127.0.0.1:3000
curl -I https://muck.tr
```

---

## 8. Güncelleme (sonraki deploy'lar)

```bash
cd /home/muck
npm install --omit=dev
pm2 restart muck
```

---

## Sorun giderme

| Sorun | Çözüm |
|-------|--------|
| DNS_PROBE_FINISHED_NXDOMAIN | A kaydı bekle / `ipconfig /flushdns` |
| Socket bağlanmıyor | Nginx `/socket.io/` location + `Upgrade`/`Connection` (`deploy/nginx-muck.conf`). Certbot sonrası 443 bloğunda da aynı `/socket.io/` bloğu olmalı. |
| Ses/kamera karşı tarafa gitmiyor (local çalışıyor) | Sunucuda `bash deploy/install-turn.sh` (coturn). Sonra `pm2 delete muck && pm2 start ecosystem.config.cjs`. Tarayıcıda Ctrl+Shift+R. Konsolda `[voice] peer … ice: connected` görülmeli. `/api/ice` cevabında `"turn": true` olmalı. |
| Ekran paylaşımı yok | HTTPS aktif mi kontrol et |
| Loglar | `pm2 logs muck` |
