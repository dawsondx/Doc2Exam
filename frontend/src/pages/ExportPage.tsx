import { useCallback, useEffect, useState } from "react";
import * as api from "../api/endpoints";
import { ApiError } from "../api/client";
import { isPublicMode } from "../demo/mode";
import { useWorkflow } from "../store";
import { useToast } from "../components/ui/toast";
import { Badge, Card } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icons";
import { EmptyState, PageHeader, SectionHeading, Stat } from "../components/ui/layout";
import type { QuizRecordDto } from "../types/api";

export function ExportPage() {
  const { quiz, quizRecordId, setQuizRecordId, refreshQuiz, goto } = useWorkflow();
  const { push } = useToast();
  const [exporting, setExporting] = useState(false);
  const [exportingRecordId, setExportingRecordId] = useState<string | null>(null);
  const [history, setHistory] = useState<QuizRecordDto[]>([]);
  const [batches, setBatches] = useState<Record<string, { batch_id: string; files: { id: string; kind: string; filename: string; download_url: string; is_current: boolean }[]; is_current: boolean }[]>>({});

  const loadHistory = useCallback(async () => {
    const data = await api.listQuizRecords();
    setHistory(data.items);
    const next: typeof batches = {};
    await Promise.all(
      data.items.map(async (record) => {
        try {
          const exports = await api.listExports(record.id);
          if (exports.items.length) next[record.id] = exports.items;
        } catch {
          /* 无导出记录 */
        }
      }),
    );
    setBatches(next);
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function exportNow() {
    if (!quizRecordId) return;
    setExporting(true);
    try {
      await api.createExports(quizRecordId);
      await refreshQuiz(quizRecordId);
      await loadHistory();
      push({ tone: "success", message: "题目版与答案版 Word 已生成" });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "导出失败",
      });
    } finally {
      setExporting(false);
    }
  }

  async function removeQuiz(id: string) {
    try {
      const impact = await api.quizDeletionImpact(id);
      const detail = Object.entries(impact.counts)
        .map(([key, value]) => `${value} ${key}`)
        .join("、");
      if (!window.confirm(`将删除该试卷及其 ${detail},不可恢复。确认删除?`)) return;
      await api.deleteQuizRecord(id, impact.deletion_token);
      await loadHistory();
      push({ tone: "success", message: "试卷及关联数据已删除" });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "删除失败",
      });
    }
  }

  async function openQuiz(id: string) {
    setQuizRecordId(id);
    await refreshQuiz(id);
    goto(6);
  }

  async function exportRecord(id: string) {
    setExportingRecordId(id);
    try {
      await api.createExports(id);
      if (quizRecordId === id) await refreshQuiz(id);
      await loadHistory();
      push({ tone: "success", message: "已重新生成该试卷的题目版与答案版" });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "重新导出失败",
      });
    } finally {
      setExportingRecordId(null);
    }
  }

  const ready = quiz?.progress?.export_ready ?? false;
  const target = quiz?.progress?.target ?? 0;
  const approved = quiz?.progress?.approved ?? 0;

  return (
    <section className="space-y-8" aria-labelledby="export-title">
      <PageHeader
        step={8}
        kicker="导出与历史"
        title="导出与历史"
        description={
          isPublicMode
            ? "达到配置题数且全部题目通过校验与人工复核后，在浏览器中生成题目版和答案版 Word。试卷与导出记录只保存在当前浏览器，可随时重新生成。"
            : "达到配置题数且全部题目通过校验与人工复核后，一次生成题目版和答案版 Word。每次导出都会保留批次记录，可随时重新生成。"
        }
        aside={
          <div className="ui-folio">
            <Stat label="历史记录" value={history.length} unit="份" />
            <span className="h-8 w-px bg-[var(--color-rule)]" aria-hidden="true" />
            <Stat
              label="当前试卷"
              value={ready ? "可导出" : "未就绪"}
              tone={ready ? "success" : "warning"}
            />
          </div>
        }
      />

      <Card className="reveal relative overflow-hidden" style={{ ["--i" as string]: 1 }}>
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">EXPORT</p>
            <h3 className="mt-1.5 font-[family-name:var(--font-display)] text-xl font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
              当前试卷
            </h3>
            {!ready ? (
              <>
                <p className="mt-2 flex items-center gap-1.5 text-[length:var(--text-sm)] text-[var(--color-warning)]">
                  <Icon name="alert" size={15} />
                  ▲ 还缺 {quiz?.progress?.missing ?? "?"} 题，导出门槛未满足。
                </p>
                <div className="mt-4">
                  <Button variant="secondary" onClick={() => goto(6)}>返回复核</Button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-2 text-[length:var(--text-sm)] leading-6 text-[var(--color-neutral)]">
                  {approved} 题已通过复核，可以导出。导出后仍可返回复核并重新生成。
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">目标 {target} 题</Badge>
                  <Badge tone="success">已通过 {approved} 题</Badge>
                  <Badge tone="accent">两种版本</Badge>
                </div>
                <div className="mt-5">
                  <Button loading={exporting} onClick={() => void exportNow()}>
                    <Icon name="download" size={16} />
                    导出 Word(题目版 + 答案版)
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="grid w-full shrink-0 grid-cols-2 gap-3 lg:w-[22rem]">
            {[
              { label: "题目版", hint: "供学员作答", icon: "file" as const, tone: "text-[var(--color-accent)]" },
              { label: "答案版", hint: "含答案与解析", icon: "clipboardCheck" as const, tone: "text-[var(--color-accent-2)]" },
            ].map((file) => (
              <div
                key={file.label}
                className={
                  "border p-3.5 transition-opacity " +
                  (ready ? "border-[var(--color-rule)] bg-[var(--color-paper-2)]/50 opacity-100" : "border-[var(--color-rule)] opacity-55")
                }
              >
                <span className={"flex size-9 items-center justify-center border border-[var(--color-rule)] bg-[var(--color-paper-hi)] " + file.tone}>
                  <Icon name={file.icon} size={17} />
                </span>
                <p className="mt-3 text-[length:var(--text-sm)] font-medium text-[var(--color-ink)]">{file.label}</p>
                <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">{file.hint}</p>
                <p className="mt-2 font-[family-name:var(--font-outlier)] text-[10px] tracking-[0.1em] text-[var(--color-muted)]">DOCX</p>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="space-y-4">
        <SectionHeading
          index="ARCHIVE"
          title="历史试卷"
          description="每次生成的试卷与导出批次都会保留，可继续复核或重新生成 Word。"
          action={<Badge tone="neutral">共 {history.length} 份</Badge>}
        />
        <ul className="space-y-3" aria-label="历史试卷列表">
          {history.map((record, index) => (
            <li key={record.id} className="reveal" style={{ ["--i" as string]: Math.min(index + 2, 9) }}>
              <Card className="overflow-hidden p-0">
                <div className="p-5">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center border border-[var(--color-rule)] bg-[var(--color-paper-hi)] text-[var(--color-muted)]">
                        <Icon name="files" size={18} />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-[family-name:var(--font-display)] text-[15px] font-semibold text-[var(--color-ink)]">
                            {record.ai_profile_name ?? "未知配置"} · {record.model_name ?? ""}
                          </p>
                          <Badge tone={record.status === "exported" ? "success" : record.status === "ready" ? "accent" : "neutral"}>
                            {record.status === "exported" ? "✓ 已导出" : record.status === "ready" ? "可导出" : "草稿"}
                          </Badge>
                        </div>
                        <p className="mt-1.5 text-[11px] text-[var(--color-muted)]">
                          {record.created_at?.slice(0, 10) ?? ""}
                          <span className="mx-2 opacity-50">·</span>
                          单选 {record.question_config.single_choice ?? 0}
                          <span className="mx-1.5 opacity-50">/</span>
                          判断 {record.question_config.true_false ?? 0}
                          <span className="mx-1.5 opacity-50">/</span>
                          填空 {record.question_config.fill_blank ?? 0}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => void openQuiz(record.id)}>查看 / 继续复核</Button>
                      {(record.status === "ready" || record.status === "exported") && (
                        <Button
                          variant="secondary"
                          loading={exportingRecordId === record.id}
                          onClick={() => void exportRecord(record.id)}
                        >
                          <Icon name="refresh" size={14} />
                          重新生成 Word
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => void removeQuiz(record.id)}>
                        <Icon name="trash" size={14} />
                        删除
                      </Button>
                    </div>
                  </div>

                  {(batches[record.id] ?? []).map((batch) => (
                    <div key={batch.batch_id} className="mt-4 border-t border-[var(--color-rule)] pt-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[10px] tracking-[0.08em] text-[var(--color-muted)]">
                          导出批次 {batch.batch_id.replace(/^batch-/, "#")}
                        </p>
                        {batch.is_current && <Badge tone="accent">当前批次</Badge>}
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {batch.files.map((file) => (
                          <a
                            key={file.id}
                            href={file.download_url}
                            download={file.filename}
                            className={
                              "group flex min-h-14 items-center gap-3 border px-3.5 py-2.5 " +
                              "transition-[border-color,transform,background-color] duration-[var(--dur-short)] " +
                              "ease-[var(--ease-paper)] hover:-translate-y-px " +
                              (file.is_current
                                ? "border-[var(--color-accent)]/35 bg-[var(--color-accent-soft)]/40 hover:border-[var(--color-accent)]"
                                : "border-[var(--color-rule)] bg-[var(--color-paper-2)]/40 hover:border-[var(--color-rule-strong)]")
                            }
                          >
                            <span
                              className={
                                "flex size-9 shrink-0 items-center justify-center border " +
                                (file.is_current
                                  ? "border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                                  : "border-[var(--color-rule)] bg-[var(--color-paper-hi)] text-[var(--color-muted)]")
                              }
                            >
                              <Icon name="download" size={16} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[length:var(--text-sm)] text-[var(--color-ink)] group-hover:text-[var(--color-accent)]">
                                {file.filename}
                              </span>
                              <span className="mt-0.5 block text-[10px] text-[var(--color-muted)]">
                                {file.kind === "student" ? "题目版" : "答案版"} · DOCX
                                {!file.is_current ? " · 历史批次" : ""}
                              </span>
                            </span>
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ul>
        {history.length === 0 && (
          <EmptyState
            icon="package"
            title="还没有历史试卷"
            description="完成一次导出后，试卷和 Word 批次会保存在这里，可随时继续复核或重新生成。"
          />
        )}
      </div>
    </section>
  );
}
