$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$WatchdogMutexCreated = $false
$WatchdogMutex = New-Object System.Threading.Mutex($true, "Local\AsterUnifiedResearchWorkbenchWatchdog", [ref]$WatchdogMutexCreated)
if (-not $WatchdogMutexCreated) { exit 0 }
$RuntimeDir = Join-Path $ProjectRoot "data\runtime"
$LogDir = Join-Path $ProjectRoot "data\logs"
$NodePath = Join-Path $env:ProgramFiles "nodejs\node.exe"
# Scheduled tasks can outlive a user-environment change. Refresh the read-only
# visitor context explicitly without ever writing its value to a log or file.
$WanzhuAuthorization = [Environment]::GetEnvironmentVariable("WANZHU_AUTHORIZATION", "User")
if ($WanzhuAuthorization) { $env:WANZHU_AUTHORIZATION = $WanzhuAuthorization }
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node.js runtime not found: $NodePath" }
Get-ChildItem -LiteralPath $LogDir -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item -Force

function Write-WatchdogLog([string]$Message) {
  $line = "{0} {1}" -f (Get-Date).ToString("o"), $Message
  Add-Content -LiteralPath (Join-Path $LogDir ("watchdog-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))) -Value $line -Encoding utf8
}

function Test-Port([int]$Port) {
  try {
    # Listener existence is an operating-system fact and must not depend on
    # whether a CPU-heavy provider job accepts a new socket within 700ms.
    # Response liveness is checked separately by the HTTP health probes.
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1)
  } catch { return $false }
}

function Test-EngineHealth {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:8035/health" -TimeoutSec 5
    return $health.ok -eq $true -and $health.database -eq "online"
  } catch { return $false }
}

function Test-WebHealth {
  try {
    $page = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3100/" -TimeoutSec 5
    if ($page.StatusCode -ne 200 -or $page.Headers["Content-Type"] -notmatch "text/html") { return $false }
    $stylesheet = [regex]::Match($page.Content, 'href="([^"]+\.css(?:\?[^"]*)?)"')
    if (-not $stylesheet.Success) { return $false }
    $stylesheetUri = [Uri]::new([Uri]"http://127.0.0.1:3100/", $stylesheet.Groups[1].Value).AbsoluteUri
    $css = Invoke-WebRequest -UseBasicParsing -Uri $stylesheetUri -TimeoutSec 5
    if ($css.StatusCode -ne 200 -or $css.Headers["Content-Type"] -notmatch "text/css" -or $css.RawContentLength -le 1024) { return $false }
    # A production rebuild changes hashed client filenames.  The long-running
    # SSR worker can still emit its cached old HTML while those old chunks have
    # already disappeared, leaving a page that looks normal but cannot hydrate
    # or react to clicks.  Treat every missing JS entry chunk as unhealthy so
    # the watchdog restarts the web worker and reloads the current manifest.
    $scripts = [regex]::Matches($page.Content, '<script[^>]+src="([^"]+\.js(?:\?[^\"]*)?)"')
    if ($scripts.Count -eq 0) { return $false }
    foreach ($script in $scripts) {
      $scriptUri = [Uri]::new([Uri]"http://127.0.0.1:3100/", $script.Groups[1].Value).AbsoluteUri
      $javascript = Invoke-WebRequest -UseBasicParsing -Uri $scriptUri -TimeoutSec 5
      if ($javascript.StatusCode -ne 200 -or $javascript.Headers["Content-Type"] -notmatch "(?:javascript|ecmascript)" -or $javascript.RawContentLength -le 128) { return $false }
    }
    return $true
  } catch { return $false }
}

function Stop-ManagedProcess([string]$Name) {
  $statePath = Join-Path $RuntimeDir "$Name.json"
  if (-not (Test-Path -LiteralPath $statePath)) { return }
  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.projectRoot -ne $ProjectRoot) { return }
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if (-not $process) { return }
    $recorded = [datetime]::Parse($state.startedAt)
    if ([math]::Abs(($process.StartTime - $recorded).TotalSeconds) -lt 3) {
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit(3000)
    }
  } catch {}
}

function Save-Process([string]$Name, $Process, [string]$Command) {
  [ordered]@{
    pid = $Process.Id
    startedAt = $Process.StartTime.ToString("o")
    command = $Command
    projectRoot = $ProjectRoot
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeDir "$Name.json") -Encoding utf8
}

function Sync-ListenerProcess([string]$Name, [int]$Port, [string]$Command) {
  try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    $process = Get-Process -Id ([int]$listener.OwningProcess) -ErrorAction Stop
    Save-Process $Name $process $Command
  } catch {}
}

function Start-Engine {
  $date = Get-Date -Format "yyyy-MM-dd"
  $stamp = Get-Date -Format "HHmmssfff"
  $process = Start-Process -FilePath $NodePath -ArgumentList @("engine/server.mjs") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogDir "engine-$date-$stamp.out.log") -RedirectStandardError (Join-Path $LogDir "engine-$date-$stamp.err.log")
  Save-Process "engine" $process "node engine/server.mjs"
  Write-WatchdogLog "engine restart pid=$($process.Id)"
}

