[CmdletBinding()]
param(
    [string]$ConsoleUrl,
    [string]$DataRoot = $(if ($env:CONDUCTOR_DATA_DIR) { $env:CONDUCTOR_DATA_DIR } else { Join-Path $HOME ".conductor" }),
    [switch]$StateMap,
    [string]$SnapshotJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-StateMap {
    param([AllowNull()]$Snapshot)
    if ($null -eq $Snapshot) {
        return [pscustomobject]@{
            ToolTip = "Conductor console unavailable"
            Status = "Unavailable"
            CanLoad = $false
            CanUnload = $false
        }
    }
    $model = $Snapshot.model
    $active = @($Snapshot.queue.items | Where-Object { $_.status -in @("dispatching", "running", "cancelling") }).Count
    $modelState = if ($null -eq $model) { "unconfigured" } else { [string]$model.state }
    return [pscustomobject]@{
        ToolTip = "Conductor: $active active, model $modelState"
        Status = "$active active job(s) | model: $modelState"
        CanLoad = $null -ne $model -and $model.state -in @("offline", "error", "wrong-model")
        CanUnload = $null -ne $model -and [bool]$model.canUnload -and $model.state -in @("ready", "error")
    }
}

if ($StateMap) {
    $snapshot = if ([string]::IsNullOrWhiteSpace($SnapshotJson)) { $null } else { $SnapshotJson | ConvertFrom-Json -Depth 40 }
    Get-StateMap $snapshot | ConvertTo-Json -Compress
    exit 0
}

if ([string]::IsNullOrWhiteSpace($ConsoleUrl)) {
    $hostName = if ($env:CONDUCTOR_CONSOLE_HOST) { $env:CONDUCTOR_CONSOLE_HOST } else { "127.0.0.1" }
    $portNumber = if ($env:CONDUCTOR_CONSOLE_PORT) { [int]$env:CONDUCTOR_CONSOLE_PORT } else { 8787 }
    $settingsPath = Join-Path $DataRoot "control-console\console-settings.json"
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $settingsDocument = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -Depth 20
        if (-not $env:CONDUCTOR_CONSOLE_HOST) { $hostName = [string]$settingsDocument.settings.console.host }
        if (-not $env:CONDUCTOR_CONSOLE_PORT) { $portNumber = [int]$settingsDocument.settings.console.port }
    }
    $urlHost = if ($hostName -eq "::1") { "[::1]" } else { $hostName }
    $ConsoleUrl = "http://${urlHost}:$portNumber"
}

if (-not $IsWindows) { throw "The Conductor notification-area host requires Windows." }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$identityBytes = [Text.Encoding]::UTF8.GetBytes(([IO.Path]::GetFullPath($DataRoot)).ToLowerInvariant())
$identity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($identityBytes)).Substring(0, 16)
$mutexName = "Local\ConductorTray-$identity"
$eventName = "Local\ConductorTrayActivate-$identity"
$createdMutex = $false
$mutex = [Threading.Mutex]::new($true, $mutexName, [ref]$createdMutex)
if (-not $createdMutex) {
    try {
        $existingEvent = [Threading.EventWaitHandle]::OpenExisting($eventName)
        [void]$existingEvent.Set()
        $existingEvent.Dispose()
    } catch {}
    $mutex.Dispose()
    exit 0
}
$createdEvent = $false
$activationEvent = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, $eventName, [ref]$createdEvent)

function Open-ConsolePath([string]$Path) {
    Start-Process ($ConsoleUrl.TrimEnd("/") + $Path)
}

function Get-Snapshot {
    Invoke-RestMethod -Uri ($ConsoleUrl.TrimEnd("/") + "/api/v1/snapshot") -TimeoutSec 3
}

function Resolve-BunExecutable {
    $command = Get-Command bun -ErrorAction Stop
    if ($command.CommandType -eq "Application" -and $command.Source.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
        return $command.Source
    }
    $candidates = @(
        Join-Path (Split-Path $command.Source -Parent) "node_modules\bun\bin\bun.exe"
    )
    if ($env:BUN_INSTALL) { $candidates += Join-Path $env:BUN_INSTALL "bin\bun.exe" }
    $executable = @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }) | Select-Object -First 1
    if (-not $executable) { throw "Could not resolve bun to a native executable." }
    return $executable
}

function Test-ConsoleHealth {
    try {
        $health = Invoke-RestMethod -Uri ($ConsoleUrl.TrimEnd("/") + "/health") -TimeoutSec 2
        return $health.schema -eq "conductor.control-console-health/v1" -and [bool]$health.ready
    } catch { return $false }
}

function Ensure-Console {
    if (Test-ConsoleHealth) { return }
    $bun = Resolve-BunExecutable
    $repository = Split-Path $PSScriptRoot -Parent
    Start-Process -FilePath $bun -ArgumentList @("src/cli.ts", "console") -WorkingDirectory $repository -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        if (Test-ConsoleHealth) { return }
    } while ((Get-Date) -lt $deadline)
    throw "The Conductor console did not become ready within 30 seconds."
}

