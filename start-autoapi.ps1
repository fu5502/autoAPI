$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$ApiPort = 8080
$WebPort = 5173
$ApiUrl = "http://127.0.0.1:$ApiPort"
$WebUrl = "http://127.0.0.1:$WebPort"

function Write-MenuText([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::Gray) {
  Write-Host $Text -ForegroundColor $Color
}

function Clear-Screen {
  # Clear-Host on Windows conhost keeps the scrollback buffer, so the menu can
  # end up below old output instead of at the very top. Reset both the visible
  # screen and the scrollback so the menu is always pinned to the top.
  try {
    $raw = $Host.UI.RawUI
    $size = $raw.BufferSize
    $blank = ' ' * $size.Width
    $origin = New-Object System.Management.Automation.Host.Coordinates 0, 0
    for ($row = 0; $row -lt $size.Height; $row++) {
      [System.Console]::SetCursorPosition(0, $row)
      [System.Console]::Write($blank)
    }
    $raw.CursorPosition = $origin
    $window = $raw.WindowPosition
    $window.X = 0
    $window.Y = 0
    $raw.WindowPosition = $window
  } catch {
    Clear-Host
  }
}

function Test-Command([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-Port([int]$Port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-PortProcess([int]$Port) {
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) { return $null }
  return Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
}

function New-ProcessJob {
  if ($null -eq ("AutoApiProcessJob" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AutoApiProcessJob
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize;
        public IntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public IntPtr ProcessMemoryLimit;
        public IntPtr JobMemoryLimit;
        public IntPtr PeakProcessMemoryUsed;
        public IntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref ExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnClose()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        uint length = (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation));
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref information, length))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }

        return job;
    }

    public static void Assign(IntPtr job, IntPtr process)
    {
        if (!AssignProcessToJobObject(job, process))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void Close(IntPtr job)
    {
        if (job != IntPtr.Zero)
        {
            CloseHandle(job);
        }
    }
}
"@
  }
  return [AutoApiProcessJob]::CreateKillOnClose()
}

function Add-ProcessToJob([IntPtr]$Job, [System.Diagnostics.Process]$Process) {
  [AutoApiProcessJob]::Assign($Job, $Process.Handle)
}

function Ensure-Dependencies {
  if (-not (Test-Command "node.exe")) {
    Write-MenuText "未找到 Node.js，请安装 Node.js 22 或更高版本。" Red
    return $false
  }
  if (-not (Test-Command "pnpm.cmd")) {
    Write-MenuText "未找到 pnpm，请先启用 Corepack 或安装 pnpm。" Red
    return $false
  }
  if (-not (Test-Path (Join-Path $Root "node_modules\.pnpm"))) {
    Write-MenuText "依赖尚未安装，正在执行 pnpm install..." Yellow
    & pnpm.cmd install
    if ($LASTEXITCODE -ne 0) {
      Write-MenuText "依赖安装失败。" Red
      return $false
    }
  }
  return $true
}

function Show-ServiceStatus {
  $apiProcess = Get-PortProcess $ApiPort
  $webProcess = Get-PortProcess $WebPort
  $apiText = if ($apiProcess) { "运行中  (PID $($apiProcess.Id), $($apiProcess.ProcessName))" } else { "未运行" }
  $webText = if ($webProcess) { "运行中  (PID $($webProcess.Id), $($webProcess.ProcessName))" } else { "未运行" }
  Write-Host "服务状态  " -NoNewline -ForegroundColor Gray
  $apiColor = if ($apiProcess) { "Green" } else { "DarkGray" }
  Write-Host "API $apiText" -ForegroundColor $apiColor
  Write-Host "          " -NoNewline
  $webColor = if ($webProcess) { "Green" } else { "DarkGray" }
  Write-Host "前端 $webText" -ForegroundColor $webColor
}

