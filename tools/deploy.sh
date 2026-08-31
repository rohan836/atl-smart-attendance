#!/bin/bash
# Deploy this repo to Pi lancer@192.168.1.8:/opt/atl-attendance
# Run from the repo root: bash tools/deploy.sh
set -e
HOST="192.168.1.8"
USER="lancer"
REMOTE="/opt/atl-attendance"
KEY="C:/Users/LaNcer/.ssh/id_ed25519"

echo "=== Deploy to $USER@$HOST:$REMOTE ==="

# Never deploy: .git, artifacts (*.db, uploads, __pycache__, venv), config.json
# Never --delete: that would wipe /opt/atl-attendance/venv and Pi-only files.
if command -v rsync >/dev/null 2>&1; then
  echo "Using rsync..."
  rsync -avz -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
    --exclude '.git' --exclude '__pycache__' --exclude '*.db' --exclude 'uploads' \
    --exclude 'venv' --exclude '.venv' --exclude 'backend/venv' \
    --exclude 'backend/config.json' --exclude '*.log' \
    ./ "$USER@$HOST:$REMOTE/"
else
  echo "Using scp (rsync not found)..."
  scp -i "$KEY" ATL-Smart-Attendance-Production.html "$USER@$HOST:$REMOTE/"
  scp -i "$KEY" -r ./backend/app.py ./backend/ui_app.js ./backend/gt511c3.py ./backend/schema.sql "$USER@$HOST:$REMOTE/backend/"
  scp -i "$KEY" -r ./assets "$USER@$HOST:$REMOTE/"
  scp -i "$KEY" ./pi/atl-attendance.service "$USER@$HOST:/tmp/"
fi

echo "=== On Pi: set perms, restart service ==="
ssh -i "$KEY" "$USER@$HOST" "sudo mkdir -p /var/lib/atl/images && sudo chown -R lancer:lancer /opt/atl-attendance /var/lib/atl && sudo cp /tmp/atl-attendance.service /etc/systemd/system/ 2>/dev/null; sudo systemctl daemon-reload; sudo systemctl restart atl-attendance.service; sleep 2; sudo systemctl status atl-attendance.service --no-pager -l | head -n 20; echo '---'; curl -s http://127.0.0.1:5000/api/health | head -c 400; echo"

echo "=== Done ==="
echo "Open: http://$HOST:5000/  (production UI: ATL-Smart-Attendance-Production.html)"
