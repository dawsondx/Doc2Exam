import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const e2eData = path.join(rootDir, "e2e-data");

// 本机可能配置了全局 HTTP 代理；端到端服务始终直连回环地址。
const loopbackHosts = "127.0.0.1,localhost";
process.env.NO_PROXY = [process.env.NO_PROXY, loopbackHosts].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, loopbackHosts].filter(Boolean).join(",");

export default defineConfig({
  testDir: "./tests-e2e",
  timeout: 180_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8000",
    trace: "off",
  },
  webServer: {
    // 清空测试数据 → 迁移 → 启动。清理放在 webServer 命令内(与 alembic/uvicorn
    // 同一进程链),避免跨进程文件句柄竞争导致目录删除静默失败。
    command:
      "node -e \"require('fs').rmSync('e2e-data',{recursive:true,force:true})\" && " +
      "uv run --project ../backend alembic -c ../backend/alembic.ini upgrade head && " +
      "uv run --project ../backend uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port 8000",
    url: "http://127.0.0.1:8000/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      AI_QUIZ_MOCK_AI: "1",
      AI_QUIZ_DATA_DIR: e2eData,
    },
  },
});