function Show-Menu {
  Clear-Screen
  Write-Host "============================================================" -ForegroundColor DarkCyan
  Write-Host " autoAPI 多渠道模型网关 - 控制台" -ForegroundColor White
  Write-Host "============================================================" -ForegroundColor DarkCyan
  Write-Host "网关入口  " -NoNewline -ForegroundColor Gray
  Write-Host $ApiUrl -ForegroundColor Cyan
  Write-Host "管理后台  " -NoNewline -ForegroundColor Gray
  Write-Host $WebUrl -ForegroundColor Cyan
  Write-Host "------------------------------------------------------------" -ForegroundColor DarkCyan
  Show-ServiceStatus
  Write-Host ""
  Write-Host "-- 启动 ----------------------------------------------------" -ForegroundColor Magenta
  Write-Host "[1]" -ForegroundColor Yellow -NoNewline; Write-Host " 正式模式        当前终端前台运行 Docker Compose 服务"
  Write-Host "[2]" -ForegroundColor Yellow -NoNewline; Write-Host " 开发模式        当前终端运行 API 与前端热更新"
  Write-Host "[3]" -ForegroundColor Yellow -NoNewline; Write-Host " 打开控制台      打开正在运行的 autoAPI 页面"
  Write-Host ""
  Write-Host "-- 维护 ----------------------------------------------------" -ForegroundColor Magenta
  Write-Host "[4]" -ForegroundColor Yellow -NoNewline; Write-Host " 完整检查        类型检查、测试和生产构建"
  Write-Host "[5]" -ForegroundColor Yellow -NoNewline; Write-Host " 运行诊断        检查环境、端口和健康状态"
  Write-Host "[6]" -ForegroundColor Yellow -NoNewline; Write-Host " 环境配置        创建或打开 .env 配置文件"
  Write-Host "[7]" -ForegroundColor Yellow -NoNewline; Write-Host " 重新构建        重新构建前端和 API"
  Write-Host ""
  Write-Host "-- 服务与数据 ----------------------------------------------" -ForegroundColor Magenta
  Write-Host "[8]" -ForegroundColor Yellow -NoNewline; Write-Host " 停止服务        停止本地 API、前端和 Docker 服务"
  Write-Host "[9]" -ForegroundColor Yellow -NoNewline; Write-Host " 数据目录        在资源管理器中打开项目目录"
  Write-Host "[B]" -ForegroundColor Yellow -NoNewline; Write-Host " 备份配置        备份 .env、迁移文件和文档"
  Write-Host "[M]" -ForegroundColor Yellow -NoNewline; Write-Host " 迁移签到数据    从 zhongzhuanzhan 导入站点和签到历史"
  Write-Host "[K]" -ForegroundColor Yellow -NoNewline; Write-Host " 备份签到数据    备份签到 SQLite 与浏览器配置"
  Write-Host "[E]" -ForegroundColor Yellow -NoNewline; Write-Host " 授权助手目录    打开 Chrome/Edge 本地授权助手目录"
  Write-Host "[V]" -ForegroundColor Yellow -NoNewline; Write-Host " 版本信息        查看 Node、pnpm 和项目版本"
  Write-Host ""
  Write-Host "------------------------------------------------------------" -ForegroundColor DarkCyan
  Write-Host "[0]" -ForegroundColor Yellow -NoNewline; Write-Host " 退出"
  Write-Host ""
}

