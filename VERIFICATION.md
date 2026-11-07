# AI 出题精灵 · 验证报告

- 日期:2026-11-07(本轮 Bug 修复后重跑;上一轮 2026-08-24)
- 版本:1.1.0(对应 `backend/app/config.py` 的 `__version__`)
- 规格:`quiz-generator-spec.md` v1.1;研发流程:`AGENT.md`

## 0. 本轮修复的缺陷

本轮以「研究 + 修 Bug」为目标,共定位并修复 8 个缺陷,下表列出根因与影响面。

| # | 缺陷 | 根因 | 影响 |
| --- | --- | --- | --- |
| 1 | `start.bat` 无法正常使用 | 文件用 LF 换行。cmd.exe 按 CRLF(2 字节)计算批处理文件的读取偏移,LF-only 会把读取位置落到行中间,把行内中文当成命令执行 | 双击启动即报 `'一键启动' is not recognized…`;干净检出后必然复发 |
| 2 | 任务「继续/恢复」可能 500 | `runner.py` 同步分支登记的是 `asyncio.Task` **类**而非实例,`is_job_active()` 调用 `task.done()` 抛 `TypeError` | FastAPI 同步路由(生成/抽取/恢复)走该分支,恢复接口直接报错 |
| 3 | 任务句柄僵尸与竞态 | 句柄在后台线程启动**之后**才登记,线程极快结束时 `finally` 先 pop,留下永不清理的条目 | 后续提交被判为「任务仍在运行」而静默跳过 |
| 4 | Toast 吞掉右下角主按钮点击 | Toast 卡片整体 `pointer-events-auto`,固定定位在右下角 | 提示出现时「下一步」等主按钮点不动,端到端主流程因此超时 |
| 5 | `npm run lint` 失败 | `frontend/src/public/` 三处 ESLint 报错 | 前端验证门禁不通过 |
| 6 | 端到端断言与新版 UI 不同步 | UI 改造把徽标文案改为「测试模式 · Mock AI」,断言仍写旧文案 | e2e 首条用例即失败 |
| 7 | 全新环境无法跑端到端测试 | 未安装 Playwright 浏览器,且 README/setup.ps1 均未说明 | `npm run e2e` 报 `Executable doesn't exist` |
| 8 | 测试收尾与后台线程竞态 | 夹具在后台任务线程仍在运行时拆除数据库 | 随机出现 `no such table: jobs` 线程告警,存在转为偶发失败的风险 |

另修正:Alembic 缺 `path_separator = os` 产生的弃用告警;新增 `.gitattributes` 锁定 `*.bat`/`*.cmd`/`*.ps1` 为 CRLF,避免缺陷 1 复发。

## 1. 验证环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 11(build 26200)x64 |
| Python | 3.14(经 uv 管理,见 `.python-version`) |
| Node.js | v24.15.0 |
| 浏览器 | Chromium(Playwright 内置) |

**重要声明:全部自动化验证在测试模式(`AI_QUIZ_MOCK_AI=1`)下执行,AI 调用走本地 Mock,不访问任何真实 AI 服务。** 界面在此模式下显示"测试模式"徽标。

## 2. 自动化命令与结果(实际运行)

以下为提交前实际执行的命令与退出码结果:

| # | 命令 | 工作目录 | 结果 |
| --- | --- | --- | --- |
| 1 | `uv run ruff check app tests` | `backend/` | ✅ All checks passed!(0 error) |
| 2 | `uv run mypy app`(strict) | `backend/` | ✅ Success: no issues found in 58 source files |
| 3 | `uv run pytest tests -q` | `backend/` | ✅ **71 passed, 1 skipped**(0 failed) |
| 4 | `npm run lint` | `frontend/` | ✅ 通过(0 error / 0 warning) |
| 5 | `npm run test` | `frontend/` | ✅ **4 passed**(2 个测试文件) |
| 6 | `npm run build` | `frontend/` | ✅ 构建成功,产出 `dist/index.html` 与 assets |
| 7 | `npx playwright test` | `frontend/` | ✅ **4 passed**(25.5s) |

> 端到端测试首次运行前需下载 Playwright 浏览器:`npx playwright install chromium`
> (约 115 MB;`scripts/setup.ps1` 已加入该步骤,README 亦已注明)。

### 2.1 后端自动化测试构成(71 个)

