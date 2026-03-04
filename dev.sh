#!/usr/bin/env bash
#
# Vindustry Development Runner
#
# Starts the water-treatment PLC (physics + control + alarms in one process).
# Requires NATS server running with JetStream enabled.
# Requires tentacle-modbus-server running separately (in tentacle repo).
#
# Usage:
#   ./dev.sh start       Start all services
#   ./dev.sh stop        Stop all services
#   ./dev.sh status      Show running services
#   ./dev.sh logs        Follow all service logs
#   ./dev.sh restart     Restart all services

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/.dev-logs"

SERVICES=(
  "verticals/water-treatment"
)

SERVICE_NAMES=(
  "water-treatment-plc"
)

mkdir -p "$LOG_DIR"

start_service() {
  local dir="$1"
  local name="$2"
  local pid_file="$LOG_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"

  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "  $name: already running (PID $(cat "$pid_file"))"
    return
  fi

  echo "  $name: starting..."
  cd "$SCRIPT_DIR/$dir"
  setsid deno task dev > "$log_file" 2>&1 &
  local pid=$!
  echo "$pid" > "$pid_file"
  cd "$SCRIPT_DIR"
  echo "  $name: started (PID $pid)"
}

stop_service() {
  local name="$1"
  local pid_file="$LOG_DIR/$name.pid"

  if [[ ! -f "$pid_file" ]]; then
    echo "  $name: not running"
    return
  fi

  local pid
  pid=$(cat "$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $name: stopping (PID $pid)..."
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    # Wait a moment for graceful shutdown
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    # Force kill if still running
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 -- -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    fi
    echo "  $name: stopped"
  else
    echo "  $name: not running (stale PID file)"
  fi
  rm -f "$pid_file"
}

case "${1:-start}" in
  start)
    echo "Starting Vindustry services..."
    for i in "${!SERVICES[@]}"; do
      start_service "${SERVICES[$i]}" "${SERVICE_NAMES[$i]}"
    done
    echo ""
    echo "Services started. Use './dev.sh logs' to follow output."
    echo "Note: NATS server and tentacle-modbus-server must be running separately."
    ;;

  stop)
    echo "Stopping Vindustry services..."
    for name in "${SERVICE_NAMES[@]}"; do
      stop_service "$name"
    done
    ;;

  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;

  status)
    echo "Vindustry service status:"
    for name in "${SERVICE_NAMES[@]}"; do
      local_pid_file="$LOG_DIR/$name.pid"
      if [[ -f "$local_pid_file" ]] && kill -0 "$(cat "$local_pid_file")" 2>/dev/null; then
        echo "  $name: running (PID $(cat "$local_pid_file"))"
      else
        echo "  $name: stopped"
      fi
    done
    ;;

  logs)
    echo "Following all service logs (Ctrl+C to stop)..."
    tail -f "$LOG_DIR"/*.log
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
