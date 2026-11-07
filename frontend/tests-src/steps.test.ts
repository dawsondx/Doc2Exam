import { describe, expect, it } from "vitest";
import { STEPS } from "../src/store";

describe("流程定义", () => {
  it("八步流程按规格顺序排列", () => {
    expect(STEPS.map((s) => s.label)).toEqual([
      "上传文档", "AI 配置", "配置题目", "抽取考点",
      "选择考点", "生成题目", "人工复核", "导出与历史",
    ]);
  });

  it("步骤键唯一", () => {
    const keys = STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
