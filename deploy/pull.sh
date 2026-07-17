#!/bin/bash
# Sunucuda: /home/muck içinde çalıştır
#   bash deploy/pull.sh
set -e
cd "$(dirname "$0")/.."
echo "==> git pull..."
git pull --ff-only
echo "==> npm install..."
npm install --omit=dev
echo "==> pm2 restart..."
pm2 restart muck || pm2 start ecosystem.config.cjs
pm2 save
echo ""
echo "Tamam. Yeni UI için: https://muck.tr/login"
echo "Temiz DB için (dikkat: her şeyi siler): node deploy/wipe-fresh.js && pm2 restart muck"
