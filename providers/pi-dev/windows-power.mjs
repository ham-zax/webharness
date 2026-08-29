import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powerShellPath = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const sleepDelaySeconds = 10;
const minimumWakeDelayMs = 2 * 60 * 1000;
const offsetTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeWakeAt(wakeAt) {
  if (wakeAt === undefined) return { input: null, iso: null };
  if (!offsetTimestamp.test(wakeAt)) {
    throw new Error('wake_at must be an ISO 8601 timestamp ending in Z or an explicit UTC offset');
  }

  const timestamp = Date.parse(wakeAt);
  if (!Number.isFinite(timestamp)) throw new Error('wake_at is not a valid timestamp');
  if (timestamp < Date.now() + minimumWakeDelayMs) {
    throw new Error('wake_at must be at least two minutes in the future');
  }
  return { input: wakeAt, iso: new Date(timestamp).toISOString() };
}

function windowsSetupScript(wakeAt) {
  const wakeAtBase64 = Buffer.from(wakeAt ?? '', 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$taskName = 'MCP Harness Scheduled Wake'
$wakeAtText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${wakeAtBase64}'))

if ([string]::IsNullOrEmpty($wakeAtText)) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
} else {
    $wakeAt = [DateTimeOffset]::Parse(
        $wakeAtText,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    )
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\cmd.exe" -Argument '/c exit 0'
    $trigger = New-ScheduledTaskTrigger -Once -At $wakeAt.LocalDateTime
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable
    $taskArguments = @{
        TaskName = $taskName
        Action = $action
        Trigger = $trigger
        Settings = $settings
        Description = 'Wake scheduled by the personal MCP harness before Windows sleep.'
        Force = $true
    }
    Register-ScheduledTask @taskArguments | Out-Null

    $registered = Get-ScheduledTask -TaskName $taskName
    if ($registered.Settings.WakeToRun -ne $true) {
        throw 'Task Scheduler did not retain WakeToRun'
    }
}

$sleepScript = @'
Start-Sleep -Seconds ${sleepDelaySeconds}
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class McpHarnessPower {
    [DllImport("powrprof.dll", SetLastError = true)]
    public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
}
"@
if (-not [McpHarnessPower]::SetSuspendState($false, $false, $false)) {
    exit 1
}
'@
$sleepEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($sleepScript))
$powerShell = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
$startArguments = @{
    FilePath = $powerShell
    ArgumentList = @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', $sleepEncoded)
    WindowStyle = 'Hidden'
}
Start-Process @startArguments | Out-Null
`;
}

function errorDetail(error) {
  const detail = [error?.stderr, error?.stdout, error?.message]
    .map(value => typeof value === 'string' ? value.trim() : '')
    .find(Boolean);
  return detail || String(error);
}

export async function runWindowsSleep({ wakeAt, signal } = {}) {
  const normalizedWakeAt = normalizeWakeAt(wakeAt);
  try {
    await execFileAsync(powerShellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      windowsSetupScript(normalizedWakeAt.input),
    ], {
      signal,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Windows sleep setup failed: ${errorDetail(error)}`);
  }

  const wake = normalizedWakeAt.iso
    ? ` Windows wake is scheduled for ${normalizedWakeAt.iso}.`
    : ' No MCP wake timer is scheduled.';
  return `Windows sleep is scheduled in ${sleepDelaySeconds} seconds.${wake}`;
}
