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

const TERMINAL = ["completed", "partial", "failed", "cancelled", "interrupted"];
const STATUS_LABELS: Record<string, string> = {
  queued: "等待开始", running: "生成中", completed: "✓ 已完成", partial: "▲ 部分完成",
  failed: "✕ 失败", cancelled: "已取消", interrupted: "已中断",
};

export function GeneratePage() {
  const {
    selectedDocumentIds, activeProfileId, consentId, questionConfig, points,
    setQuizRecordId, refreshQuiz, goto, refreshJobs, generationJobId, setGenerationJobId, showReview,
  } = useWorkflow();
  const { push } = useToast();
  const [job, setJob] = useState<JobDto | null>(null);
  const [starting, setStarting] = useState(false);
  const { connected, events } = useJobEvents(generationJobId);

  const selectedPoints = points.filter((p) => p.selected).map((p) => p.id);
  const total =
    questionConfig.single_choice + questionConfig.true_false + questionConfig.fill_blank;

  useEffect(() => {
    if (!generationJobId || (job && TERMINAL.includes(job.status))) return;
    const timer = window.setInterval(() => {
      api.getJob(generationJobId)
        .then(async (nextJob) => {
          setJob(nextJob);
          if (TERMINAL.includes(nextJob.status)) {
            void refreshJobs();
            if (nextJob.quiz_record_id) {
              setQuizRecordId(nextJob.quiz_record_id);
              await refreshQuiz(nextJob.quiz_record_id);
            }
            if (nextJob.status === "completed") {
              push({ tone: "success", message: "题目生成完成,已刷新复核结果" });
            }
            if (nextJob.status === "partial") {
              push({ tone: "warning", message: "部分槽位未完成,可继续补题或手动填写" });
            }
            if ((nextJob.status === "completed" || nextJob.status === "partial") && nextJob.quiz_record_id) {
              setGenerationJobId(null);
              showReview(nextJob.quiz_record_id);
            }
          }
        })
        .catch(() => undefined);
    }, 800);
    return () => clearInterval(timer);
  }, [generationJobId, job, setQuizRecordId, refreshQuiz, refreshJobs, push, setGenerationJobId, showReview]);

  const latest = events[events.length - 1];
  const terminal = job ? TERMINAL.includes(job.status) : false;
  const progressTotal = job?.total || latest?.total || total;
  const readyCount = job?.current ?? latest?.current ?? 0;
  const failedCount = events.filter((e) => e.message?.includes("未生成成功")).length;
  const missingCount = Math.max(0, progressTotal - readyCount - failedCount);
  const percent = progressTotal ? Math.round((readyCount / progressTotal) * 100) : 0;

  async function start() {
    if (!activeProfileId || !consentId || !selectedDocumentIds.length) return;
    setStarting(true);
    try {
      const result = await api.createGenerationJob({
        document_ids: selectedDocumentIds,
        selected_point_ids: selectedPoints,
        ai_profile_id: activeProfileId,
        consent_id: consentId,
        question_config: questionConfig,
      });
      setJob(null);
      setGenerationJobId(result.job_id);
      setQuizRecordId(result.quiz_record_id);
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "创建任务失败",
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="space-y-8" aria-labelledby="generate-title">
      <PageHeader
        step={6}
        kicker="生成题目"
        title="生成题目"
        description={`程序先建立 ${total} 个固定槽位并把考点一对一分配；每题最多 5 次调用预算，失败自动换考点补位。生成结果会立即进入人工复核。`}
        aside={
          <div className="ui-folio">
            <Stat label="目标题数" value={total} unit="题" tone="accent" />
            <span className="h-8 w-px bg-[var(--color-rule)]" aria-hidden="true" />
            <Stat label="已选考点" value={selectedPoints.length} unit="个" />
          </div>
        }
      />

      {!generationJobId && (
        <Card className="reveal relative overflow-hidden" style={{ ["--i" as string]: 1 }}>
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 flex-1">
              <SectionHeading
                index="GENERATION"
                title="生成计划"
                description="开始后可以随时取消；每题成功后即持久化，中断后可从已保存的槽位继续。"
              />
              <div className="mt-4 grid max-w-md grid-cols-3 gap-px border border-[var(--color-rule)] bg-[var(--color-rule)]">
                {[
                  { label: "单选题", value: questionConfig.single_choice },
                  { label: "判断题", value: questionConfig.true_false },
                  { label: "填空题", value: questionConfig.fill_blank },
                ].map((item) => (
                  <div key={item.label} className="bg-[var(--color-paper-2)] px-3 py-3">
                    <Stat label={item.label} value={item.value} unit="题" />
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Badge tone={selectedPoints.length >= total ? "success" : "warning"}>
                  已选考点 {selectedPoints.length}
                </Badge>
                <span className="text-[length:var(--text-xs)] text-[var(--color-muted)]">
                  建议 ≥ {Math.ceil(total * 1.25)}，给补位留余量
                </span>
              </div>
              <div className="mt-5">
                <Button
                  loading={starting}
                  disabled={selectedPoints.length < total}
                  onClick={() => void start()}
                >
                  <Icon name="wand" size={16} />
                  开始生成 {total} 题
                </Button>
              </div>
              {selectedPoints.length < total && (
                <p className="mt-2 flex items-center gap-1.5 text-[length:var(--text-sm)] text-[var(--color-warning)]">
                  <Icon name="alert" size={14} />
                  所选考点不足，请返回“选择考点”增选。
                </p>
              )}
            </div>
            <div className="relative hidden shrink-0 lg:block">
              <div className="stamp size-40">
                <span className="font-[family-name:var(--font-display)] text-5xl font-medium leading-none tracking-[-0.04em] text-[var(--color-accent)]">
                  {total}
                </span>
                <span className="mt-2.5 font-[family-name:var(--font-outlier)] text-[9px] tracking-[0.22em] text-[var(--color-muted)]">
                  QUESTIONS
                </span>
              </div>
              <span
                aria-hidden="true"
                className="absolute inset-[-9px] rounded-full border border-dashed border-[var(--color-rule)]"
              />
            </div>
          </div>
        </Card>
      )}

      {generationJobId && (
        <Card className="reveal relative overflow-hidden" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="eyebrow">GENERATION</p>
              <h3 className="mt-1.5 font-[family-name:var(--font-display)] text-lg font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                生成进度
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
            <p className="font-[family-name:var(--font-display)] text-[clamp(2.4rem,6vw,3.5rem)] font-medium leading-none tracking-[-0.05em] text-[var(--color-accent)]">
              {percent}
              <span className="ml-1.5 font-[family-name:var(--font-body)] text-lg font-normal text-[var(--color-muted)]">%</span>
            </p>
            <p className="pb-1 text-right text-[length:var(--text-sm)] text-[var(--color-neutral)]">
              <span className="font-[family-name:var(--font-outlier)] text-[var(--color-ink)]">{readyCount}</span>
              <span className="text-[var(--color-muted)]"> / {progressTotal || "?"} 题</span>
            </p>
          </div>
          <div className="mt-3">
            <Progress value={percent} label="生成进度" running={!terminal} />
          </div>

          <div className="mt-5 grid gap-px border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-3">
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat label="已完成" value={readyCount} unit="题" tone="success" />
            </div>
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat label="失败" value={failedCount} unit="题" tone={failedCount ? "danger" : "neutral"} />
            </div>
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat label="缺失" value={missingCount} unit="题" tone="neutral" />
            </div>
          </div>

          {latest?.message && (
            <div className="mt-4 flex items-start gap-2 border-l-2 border-[var(--color-accent)] pl-3 text-[length:var(--text-sm)] text-[var(--color-neutral)]">
              <Icon name="activity" size={15} className="mt-1 shrink-0 text-[var(--color-accent)]" />
              {latest.message}
            </div>
          )}
          <Notice tone="info" className="mt-4">
            已保存进度：{isPublicMode ? "浏览器" : "后端"}每题提交成功后即持久化，刷新或中断可恢复。
          </Notice>
          <div className="mt-5 flex flex-wrap gap-2 border-t border-[var(--color-rule-strong)] pt-4">
            {!terminal ? (
              <Button variant="danger" onClick={() => void api.cancelJob(generationJobId).catch(() => undefined)}>
                取消任务
              </Button>
            ) : (
              <Button onClick={() => goto(6)}>
                进入人工复核
                <Icon name="arrowRight" size={16} />
              </Button>
            )}
          </div>
        </Card>
      )}
    </section>
  );
}