function Start-DevMode {
  if (-not (Ensure-Dependencies)) { return }
  Stop-PreviousServices
  $busyPorts = @($ApiPort, $WebPort) | Where-Object { Test-Port $_ }
  if ($busyPorts.Count -gt 0) {
    Write-MenuText "端口 $($busyPorts -join ', ') 已被占用，请先停止已有服务。" Yellow
    return
  }

  Write-Host ""
  Write-MenuText "开发服务将在当前终端启动。" Green
  Write-Host "API: $ApiUrl"
  Write-Host "Web: $WebUrl"
  Write-MenuText "日志会显示在此窗口；按 Ctrl+C 或关闭此窗口会停止本次启动的服务。" Yellow
  Write-Host ""

  $job = [IntPtr]::Zero
  $services = @()
  try {
    try {
      $job = New-ProcessJob
    } catch {
      Write-MenuText "无法创建进程生命周期绑定，将使用前台进程树清理：$($_.Exception.Message)" Yellow
    }
    $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
    $tsxScript = (Resolve-Path (Join-Path $Root "apps\api\node_modules\.bin\..\tsx\dist\cli.mjs") -ErrorAction Stop).Path
    $viteScript = (Resolve-Path (Join-Path $Root "apps\web\node_modules\.bin\..\vite\bin\vite.js") -ErrorAction Stop).Path
    $apiDirectory = Join-Path $Root "apps\api"
    $webDirectory = Join-Path $Root "apps\web"

    $apiProcess = Start-Process -FilePath $nodeCommand -ArgumentList @($tsxScript, "watch", "src/index.ts") -WorkingDirectory $apiDirectory -NoNewWindow -PassThru
    $services += [PSCustomObject]@{ Name = "API"; Process = $apiProcess }
    if ($job -ne [IntPtr]::Zero) {
      try {
        Add-ProcessToJob $job $apiProcess
      } catch {
        Write-MenuText "无法绑定 API 进程，将使用前台进程树清理：$($_.Exception.Message)" Yellow
        [AutoApiProcessJob]::Close($job)
        $job = [IntPtr]::Zero
      }
    }

    $webProcess = Start-Process -FilePath $nodeCommand -ArgumentList @($viteScript, "--host", "0.0.0.0") -WorkingDirectory $webDirectory -NoNewWindow -PassThru
    $services += [PSCustomObject]@{ Name = "Web"; Process = $webProcess }
    if ($job -ne [IntPtr]::Zero) {
      try {
        Add-ProcessToJob $job $webProcess
      } catch {
        Write-MenuText "无法绑定 Web 进程，将使用前台进程树清理：$($_.Exception.Message)" Yellow
        [AutoApiProcessJob]::Close($job)
        $job = [IntPtr]::Zero
      }
    }

    $ready = $false
    $startupDeadline = (Get-Date).AddSeconds(30)
    while ($true) {
      foreach ($service in $services) { $service.Process.Refresh() }
      $exited = @($services | Where-Object { $_.Process.HasExited })
      if ($exited.Count -gt 0) {
        foreach ($service in $exited) {
          Write-MenuText "$($service.Name) 服务已退出，退出码：$($service.Process.ExitCode)。请查看上方日志。" Red
        }
        break
      }
      if (-not $ready -and (Test-Port $ApiPort) -and (Test-Port $WebPort)) {
        Write-MenuText "API 与 Web 已启动。" Green
        $ready = $true
      }
      if (-not $ready -and (Get-Date) -ge $startupDeadline) {
        Write-MenuText "开发服务启动超时，请查看上方 API/Web 日志。" Red
        break
      }
      Start-Sleep -Milliseconds 400
    }
  } catch {
    Write-MenuText "开发服务启动失败：$($_.Exception.Message)" Red
  } finally {
    foreach ($service in $services) {
      $service.Process.Refresh()
      if (-not $service.Process.HasExited) {
        & taskkill.exe /PID $service.Process.Id /T /F 2>$null | Out-Null
      }
    }
    if ($job -ne [IntPtr]::Zero) {
      [AutoApiProcessJob]::Close($job)
    }
    Stop-LocalServices
  }
}

function Start-ProductionMode {
  if (-not (Test-Command "docker.exe")) {
    Write-MenuText "未找到 Docker Desktop 或 docker.exe。" Red
    return
  }
  if (-not (Test-Path (Join-Path $Root ".env"))) {
    Write-MenuText "未找到 .env，先执行环境配置。" Yellow
    Initialize-Environment
    if (-not (Test-Path (Join-Path $Root ".env"))) { return }
  }
  $envContent = Get-Content (Join-Path $Root ".env") -Raw
  $requiredValues = @{}
  foreach ($required in @("POSTGRES_PASSWORD", "DATABASE_URL", "CREDENTIAL_ENCRYPTION_KEY", "ADMIN_TOKEN", "ADMIN_PASSWORD", "GATEWAY_API_KEY")) {
    $match = [regex]::Match($envContent, "(?m)^$required=([^\r\n]+)")
    if (-not $match.Success -or [string]::IsNullOrWhiteSpace($match.Groups[1].Value)) {
      Write-MenuText ".env 缺少 $required，无法启动正式模式。" Red
      return
    }
    $requiredValues[$required] = $match.Groups[1].Value.Trim()
  }
  foreach ($entry in $requiredValues.GetEnumerator()) {
    if ($entry.Value -match "(?i)^(change[-_ ]?me|replace(?:[-_ ]?with)?|your[-_ ])" -or $entry.Value -in @("AutoAPI@123456", "autoapi", "replace8")) {
      Write-MenuText ".env 中的 $($entry.Key) 仍是示例占位值，请先修改。" Red
      return
    }
  }
  Stop-PreviousServices
  if (Test-Port $ApiPort) {
    Write-MenuText "端口 $ApiPort 已被占用，请先停止已有服务。" Yellow
    return
  }

  Write-Host ""
  Write-MenuText "Docker 正式模式将在当前终端前台运行。" Green
  Write-Host "网关地址: $ApiUrl"
  Write-MenuText "日志会显示在此窗口；按 Ctrl+C 或关闭此窗口会停止本 Compose 项目。" Yellow
  Write-Host ""

  try {
    & docker compose up --build
  } finally {
    Write-MenuText "正在停止本次启动的 Docker 服务（不会删除数据卷）..." Yellow
    & docker compose down --remove-orphans 2>$null | Out-Null
  }
}