function Start-Web {
  $webServer = Join-Path $ProjectRoot "engine\web_server.mjs"
  $date = Get-Date -Format "yyyy-MM-dd"
  $stamp = Get-Date -Format "HHmmssfff"
  $process = Start-Process -FilePath $NodePath -ArgumentList @($webServer) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogDir "web-$date-$stamp.out.log") -RedirectStandardError (Join-Path $LogDir "web-$date-$stamp.err.log")
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $listener = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      $actual = Get-Process -Id ([int]$listener.OwningProcess) -ErrorAction SilentlyContinue
      if ($actual) { Save-Process "web" $actual "Aster fast web listener on port 3100"; Write-WatchdogLog "web restart pid=$($actual.Id)"; return }
    }
  }
  Save-Process "web" $process "node engine/web_server.mjs"
  Write-WatchdogLog "web restart pid=$($process.Id)"
}

[ordered]@{ pid = $PID; startedAt = (Get-Process -Id $PID).StartTime.ToString("o"); projectRoot = $ProjectRoot } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeDir "watchdog.json") -Encoding utf8

$previousHealth = $null
try { $previousHealth = Get-Content -LiteralPath (Join-Path $RuntimeDir "system-health.json") -Raw | ConvertFrom-Json } catch {}
$restartCount = @{
  engine = if ($previousHealth) { [int]$previousHealth.engineRestarts } else { 0 }
  web = if ($previousHealth) { [int]$previousHealth.webRestarts } else { 0 }
}
$engineFailureStreak = 0
$webFailureStreak = 0
$EngineResponsiveFailureLimit = 12
$WebResponsiveFailureLimit = 12
Write-WatchdogLog "watchdog started pid=$PID root=$ProjectRoot"
while ($true) {
  try {
    $engineListening = Test-Port 8035
    $engineHealthy = $engineListening -and (Test-EngineHealth)
    if (-not $engineHealthy) {
      $engineFailureStreak += 1
      # A full-market AKShare request may temporarily make a data-heavy endpoint
      # slow while the lightweight /health endpoint and listener remain alive.
      # Restart immediately only when the listener has disappeared; otherwise
      # The provider and M30 jobs can legitimately keep a worker busy for more
      # than two minutes.  When the listener and managed process still exist,
      # allow a six-minute observation window before treating it as a deadlock.
      # A vanished listener is still recovered immediately.
      if ($engineFailureStreak -eq 1) { Write-WatchdogLog "engine health probe delayed; listener=$engineListening" }
      if (-not $engineListening -or $engineFailureStreak -ge $EngineResponsiveFailureLimit) {
        Write-WatchdogLog "engine recovery triggered; listener=$engineListening streak=$engineFailureStreak"
        Stop-ManagedProcess "engine"
        Start-Engine
        $restartCount.engine += 1
        $engineFailureStreak = 0
        for ($attempt = 0; $attempt -lt 20 -and -not ($engineHealthy = Test-EngineHealth); $attempt += 1) {
          Start-Sleep -Milliseconds 250
        }
      }
    } else {
      $engineFailureStreak = 0
    }
    if ($engineHealthy) { Sync-ListenerProcess "engine" 8035 "node engine/server.mjs" }
    $webHealthy = Test-WebHealth
    if (-not $webHealthy) {
      $webFailureStreak += 1
      $webListening = Test-Port 3100
      if ($webFailureStreak -eq 1) { Write-WatchdogLog "web health probe delayed; listener=$webListening" }
      if (-not $webListening -or $webFailureStreak -ge $WebResponsiveFailureLimit) {
        Write-WatchdogLog "web recovery triggered; listener=$webListening streak=$webFailureStreak"
        Stop-ManagedProcess "web"
        Start-Web
        $restartCount.web += 1
        $webFailureStreak = 0
        for ($attempt = 0; $attempt -lt 20 -and -not ($webHealthy = Test-WebHealth); $attempt += 1) {
          Start-Sleep -Milliseconds 250
        }
      }
    } else {
      $webFailureStreak = 0
    }
    if ($webHealthy) { Sync-ListenerProcess "web" 3100 "Aster fast web listener on port 3100" }
    [ordered]@{
      checkedAt = (Get-Date).ToString("o")
      engine = if ($engineHealthy) { "healthy" } else { "starting" }
      web = if ($webHealthy) { "healthy" } else { "starting" }
      engineRestarts = $restartCount.engine
      webRestarts = $restartCount.web
      engineFailureStreak = $engineFailureStreak
      webFailureStreak = $webFailureStreak
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeDir "system-health.json") -Encoding utf8
  } catch {
    Write-WatchdogLog ("watchdog cycle error: {0}" -f $_.Exception.Message)
    try {
      [ordered]@{
        checkedAt = (Get-Date).ToString("o")
        engine = "degraded"
        web = "degraded"
        engineRestarts = $restartCount.engine
        webRestarts = $restartCount.web
        engineFailureStreak = $engineFailureStreak
        webFailureStreak = $webFailureStreak
        error = $_.Exception.Message
      } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeDir "system-health.json") -Encoding utf8
    } catch {}
  }
  Start-Sleep -Seconds 30
}
