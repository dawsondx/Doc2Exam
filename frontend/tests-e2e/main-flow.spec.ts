import { expect, test, type ConsoleMessage } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../backend/tests/fixtures",
);

async function collectConsoleErrors(page: import("@playwright/test").Page) {
  const errors: ConsoleMessage[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message);
  });
  page.on("pageerror", (error) => {
    errors.push({ type: () => "error", text: () => String(error) } as ConsoleMessage);
  });
  return errors;
}

async function assertNoHorizontalScroll(page: import("@playwright/test").Page) {
  const delta = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(delta).toBe(0);
}

test.describe("AI出题精灵 主流程(测试模式 Mock AI)", () => {
  test.describe.configure({ mode: "serial" });

  test("上传 → 配置 → 生成 → 复核 → 导出双版本 Word", async ({ page }) => {
    const errors = await collectConsoleErrors(page);
    await page.goto("/");
    await expect(page.getByText("测试模式 · Mock AI")).toBeVisible();

    // 步骤 1:上传
    await expect(page.getByRole("heading", { name: "上传制度文档" })).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await page.getByLabel("拖拽或选择文件上传").click();
    const fileChooser = await chooser;
    await fileChooser.setFiles(path.join(fixtures, "policy_text.pdf"));
    await expect(page.getByText("✓ 解析成功").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("解析预览（前 300 字）")).toBeVisible();
    await page.getByRole("button", { name: "下一步:选择 AI 配置" }).click();

    // 步骤 2:AI 配置(测试模式)
    await expect(page.getByRole("heading", { name: "选择 AI 服务" })).toBeVisible();
    await page.getByRole("button", { name: "创建配置" }).click();
    await page.getByLabel("配置名称").fill("端到端测试配置");
    await page.getByLabel(/base_url/).fill("http://127.0.0.1:9/v1");
    await page.getByLabel("模型").fill("mock-model");
    await page.getByLabel(/API key/).fill("e2e-key");
    await page.getByRole("button", { name: "保存配置" }).click();
    await page.getByRole("button", { name: /测试连接/ }).click();
    await expect(page.getByText("✓ 完全兼容")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /查看并确认发送范围/ }).click();
    await expect(page.getByText("✓ 数据发送范围已确认")).toBeVisible();
    await page.getByRole("button", { name: "下一步:配置题目" }).click();

    // 步骤 3:配置题目(3/2/1 加速端到端)
    await page.getByLabel("单选题数量").fill("3");
    await page.getByLabel("判断题数量").fill("2");
    await page.getByLabel("填空题数量").fill("1");
    await expect(page.getByText("最坏调用上限（预算参考）")).toBeVisible();
    await page.getByRole("button", { name: "下一步:抽取考点" }).click();

    // 步骤 4:抽取考点
    await page.getByRole("button", { name: "开始抽取考点" }).click();
    await expect(page.getByRole("button", { name: "下一步:选择考点" })).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByText("✓ 已完成")).toBeVisible();
    await expect(page.getByText("… 正在恢复连接")).toHaveCount(0);
    await page.getByRole("button", { name: "下一步:选择考点" }).click();

    // 步骤 5:选择考点
    await page.getByRole("button", { name: "全选当前筛选" }).click();
    await expect(page.getByRole("button", { name: /已选择/ })).toBeVisible();
    await page.getByRole("button", { name: "下一步:生成题目" }).click();

    // 步骤 6:生成题目
    await page.getByRole("button", { name: "开始生成 6 题" }).click();
    await expect(page.getByRole("heading", { name: "人工复核" })).toBeVisible({
      timeout: 120_000,
    });

    // 步骤 7:人工复核
    await expect(page.getByRole("heading", { name: "人工复核" })).toBeVisible();
    await expect(page.getByText(/目标 6 题/)).toBeVisible();
    await expect(page.getByRole("button", { name: /待复核/ }).first()).toBeVisible();
    await page.getByRole("button", { name: "编辑" }).first().click();
    await expect(page.getByLabel(/正确答案内容/)).not.toHaveValue("");
    await page.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "重新生成" }).first().click();
    await expect(page.getByRole("heading", { name: "生成题目" })).toBeVisible();
    await expect(page.getByText("生成进度")).toBeVisible();
    await expect(page.getByRole("heading", { name: "人工复核" })).toBeVisible({ timeout: 120_000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "批量通过待复核" }).click();
    await expect(page.getByText(/已通过复核 6/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "下一步:导出" }).click();

    // 步骤 8:导出
    await page.getByRole("button", { name: /导出 Word/ }).click();
    const download1 = page.waitForEvent("download");
    await page.getByRole("link", { name: /题目版/ }).first().click();
    const student = await download1;
    expect(student.suggestedFilename()).toContain("题目版");

    // 答案版也可下载
    const download2 = page.waitForEvent("download");
    await page.getByRole("link", { name: /答案版/ }).first().click();
    await download2;

    // 刷新后直接恢复到历史,不要求重走上传/授权/抽取。
    await page.reload();
    await expect(page.getByRole("heading", { name: "导出与历史" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: /题目版/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "查看 / 继续复核" }).first()).toBeVisible();
    await page.getByRole("button", { name: "重新生成 Word" }).first().click();
    await expect(page.getByText("已重新生成该试卷的题目版与答案版")).toBeVisible();

    // 无控制台 error
    expect(errors.filter((e) => !e.text().includes("favicon"))).toEqual([]);
  });

  test("响应式三档无水平滚动且控制台无 error", async ({ page }) => {
    const errors = await collectConsoleErrors(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "导出与历史" })).toBeVisible({ timeout: 30_000 });

    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      await assertNoHorizontalScroll(page);
    }
    expect(errors.filter((e) => !e.text().includes("favicon"))).toEqual([]);
  });

  test("历史试卷可重新进入复核", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "导出与历史" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "查看 / 继续复核" }).first().click();
    await expect(page.getByRole("heading", { name: "人工复核" })).toBeVisible();
    await expect(page.getByText(/已通过复核 6/)).toBeVisible();
    await assertNoHorizontalScroll(page);
  });

  test("AI 配置可编辑、撤销授权并删除", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "导出与历史" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "AI 配置" }).click();
    await page.getByRole("button", { name: "编辑配置" }).click();
    await page.getByLabel("配置名称").fill("端到端测试配置-已编辑");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByText("测试连接:端到端测试配置-已编辑")).toBeVisible();

    await page.getByRole("button", { name: "撤销数据发送授权" }).click();
    await expect(page.getByRole("button", { name: "查看并确认发送范围" })).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "删除配置" }).click();
    await expect(page.getByText(/还没有 AI 配置/)).toBeVisible();
  });
});
