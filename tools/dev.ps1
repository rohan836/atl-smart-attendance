# tools/dev.ps1 - Start safe local development server on Windows PC
[CmdletBinding()]
param(
    [int]$Port = 5000,
    [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " ATL Smart Attendance - Local UI Development Server" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Detect Python
$PythonExe = ""
$Candidates = @(
    "python",
    "python3",
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
)
foreach ($c in $Candidates) {
    if (Get-Command $c -ErrorAction SilentlyContinue) {
        $PythonExe = $c
        break
    } elseif (Test-Path $c) {
        $PythonExe = $c
        break
    }
}
if (-not $PythonExe) {
    Write-Error "Python executable not found. Please ensure Python 3 is installed."
    exit 1
}

# 2. Ensure isolated development config exists
$ConfigPath = Join-Path $ProjectRoot "backend\config.json"
$ExampleConfigPath = Join-Path $ProjectRoot "backend\config.example.json"

if (-not (Test-Path $ConfigPath)) {
    Write-Host "[DEV] Initializing backend\config.json from template..." -ForegroundColor Yellow
    if (Test-Path $ExampleConfigPath) {
        Copy-Item -Path $ExampleConfigPath -Destination $ConfigPath
    } else {
        $defaultCfg = @{ sensor = "sim"; db = "backend/attendance.db"; imagesDir = "backend/uploads"; host = $HostAddress; port = $Port } | ConvertTo-Json
        Set-Content -Path $ConfigPath -Value $defaultCfg
    }
}

# Ensure isolated local directories exist
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "backend\uploads") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "assets\images\students") | Out-Null

$AppScript = Join-Path $ProjectRoot "backend\app.py"

Write-Host ""
Write-Host " [URL] Local Server:     http://${HostAddress}:${Port}/" -ForegroundColor Green
Write-Host " [DEV] Preview UI:       Edit ATL-Smart-Attendance-Production.html or backend/ui_app.js" -ForegroundColor White
Write-Host " [DEV] Update Mode:      Changes appear immediately on browser refresh (F5 / Ctrl+R)" -ForegroundColor White
Write-Host " [DEV] Isolation:        Local SQLite (backend\attendance.db), simulated sensor" -ForegroundColor White
Write-Host " [DEV] Raspberry Pi:     Zero connection / Zero deployment" -ForegroundColor White
Write-Host ""
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Gray
Write-Host ""

# 3. Start local development server
& $PythonExe $AppScript