- 单元:解析器确定性切分、加密/损坏/扫描件错误路径、去重传递闭包、二分图匹配、答案位置平衡、结构校验规则、Mock 失败夹具的有界错误注入(`mock_ai_failures.json` 的 429/超时用例)、导出哨兵夹具唯一性(`export_sentinel.json`)、**后台任务执行器三态(同步上下文句柄可用性、重复提交被忽略、旧执行收尾不误删新句柄)**
- 集成:上传与解析 API、SSE 事件流与 Last-Event-ID 续传、AI 配置(keyring 内存降级)、能力探测、Consent 指纹失效、考点抽取与幂等恢复、生成全流程(含导出双 Word)、A/B/C/D 平衡、编辑后复核状态重置、驳回破坏导出门槛、补题、空槽位冻结考点手填、试卷删除影响检查(DOCUMENT_IN_USE)、单题重新生成、任务列表过滤与 resume 权限

### 2.2 端到端测试构成(4 个)

1. 主流程:上传 PDF → 创建 AI 配置 → 探测"完全兼容" → 数据发送确认 → 配置 3/2/1 → 抽取考点 → 选择 → 生成 → 复核批量通过 → 导出并断言下载题目版 Word 文件名 → 刷新后恢复到历史并可重新生成 Word
2. 响应式三档(1440 / 768 / 390 宽):无水平滚动、控制台无 error
3. 历史试卷可重新进入复核
4. AI 配置可编辑、撤销授权并删除

Playwright 通过 `webServer` 自动执行"清空 `frontend/e2e-data` → Alembic 迁移 → 启动 FastAPI"(Mock AI、独立数据目录);数据清理放在 webServer 命令链内,与迁移同进程序,保证每次运行从空白状态开始且不受残留文件句柄影响。修复 Toast 点击拦截后,主流程用例耗时由「180 秒超时」降到 **14 秒**并稳定通过。

### 2.3 启动脚本实测

`scripts/start.ps1`:端口占用检测(只提示不杀进程)→ 迁移(输出静默,失败时打印真实原因)→ 启动 uvicorn(127.0.0.1:8000)→ 轮询 `/api/health` 成功 → 打开浏览器;`Ctrl+C` 终止子进程。实测:`GET /api/health` 返回 `{"status":"ok","app":"AI出题精灵","version":"1.1.0","database":"ok"}`,同源访问 `/` 返回前端页面(HTTP 200)。

`start.bat` 为命令行入口,本轮重写为:CRLF 换行(必须)、纯 ASCII 控制流(避免任何控制台代码页下的乱码)、PowerShell 主机自动探测(`powershell.exe` → `pwsh.exe` → `%SystemRoot%\System32\WindowsPowerShell\v1.0`)、脚本缺失检查、退出码透传。实测双击等价命令 `cmd /c start.bat`:控制台无 `'xxx' is not recognized` 类解析错误,`/api/health` 与 `/` 均正常。

## 3. 里程碑通过条件核对

| 里程碑 | 通过条件 | 证据 |
| --- | --- | --- |
| M0 脚手架 | 锁定依赖、健康检查、迁移、启动脚本 | 上表 1–3 + §2.3 |
| M1 文档与出处 | 上传→解析→SourceBlock 定位(PDF 页码 / DOCX 标题路径+段落序号)、SSE | 解析/文档集成测试 + e2e 步骤 1 |
| M2 AI 配置与考点 | keyring 存取、探测降级矩阵、Consent 指纹、抽取去重 | profiles/extraction 集成测试 |
| M3 题目生成质控 | 固定槽位、种子复现、有界重试、程序校验、并发隔离 | generation 单元+集成测试 |
| M4 复核与导出 | 编辑/通过/驳回/补题、导出门槛、双 Word 校验(题目版无答案字样) | review/export 测试 + e2e 导出下载 |
| M5 全套验证 | 四类验证全绿、报告 | 本报告 §2 |

## 4. 安全与数据边界抽查

- API Key:仅存 Windows Credential Manager(keyring);keyring 不可用时降级进程内存并在界面提示。代码、SQLite、日志、前端持久化均无密钥(测试覆盖 credentials 降级路径)
- 发送确认(Consent):按 `(api_mode, base_url, model)` 规范化指纹;任一变更即失效,需重新确认(测试覆盖)
- 删除:文档/试卷删除均需 deletion-impact 预检 + 一次性 token(5 分钟 TTL + impact_hash),二次确认由界面触发(测试覆盖)
- 数据目录:上传、解析块、考点、题目、导出文件只写入项目 `data/`;服务只绑定 127.0.0.1
- 导出校验(规格 15.5):用 python-docx 重新打开两份 Word 并抽取全部 `w:t` 文本;断言题目版不含「答案 / 解析 / 出处」标签,答案版四个答案侧字段(答案 / 解析 / 出处 / 原文)各不少于题数,题号齐全、含中文、全文不含任何内部校验标记 `SENTINEL-`。sentinel 只存在于导出夹具 `export_sentinel.json`,不写入正式模板——模板此前会把 sentinel 直接渲染进用户拿到的 Word,已移除(实现于 `backend/app/services/export/service.py` 与模板生成器)
- 日志:记录任务 ID 与阶段计数,不含密钥或完整文档内容

