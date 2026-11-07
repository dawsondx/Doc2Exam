import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { WorkflowProvider } from "../src/store";
import { UploadPage } from "../src/pages/UploadPage";
import { ToastProvider } from "../src/components/ui/toast";
import type { ListEnvelope, DocumentDto } from "../src/types/api";

function mockFetch(responses: Record<string, unknown>) {
  const impl = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    for (const [pattern, data] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return Promise.resolve(
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function envelope(items: DocumentDto[]): ListEnvelope<DocumentDto> {
  return { items, total: items.length, page: 1, page_size: 20 };
}

function doc(overrides: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: "doc-1",
    original_name: "policy.pdf",
    media_type: "pdf",
    size_bytes: 51200,
    page_count: 5,
    block_count: 5,
    parse_status: "ready",
    parse_error: null,
    created_at: "2026-08-23T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkflowProvider + UploadPage", () => {
  it("渲染上传页并显示解析成功的文档", async () => {
    mockFetch({
      "/api/documents": envelope([doc()]),
      "/api/ai-profiles": { items: [], total: 0, page: 1, page_size: 100 },
      "/api/jobs": { items: [], total: 0, page: 1, page_size: 20 },
      "/api/quiz-records": { items: [], total: 0, page: 1, page_size: 20 },
      "/api/health": { status: "ok", app: "AI出题精灵", version: "1.1.0" },
    });

    render(
      <ToastProvider>
        <WorkflowProvider>
          <UploadPage />
        </WorkflowProvider>
      </ToastProvider>,
    );

    expect(await screen.findByRole("heading", { name: "上传制度文档" })).toBeInTheDocument();
    expect(await screen.findByText("policy.pdf")).toBeInTheDocument();
    expect(await screen.findByText("✓ 解析成功")).toBeInTheDocument();
    const next = await screen.findByRole("button", { name: "下一步:选择 AI 配置" });
    expect(next).toBeEnabled();
  });

  it("解析失败的文档显示错误与禁用下一步", async () => {
    mockFetch({
      "/api/documents": envelope([
        doc({ id: "doc-2", original_name: "scan.pdf", parse_status: "failed",
          parse_error: "检测到扫描件,当前版本不支持 OCR。" }),
      ]),
      "/api/ai-profiles": { items: [], total: 0, page: 1, page_size: 100 },
      "/api/jobs": { items: [], total: 0, page: 1, page_size: 20 },
      "/api/quiz-records": { items: [], total: 0, page: 1, page_size: 20 },
      "/api/health": { status: "ok" },
    });

    render(
      <ToastProvider>
        <WorkflowProvider>
          <UploadPage />
        </WorkflowProvider>
      </ToastProvider>,
    );

    expect(await screen.findByText(/扫描件/)).toBeInTheDocument();
    const next = await screen.findByRole("button", { name: "下一步:选择 AI 配置" });
    await waitFor(() => expect(next).toBeDisabled());
  });
});
