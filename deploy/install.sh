#!/bin/bash
# Muck sunucu kurulum scripti — /home/muck sıfırdan kurulum
# Kullanım:
#   cd /home/muck
#   sed -i 's/\r$//' deploy/install.sh
#   chmod +x deploy/install.sh
#   sudo ./deploy/install.sh

set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "==> Node.js kontrol ediliyor..."
if ! command -v node &>/dev/null; then
  echo "Node.js bulunamadı. Kuruluyor (Node 20)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v) | npm: $(npm -v)"

echo "==> Bağımlılıklar yükleniyor..."
npm install --omit=dev

echo "==> .env oluşturuluyor..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env dosyası oluşturuldu."
fi

echo "==> PM2 kuruluyor..."
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

echo "==> Uygulama başlatılıyor..."
pm2 delete muck 2>/dev/null || true
pm2 delete streamuck 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null || true

echo ""
echo "Kurulum tamamlandı."
echo "Uygulama: http://127.0.0.1:3000"
echo ""
echo "Sonraki adımlar:"
echo "  1. Nginx: sudo cp deploy/nginx-muck.conf /etc/nginx/sites-available/muck"
echo "  2. Etkinleştir: sudo ln -sf /etc/nginx/sites-available/muck /etc/nginx/sites-enabled/"
echo "  3. sudo nginx -t && sudo systemctl reload nginx"
echo "  4. SSL: sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d muck.tr -d www.muck.tr"
