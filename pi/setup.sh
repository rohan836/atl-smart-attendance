#!/bin/bash
# ATL Smart Attendance — Pi Setup for raspberrypi123 (Debian 13 trixie)
# Run on Pi: sudo bash /media/*/pi/setup.sh  or  sudo bash ./pi/setup.sh
# Target: lancer@192.168.1.8, user lancer (uid 1001), not pi
set -e
set -x

USER="lancer"
APP_DIR="/opt/atl-attendance"
DATA_DIR="/var/lib/atl"
IMAGES_DIR="/var/lib/atl/images"
CONFIG_SRC="./backend/config.json"

echo "=== 1. System update ==="
sudo apt update && sudo apt upgrade -y

echo "=== 2. Install deps ==="
sudo apt install -y python3 python3-pip python3-venv sqlite3 git nginx

echo "=== 3. Enable UART for GT-511C3 ==="
# GT-511C3 on /dev/serial0 (GPIO14/15), 9600 baud, disable console
if ! grep -q "^enable_uart=1" /boot/firmware/config.txt 2>/dev/null && ! grep -q "^enable_uart=1" /boot/config.txt 2>/dev/null; then
  echo "enable_uart=1" | sudo tee -a /boot/firmware/config.txt >/dev/null 2>&1 || echo "enable_uart=1" | sudo tee -a /boot/config.txt >/dev/null
fi
sudo raspi-config nonint do_serial 1  # 1 = serial console disabled, HW enabled (use with caution)
sudo systemctl disable serial-getty@serial0.service || true

echo "=== 4. User groups for serial ==="
sudo usermod -aG dialout,gpio $USER || true
id $USER

echo "=== 5. App dirs ==="
sudo mkdir -p $APP_DIR $DATA_DIR $IMAGES_DIR
sudo chown -R $USER:$USER $APP_DIR $DATA_DIR
sudo chmod 755 $DATA_DIR $IMAGES_DIR

echo "=== 6. Python venv ==="
python3 -m venv $APP_DIR/venv
$APP_DIR/venv/bin/pip install --upgrade pip
$APP_DIR/venv/bin/pip install Flask Flask-Cors pyserial

echo "=== 7. Copy project (if running from D:\\ssh copy) ==="
# If this script is run from the copied project dir, copy backend/assets
if [ -d "./backend" ]; then
  sudo cp -r ./backend $APP_DIR/
  sudo cp -r ./assets $APP_DIR/ 2>/dev/null || sudo mkdir -p $APP_DIR/assets/images
  sudo cp ./ATL-Smart-Attendance-Production.html $APP_DIR/ 2>/dev/null || true
  sudo chown -R $USER:$USER $APP_DIR
fi

# Ensure DB path from config exists
DB_PATH=$(python3 -c "import json;print(json.load(open('$APP_DIR/backend/config.json'))['db'])" 2>/dev/null || echo "$DATA_DIR/attendance.db")
sudo mkdir -p $(dirname $DB_PATH)
sudo chown $USER:$USER $(dirname $DB_PATH)

echo "=== 8. Systemd service ==="
sudo cp ./pi/atl-attendance.service /etc/systemd/system/atl-attendance.service 2>/dev/null || cat <<'SERVICE' | sudo tee /etc/systemd/system/atl-attendance.service >/dev/null
[Unit]
Description=ATL Smart Attendance Backend
After=network.target

[Service]
User=lancer
WorkingDirectory=/opt/atl-attendance
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/atl-attendance/venv/bin/python /opt/atl-attendance/backend/app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable atl-attendance.service
sudo systemctl restart atl-attendance.service
sudo systemctl status atl-attendance.service --no-pager -l | head -n 30

echo "=== 9. Nginx (optional, serve HTML on :80) ==="
# Simple static serving — app itself also serves HTML on :5000. Nginx optional.
# sudo cp ./pi/nginx.conf /etc/nginx/sites-available/atl && sudo ln -sf ../sites-available/atl /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx || true

echo "=== 10. Verify ==="
sleep 3
curl -s http://127.0.0.1:5000/api/health | head -c 500; echo
ls -l $DATA_DIR $IMAGES_DIR
id $USER; groups $USER
echo "DONE. Reboot recommended for UART: sudo reboot"
echo "Test: curl http://192.168.1.8:5000/api/health  and  http://192.168.1.8:5000/"
