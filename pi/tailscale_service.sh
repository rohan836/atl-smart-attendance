#!/bin/bash
# ATL Smart Attendance — Tailscale Service Helper
# Manages user-space Tailscale daemon and local port forwarding (port 5000)

set -e

USER_BIN="/home/lancer/.local/bin"
STATE_DIR="/home/lancer/.local/share/tailscale"
SOCK_PATH="${STATE_DIR}/tailscaled.sock"
LOG_FILE="${STATE_DIR}/tailscaled.log"
TS_BIN="${USER_BIN}/tailscale"
TSD_BIN="${USER_BIN}/tailscaled"

mkdir -p "${USER_BIN}" "${STATE_DIR}"

ensure_binaries() {
  if [ ! -f "${TS_BIN}" ] || [ ! -f "${TSD_BIN}" ]; then
    echo "[Tailscale] Downloading Tailscale binaries..."
    TS_VERSION="1.102.3"
    TAR_URL="https://pkgs.tailscale.com/stable/tailscale_${TS_VERSION}_arm64.tgz"
    TMP_TGZ="/tmp/tailscale_${TS_VERSION}.tgz"
    curl -fsSL "${TAR_URL}" -o "${TMP_TGZ}"
    tar -xzf "${TMP_TGZ}" -C /tmp/
    cp "/tmp/tailscale_${TS_VERSION}_arm64/tailscale" "${TS_BIN}"
    cp "/tmp/tailscale_${TS_VERSION}_arm64/tailscaled" "${TSD_BIN}"
    chmod +x "${TS_BIN}" "${TSD_BIN}"
    rm -rf "${TMP_TGZ}" "/tmp/tailscale_${TS_VERSION}_arm64"
    echo "[Tailscale] Binaries installed to ${USER_BIN}"
  fi
}

start_daemon() {
  ensure_binaries
  if pgrep -f "${TSD_BIN}" >/dev/null; then
    echo "[Tailscale] tailscaled is already running."
  else
    echo "[Tailscale] Starting tailscaled (userspace networking)..."
    nohup "${TSD_BIN}" \
      --statedir="${STATE_DIR}" \
      --socket="${SOCK_PATH}" \
      --tun=userspace-networking >> "${LOG_FILE}" 2>&1 &
    sleep 2
    echo "[Tailscale] tailscaled started."
  fi
  # If node is authenticated, ensure serve is active
  if [ -S "${SOCK_PATH}" ]; then
    if "${TS_BIN}" --socket="${SOCK_PATH}" status --json 2>/dev/null | grep -q '"BackendState":"Running"'; then
      "${TS_BIN}" --socket="${SOCK_PATH}" serve --bg --tcp=5000 5000 2>/dev/null || true
    fi
  fi
}

stop_daemon() {
  echo "[Tailscale] Stopping tailscaled..."
  pkill -f "${TSD_BIN}" || true
  sleep 1
  echo "[Tailscale] Stopped."
}

status_daemon() {
  ensure_binaries
  if [ ! -S "${SOCK_PATH}" ]; then
    echo "[Tailscale] Socket ${SOCK_PATH} not found. Daemon may be stopped."
    exit 1
  fi
  "${TS_BIN}" --socket="${SOCK_PATH}" status
}

login_daemon() {
  ensure_binaries
  start_daemon
  echo "[Tailscale] Generating login authorization link..."
  "${TS_BIN}" --socket="${SOCK_PATH}" login --qr=false --hostname=atl-attendance-pi
}

serve_port() {
  ensure_binaries
  if [ ! -S "${SOCK_PATH}" ]; then
    echo "[Tailscale] tailscaled is not running. Run: bash pi/tailscale_service.sh start"
    exit 1
  fi
  echo "[Tailscale] Exposing local port 5000 on Tailscale network (TCP forwarder)..."
  "${TS_BIN}" --socket="${SOCK_PATH}" serve --bg --tcp=5000 5000
}

ip_daemon() {
  ensure_binaries
  "${TS_BIN}" --socket="${SOCK_PATH}" ip -4 2>/dev/null || echo "Not connected"
}

case "$1" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    start_daemon
    ;;
  status)
    status_daemon
    ;;
  login)
    login_daemon
    ;;
  serve)
    serve_port
    ;;
  ip)
    ip_daemon
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|login|serve|ip}"
    exit 1
    ;;
esac
