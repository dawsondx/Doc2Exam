# AI 出题精灵 · 一键安装(uv + Node 依赖 + 数据库迁移 + 前端构建)
# 用法:右键"使用 PowerShell 运行",或 powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($msg) { Write-Host "[错误] $msg" -ForegroundColor Red; exit 1 }

# 1. 检查工具链
Write-Host "== 检查工具链 ==" -ForegroundColor Cyan
try { $uvV = (uv --version) } catch { Fail "未找到 uv。请先安装:https://docs.astral.sh/uv/getting-started/installation/" }
Write-Host "  $uvV"
try { $nodeV = (node --version) } catch { Fail "未找到 Node.js。请安装 Node 24 LTS:https://nodejs.org/" }
Write-Host "  node $nodeV"

# 2. 后端:同步依赖(按 pyproject.toml 锁定版本,自动创建 .venv)
Write-Host "`n== 后端依赖 (uv sync) ==" -ForegroundColor Cyan
uv sync --project backend
if ($LASTEXITCODE -ne 0) { Fail "后端依赖安装失败" }

# 3. 数据库迁移(Alembic 到 head;数据只写入 data\)
Write-Host "`n== 数据库迁移 ==" -ForegroundColor Cyan
uv run --project backend alembic -c backend/alembic.ini upgrade head
if ($LASTEXITCODE -ne 0) { Fail "数据库迁移失败" }

# 4. 前端:npm ci + 生产构建(dist 由 FastAPI 同源提供)
Write-Host "`n== 前端依赖与构建 ==" -ForegroundColor Cyan
Push-Location frontend
npm ci
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "前端依赖安装失败" }
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "前端构建失败" }
Pop-Location

# 5. Playwright 浏览器(仅端到端测试需要;下载失败不影响启动与使用)
Write-Host "`n== Playwright 测试浏览器 ==" -ForegroundColor Cyan
Push-Location frontend
npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Write-Host "[提示] Playwright 浏览器下载失败。应用本身不受影响;需要跑端到端测试时请重试:npx playwright install chromium" -ForegroundColor Yellow
} else {
    Pop-Location
}

Write-Host "`n[完成] 安装就绪。运行 scripts\start.ps1 启动应用。" -ForegroundColor Green
