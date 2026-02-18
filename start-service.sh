#!/bin/bash
# Start the unreal-index service in WSL.
# Usage: ./start-service.sh              (foreground)
#        ./start-service.sh --bg         (install + start systemd service)
#        ./start-service.sh --docker     (start via Docker Compose)
#        ./start-service.sh --stop       (stop service)
#        ./start-service.sh --restart    (restart service)
#        ./start-service.sh --status     (show service status)
#        ./start-service.sh --logs       (follow service logs)

cd "$(dirname "$0")"

REPO_DIR="$(pwd -P)"
NODE_DIR="$HOME/local/node22"
NODE_BIN="$NODE_DIR/bin/node"

export PATH="$NODE_DIR/bin:$HOME/go/bin:/usr/local/go/bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=3072"

SERVICE_NAME="unreal-index"

install_systemd_service() {
  mkdir -p "$HOME/.config/systemd/user"

  local SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"

  if [ ! -f "unreal-index.service.template" ]; then
    echo "ERROR: unreal-index.service.template not found in $REPO_DIR"
    exit 1
  fi

  sed -e "s|{{REPO_DIR}}|$REPO_DIR|g" \
      -e "s|{{NODE_DIR}}|$NODE_DIR|g" \
      -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
      -e "s|{{HOME}}|$HOME|g" \
      unreal-index.service.template > "$SERVICE_FILE"

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME.service" 2>/dev/null
}

case "${1:-}" in
  --bg)
    echo "Installing systemd service..."
    install_systemd_service

    # Restart if already running, otherwise start
    if systemctl --user is-active --quiet "$SERVICE_NAME.service" 2>/dev/null; then
      systemctl --user restart "$SERVICE_NAME.service"
    else
      systemctl --user start "$SERVICE_NAME.service"
    fi

    sleep 3

    if systemctl --user is-active --quiet "$SERVICE_NAME.service"; then
      echo "Service started successfully"
      echo "  Status:  systemctl --user status $SERVICE_NAME"
      echo "  Logs:    journalctl --user -u $SERVICE_NAME -f"
      echo "  Stop:    systemctl --user stop $SERVICE_NAME"
      curl -s http://127.0.0.1:3847/health | head -1 || true
    else
      echo "ERROR: Service failed to start"
      echo "Recent logs:"
      journalctl --user -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null
      exit 1
    fi
    ;;

  --stop)
    systemctl --user stop "$SERVICE_NAME.service"
    echo "Service stopped"
    ;;

  --restart)
    systemctl --user restart "$SERVICE_NAME.service"
    sleep 2
    systemctl --user status "$SERVICE_NAME.service" --no-pager
    ;;

  --status)
    systemctl --user status "$SERVICE_NAME.service" --no-pager
    ;;

  --logs)
    journalctl --user -u "$SERVICE_NAME" -f
    ;;

  --docker)
    echo "Starting Docker container..."
    if ! command -v docker &>/dev/null; then
      echo "ERROR: Docker not found. Install Docker Engine or Docker Desktop."
      exit 1
    fi
    docker compose up -d
    echo "Waiting for service..."
    for i in $(seq 1 30); do
      if curl -s http://127.0.0.1:3847/health > /dev/null 2>&1; then
        echo "Docker service started successfully"
        echo "  Logs:    docker compose logs -f"
        echo "  Stop:    docker compose stop"
        echo "  Restart: docker compose restart"
        curl -s http://127.0.0.1:3847/health | head -1 || true
        exit 0
      fi
      sleep 1
    done
    echo "ERROR: Service did not start within 30s"
    docker compose logs --tail=20
    exit 1
    ;;

  "")
    exec "$NODE_BIN" src/service/index.js
    ;;

  *)
    echo "Unknown option: $1"
    echo "Usage: ./start-service.sh [--bg|--docker|--stop|--restart|--status|--logs]"
    exit 1
    ;;
esac
