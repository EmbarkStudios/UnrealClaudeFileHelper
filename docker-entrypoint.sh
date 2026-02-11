#!/bin/bash
set -e
mkdir -p /data/db /data/mirror /data/zoekt-index
if [ ! -f /app/config.json ]; then
  cp /app/config.docker.json /app/config.json
fi
exec node src/service/index.js
