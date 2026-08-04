param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,

  [Parameter(Mandatory = $true)]
  [string]$ArgumentsBase64,

  [Parameter(Mandatory = $true)]
  [string]$Nonce,

  [Parameter(Mandatory = $true)]
  [int]$OwnerPid,

  [Parameter(Mandatory = $true)]
  [string]$ControlPath,

  [Parameter(Mandatory = $true)]
  [string]$StopPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class ConductorWindowsJob
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(
        IntPtr process,
        IntPtr job,
        [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnClose()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");

        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(information);
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, 9, pointer, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public static void Assign(IntPtr job, Process process)
    {
        if (!AssignProcessToJobObject(job, process.Handle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
    }

    public static void VerifyOwnership(IntPtr job, Process process)
    {
        bool isMember;
        if (!IsProcessInJob(process.Handle, job, out isMember))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "IsProcessInJob failed");
        if (!isMember)
            throw new InvalidOperationException("Process guardian is not a member of its Windows Job Object");

        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 9, pointer, (uint)size, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject limits failed");
            var information = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(
                pointer,
                typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if ((information.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0)
                throw new InvalidOperationException("Windows Job Object lacks kill-on-close enforcement");
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public static void TerminateAndWait(IntPtr job, int timeoutMilliseconds)
    {
        if (!TerminateJobObject(job, 125))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");

        var deadline = Environment.TickCount64 + timeoutMilliseconds;
        while (true)
        {
            if (GetActiveProcesses(job) == 0) return;
            if (Environment.TickCount64 >= deadline)
                throw new TimeoutException("Windows Job Object still has active processes after termination");
            Thread.Sleep(25);
        }
    }

    public static uint GetActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 1, pointer, (uint)size, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject failed");
            var information = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                pointer,
                typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return information.ActiveProcesses;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public static void Close(IntPtr job)
    {
        if (job != IntPtr.Zero && !CloseHandle(job))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle failed");
    }
}
"@

$eventPrefix = [char]0x1e + "CONDUCTOR_EVENT "
$job = [IntPtr]::Zero
$child = $null
$owner = $null
$exitCode = 126
$cleanupReported = $false
$activeBeforeTermination = 0

function Write-ConductorEvent([hashtable]$Value) {
  $Value["nonce"] = $Nonce
  [Console]::Out.WriteLine($eventPrefix + ($Value | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  $argumentsJson = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($ArgumentsBase64)
  )
  $arguments = @(ConvertFrom-Json -InputObject $argumentsJson)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Executable
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $arguments) {
    [void]$start.ArgumentList.Add([string]$argument)
  }

  $job = [ConductorWindowsJob]::CreateKillOnClose()
  $child = [Diagnostics.Process]::new()
  $child.StartInfo = $start
  if (-not $child.Start()) {
    throw "Process guardian did not start"
  }
  [ConductorWindowsJob]::Assign($job, $child)
  [ConductorWindowsJob]::VerifyOwnership($job, $child)
  Write-ConductorEvent @{
    type = "ownership-ready"
    kind = "windows-job"
    ownerPid = $PID
    guardianPid = $child.Id
    kernelEnforced = $true
    killOnOwnerClose = $true
  }

  $owner = [Diagnostics.Process]::GetProcessById($OwnerPid)
  while (-not [IO.File]::Exists($ControlPath)) {
    if ($owner.HasExited -or [IO.File]::Exists($StopPath)) {
      $exitCode = 125
      $activeBeforeTermination = [ConductorWindowsJob]::GetActiveProcesses($job)
      [ConductorWindowsJob]::TerminateAndWait($job, 4000)
      $child.WaitForExit()
      break
    }
    Start-Sleep -Milliseconds 25
  }

  $standardOutput = [Console]::OpenStandardOutput()
  $standardError = [Console]::OpenStandardError()
  $outputPump = $child.StandardOutput.BaseStream.CopyToAsync($standardOutput)
  $errorPump = $child.StandardError.BaseStream.CopyToAsync($standardError)

  if (-not $child.HasExited) {
    $startMessage = [IO.File]::ReadAllText($ControlPath)
    if ([string]::IsNullOrWhiteSpace($startMessage)) {
      throw "Guardian start authorization was empty"
    }
    $child.StandardInput.WriteLine($startMessage)
    $child.StandardInput.Flush()

    while (-not $child.HasExited -and -not $owner.HasExited -and -not [IO.File]::Exists($StopPath)) {
      Start-Sleep -Milliseconds 25
    }
    if ($owner.HasExited -or [IO.File]::Exists($StopPath)) {
      $exitCode = 125
      $activeBeforeTermination = [ConductorWindowsJob]::GetActiveProcesses($job)
      [ConductorWindowsJob]::TerminateAndWait($job, 4000)
      $child.WaitForExit()
    }
    else {
      $child.WaitForExit()
      $exitCode = $child.ExitCode
      $activeBeforeTermination = [ConductorWindowsJob]::GetActiveProcesses($job)
      [ConductorWindowsJob]::TerminateAndWait($job, 4000)
    }
  }
  $child.StandardInput.Close()
  [void]$outputPump.GetAwaiter().GetResult()
  [void]$errorPump.GetAwaiter().GetResult()

  Write-ConductorEvent @{
    type = "tree-cleanup"
    status = "proven"
    method = "windows-job-terminate-and-empty"
    detail = "activeProcessesBeforeTermination=" + $activeBeforeTermination
  }
  $cleanupReported = $true
}
catch {
  $failure = $_.Exception
  if ($job -ne [IntPtr]::Zero) {
    try {
      [ConductorWindowsJob]::TerminateAndWait($job, 1000)
    }
    catch {
      # The failure is reported below; handle close remains the final kill-on-close boundary.
    }
  }
  if (-not $cleanupReported) {
    Write-ConductorEvent @{
      type = "tree-cleanup"
      status = "failed"
      method = "windows-job"
      detail = $failure.Message
    }
  }
  [Console]::Error.WriteLine($failure.ToString())
  [Console]::Error.Flush()
}
finally {
  if ($job -ne [IntPtr]::Zero) {
    try {
      [ConductorWindowsJob]::Close($job)
    }
    catch {
      [Console]::Error.WriteLine($_.Exception.ToString())
    }
  }
  if ($null -ne $child) {
    $child.Dispose()
  }
  if ($null -ne $owner) {
    $owner.Dispose()
  }
}

exit $exitCode
