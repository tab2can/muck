#!/bin/bash
# Muck — coturn (TURN) kurulumu
# Ses/kamera/ekran paylaşımının farklı ağlar arasında çalışması için zorunlu.
#
# Kullanım (sunucuda root):
#   cd /home/muck
#   sed -i 's/\r$//' deploy/install-turn.sh
#   bash deploy/install-turn.sh

set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${TURN_HOST:-muck.tr}"
SECRET="${TURN_SECRET:-}"

if [ -z "$SECRET" ]; then
  SECRET=$(openssl rand -hex 24)
fi

echo "==> coturn kuruluyor..."
apt-get update -y
apt-get install -y coturn

PUBLIC_IP=$(curl -4 -s --max-time 5 ifconfig.me || curl -4 -s --max-time 5 icanhazip.com || true)
if [ -z "$PUBLIC_IP" ]; then
  echo "UYARI: Genel IP alınamadı. /etc/turnserver.conf içinde external-ip satırını elle doldurun."
  PUBLIC_IP="0.0.0.0"
fi
echo "    Public IP: $PUBLIC_IP"

echo "==> /etc/turnserver.conf yazılıyor..."
cat > /etc/turnserver.conf <<EOF
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${SECRET}
realm=${DOMAIN}
server-name=${DOMAIN}
external-ip=${PUBLIC_IP}
min-port=49160
max-port=49200
no-cli
no-tls
no-dtls
verbose
log-file=/var/log/turnserver.log
simple-log
EOF

# systemd'de TURN aktif
sed -i 's/^TURNSERVER_ENABLED=0/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
if ! grep -q 'TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null; then
  echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
fi

echo "==> Firewall (ufw) — UDP/TCP 3478 + relay portları..."
if command -v ufw &>/dev/null; then
  ufw allow 3478/tcp || true
  ufw allow 3478/udp || true
  ufw allow 49160:49200/udp || true
  ufw allow 49160:49200/tcp || true
fi

systemctl enable coturn
systemctl restart coturn
sleep 1
systemctl --no-pager --full status coturn | head -20 || true

ENV_FILE="$APP_DIR/.env"
touch "$ENV_FILE"
# Eski TURN satırlarını temizle
sed -i '/^TURN_HOST=/d;/^TURN_SECRET=/d;/^TURN_ENABLED=/d' "$ENV_FILE"
cat >> "$ENV_FILE" <<EOF
TURN_ENABLED=1
TURN_HOST=${DOMAIN}
TURN_SECRET=${SECRET}
EOF

echo ""
echo "==> PM2 ortam değişkenleri güncelleniyor..."
# ecosystem içine yazmak yerine pm2 env ile enjekte et
cd "$APP_DIR"
if command -v pm2 &>/dev/null && pm2 describe muck &>/dev/null; then
  # ecosystem yeniden başlat — .env okuması için node tarafı process.env kullanır
  # PM2 .env otomatik yüklemez; ecosystem.config.cjs'e ekleyeceğiz veya export
  export TURN_ENABLED=1
  export TURN_HOST="$DOMAIN"
  export TURN_SECRET="$SECRET"
  pm2 restart muck --update-env || true
fi

echo ""
echo "TURN kuruldu."
echo "  Host:   ${DOMAIN}:3478"
echo "  Secret: ${SECRET}"
echo "  .env:   ${ENV_FILE}"
echo ""
echo "Önemli: Uygulama TURN_SECRET'i görmeli. Şunu çalıştırın:"
echo "  cd /home/muck"
echo "  export \$(grep -E '^TURN_' .env | xargs)"
echo "  pm2 restart muck --update-env"
echo "  # veya ecosystem.config.cjs env bölümüne TURN_* ekleyin"
echo ""
echo "Test: https://muck.tr  → ses kanalına iki farklı ağdan girin."
