# AI 出题精灵

把文字版 PDF / DOCX 批量转换为**可追溯、可复核**的单选、判断、填空题,并导出题目版与答案版两套 Word 文档。

- 完整产品与接口规格见 [`quiz-generator-spec.md`](./quiz-generator-spec.md)
- 研发流程与验收标准见 [`AGENT.md`](./AGENT.md)
- 源码仓库:<https://github.com/dawsondx/Doc2Exam>

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 批量上传 | 一次最多 10 个文件、单个 ≤50 MB;PDF(≤500 页)与 DOCX |
| 出处追溯 | 每道题挂到 SourceBlock:PDF 定位到"第 N 页",DOCX 定位到"标题路径 > 段落 N / 表格 N" |
| AI 配置 | OpenAI 兼容接口;API Key 只存 Windows 凭据管理器(keyring),发送数据前需逐配置确认 |
| 两阶段出题 | 先抽考点候选 → 勾选 → 按固定槽位生成,支持确定性种子复现 |
| 质量控制 | 结构校验 + 有界重试 + 人工复核(编辑/通过/驳回/补题) |
| 导出 | 题目版(不含任何答案信息)与答案版双 Word;导出前自动校验 |

明确不做:OCR、多用户、在线考试、题库管理、自动组卷、安装包。

## 环境要求(Windows 11)

- [uv](https://docs.astral.sh/uv/getting-started/installation/)(自动管理 Python 3.14 与后端依赖)
- [Node.js 24 LTS](https://nodejs.org/) 与 npm
- Windows Credential Manager(API Key 持久化,系统自带)

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

脚本依次完成:检查工具链 → `uv sync` 安装后端依赖 → Alembic 迁移数据库 → `npm ci && npm run build` 构建前端 → 下载 Playwright 测试浏览器(仅端到端测试需要)。

## 启动

双击 `start.bat`,或:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

服务只绑定 `http://127.0.0.1:8000`,由 FastAPI 同源提供前端页面。启动脚本会检测端口占用(只提示、不杀进程),健康检查通过后自动打开浏览器;`Ctrl+C` 停止服务。

所有用户数据(上传文件、解析结果、题目、导出 Word)只写入项目内 `data\` 目录;删除文档或试卷必须经界面二次确认。

## 公开 BYOK 站点(GitHub Pages)

公开版是纯静态站点:PDF/DOCX 在浏览器内解析,API Key 只保存在浏览器,AI 请求由浏览器直连所选服务商,不需要后端。

线上地址:`https://doc2exam.dawsondx.top`

- 构建:`cd frontend; npm run build:site`(输出到 `site-dist/`)
- 自动发布:推送到 `main` 后由 `.github/workflows/deploy-pages.yml` 构建并发布到 `gh-pages` 分支
- GitHub Pages:Source 选择 `gh-pages` / root,Custom domain 填 `doc2exam.dawsondx.top`,证书就绪后启用 Enforce HTTPS
- DNS:在域名 DNS 服务商添加 `CNAME doc2exam -> dawsondx.github.io`(Cloudflare 需先设为 DNS only)

## 开发

```powershell
# 后端(在 backend\ 下)
uv run uvicorn app.main:app --reload --port 8000   # API 服务
uv run pytest tests -q                              # 自动化测试(Mock AI)
uv run ruff check app tests                         # Lint
uv run mypy app                                     # 类型检查(strict)

# 前端(在 frontend\ 下)
npm run dev        # Vite 开发服务器(127.0.0.1:5173,代理 API)
npm run test       # Vitest 单元测试
npm run lint       # ESLint
npm run e2e        # Playwright 端到端(Mock AI,自动起服务)
```

> 首次跑端到端测试前需要下载浏览器(约 115 MB,`setup.ps1` 已自动执行):
>
> ```powershell
> cd frontend; npx playwright install chromium
> ```

### 测试模式

设置环境变量 `AI_QUIZ_MOCK_AI=1` 后,AI 调用全部走本地 Mock(确定性合成考点与题目,不访问网络)。自动化测试与端到端测试只允许在此模式下运行;界面上会显示"测试模式"徽标。

## 目录结构

```
backend/    FastAPI + SQLAlchemy + Alembic(app/ 为应用,tests/ 为自动化测试)
frontend/   React 19 + Vite + Tailwind CSS 4(src/pages 对应八步流程页面)
data/       运行时数据(uploads / 解析块 / 考点 / 题目 / exports / logs),不入版本控制
scripts/    setup.ps1(安装)、start.ps1(启动)
```
