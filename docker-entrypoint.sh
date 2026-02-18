#!/bin/sh
set -e

# Ensure data directories exist (volumes may mount as empty)
mkdir -p /data/db /data/mirror /data/zoekt-index

# Use bind-mounted config if present, otherwise copy default
if [ ! -f /app/config.json ]; then
  cp /app/config.docker.json /app/config.json
  echo "[Docker] Using default config.docker.json"
fi

exec node src/service/index.js
