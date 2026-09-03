#!/usr/bin/env bash
# tools/dev.sh — Start safe local development server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo "============================================================"
echo " ATL Smart Attendance — Local UI Development Server"
echo "============================================================"

PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  PYTHON="python"
fi

CONFIG_FILE="$PROJECT_ROOT/backend/config.json"
EXAMPLE_CONFIG="$PROJECT_ROOT/backend/config.example.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[DEV] Initializing backend/config.json from template..."
  if [ -f "$EXAMPLE_CONFIG" ]; then
    cp "$EXAMPLE_CONFIG" "$CONFIG_FILE"
  fi
fi

mkdir -p "$PROJECT_ROOT/backend/uploads"
mkdir -p "$PROJECT_ROOT/assets/images/students"

echo ""
echo " [URL] Local Server:     http://127.0.0.1:5000/"
echo " [DEV] Preview UI:       Edit ATL-Smart-Attendance-Production.html or backend/ui_app.js"
echo " [DEV] Update Mode:      Changes appear immediately on browser refresh (F5 / Ctrl+R)"
echo " [DEV] Isolation:        Local SQLite, simulated sensor"
echo " [DEV] Raspberry Pi:     Zero connection / Zero deployment"
echo ""
echo "Press Ctrl+C to stop the server."
echo ""

exec "$PYTHON" "$PROJECT_ROOT/backend/app.py"
