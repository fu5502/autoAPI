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
  Clear-Host
  Write-Host "============================================================" -ForegroundColor DarkCyan
  Write-Host " autoAPI 多渠道模型网关 - 控制台" -ForegroundColor White
  Write-Host "============================================================" -ForegroundColor DarkCyan
  Show-ServiceStatus
  Write-Host ""
  Write-Host "-- 启动 ----------------------------------------------------" -ForegroundColor Magenta
  Write-Host "[1]" -ForegroundColor Yellow -NoNewline; Write-Host " 正式模式        Docker Compose 启动 PostgreSQL、Redis 和网关"
  Write-Host "[2]" -ForegroundColor Yellow -NoNewline; Write-Host " 开发模式        启动 API 与前端热更新窗口"
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
  Write-Host "[V]" -ForegroundColor Yellow -NoNewline; Write-Host " 版本信息        查看 Node、pnpm 和项目版本"
  Write-Host ""
  Write-Host "------------------------------------------------------------" -ForegroundColor DarkCyan
  Write-Host "[0]" -ForegroundColor Yellow -NoNewline; Write-Host " 退出"
  Write-Host ""
}

function Start-DevMode {
  if (-not (Ensure-Dependencies)) { return }
  if (-not (Test-Port $ApiPort)) {
    $apiCommand = "cd /d `"$Root`" && title autoAPI API && pnpm.cmd --filter @autoapi/api dev"
    Start-Process -FilePath $env:ComSpec -ArgumentList @("/k", $apiCommand) -WorkingDirectory $Root | Out-Null
  } else {
    Write-MenuText "API 已占用 $ApiPort 端口，跳过启动。" Yellow
  }
  if (-not (Test-Port $WebPort)) {
    $webCommand = "cd /d `"$Root`" && title autoAPI Web && pnpm.cmd --filter @autoapi/web dev"
    Start-Process -FilePath $env:ComSpec -ArgumentList @("/k", $webCommand) -WorkingDirectory $Root | Out-Null
  } else {
    Write-MenuText "前端已占用 $WebPort 端口，跳过启动。" Yellow
  }
  Write-MenuText "开发服务已启动，API: $ApiUrl，前端: $WebUrl" Green
  Start-Sleep -Seconds 2
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
  Start-Process -FilePath $env:ComSpec -ArgumentList @("/k", "cd /d `"$Root`" && title autoAPI Docker && docker compose up --build") -WorkingDirectory $Root | Out-Null
  Write-MenuText "Docker 正式模式已启动，网关地址: $ApiUrl" Green
  Start-Sleep -Seconds 2
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

function Stop-Services {
  foreach ($port in @($ApiPort, $WebPort)) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-MenuText "已停止端口 $port 的进程 PID $($connection.OwningProcess)。" Green
    }
  }
  if (Test-Command "docker.exe") {
    docker compose stop
  }
  Start-Sleep -Seconds 1
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
    "V" { Show-Version }
    "0" { exit 0 }
    default { Write-MenuText "无效选项，请重新选择。" Yellow }
  }
  Write-Host ""
  Read-Host "按 Enter 返回菜单"
}
