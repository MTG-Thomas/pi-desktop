<#
.SYNOPSIS
  PiBus: drive pi --mode rpc sessions over HTTP (loopback broker).
  Single-machine appserver shim: spawn/list/turn/steer/read.
  Password lives in ~/.local/share/pi-bus/broker.json and must NEVER be
  posted to GitHub or the bus; the bus carries threadIds, not secrets.
.NOTES
  PowerShell 5.1 compatible. Loopback-only. Never point prompt/steer at a
  harness-owned LIVE thread (interactive TUI, Pi Desktop pane): mailbox/bus
  notes only for those; the broker owns only sessions it spawned.
#>

$script:PiBusRoot = Join-Path $HOME '.local/share/pi-bus'
$script:PiBusConfigPath = Join-Path $script:PiBusRoot 'broker.json'
$script:PiBusBrokerScript = Join-Path $PSScriptRoot 'broker.mjs'

function Get-PiBusConfig {
  if (-not (Test-Path -LiteralPath $script:PiBusConfigPath)) {
    throw "PiBus config missing at $($script:PiBusConfigPath). Run Start-PiBusBroker first."
  }
  return (Get-Content -LiteralPath $script:PiBusConfigPath -Raw | ConvertFrom-Json)
}

function Get-PiBusAuthHeader {
  param([Parameter(Mandatory = $true)]$Config)
  $pair = "$($Config.user):$($Config.password)"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
  return @{ Authorization = "Basic $b64" }
}

function Start-PiBusBroker {
  <#
  .SYNOPSIS Starts the loopback pi-broker; records PID + password locally.
  #>
  param([int]$Port = 4098)
  $busy = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Listen' }
  if ($busy) { throw "Port $Port already listening. Reuse it or pick another." }
  $node = (Get-Command node -ErrorAction Stop).Source
  if (-not (Test-Path -LiteralPath $script:PiBusBrokerScript)) {
    throw "broker.mjs missing at $($script:PiBusBrokerScript)."
  }
  $proc = Start-Process -FilePath $node `
    -ArgumentList "`"$($script:PiBusBrokerScript)`" --port $Port" `
    -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(20)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if (Test-Path -LiteralPath $script:PiBusConfigPath) {
      try {
        $cfg = Get-PiBusConfig
        if ($cfg.port -eq $Port) {
          $hdr = Get-PiBusAuthHeader -Config $cfg
          $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" `
            -Headers $hdr -TimeoutSec 5
          if ($h.healthy) { $healthy = $true; break }
        }
      } catch { }
    }
  }
  if (-not $healthy) { throw "Broker on :$Port did not become healthy (spawned pid $($proc.Id))." }
  Write-Output "pi-broker healthy on 127.0.0.1:$Port (pid $($proc.Id))"
}

function Get-PiBusHealth {
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  return Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/health" `
    -Headers $hdr -TimeoutSec 10
}

function New-PiBusSession {
  <#
  .SYNOPSIS Spawn a broker-owned pi --mode rpc session. -Model 'provider/model-id' sets it at spawn.
  .EXAMPLE New-PiBusSession -Title 'auth worker' -Model 'opencode-go/muse-spark-1.3-contributor'
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Model,
    [string]$Provider,
    [string]$Fork,
    [string[]]$Extensions,
    [switch]$NoSession
  )
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  $body = @{ title = $Title }
  if ($Model) { $body['model'] = $Model }
  if ($Provider) { $body['provider'] = $Provider }
  if ($Fork) { $body['fork'] = $Fork }
  if ($Extensions) { $body['extensions'] = @($Extensions) }
  if ($NoSession) { $body['noSession'] = $true }
  $json = $body | ConvertTo-Json
  return Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session" `
    -Method Post -Headers $hdr -ContentType 'application/json' -Body $json `
    -TimeoutSec 60
}

function Get-PiBusSession {
  param([string]$Id)
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  $all = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session" `
    -Headers $hdr -TimeoutSec 15
  if ($Id) {
    foreach ($s in $all) { if ($s.id -eq $Id) { return $s } }
    throw "Unknown pi-broker session $Id."
  }
  return $all
}

