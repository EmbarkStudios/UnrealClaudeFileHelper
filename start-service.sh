#!/bin/bash
# Start the unreal-index service in WSL.
# Usage: ./start-service.sh          (foreground)
#        ./start-service.sh --bg     (background via screen)

cd "$(dirname "$0")"

# Add Go/Zoekt binaries to PATH
export PATH="$HOME/local/node22/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"

# Give Node enough heap for the in-memory index (~1.3GB for large projects)
export NODE_OPTIONS="--max-old-space-size=3072"

if [ "$1" = "--bg" ]; then
  screen -dmS unreal-index bash -c "node src/service/index.js 2>&1 | tee /tmp/unreal-index.log"
  sleep 3
  if screen -ls | grep -q unreal-index; then
    echo "Service started in screen session 'unreal-index'"
    echo "  Attach: screen -r unreal-index"
    echo "  Logs:   tail -f /tmp/unreal-index.log"
    curl -s http://127.0.0.1:3847/health | head -1
  else
    echo "ERROR: Service failed to start. Check /tmp/unreal-index.log"
    exit 1
  fi
elif [ "$1" = "--docker" ]; then
  docker compose up -d
  echo "Container starting... waiting for health check"
  for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:3847/health > /dev/null 2>&1; then
      echo "Service ready!"
      curl -s http://127.0.0.1:3847/health
      exit 0
    fi
    sleep 1
  done
  echo "WARNING: Service did not become healthy in 30s"
  docker compose logs --tail=20
  exit 1
else
  exec node src/service/index.js

fi
