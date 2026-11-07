# AI 出题精灵 · 启动(FastAPI 127.0.0.1:8000 同源提供前端)
# 用法:powershell -ExecutionPolicy Bypass -File scripts\start.ps1
# 本文件需保存为 UTF-8 with BOM,否则 Windows PowerShell 5.1 会按系统 ANSI
# 码页解析,中文提示会变成乱码。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($msg) { Write-Host "[错误] $msg" -ForegroundColor Red; exit 1 }

# 端口占用检测:只提示,不杀进程
$conn = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Fail "端口 8000 已被占用(PID $($conn[0].OwningProcess))。请先关闭占用该端口的程序后重试。"
}

# 前置检查
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail "未找到 uv。请先安装:https://docs.astral.sh/uv/getting-started/installation/ ,再重新运行 scripts\setup.ps1。"
}
if (-not (Test-Path "backend\.venv")) {
    Fail "尚未安装。请先运行 scripts\setup.ps1。"
}
if (-not (Test-Path "frontend\dist\index.html")) {
    Write-Host "[提示] 未找到 frontend\dist,将只提供 API(开发时前端请另跑 npm run dev)。" -ForegroundColor Yellow
    Write-Host "[提示] 需要完整界面请先执行:cd frontend; npm run build" -ForegroundColor Yellow
}

# 数据库迁移到最新
# 原生命令的 stderr 在 $ErrorActionPreference="Stop" 下会被 PowerShell 5.1
# 转成 NativeCommandError 终止性错误(仅当 stderr 被 2>&1 并入成功流时触发)。
# 这里临时降级为 Continue 并用 2>&1 收集输出:成功时静默,失败时打印真实原因。
$strictPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$migrateOut = uv run --project backend alembic -c backend/alembic.ini upgrade head 2>&1
$migrateCode = $LASTEXITCODE
$ErrorActionPreference = $strictPref
if ($migrateCode -ne 0) {
    $migrateOut | ForEach-Object { Write-Host ("  " + $_.ToString()) -ForegroundColor DarkGray }
    Fail "数据库迁移失败(退出码 $migrateCode)。请检查上面的输出后重试。"
}

# 启动服务;Ctrl+C 一并终止子进程
Write-Host "== AI 出题精灵启动中:http://127.0.0.1:8000 ==" -ForegroundColor Green
$server = Start-Process -FilePath "uv" -ArgumentList @("run", "--project", "backend", "uvicorn", "app.main:app", "--app-dir", "backend", "--host", "127.0.0.1", "--port", "8000") -PassThru -NoNewWindow

# 健康检查通过后自动打开浏览器
$ok = $false
foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 500
    if ($server.HasExited) { break }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/health" -TimeoutSec 2 -ErrorAction Stop
        if ($health.status -eq "ok") { $ok = $true; break }
    } catch {}
}
if ($ok) {
    Write-Host "== 服务就绪,打开浏览器 ==" -ForegroundColor Green
    Start-Process "http://127.0.0.1:8000"
} elseif ($server.HasExited) {
    Fail "服务进程已退出(退出码 $($server.ExitCode))。请查看上方日志排查后重试。"
} else {
    Write-Host "[提示] 服务未在 15 秒内就绪,请查看日志输出。" -ForegroundColor Yellow
}

try {
    if (-not $server.HasExited) { Wait-Process -Id $server.Id }
} finally {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