## 5. 性能基准(规格 21.5,实测)

### 5.1 基准机器环境

| 项 | 值 |
| --- | --- |
| CPU | Intel Core Ultra 7 155H(16 核 22 线程) |
| 内存 | 32 GB(33,779,150,848 字节) |
| 磁盘 | SSD Device 1TB(1,024,203,640,320 字节) |
| 操作系统 | Windows 11(build 26200)x64 |
| 运行形态 | 后端进程内(TestClient),Mock AI,SQLite WAL |

### 5.2 基准结果(2026-11-07 重跑)

| # | 基准项(规格 21.5) | 阈值 | 实测 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 20 页文字 PDF 本地解析(上传 → ParseJob 完成,含 SourceBlock 落库) | < 5 秒 | **0.27 秒** | ✅ PASS |
| 2 | 20 题双 Word 导出(生成 + 15.5 哨兵校验 + 文件落库) | < 3 秒 | **0.38 秒** | ✅ PASS |
| 3 | 1000 条历史列表首屏(`GET /api/quiz-records?page=1&page_size=20`) | < 1 秒 | **21 毫秒** | ✅ PASS |

基准 1 使用 `backend/tests/fixtures/bench_20p.pdf`(reportlab 生成的 20 页 × 14 段中文文字 PDF,34 KB);基准 3 先以 SQL 批量插入 1000 条 `quiz_records`(status=ready),再计时首屏查询并断言 `total ≥ 1000` 且返回 20 条。

执行方式(不进入常规测试,需显式触发):

```bash
cd backend && AI_QUIZ_BENCH=1 AI_QUIZ_MOCK_AI=1 \
    uv run pytest tests/integration/test_benchmarks.py -s -q
```

### 5.3 基准过程中发现并修复的并发缺陷

首轮基准暴露出一个多页 PDF 解析必现的死锁缺陷:`ParseJob` 外层会话在单元循环内的 SELECT 触发 SQLAlchemy autoflush,把本单元的 `SourceBlock` INSERT 提前发往 SQLite 并持有未提交写锁,直到循环末尾才提交;而幂等单元写入 `upsert_unit` 使用独立连接写 `job_units`,被该锁阻塞至 busy_timeout(30 秒×20 次重试)后抛出 `database is locked`,任务失败。修复:每个单元完成块写入后立即提交外层会话再调用 `upsert_unit`(`backend/app/services/parse_job.py`)。修复后全量回归通过(ruff / mypy strict / pytest 67 / e2e 3),三项基准数据即来自修复后的版本。该缺陷同时解释了为何大文档解析在修复前会超时失败。

## 6. 已知限制(与规格"明确不做"一致)

1. 不支持 OCR:扫描版 PDF 会被识别并拒绝(`SCANNED_PDF_NOT_SUPPORTED`);加密/损坏文件给出明确错误
2. 单用户单机形态,无鉴权体系;仅本机回环地址可访问
3. 无自动组卷/题库管理;试卷以 QuizRecord 为单位管理
4. 真实 AI 服务的人工验收未包含在本报告中(见 §7)
5. Windows Credential Manager 在某些受限环境下不可用时,API Key 仅驻留进程内存,重启需重新输入(设计内降级)

## 7. 真实 AI 服务人工验收(占位说明)

规格要求对真实 OpenAI 兼容端点进行人工验收。本次交付环境无法访问外部付费 AI 服务,该项留待部署方执行,建议步骤:

1. `start.bat` 启动应用,进入"AI 配置"
2. 录入真实 base_url / model / API Key,点击"测试连接",确认能力矩阵与兼容判定
3. "查看并确认发送范围"完成 Consent
4. 用一份小体积文字版 PDF 走完八步流程,重点观察:考点与原文一致性、出处定位准确性、失败修复提示、导出 Word 内容完整

## 8. 结论

四类验证(后端、前端、浏览器端、Word 导出)对应的自动化命令全部退出码 0;性能基准三项均在阈值内;规格中"明确不做"之外的功能范围已实现并有测试证据。本轮另修复 8 个缺陷(含 `start.bat` 无法启动),并新增 `.gitattributes` 与 3 条回归测试防止同类问题复发。产品达到可交付状态。
