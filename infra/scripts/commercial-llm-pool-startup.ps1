#requires -Version 5.1
<#
.SYNOPSIS
Installs or removes a Windows task for an already installed MAXIM pool worker.
.DESCRIPTION
Logon starts after this Windows user signs in. Startup uses that same user's
credential-backed Task Scheduler logon and can run before interactive sign-in.
The task owns a foreground watch process so Windows can restart WSL failures.
It does not enable a worker that was manually stopped and never changes sleep,
BIOS, firewall, SSH trust, or a different Windows user's WSL installation.
.EXAMPLE
.\commercial-llm-pool-startup.ps1 -Operation Install -NodeId pc-b-9b -Distro Ubuntu -Mode Logon
.EXAMPLE
.\commercial-llm-pool-startup.ps1 -Operation Install -NodeId pc-a-4b -Distro Ubuntu-24.04 -Mode Startup
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Status', 'Remove')]
    [string]$Operation = 'Status',
    [Parameter(Mandatory = $true)]
    [ValidateSet('pc-a-4b', 'pc-b-9b', 'pc-a-cpu-9b')]
    [string]$NodeId,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')]
    [string]$Distro,
    [ValidateSet('Logon', 'Startup')]
    [string]$Mode = 'Logon',
    [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = 'Stop'
$aiOwner = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($aiOwner.IsSystem) { throw 'Run as the Windows user who owns the WSL distribution, not SYSTEM.' }
$aiTaskName = "Major-Maksimov-AI-$NodeId"
$aiMarker = "MAXIM AI pool owner=$($aiOwner.User.Value); node=$NodeId;"
$aiTask = Get-ScheduledTask -TaskName $aiTaskName -ErrorAction SilentlyContinue
if ($aiTask -and -not $aiTask.Description.StartsWith($aiMarker, [StringComparison]::Ordinal)) {
    throw 'A different task already uses this name; it will not be replaced or removed.'
}
$aiTaskRoot = Join-Path $env:LOCALAPPDATA "MajorMaksimov\ai-pool\$NodeId"
$aiReceiptPath = Join-Path $aiTaskRoot 'startup-receipt.json'
$aiWsl = Join-Path $env:SystemRoot 'System32\wsl.exe'

function ConvertTo-AiNativeArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $aiQuoted = [Text.StringBuilder]::new('"')
    $aiBackslashes = 0
    foreach ($aiCharacter in $Value.ToCharArray()) {
        if ($aiCharacter -eq '\') {
            $aiBackslashes++
            continue
        }
        if ($aiCharacter -eq '"') {
            [void]$aiQuoted.Append(('\' * (2 * $aiBackslashes + 1)))
        } elseif ($aiBackslashes -gt 0) {
            [void]$aiQuoted.Append(('\' * $aiBackslashes))
        }
        [void]$aiQuoted.Append($aiCharacter)
        $aiBackslashes = 0
    }
    [void]$aiQuoted.Append(('\' * (2 * $aiBackslashes)))
    [void]$aiQuoted.Append('"')
    return $aiQuoted.ToString()
}

function Invoke-AiWsl {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Arguments)

    $aiStart = [Diagnostics.ProcessStartInfo]::new()
    $aiStart.FileName = $aiWsl
    $aiStart.Arguments = (($Arguments | ForEach-Object { ConvertTo-AiNativeArgument $_ }) -join ' ')
    $aiStart.UseShellExecute = $false
    $aiStart.CreateNoWindow = $true
    $aiStart.WorkingDirectory = $env:SystemRoot
    $aiStart.RedirectStandardOutput = $true
    $aiStart.RedirectStandardError = $true
    $aiStart.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $aiStart.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $aiProcess = [Diagnostics.Process]::new()
    $aiProcess.StartInfo = $aiStart
    $aiStarted = $false
    $aiClock = [Diagnostics.Stopwatch]::StartNew()
    try {
        $aiStarted = $aiProcess.Start()
        if (-not $aiStarted) { throw 'WSL native process did not start.' }
        $aiStreams = @(
            [pscustomobject]@{ Reader = $aiProcess.StandardOutput; Buffer = [char[]]::new(4096); Text = [Text.StringBuilder]::new(); Read = $null; Finished = $false },
            [pscustomobject]@{ Reader = $aiProcess.StandardError; Buffer = [char[]]::new(4096); Text = [Text.StringBuilder]::new(); Read = $null; Finished = $false }
        )
        foreach ($aiStream in $aiStreams) {
            $aiStream.Read = $aiStream.Reader.ReadAsync($aiStream.Buffer, 0, $aiStream.Buffer.Length)
        }
        # FLAG: Drain both pipes within one deadline and private output cap; kill only this owned child on failure.
        while ($true) {
            foreach ($aiStream in $aiStreams) {
                if (-not $aiStream.Finished -and $aiStream.Read.IsCompleted) {
                    $aiCount = $aiStream.Read.GetAwaiter().GetResult()
                    if ($aiCount -eq 0) {
                        $aiStream.Finished = $true
                        $aiStream.Read = $null
                    } else {
                        if ($aiStream.Text.Length + $aiCount -gt 65536) { throw 'WSL native output exceeded its private limit.' }
                        [void]$aiStream.Text.Append($aiStream.Buffer, 0, $aiCount)
                        $aiStream.Read = $aiStream.Reader.ReadAsync($aiStream.Buffer, 0, $aiStream.Buffer.Length)
                    }
                }
            }
            if ($aiClock.ElapsedMilliseconds -ge 30000) { throw 'WSL native invocation exceeded its deadline.' }
            if ($aiStreams[0].Finished -and $aiStreams[1].Finished -and $aiProcess.HasExited) { break }
            [Threading.Thread]::Sleep(10)
        }
        return [pscustomobject]@{
            ExitCode = $aiProcess.ExitCode
            Output = $aiStreams[0].Text.ToString()
            ErrorOutput = $aiStreams[1].Text.ToString()
        }
    } finally {
        try {
            if ($aiStarted -and -not $aiProcess.HasExited) {
                try { $aiProcess.Kill() } catch {
                    if (-not $aiProcess.HasExited) { throw }
                }
                [void]$aiProcess.WaitForExit(1000)
            }
        } finally {
            $aiProcess.Dispose()
            $aiClock.Stop()
        }
    }
}

if ($Operation -eq 'Status') {
    if (-not $aiTask) {
        [pscustomobject]@{ Installed = $false; NodeId = $NodeId } | ConvertTo-Json -Compress
        return
    }
    $aiInfo = Get-ScheduledTaskInfo -TaskName $aiTaskName
    [pscustomobject]@{
        Installed = $true
        NodeId = $NodeId
        TaskName = $aiTaskName
        State = [string]$aiTask.State
        User = $aiTask.Principal.UserId
        LogonType = [string]$aiTask.Principal.LogonType
        LastRunTime = $aiInfo.LastRunTime
        LastTaskResult = $aiInfo.LastTaskResult
    } | ConvertTo-Json -Compress
    return
}

if ($Operation -eq 'Remove') {
    if (-not $aiTask) { return }
    if (-not (Test-Path -LiteralPath $aiReceiptPath)) { throw 'Startup receipt is missing; inspect the task before removing it.' }
    $aiReceipt = Get-Content -LiteralPath $aiReceiptPath -Raw | ConvertFrom-Json
    if ($aiReceipt.OwnerSid -ne $aiOwner.User.Value -or $aiReceipt.NodeId -ne $NodeId -or
        $aiReceipt.Distro -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or
        $aiReceipt.Launcher -notmatch '^/[A-Za-z0-9_./-]+/maxim-llm-pc-(a-4b|b-9b|a-cpu-9b)$' -or
        -not $aiReceipt.Launcher.EndsWith("/maxim-llm-$NodeId", [StringComparison]::Ordinal)) {
        throw 'Startup receipt identity does not match this worker.'
    }
    $aiStop = Invoke-AiWsl @('-d', $aiReceipt.Distro, '--exec', $aiReceipt.Launcher, 'stop')
    if ($aiStop.ExitCode -ne 0) { throw 'Worker stop failed; startup task was preserved.' }
    Stop-ScheduledTask -TaskName $aiTaskName
    Unregister-ScheduledTask -TaskName $aiTaskName -Confirm:$false
    [pscustomobject]@{ Removed = $true; NodeId = $NodeId; WorkerStopped = $true } | ConvertTo-Json -Compress
    return
}

if (-not $Distro) { throw '-Distro is required for Install; select the owning user''s actual distribution.' }
if ($aiTask -and $aiTask.State -eq 'Running') { throw 'Stop the existing startup task before replacing its configuration.' }

# FLAG: WSL distributions and SSH keys belong to the current Windows user. Never probe or register as SYSTEM.
$aiLinuxResult = Invoke-AiWsl @('-d', $Distro, '--exec', '/usr/bin/python3', '-c', "import json,os; print(json.dumps({'home':os.path.expanduser('~'),'uid':os.getuid()}))")
if ($aiLinuxResult.ExitCode -ne 0) { throw 'The specified WSL distribution is unavailable for this Windows user.' }
$aiLinux = $aiLinuxResult.Output | ConvertFrom-Json
if ($aiLinux.uid -eq 0 -or $aiLinux.home -notmatch '^/[A-Za-z0-9_./-]+$' -or $aiLinux.home.Contains('/../')) {
    throw 'Install under a normal WSL user with an absolute home directory.'
}
$aiLauncher = "$($aiLinux.home)/.local/bin/maxim-llm-$NodeId"
$aiExecutable = Invoke-AiWsl @('-d', $Distro, '--exec', '/usr/bin/test', '-x', $aiLauncher)
if ($aiExecutable.ExitCode -ne 0) { throw 'Install the matching Linux pool worker before configuring Windows startup.' }
$aiStatus = Invoke-AiWsl @('-d', $Distro, '--exec', $aiLauncher, 'status')
if ($aiStatus.ExitCode -ne 0) { throw 'The installed worker did not pass its local status check.' }

if ($Mode -eq 'Startup') {
    if (-not $Credential) {
        $Credential = Get-Credential -UserName $aiOwner.Name -Message 'Windows Task Scheduler needs this WSL owner account to start before sign-in. The password is not saved in project files.'
    }
    if (-not $Credential) { throw 'Unattended startup needs the WSL owner credential; use Logon mode otherwise.' }
    $aiCredentialSid = ([Security.Principal.NTAccount]$Credential.UserName).Translate([Security.Principal.SecurityIdentifier])
    if ($aiCredentialSid.Value -ne $aiOwner.User.Value) { throw 'The credential must belong to the current Windows user who owns this WSL distribution.' }
}

New-Item -ItemType Directory -Path $aiTaskRoot -Force | Out-Null
$aiWatchSource = @'
# MAXIM AI pool startup watch
$ErrorActionPreference = 'Stop'
$aiProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wsl.exe') -ArgumentList @('-d', '__DISTRO__', '--exec', '__LAUNCHER__', 'watch') -WindowStyle Hidden -PassThru -Wait
exit $aiProcess.ExitCode
'@
$aiWatchSource = $aiWatchSource.Replace('__DISTRO__', $Distro).Replace('__LAUNCHER__', $aiLauncher)
$aiDigest = [Security.Cryptography.SHA256]::Create()
try {
    $aiWatchHash = ([BitConverter]::ToString($aiDigest.ComputeHash([Text.Encoding]::UTF8.GetBytes($aiWatchSource)))).Replace('-', '').ToLowerInvariant()
} finally { $aiDigest.Dispose() }
$aiWatchPath = Join-Path $aiTaskRoot "watch-$($aiWatchHash.Substring(0,16)).ps1"
if ((Test-Path -LiteralPath $aiWatchPath) -and
    (Get-Content -LiteralPath $aiWatchPath -Raw).TrimEnd() -ne $aiWatchSource.TrimEnd()) {
    throw 'A different file occupies the startup helper path.'
}
Set-Content -LiteralPath $aiWatchPath -Value $aiWatchSource -Encoding UTF8
$aiPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$aiAction = New-ScheduledTaskAction -Execute $aiPowerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $aiWatchPath + '"') -WorkingDirectory $aiTaskRoot
$aiTrigger = if ($Mode -eq 'Startup') { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn -User $aiOwner.Name }
$aiSettings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$aiDescription = "$aiMarker distro=$Distro; mode=$Mode. Foreground WSL watch; manual stop remains disabled."

# FLAG: The OS credential store owns the unattended logon secret; no password enters files, arguments or output.
if ($Mode -eq 'Startup') {
    $aiPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Credential.Password)
    try {
        $aiPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($aiPasswordPointer)
        Register-ScheduledTask -TaskName $aiTaskName -Description $aiDescription -Action $aiAction -Trigger $aiTrigger -Settings $aiSettings -User $aiOwner.Name -Password $aiPassword -RunLevel Limited -Force | Out-Null
    } finally {
        $aiPassword = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($aiPasswordPointer)
    }
} else {
    $aiPrincipal = New-ScheduledTaskPrincipal -UserId $aiOwner.Name -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $aiTaskName -Description $aiDescription -Action $aiAction -Trigger $aiTrigger -Settings $aiSettings -Principal $aiPrincipal -Force | Out-Null
}

[pscustomobject]@{
    NodeId = $NodeId
    OwnerSid = $aiOwner.User.Value
    Distro = $Distro
    Launcher = $aiLauncher
    Mode = $Mode
    TaskName = $aiTaskName
    InstalledAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $aiReceiptPath -Encoding UTF8
[pscustomobject]@{
    Installed = $true
    NodeId = $NodeId
    TaskName = $aiTaskName
    Mode = $Mode
    StartsBeforeSignIn = ($Mode -eq 'Startup')
    ManualStopPreserved = $true
    RebootVerified = $false
} | ConvertTo-Json -Compress