function Open-Dashboard {
  if (Test-Port $WebPort) { Start-Process $WebUrl }
  elseif (Test-Port $ApiPort) { Start-Process $ApiUrl }
  else { Write-MenuText "当前没有检测到运行中的服务。" Yellow }
}

function Run-Checks {
  if (-not (Ensure-Dependencies)) { return }
  Write-MenuText "开始执行完整检查..." Cyan
  & pnpm.cmd typecheck
  if ($LASTEXITCODE -ne 0) { Write-MenuText "类型检查失败。" Red; return }
  & pnpm.cmd test
  if ($LASTEXITCODE -ne 0) { Write-MenuText "测试失败。" Red; return }
  & pnpm.cmd build
  if ($LASTEXITCODE -ne 0) { Write-MenuText "构建失败。" Red; return }
  Write-MenuText "完整检查通过。" Green
}

function Run-Diagnostics {
  Write-Host ""
  Write-Host "环境" -ForegroundColor Cyan
  if (Test-Command "node.exe") { node --version } else { Write-MenuText "Node.js: 未安装" Red }
  if (Test-Command "pnpm.cmd") { pnpm.cmd --version } else { Write-MenuText "pnpm: 未安装" Red }
  Write-Host ""
  Write-Host "端口" -ForegroundColor Cyan
  $apiPortText = if (Test-Port $ApiPort) { "已监听" } else { "未监听" }
  $webPortText = if (Test-Port $WebPort) { "已监听" } else { "未监听" }
  Write-Host "API ${ApiPort}: $apiPortText"
  Write-Host "Web ${WebPort}: $webPortText"
  if (Test-Port $ApiPort) {
    try {
      $health = Invoke-RestMethod "$ApiUrl/healthz" -TimeoutSec 3
      Write-Host "健康检查: $($health.status) / $($health.mode)" -ForegroundColor Green
    } catch { Write-MenuText "健康检查失败: $($_.Exception.Message)" Red }
  }
  if (Test-Command "docker.exe") {
    Write-Host ""
    docker compose ps
  }
}

function Initialize-Environment {
  $envPath = Join-Path $Root ".env"
  if (-not (Test-Path $envPath)) {
    Copy-Item (Join-Path $Root ".env.example") $envPath
    Write-MenuText "已从 .env.example 创建 .env，请修改管理员令牌、网关密钥和加密密钥。" Yellow
  }
  Start-Process notepad.exe $envPath
}

function Stop-LocalServices {
  $stopped = @{}
  foreach ($port in @($ApiPort, $WebPort)) {
    $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
      $processId = [int]$connection.OwningProcess
      if ($stopped.ContainsKey($processId)) { continue }
      $stopped[$processId] = $true
      $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($process) {
        Write-MenuText "正在停止端口 $port 的进程 PID $processId 及其子进程..." Yellow
        & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
      }
    }
  }
}