function Send-PiBusPrompt {
  <#
  .SYNOPSIS Blocking turn: prompt a broker-owned session, wait for agent_settled, return reply text.
  Never use on harness-owned LIVE threads.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$Text,
    [int]$TimeoutMs = 300000
  )
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  $body = @{ message = $Text; timeoutMs = $TimeoutMs } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/prompt" `
    -Method Post -Headers $hdr -ContentType 'application/json' -Body $body `
    -TimeoutSec ([Math]::Max(60, [int]($TimeoutMs / 1000) + 60))
  if (-not $r.settled) { Write-Warning "prompt timed out without agent_settled; partial text returned." }
  return $r
}

function Send-PiBusSteer {
  <#
  .SYNOPSIS Steer a streaming broker-owned session (errors if idle; use prompt/follow-up then).
  #>
  param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  $body = @{ message = $Text } | ConvertTo-Json -Depth 5
  return Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/steer" `
    -Method Post -Headers $hdr -ContentType 'application/json' -Body $body `
    -TimeoutSec 30
}

function Send-PiBusFollowUp {
  param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  $body = @{ message = $Text } | ConvertTo-Json -Depth 5
  return Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/follow_up" `
    -Method Post -Headers $hdr -ContentType 'application/json' -Body $body `
    -TimeoutSec 30
}

function Stop-PiBusRun {
  <#.SYNOPSIS Abort the active run (silent-busy recovery: abort, then redrive report-first).#>
  param([Parameter(Mandatory = $true)][string]$SessionId)
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  return Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/abort" `
    -Method Post -Headers $hdr -TimeoutSec 30
}

function Get-PiBusMessages {
  param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [int]$Limit = 5,
    [int]$MaxChars = 300
  )
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  $m = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/messages" `
    -Headers $hdr -TimeoutSec 30
  $msgs = $m.messages
  if (-not $msgs) { return $m }
  $tail = @($msgs | Select-Object -Last $Limit)
  foreach ($x in $tail) {
    $texts = @()
    foreach ($p in $x.content) {
      if ($p.type -eq 'text' -and $p.text) { $texts += $p.text }
    }
    $j = ($texts -join ' ')
    if ($j.Length -eq 0) { $j = '(non-text parts only)' }
    Write-Output "$($x.role): $($j.Substring(0, [Math]::Min($MaxChars, $j.Length)))"
  }
}

function Get-PiBusState {
  param([Parameter(Mandatory = $true)][string]$SessionId)
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  return Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/state" `
    -Headers $hdr -TimeoutSec 15
}

function Remove-PiBusSession {
  param([Parameter(Mandatory = $true)][string]$SessionId)
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  return Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId" `
    -Method Delete -Headers $hdr -TimeoutSec 15
}

function Get-PiBusDigest {
  <#.SYNOPSIS One-call watch round: broker, sessions, bus log tail. Run on wake only.#>
  param([int]$BusTail = 5)
  $cfg = Get-PiBusConfig
  $hdr = Get-PiBusAuthHeader -Config $cfg
  $base = "http://127.0.0.1:$($cfg.port)"
  try {
    $h = Invoke-RestMethod -Uri "$base/health" -Headers $hdr -TimeoutSec 10
    Write-Output ("broker: ok v" + $h.version)
  } catch { Write-Output 'broker: DOWN'; return }
  $all = Invoke-RestMethod -Uri "$base/session" -Headers $hdr -TimeoutSec 15
  foreach ($s in $all) {
    $st = 'dead'
    if ($s.alive) { $st = 'alive' }
    Write-Output ("  " + $s.id + " [" + $st + "] " + $s.title)
  }
  $busFile = Join-Path $script:PiBusRoot 'bus.jsonl'
  if (Test-Path -LiteralPath $busFile) {
    $lines = @(Get-Content -LiteralPath $busFile -Tail $BusTail)
    Write-Output ("bus tail (" + $lines.Count + "):")
    foreach ($l in $lines) {
      try {
        $e = $l | ConvertFrom-Json
        Write-Output ("  [" + $e.topic + " " + $e.threadId + "] " + $e.id)
      } catch { }
    }
  }
}
