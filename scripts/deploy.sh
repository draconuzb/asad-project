#!/bin/bash
# Deploy script - runs on server after git pull
set -e

APP_DIR="/home/ubuntu/asad-project"
cd "$APP_DIR"

echo "📦 Installing dependencies..."
npm ci --production 2>/dev/null || npm install --production

echo "📦 Installing GUI dependencies..."
cd gui && npm ci --production 2>/dev/null || npm install --production
cd "$APP_DIR"

echo "🔄 Restarting services with PM2..."
pm2 restart ecosystem.config.js --update-env

echo "✅ Deploy complete!"
pm2 status