function Stop-ManagedDevProcesses {
  $patterns = @(
    '(?i)@autoapi[\\/](api|web).*dev',
    '(?i)apps[\\/]api[\\/].*tsx.*src[\\/]index\.ts',
    '(?i)apps[\\/]web[\\/].*vite'
  )
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $matched = @($processes | Where-Object {
    $commandLine = [string]$_.CommandLine
    $commandLine -and ($patterns | Where-Object { $commandLine -match $_ })
  })
  $stopped = @{}
  foreach ($process in $matched) {
    $processId = [int]$process.ProcessId
    if ($processId -eq $PID -or $stopped.ContainsKey($processId)) { continue }
    $stopped[$processId] = $true
    Write-MenuText "正在清理旧 autoAPI 进程 PID $processId 及其子进程..." Yellow
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
  }
}

function Wait-PortsFree([int[]]$Ports, [int]$TimeoutSeconds = 10) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $busy = @($Ports | Where-Object { Test-Port $_ })
    if ($busy.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Stop-PreviousServices {
  Write-MenuText "启动前正在清理旧的 autoAPI 服务..." Yellow
  Stop-ManagedDevProcesses
  Stop-LocalServices
  if (Test-Command "docker.exe") {
    & docker compose stop 2>$null | Out-Null
  }
  if (-not (Wait-PortsFree @($ApiPort, $WebPort))) {
    Write-MenuText "旧服务清理后仍有端口未释放，将在启动前继续检查。" Yellow
  }
}

function Stop-Services {
  Stop-PreviousServices
  Write-MenuText "旧服务已停止。" Green
}

function Backup-Configuration {
  $backupDir = Join-Path $Root "backups"
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $zipPath = Join-Path $backupDir "autoapi-config-$stamp.zip"
  $items = @(".env", ".env.example", "docker-compose.yml", "Dockerfile", "README.md", "docs", "apps/api/migrations", ".autoapi-data", "apps/api/.autoapi-data") | ForEach-Object { Join-Path $Root $_ } | Where-Object { Test-Path $_ }
  Compress-Archive -Path $items -DestinationPath $zipPath -Force
  Write-MenuText "配置备份已生成: $zipPath" Green
}

function Migrate-CheckinData {
  if (-not (Ensure-Dependencies)) { return }
  Write-MenuText "开始迁移公益站签到数据，源目录不会被删除或修改..." Cyan
  & pnpm.cmd --filter @autoapi/api migrate:checkin
  if ($LASTEXITCODE -eq 0) { Write-MenuText "签到数据迁移完成。" Green } else { Write-MenuText "签到数据迁移失败。" Red }
}

function Backup-CheckinData {
  if (-not (Ensure-Dependencies)) { return }
  & pnpm.cmd --filter @autoapi/api backup:checkin
  if ($LASTEXITCODE -eq 0) { Write-MenuText "签到数据备份完成。" Green } else { Write-MenuText "签到数据备份失败。" Red }
}

function Open-AuthAssistant {
  Start-Process explorer.exe (Join-Path $Root "apps\auth-assistant")
  Write-MenuText "已打开本地授权助手目录，请在 Chrome/Edge 扩展管理页加载该目录。" Green
}

function Show-Version {
  $package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
  Write-Host "autoAPI: $($package.version)"
  if (Test-Command "node.exe") { node --version }
  if (Test-Command "pnpm.cmd") { pnpm.cmd --version }
}

while ($true) {
  Show-Menu
  $choice = (Read-Host "请选择功能").Trim().ToUpperInvariant()
  switch ($choice) {
    "1" { Start-ProductionMode }
    "2" { Start-DevMode }
    "3" { Open-Dashboard }
    "4" { Run-Checks }
    "5" { Run-Diagnostics }
    "6" { Initialize-Environment }
    "7" { if (Ensure-Dependencies) { & pnpm.cmd build } }
    "8" { Stop-Services }
    "9" { Start-Process explorer.exe $Root }
    "B" { Backup-Configuration }
    "M" { Migrate-CheckinData }
    "K" { Backup-CheckinData }
    "E" { Open-AuthAssistant }
    "V" { Show-Version }
    "0" { exit 0 }
    default { Write-MenuText "无效选项，请重新选择。" Yellow }
  }
  Write-Host ""
  Read-Host "按 Enter 返回菜单"
}
