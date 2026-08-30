# Dev watcher - E:\sss -> Pi auto-deploy (dev-only)
param(
  [string]$HostAddr = "192.168.1.8",
  [int]$DebounceMs = 700,
  [int]$ReloadPort = 35729
)
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot
if (-not $src -or $src -eq "") { $src = "E:\sss" }
Write-Host "=== ATL Dev Watch ===" -ForegroundColor Cyan
Write-Host "Source: $src"
Write-Host "Watch: ATL-Smart-Attendance-Production.html, backend/*.js|*.py|*.sql, assets/*, pi/*"
Write-Host "Exclude: .git, __pycache__, *.db, uploads, venv, logs, config.json"
Write-Host "Deploy: tools/deploy.ps1  Debounce: ${DebounceMs}ms  Reload: http://127.0.0.1:${ReloadPort}/__dev_reload (?dev=1)"
Write-Host "Open dev URL: http://192.168.1.8:5000/?dev=1  (production http://192.168.1.8:5000/ unchanged)"
Write-Host "Press Ctrl+C to stop"
Write-Host ""

$clients = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
$listener = $null
$reloadServerRunning = $false

try {
  $script:listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse("127.0.0.1"), $ReloadPort)
  $listener.Start()
  $script:reloadServerRunning = $true
  Write-Host ("[{0}] reload SSE http://127.0.0.1:{1}/__dev_reload" -f (Get-Date -Format "HH:mm:ss"), $ReloadPort) -ForegroundColor DarkGray
} catch {
  Write-Host ("[{0}] reload server failed: {1}" -f (Get-Date -Format "HH:mm:ss"), $_.Exception.Message) -ForegroundColor Yellow
  $script:reloadServerRunning = $false
}

$acceptRunspace = $null
if ($reloadServerRunning) {
  $acceptRunspace = [powershell]::Create()
  [void]$acceptRunspace.AddScript({
    param($listener, $clients)
    while ($true) {
      try {
        if (-not $listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $requestLine = $reader.ReadLine()
        while ($true) {
          $line = $reader.ReadLine()
          if ([string]::IsNullOrWhiteSpace($line)) { break }
        }
        if ($requestLine -match "GET /__dev_reload") {
          $writer = New-Object System.IO.StreamWriter($stream)
          $writer.NewLine = "`r`n"
          $writer.WriteLine("HTTP/1.1 200 OK")
          $writer.WriteLine("Content-Type: text/event-stream")
          $writer.WriteLine("Cache-Control: no-cache")
          $writer.WriteLine("Connection: keep-alive")
          $writer.WriteLine("Access-Control-Allow-Origin: *")
          $writer.WriteLine("")
          $writer.Flush()
          try { $writer.WriteLine("data: connected"); $writer.WriteLine(""); $writer.Flush() } catch {}
          $entry = @{ Client=$client; Stream=$stream; Writer=$writer }
          [void]$clients.Add($entry)
        } else {
          $writer = New-Object System.IO.StreamWriter($stream)
          $writer.WriteLine("HTTP/1.1 404 Not Found")
          $writer.WriteLine("Content-Length: 0")
          $writer.WriteLine("")
          $writer.Flush()
          $client.Close()
        }
      } catch {
        Start-Sleep -Milliseconds 200
      }
    }
  }).AddArgument($listener).AddArgument($clients)
  $handle = $acceptRunspace.BeginInvoke()
}

function Send-Reload {
  if (-not $reloadServerRunning) {
    try {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      $wshell = New-Object -ComObject WScript.Shell -ErrorAction SilentlyContinue
      if ($wshell) {
        $wshell.AppActivate("ATL Smart Attendance Terminal") | Out-Null
        Start-Sleep -Milliseconds 200
        $wshell.SendKeys("^r")
        Write-Host ("[{0}] reload fallback SendKeys" -f (Get-Date -Format "HH:mm:ss")) -ForegroundColor DarkGray
      }
    } catch {}
    return
  }
  $toRemove = @()
  foreach ($entry in $clients.ToArray()) {
    try {
      $w = $entry.Writer
      $w.WriteLine("data: reload")
      $w.WriteLine("")
      $w.Flush()
    } catch {
      $toRemove += $entry
    }
  }
  foreach ($r in $toRemove) { [void]$clients.Remove($r); try { $r.Client.Close() } catch {} }
  if ($clients.Count -gt 0) {
    Write-Host ("[{0}] browser reload sent to {1} client(s)" -f (Get-Date -Format "HH:mm:ss"), $clients.Count) -ForegroundColor Green
  } else {
    Write-Host ("[{0}] reload sent (no SSE clients - open http://192.168.1.8:5000/?dev=1)" -f (Get-Date -Format "HH:mm:ss")) -ForegroundColor Yellow
  }
}

# Polling watcher (reliable, no Register-ObjectEvent runspace issues)
$pendingChanges = New-Object System.Collections.ArrayList
$deploying = $false
$lastStates = @{}

function Get-RelevantFiles {
  $files = @()
  $files += Get-ChildItem -Path $src -Filter "ATL-Smart-Attendance-Production.html" -File -ErrorAction SilentlyContinue
  $files += Get-ChildItem -Path (Join-Path $src "backend") -Include "app.py","ui_app.js","gt511c3.py","schema.sql" -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "__pycache__" -and $_.FullName -notmatch "venv" }
  $files += Get-ChildItem -Path (Join-Path $src "assets") -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match "\.(svg|png|jpg|jpeg|css|js)$" }
  $files += Get-ChildItem -Path (Join-Path $src "pi") -Filter "atl-attendance.service" -File -ErrorAction SilentlyContinue
  $files += Get-ChildItem -Path $src -Filter "requirements.txt" -File -ErrorAction SilentlyContinue
  return $files
}

