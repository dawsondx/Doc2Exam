import { useEffect, useState } from "react";
import * as api from "../api/endpoints";
import { ApiError } from "../api/client";
import { isPublicMode } from "../demo/mode";
import { useWorkflow } from "../store";
import { useToast } from "../components/ui/toast";
import { Badge, Card, Progress } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icons";
import { Notice, PageHeader, SectionHeading, Stat } from "../components/ui/layout";
import { useJobEvents } from "../hooks/useJobEvents";
import type { JobDto } from "../types/api";

const TERMINAL = ["completed", "failed", "cancelled", "partial", "interrupted"];
const STATUS_LABELS: Record<string, string> = {
  queued: "等待开始", running: "抽取中", completed: "✓ 已完成", partial: "▲ 部分完成",
  failed: "✕ 失败", cancelled: "已取消", interrupted: "已中断",
};

const ERROR_HINTS: Record<string, string> = {
  AI_KEY_INVALID: "请返回 AI 配置，检查 Key、账户权限与浏览器直连支持。",
  AI_UPSTREAM_BUSY: "等待约 1 分钟后从断点重试，或检查账户余额。",
  AI_UPSTREAM_FAILED: "稍后从断点重试；若持续失败，请查看服务商状态。",
  AI_NETWORK: "浏览器无法连接服务商，请检查网络、base_url 与跨域设置。",
  AI_TIMEOUT: "服务商响应超时，可重试或减少文档范围。",
  AI_INVALID_RESPONSE: "模型返回格式不符合要求，将从失败的文本块继续。",
  AI_BAD_REQUEST: "服务商拒绝了请求，请检查模型名称与账户额度。",
  AI_ENDPOINT_NOT_FOUND: "接口地址或模型不存在，请检查 base_url 与模型名称。",
};

