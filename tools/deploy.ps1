# PowerShell deploy to Pi — single-file UI ATL-Smart-Attendance-Production.html + backend/assets/service
param(
  [string]$HostAddr = "192.168.1.8",
  [string]$User = "lancer",
  [string]$Key = "C:\Users\LaNcer\.ssh\id_ed25519",
  [string]$Remote = "/opt/atl-attendance"
)
$ErrorActionPreference = "Stop"
Write-Host "=== Deploy to $User@$HostAddr ==="

# Repo root = parent of tools/ — works from any drive/location
$src = Split-Path -Parent $PSScriptRoot
Write-Host "Source: $src"

function Exec-Checked {
  param([scriptblock]$Cmd, [string]$StepName)
  & $Cmd
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Deployment failed at step: $StepName (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
  }
}

# Copy code only — NEVER overwrite Pi SQLite DB (attendance.db) or config.json
Exec-Checked { & scp -i $Key -o StrictHostKeyChecking=accept-new "$src\ATL-Smart-Attendance-Production.html" "${User}@${HostAddr}:${Remote}/" } "Copy HTML shell"
Exec-Checked { & scp -i $Key -o StrictHostKeyChecking=accept-new "$src\backend\app.py" "${User}@${HostAddr}:${Remote}/backend/app.py" } "Copy app.py"
Exec-Checked { & scp -i $Key -o StrictHostKeyChecking=accept-new "$src\backend\gdrive_backup.py" "${User}@${HostAddr}:${Remote}/backend/gdrive_backup.py" } "Copy gdrive_backup.py"
Exec-Checked { & scp -i $Key -o StrictHostKeyChecking=accept-new "$src\backend\ui_app.js" "${User}@${HostAddr}:${Remote}/backend/ui_app.js" } "Copy ui_app.js"
Exec-Checked { & scp -i $Key -o StrictHostKeyChecking=accept-new "$src\backend\gt511c3.py" "${User}@${HostAddr}:${Remote}/backend/gt511c3.py" } "Copy gt511c3.py"
Exec-Checked { & scp -i $Key -o StrictHostKeyChecking=accept-new "$src\backend\schema.sql" "${User}@${HostAddr}:${Remote}/backend/schema.sql" } "Copy schema.sql"
Exec-Checked { & scp -i $Key -o StrictHostKeyChecking=accept-new -r "$src\assets" "${User}@${HostAddr}:${Remote}/" } "Copy assets directory"
Exec-Checked { & scp -i $Key -o StrictHostKeyChecking=accept-new "$src\pi\atl-attendance.service" "${User}@${HostAddr}:/tmp/" } "Copy systemd service definition"

Write-Host "Restarting service and verifying health (OpenSSH)..."
$sshCmd = @'
sudo mkdir -p /opt/atl-attendance/backend /var/lib/atl/images 2>/dev/null || true
sudo chown -R lancer:lancer /opt/atl-attendance /var/lib/atl 2>/dev/null || true
if [ -f /tmp/atl-attendance.service ]; then
  sudo cp /tmp/atl-attendance.service /etc/systemd/system/atl-attendance.service 2>/dev/null || true
  sudo systemctl daemon-reload 2>/dev/null || true
  rm -f /tmp/atl-attendance.service 2>/dev/null || true
fi
sudo systemctl restart atl-attendance.service 2>/dev/null || pkill -TERM -f '/opt/atl-attendance/backend/app.py' || true

HEALTH=""
for i in $(seq 1 6); do
  sleep 3
  HEALTH=$(curl -s -f http://127.0.0.1:5000/api/health || true)
  if echo "$HEALTH" | grep -q '"ok": *true'; then
    break
  fi
done

echo "Health: $HEALTH"
if ! echo "$HEALTH" | grep -q '"ok": *true'; then
  echo "ERROR: Health check failed on remote service" >&2
  exit 1
fi

HTML_TITLE=$(curl -s -f http://127.0.0.1:5000/ | grep -o "ATL Smart Attendance Terminal" | head -n 1 || true)
if [ -z "$HTML_TITLE" ]; then
  echo "ERROR: HTML UI check failed" >&2
  exit 1
fi
echo "HTML Title: $HTML_TITLE"
'@

$b64Cmd = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($sshCmd))
Exec-Checked { & ssh -i $Key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "${User}@${HostAddr}" "echo $b64Cmd | base64 -d | bash" } "Remote restart and health check"

Write-Host "Done. Open http://$HostAddr`:5000/"