function Should-Ignore($path) {
  if (-not $path) { return $true }
  $p = $path -replace "\\", "/"
  if ($p -match "(^|/)\.git(/|$)") { return $true }
  if ($p -match "__pycache__") { return $true }
  if ($p -match "\.pyc$") { return $true }
  if ($p -match "\.log$") { return $true }
  if ($p -match "\.db$") { return $true }
  if ($p -match "/uploads(/|$)") { return $true }
  if ($p -match "/venv(/|$)") { return $true }
  if ($p -match "backend/config\.json$") { return $true }
  if ($p -match "backend/attendance\.db") { return $true }
  if ($p -match "/\.vscode(/|$)") { return $true }
  if ($p -match "~$") { return $true }
  if ($p -match "\.tmp$") { return $true }
  $isRelevant = $false
  if ($p -match "ATL-Smart-Attendance-Production\.html$") { $isRelevant = $true }
  elseif ($p -match "backend/(app\.py|ui_app\.js|gt511c3\.py|schema\.sql)$") { $isRelevant = $true }
  elseif ($p -match "assets/.*\.(svg|png|jpg|jpeg|css|js)$") { $isRelevant = $true }
  elseif ($p -match "pi/atl-attendance\.service$") { $isRelevant = $true }
  elseif ($p -match "requirements\.txt$") { $isRelevant = $true }
  if (-not $isRelevant) { return $true }
  return $false
}

# Initialize last states
foreach ($f in Get-RelevantFiles) {
  if (Should-Ignore $f.FullName) { continue }
  $lastStates[$f.FullName] = $f.LastWriteTimeUtc.Ticks
}

$debounceTimer = $null
$debounceDeadline = [DateTime]::MinValue

Write-Host ("[{0}] watching..." -f (Get-Date -Format "HH:mm:ss")) -ForegroundColor DarkGray

try {
  while ($true) {
    Start-Sleep -Milliseconds 300
    $changed = @()
    foreach ($f in Get-RelevantFiles) {
      if (Should-Ignore $f.FullName) { continue }
      $ticks = $f.LastWriteTimeUtc.Ticks
      $prev = $lastStates[$f.FullName]
      if ($null -eq $prev) {
        $lastStates[$f.FullName] = $ticks
        $changed += $f.FullName
      } elseif ($ticks -ne $prev) {
        $lastStates[$f.FullName] = $ticks
        $changed += $f.FullName
      }
    }
    # Also check for deleted files
    $toRemove = @()
    foreach ($key in $lastStates.Keys) {
      if (-not (Test-Path $key)) { $toRemove += $key }
    }
    foreach ($k in $toRemove) { $lastStates.Remove($k); $changed += $k }

    if ($changed.Count -gt 0) {
      foreach ($c in $changed) {
        $rel = $c.Replace($src, "").TrimStart("\","/")
        if (-not $pendingChanges.Contains($rel)) { [void]$pendingChanges.Add($rel) }
        Write-Host ("[{0}] change {1} debouncing..." -f (Get-Date -Format "HH:mm:ss"), $rel) -ForegroundColor DarkGray
      }
      $debounceDeadline = (Get-Date).AddMilliseconds($DebounceMs)
    }

    if ($pendingChanges.Count -gt 0 -and (Get-Date) -ge $debounceDeadline) {
      if ($deploying) {
        Write-Host ("[{0}] deploy queued {1} change(s)" -f (Get-Date -Format "HH:mm:ss"), $pendingChanges.Count) -ForegroundColor Yellow
        $debounceDeadline = (Get-Date).AddMilliseconds($DebounceMs)
        continue
      }
      $changes = $pendingChanges.ToArray()
      $pendingChanges.Clear()
      $unique = $changes | Sort-Object -Unique
      $list = ($unique -join ", ")
      if ($list.Length -gt 120) { $list = $list.Substring(0,120) + "..." }
      Write-Host ("`n[{0}] deploying ({1})..." -f (Get-Date -Format "HH:mm:ss"), $list) -ForegroundColor Yellow
      $deploying = $true
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      try {
        $deployScript = Join-Path $src "tools\deploy.ps1"
        $out = & powershell -ExecutionPolicy Bypass -File $deployScript 2>&1 | Out-String
        $exit = $LASTEXITCODE
        $sw.Stop()
        if ($exit -eq 0 -or $out -match "Done\. Open") {
          Write-Host ("[{0}] deployed in {1:N1}s" -f (Get-Date -Format "HH:mm:ss"), $sw.Elapsed.TotalSeconds) -ForegroundColor Green
          Send-Reload
        } else {
          Write-Host ("[{0}] failed (exit {1}) in {2:N1}s" -f (Get-Date -Format "HH:mm:ss"), $exit, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
          Write-Host $out -ForegroundColor Red
        }
      } catch {
        $sw.Stop()
        Write-Host ("[{0}] failed: {1}" -f (Get-Date -Format "HH:mm:ss"), $_.Exception.Message) -ForegroundColor Red
      } finally {
        $deploying = $false
        Write-Host ("[{0}] watching..." -f (Get-Date -Format "HH:mm:ss")) -ForegroundColor DarkGray
      }
    }
  }
} finally {
  Write-Host "Stopping watcher..."
  try { $listener.Stop() } catch {}
  try { $acceptRunspace.Stop() } catch {}
}