export function ExtractPage() {
  const {
    selectedDocumentIds, activeProfileId, consentId, questionConfig,
    extractionJobId, setExtractionJobId, refreshPoints, goto, refreshJobs,
  } = useWorkflow();
  const { push } = useToast();
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [jobId, setJobId] = useState<string | null>(extractionJobId);
  const [job, setJob] = useState<JobDto | null>(null);
  const { connected, events } = useJobEvents(jobId);

  useEffect(() => {
    if (!jobId || (job && TERMINAL.includes(job.status))) return;
    const timer = window.setInterval(() => {
      api.getJob(jobId)
        .then((nextJob) => {
          setJob(nextJob);
          if (nextJob.status === "completed") {
            void refreshPoints(nextJob.id);
            push({ tone: "success", message: "考点抽取完成,进入下一步选择考点" });
          }
          if (TERMINAL.includes(nextJob.status)) {
            setExtractionJobId(nextJob.id);
            void refreshJobs();
          }
        })
        .catch(() => undefined);
    }, 800);
    return () => clearInterval(timer);
  }, [jobId, job, refreshPoints, setExtractionJobId, refreshJobs, push]);

  const latest = events[events.length - 1];
  const current = job?.current ?? latest?.current ?? null;
  const total = job?.total ?? latest?.total ?? null;
  const done = job?.status === "completed";
  const terminal = job ? TERMINAL.includes(job.status) : false;
  const failed = job?.status === "failed" || job?.status === "cancelled";

  const targetQuestions =
    questionConfig.single_choice + questionConfig.true_false + questionConfig.fill_blank;
  const candidateTarget = Math.ceil(targetQuestions * 2.5);
  const percent = total ? Math.round(((current ?? 0) / total) * 100) : 0;

  async function start() {
    if (!activeProfileId || !consentId || !selectedDocumentIds.length) return;
    setStarting(true);
    setJob(null);
    try {
      const result = await api.createExtractionJob({
        document_ids: selectedDocumentIds,
        ai_profile_id: activeProfileId,
        consent_id: consentId,
        target_question_count: targetQuestions,
      });
      setJobId(result.job_id);
      setExtractionJobId(result.job_id);
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "创建任务失败",
      });
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!jobId) return;
    await api.cancelJob(jobId).catch(() => undefined);
    push({ tone: "info", message: "已请求取消,已完成部分会保留" });
  }

  async function resume() {
    if (!jobId) return;
    setRetrying(true);
    try {
      await api.resumeJob(jobId);
      setJob(null);
      push({ tone: "info", message: "已从断点继续抽取" });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? error.message : "重试失败,请稍后再试",
      });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className="space-y-8" aria-labelledby="extract-title">
      <PageHeader
        step={4}
        kicker="抽取考点"
        title="抽取考点"
        description="系统将选中文档切分为文本块并请求 AI 提取原子考点。目标候选数按题数的 2.5 倍计算，抽取结果会在下一步供你筛选。"
        aside={
          <div className="ui-folio">
            <Stat label="候选目标" value={candidateTarget} unit="个" tone="accent" />
            <span className="h-8 w-px bg-[var(--color-rule)]" aria-hidden="true" />
            <Stat label="目标题数" value={targetQuestions} unit="题" />
          </div>
        }
      />

      {!jobId && (
        <Card className="reveal" style={{ ["--i" as string]: 1 }}>
          <SectionHeading
            index="READY"
            title="抽取准备"
            description="确认以下范围后开始。抽取过程只发送文本块与考点约束，不发送原始文件。"
          />
          <div className="mt-4 grid gap-px border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-3">
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat label="文档" value={selectedDocumentIds.length} unit="份" />
            </div>
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat label="目标题数" value={targetQuestions} unit="题" />
            </div>
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat label="候选目标" value={candidateTarget} unit="个" tone="accent" />
            </div>
          </div>
          <Notice tone="info" className="mt-4">
            将对 {selectedDocumentIds.length} 个文档抽取考点，用于生成 {targetQuestions} 道题。任务可随时取消，已完成部分会保留。
          </Notice>
          <div className="mt-5">
            <Button loading={starting} onClick={() => void start()}>
              <Icon name="scan" size={16} />
              开始抽取考点
            </Button>
          </div>
        </Card>
      )}

      {jobId && (
        <Card className="reveal relative overflow-hidden" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">EXTRACTION</p>
              <h3 className="mt-1.5 font-[family-name:var(--font-display)] text-lg font-bold tracking-[-0.02em] text-[var(--color-ink)]">
                任务进度
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!terminal && (
                <Badge tone={connected ? "success" : "warning"}>
                  {isPublicMode ? "✓ 进度自动刷新" : connected ? "✓ 实时连接" : "… 正在恢复连接"}
                </Badge>
              )}
              {job && (
                <Badge tone={job.status === "completed" ? "success" : job.status === "failed" ? "danger" : "neutral"}>
                  {STATUS_LABELS[job.status] ?? job.status}
                </Badge>
              )}
            </div>
          </div>

          <div className="mt-6 flex items-end justify-between gap-4">
            <p className="font-[family-name:var(--font-outlier)] text-[clamp(2.4rem,6vw,3.5rem)] leading-none tracking-[-0.04em] text-[var(--color-accent)]">
              {percent}
              <span className="ml-1 text-lg text-[var(--color-muted)]">%</span>
            </p>
            <p className="pb-1 text-right text-[length:var(--text-sm)] text-[var(--color-neutral)]">
              <span className="font-[family-name:var(--font-outlier)] text-[var(--color-ink)]">
                {current ?? 0}
              </span>
              <span className="text-[var(--color-muted)]"> / {total ?? "?"} 组</span>
            </p>
          </div>
          <div className="mt-3">
            <Progress value={percent} label="抽取进度" running={!terminal} />
          </div>

          <div className="mt-5 grid gap-2 border-y border-[var(--color-rule)] py-3 sm:grid-cols-3">
            {[
              { label: "切分文本块", icon: "layers" as const },
              { label: "提取原子考点", icon: "scan" as const },
              { label: "校验与去重", icon: "listChecks" as const },
            ].map((stage, index) => (
              <div key={stage.label} className="flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-neutral)]">
                <span
                  className={
                    "flex size-6 shrink-0 items-center justify-center border " +
                    (done
                      ? "border-[var(--color-success)]/40 bg-[#e9eee2] text-[var(--color-success)]"
                      : "border-[var(--color-rule)] text-[var(--color-muted)]")
                  }
                >
                  {done ? <Icon name="check" size={12} /> : <span className="font-[family-name:var(--font-outlier)] text-[10px]">{index + 1}</span>}
                </span>
                {stage.label}
              </div>
            ))}
          </div>

          {latest?.message && (
            <div className="mt-4 flex items-start gap-2 border-l-2 border-[var(--color-accent)] pl-3 text-[length:var(--text-sm)] text-[var(--color-neutral)]">
              <Icon name="activity" size={15} className="mt-1 shrink-0 text-[var(--color-accent)]" />
              {latest.message}
            </div>
          )}
          {failed && (
            <Notice
              tone="danger"
              className="mt-4"
              title={job?.status === "cancelled" ? "任务已取消" : "抽取未完成"}
            >
              <p>
                {job?.status === "cancelled"
                  ? `已保留前 ${current ?? 0} 组候选。`
                  : `已保留前 ${current ?? 0} 组候选，可从断点继续。`}
              </p>
              {job?.error && (
                <p className="mt-1">
                  原因：{job.error.message}
                  <span className="ml-1.5 font-[family-name:var(--font-outlier)] text-[10px] tracking-[0.08em] text-[var(--color-muted)]">
                    {job.error.code}
                  </span>
                </p>
              )}
              {job?.error && ERROR_HINTS[job.error.code] && (
                <p className="mt-1 text-[var(--color-muted)]">{ERROR_HINTS[job.error.code]}</p>
              )}
            </Notice>
          )}
          <div className="mt-5 flex flex-wrap gap-2 border-t border-[var(--color-rule-strong)] pt-4">
            {!terminal && (
              <Button variant="danger" onClick={() => void cancel()}>取消任务</Button>
            )}
            {job?.status === "failed" && job.job_type === "extraction" && (
              <Button loading={retrying} onClick={() => void resume()}>
                <Icon name="refresh" size={16} />
                从断点重试
              </Button>
            )}
            {job?.status === "interrupted" && (
              <Button onClick={() => void api.resumeJob(jobId).catch(() => undefined)}>
                继续任务
              </Button>
            )}
            {done && (
              <Button onClick={() => goto(4)}>
                下一步:选择考点
                <Icon name="arrowRight" size={16} />
              </Button>
            )}
          </div>
        </Card>
      )}
    </section>
  );
}
