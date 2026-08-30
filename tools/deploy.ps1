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

# Copy code only — NEVER overwrite Pi SQLite DB (attendance.db) or config.json
& scp -i $Key "$src\ATL-Smart-Attendance-Production.html" "${User}@${HostAddr}:${Remote}/" 2>&1 | Write-Host
& scp -i $Key "$src\backend\app.py" "${User}@${HostAddr}:${Remote}/backend/app.py" 2>&1 | Write-Host
& scp -i $Key "$src\backend\ui_app.js" "${User}@${HostAddr}:${Remote}/backend/ui_app.js" 2>&1 | Write-Host
& scp -i $Key "$src\backend\gt511c3.py" "${User}@${HostAddr}:${Remote}/backend/gt511c3.py" 2>&1 | Write-Host
& scp -i $Key "$src\backend\schema.sql" "${User}@${HostAddr}:${Remote}/backend/schema.sql" 2>&1 | Write-Host
& scp -i $Key -r "$src\assets" "${User}@${HostAddr}:${Remote}/" 2>&1 | Write-Host
& scp -i $Key "$src\pi\atl-attendance.service" "${User}@${HostAddr}:/tmp/" 2>&1 | Write-Host

Write-Host "Restarting service (OpenSSH)..."
# Backend needs restart — try systemctl, else pkill (lancer may not be in sudoers)
$sshCmd = 'sudo mkdir -p /var/lib/atl/images 2>/dev/null; sudo chown -R lancer:lancer /opt/atl-attendance /var/lib/atl 2>/dev/null; sudo cp /tmp/atl-attendance.service /etc/systemd/system/ 2>/dev/null; sudo systemctl daemon-reload 2>/dev/null; sudo systemctl restart atl-attendance.service 2>/dev/null; pkill -f "python.*app.py" 2>/dev/null || true; sleep 3; curl -s http://127.0.0.1:5000/api/health; echo ""; echo "---HTML check---"; curl -s http://127.0.0.1:5000/ | grep -o "ATL Smart Attendance Terminal" | head -n 1; echo ""; curl -s -I http://127.0.0.1:5000/ | grep -i Cache-Control | head -n 1; exit 0'
& ssh -i $Key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "${User}@${HostAddr}" $sshCmd 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "ssh returned $LASTEXITCODE (may be ok), checking output above..."
}

Write-Host "Done. Open http://$HostAddr`:5000/"