$notify = [Windows.Forms.NotifyIcon]::new()
$notify.Icon = [Drawing.SystemIcons]::Application
$notify.Text = "Conductor starting"
$notify.Visible = $true
$menu = [Windows.Forms.ContextMenuStrip]::new()
$statusItem = [Windows.Forms.ToolStripMenuItem]::new("Starting…")
$statusItem.Enabled = $false
$openQueue = [Windows.Forms.ToolStripMenuItem]::new("Open Queue")
$openSettings = [Windows.Forms.ToolStripMenuItem]::new("Settings")
$loadModel = [Windows.Forms.ToolStripMenuItem]::new("Load Model")
$unloadModel = [Windows.Forms.ToolStripMenuItem]::new("Unload Model")
$pauseAll = [Windows.Forms.ToolStripMenuItem]::new("Pause All and Unload (available in phase 4)")
$withdrawPause = [Windows.Forms.ToolStripMenuItem]::new("Withdraw Pending Pause (available in phase 4)")
$resumeAll = [Windows.Forms.ToolStripMenuItem]::new("Resume Paused Jobs (available in phase 4)")
$pauseAll.Enabled = $false
$withdrawPause.Enabled = $false
$resumeAll.Enabled = $false
$exitTray = [Windows.Forms.ToolStripMenuItem]::new("Exit Tray")
[void]$menu.Items.AddRange([Windows.Forms.ToolStripItem[]]@(
    $statusItem, (New-Object Windows.Forms.ToolStripSeparator),
    $openQueue, $openSettings, (New-Object Windows.Forms.ToolStripSeparator),
    $loadModel, $unloadModel, $pauseAll, $withdrawPause, $resumeAll,
    (New-Object Windows.Forms.ToolStripSeparator), $exitTray
))
$notify.ContextMenuStrip = $menu

$script:lastSnapshot = $null
$script:modelJob = $null
$script:modelAction = $null

function Start-ModelMutation([string]$Path, [string]$ActionName, [int]$Revision) {
    if ($null -ne $script:modelJob) { return }
    $loadModel.Enabled = $false
    $unloadModel.Enabled = $false
    $statusItem.Text = "$ActionName requested; waiting for durable completion…"
    $script:modelAction = $ActionName
    $script:modelJob = Start-Job -ScriptBlock {
        param($BaseUrl, $MutationPath, $ExpectedRevision)
        $ErrorActionPreference = "Stop"
        $session = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd("/") + "/api/v1/session") -TimeoutSec 3
        $payload = @{
            expectedRevision = $ExpectedRevision
            csrfToken = $session.csrfToken
            idempotencyKey = [guid]::NewGuid().ToString()
        }
        Invoke-RestMethod -Method Post -Uri ($BaseUrl.TrimEnd("/") + $MutationPath) -ContentType "application/json" -Body ($payload | ConvertTo-Json -Depth 20) -TimeoutSec 1800
    } -ArgumentList $ConsoleUrl, $Path, $Revision
}

function Complete-ModelMutation {
    if ($null -eq $script:modelJob -or $script:modelJob.State -notin @("Completed", "Failed", "Stopped")) { return }
    $actionName = $script:modelAction
    try {
        [void](Receive-Job -Job $script:modelJob -ErrorAction Stop)
        $message = if ($actionName -eq "Load") { "Exact model load durably completed." } else { "Model service stopped with process-tree closure proof; GPU/model resources were released." }
        $notify.ShowBalloonTip(5000, "Conductor", $message, [Windows.Forms.ToolTipIcon]::Info)
    } catch {
        $notify.ShowBalloonTip(7000, "Conductor model $($actionName.ToLowerInvariant()) failed", $_.Exception.Message, [Windows.Forms.ToolTipIcon]::Error)
    } finally {
        Remove-Job -Job $script:modelJob -Force -ErrorAction SilentlyContinue
        $script:modelJob = $null
        $script:modelAction = $null
        Refresh-Tray
    }
}

function Refresh-Tray {
    try {
        $script:lastSnapshot = Get-Snapshot
        $map = Get-StateMap $script:lastSnapshot
        $statusItem.Text = $map.Status
        $loadModel.Enabled = $map.CanLoad
        $unloadModel.Enabled = $map.CanUnload
        $notify.Text = $map.ToolTip.Substring(0, [Math]::Min(63, $map.ToolTip.Length))
    } catch {
        $script:lastSnapshot = $null
        $statusItem.Text = "Console unavailable"
        $loadModel.Enabled = $false
        $unloadModel.Enabled = $false
        $notify.Text = "Conductor console unavailable"
    }
}

$openQueue.add_Click({ Open-ConsolePath "/queue" })
$openSettings.add_Click({ Open-ConsolePath "/settings" })
$notify.add_DoubleClick({ Open-ConsolePath "/queue" })
$loadModel.add_Click({
    Start-ModelMutation "/api/v1/model/load" "Load" ([int]$script:lastSnapshot.model.revision)
})
$unloadModel.add_Click({
    Start-ModelMutation "/api/v1/model/unload" "Unload" ([int]$script:lastSnapshot.model.revision)
})
$exitTray.add_Click({ [Windows.Forms.Application]::Exit() })

$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 3000
$timer.add_Tick({
    if ($activationEvent.WaitOne(0)) { Open-ConsolePath "/queue" }
    Complete-ModelMutation
    if ($null -eq $script:modelJob) { Refresh-Tray }
})

try {
    Ensure-Console
    Refresh-Tray
    $timer.Start()
    [Windows.Forms.Application]::Run()
} catch {
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Conductor Tray", "OK", "Error") | Out-Null
} finally {
    $timer.Stop()
    if ($null -ne $script:modelJob) {
        Stop-Job -Job $script:modelJob -ErrorAction SilentlyContinue
        Remove-Job -Job $script:modelJob -Force -ErrorAction SilentlyContinue
    }
    $timer.Dispose()
    $notify.Visible = $false
    $notify.Dispose()
    $menu.Dispose()
    $activationEvent.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
