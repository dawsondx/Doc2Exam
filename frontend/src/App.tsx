import { useEffect, useState, type ReactNode } from "react";
import { AppShell } from "./components/AppShell";
import { ToastProvider } from "./components/ui/toast";
import { isDemoMode, isPublicMode } from "./demo/mode";
import { Icon } from "./components/ui/icons";
import { WorkflowProvider, useWorkflow } from "./store";
import { UploadPage } from "./pages/UploadPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ConfigPage } from "./pages/ConfigPage";
import { ExtractPage } from "./pages/ExtractPage";
import { PointsPage } from "./pages/PointsPage";
import { GeneratePage } from "./pages/GeneratePage";
import { ReviewPage } from "./pages/ReviewPage";
import { ExportPage } from "./pages/ExportPage";

function Pages() {
  const { step } = useWorkflow();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);
  switch (step) {
    case 0:
      return <UploadPage />;
    case 1:
      return <ProfilePage />;
    case 2:
      return <ConfigPage />;
    case 3:
      return <ExtractPage />;
    case 4:
      return <PointsPage />;
    case 5:
      return <GeneratePage />;
    case 6:
      return <ReviewPage />;
    default:
      return <ExportPage />;
  }
}

function SlimNotice({
  title,
  children,
  onDismiss,
  dismissLabel,
}: {
  title: string;
  children: ReactNode;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  return (
    <div className="mb-6 flex items-start gap-2.5 border-y border-[var(--color-rule)] bg-[#f8f2e7]/70 px-3 py-2.5 sm:gap-4">
      <Icon name="sparkles" size={13} className="mt-1 shrink-0 text-[var(--color-accent)] sm:mt-0" />
      <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
        <p className="font-[family-name:var(--font-display)] text-[12px] font-semibold text-[var(--color-ink)] sm:shrink-0 sm:text-[13px]">
          {title}
        </p>
        <p className="mt-0.5 text-[11px] leading-5 text-[var(--color-neutral)] sm:mt-0">{children}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-[var(--color-muted)] transition-colors hover:text-[var(--color-ink)]"
        aria-label={dismissLabel}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function DemoNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (!isDemoMode || dismissed) return null;
  return (
    <SlimNotice
      title="交互演示 · 内置示例数据"
      onDismiss={() => setDismissed(true)}
      dismissLabel="关闭演示说明"
    >
      可以从上传一路走到导出，体验完整的 8 步流程。所有数据只存在于当前浏览器，刷新后重置；真实文档解析、AI 调用与 Word 导出请在桌面版中使用。
    </SlimNotice>
  );
}

function PublicNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (!isPublicMode || dismissed) return null;
  return (
    <SlimNotice
      title="公共体验 · 自带 Key，浏览器直连"
      onDismiss={() => setDismissed(true)}
      dismissLabel="关闭公共体验说明"
    >
      请在「AI 配置」填入你自己的 API Key；Key 与文档只保存在当前浏览器，任务文本块会直接发送给你选择的服务商，费用由你的账户结算。
    </SlimNotice>
  );
}

function InterruptedBanner() {
  const { activeJobs, refreshJobs } = useWorkflow();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void refreshJobs();
  }, [refreshJobs]);

  if (!activeJobs.some((j) => j.status === "interrupted")) return null;
  return (
    <div className="mb-6 border-l-2 border-[var(--color-warning)] bg-[#f7f0e1] px-4 py-3 text-[length:var(--text-sm)]">
      <p className="flex items-center gap-2 text-[var(--color-warning)]">
        <Icon name="alert" size={16} />
        有 {activeJobs.filter((j) => j.status === "interrupted").length} 个任务上次被程序退出中断，已完成部分已保存。
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {activeJobs
          .filter((j) => j.status === "interrupted")
          .map((job) => (
            <button
              key={job.id}
              type="button"
              disabled={busy === job.id}
              onClick={async () => {
                setBusy(job.id);
                try {
                  const response = await fetch(`/api/jobs/${job.id}/resume`, { method: "POST" });
                  if (!response.ok) throw new Error();
                  await refreshJobs();
                } catch {
                  /* 中断的 AI 任务可能需要重新确认,进入对应页面处理 */
                } finally {
                  setBusy(null);
                }
              }}
              className="min-h-9 border border-[var(--color-rule-strong)] bg-[var(--color-paper-hi)] px-3 text-[length:var(--text-xs)] text-[var(--color-warning)] transition-colors hover:border-[var(--color-warning)]"
            >
              继续任务（{job.job_type === "parse" ? "解析" : job.job_type === "extraction" ? "抽取" : "生成"}）
            </button>
          ))}
      </div>
    </div>
  );
}

function WorkflowStage() {
  const { step } = useWorkflow();
  return (
    <div key={step} className="stage-enter">
      <Pages />
    </div>
  );
}

export default function App() {
  const [mockMode, setMockMode] = useState(false);
  useEffect(() => {
    fetch("/api/health")
      .then((response) => {
        setMockMode(response.headers.get("X-AI-Quiz-Mock") === "1");
        return response.ok ? response.json() : null;
      })
      .catch(() => undefined);
  }, []);

  return (
    <ToastProvider>
      <WorkflowProvider>
        <AppShell mockMode={mockMode}>
          <DemoNotice />
          <PublicNotice />
          <InterruptedBanner />
          <WorkflowStage />
        </AppShell>
      </WorkflowProvider>
    </ToastProvider>
  );
}
