import { useEffect, useState } from "react";
import * as api from "../api/endpoints";
import { ApiError } from "../api/client";
import { useWorkflow } from "../store";
import { useToast } from "../components/ui/toast";
import { Badge, Card, Input, Label, Progress, Select, Textarea } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icons";
import { EmptyState, Notice, PageHeader, Segmented } from "../components/ui/layout";
import type { QuestionDto } from "../types/api";

const TYPE_LABELS: Record<string, string> = {
  single_choice: "单选", true_false: "判断", fill_blank: "填空",
};

function stateBadges(question: QuestionDto) {
  return (
    <div className="flex flex-wrap gap-2">
      {question.validation_state === "passed" ? (
        <Badge tone="success">✓ 校验通过</Badge>
      ) : question.validation_state === "failed" ? (
        <Badge tone="danger">✕ 校验未通过</Badge>
      ) : (
        <Badge tone="neutral">… 待生成</Badge>
      )}
      {question.review_state === "approved" && <Badge tone="success">✓ 已通过复核</Badge>}
      {question.review_state === "rejected" && <Badge tone="danger">✕ 已驳回</Badge>}
      {question.review_state === "unreviewed" && question.validation_state === "passed" && (
        <Badge tone="warning">待复核</Badge>
      )}
    </div>
  );
}

function displayedAnswer(question: QuestionDto) {
  if (question.question_type !== "single_choice") return question.answer;
  const index = "ABCD".indexOf(question.answer ?? "");
  const option = index >= 0 ? question.options?.[index] : undefined;
  return option ? `${question.answer}. ${option}` : question.answer;
}

function QuestionCard({ question }: { question: QuestionDto }) {
  const { quizRecordId, consentId, refreshQuiz, goto, setGenerationJobId } = useWorkflow();
  const { push } = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expandedSource, setExpandedSource] = useState(false);
  const [form, setForm] = useState({
    stem: question.stem ?? "",
    explanation: question.explanation ?? "",
    options: question.options ? [...question.options] : ["", "", "", ""],
    answer_content:
      question.question_type === "single_choice"
        ? (question.options?.["ABCD".indexOf(question.answer ?? "A")] ?? "")
        : "",
    answer: question.answer ?? (question.question_type === "true_false" ? "正确" : ""),
    acceptable_answers: (question.acceptable_answers ?? []).join("、"),
    knowledge_point_id: question.knowledge_point_id ?? "",
  });

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      if (quizRecordId) await refreshQuiz(quizRecordId);
      push({ tone: "success", message: success });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "操作失败",
      });
    } finally {
      setBusy(false);
    }
  }

  const issues = question.validation_issues ?? [];

  return (
    <Card className="relative overflow-hidden p-0">
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center border border-[var(--color-rule)] bg-[var(--color-paper-hi)] font-[family-name:var(--font-outlier)] text-[11px] text-[var(--color-muted)]">
              {String(question.slot_number).padStart(2, "0")}
            </span>
            <Badge tone="neutral">{TYPE_LABELS[question.question_type]}</Badge>
            {question.attempt_count > 0 && (
              <span className="text-[11px] text-[var(--color-muted)]">
                调用 {question.attempt_count} 次
              </span>
            )}
          </div>
          {stateBadges(question)}
        </div>

        {!editing && question.stem && (
          <div>
            <p className="mt-4 font-[family-name:var(--font-display)] text-[1.05rem] font-medium leading-7 tracking-[-0.005em] text-[var(--color-ink)] sm:text-[1.12rem]">
              {question.stem}
            </p>
            {question.question_type === "single_choice" && (
              <div className="mt-3 grid gap-1.5">
                {(question.options ?? []).map((option, index) => {
                  const letter = "ABCD"[index];
                  const correct = letter === question.answer;
                  return (
                    <div
                      key={index}
                      className={
                        "flex items-start gap-2.5 border px-3 py-2 text-[length:var(--text-sm)] leading-6 " +
                        (correct
                          ? "border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]/55 text-[var(--color-ink)]"
                          : "border-transparent text-[var(--color-neutral)]")
                      }
                    >
                      <span
                        className={
                          "mt-0.5 flex size-5 shrink-0 items-center justify-center border font-[family-name:var(--font-outlier)] text-[10px] " +
                          (correct
                            ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-ink)]"
                            : "border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-muted)]")
                        }
                      >
                        {letter}
                      </span>
                      <span className="min-w-0 flex-1">{option}</span>
                      {correct && <Icon name="check" size={14} className="mt-1 shrink-0 text-[var(--color-accent)]" />}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-4 grid border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] sm:divide-x sm:divide-[var(--color-rule)]">
              <div className="px-4 py-3">
                <p className="text-[9px] tracking-[0.16em] text-[var(--color-muted)]">答案</p>
                <p className="mt-1.5 font-[family-name:var(--font-outlier)] text-[length:var(--text-sm)] leading-6 text-[var(--color-accent)]">
                  {displayedAnswer(question)}
                  {question.question_type === "fill_blank" && question.acceptable_answers?.length
                    ? `(可接受:${question.acceptable_answers.join("、")})`
                    : ""}
                </p>
              </div>
              <div className="border-t border-[var(--color-rule)] px-4 py-3 sm:border-t-0">
                <p className="text-[9px] tracking-[0.16em] text-[var(--color-muted)]">解析</p>
                <p className="mt-1.5 text-[length:var(--text-sm)] leading-6 text-[var(--color-neutral)]">
                  {question.explanation}
                </p>
              </div>
            </div>
          </div>
        )}

        {!question.stem && !editing && (
          <p className="mt-4 flex items-center gap-2 border-l-2 border-[var(--color-warning)] bg-[#f7f0e1]/70 px-3.5 py-2.5 text-[length:var(--text-sm)] text-[var(--color-warning)]">
            <Icon name="alert" size={15} />
            槽位为空 — 可手动填写、重新生成或继续补题。
          </p>
        )}

        {issues.length > 0 && (
          <ul className="mt-3 space-y-1.5" aria-label="校验问题">
            {issues.map((issue, index) => (
              <li
                key={index}
                className={
                  "flex items-start gap-2 border-l-2 px-3 py-2 text-[length:var(--text-xs)] leading-5 " +
                  (issue.severity === "blocking"
                    ? "border-[var(--color-danger)] bg-[#f7eae5]/60 text-[var(--color-danger)]"
                    : "border-[var(--color-warning)] bg-[#f7f0e1]/60 text-[var(--color-warning)]")
                }
              >
                <Icon name="alert" size={13} className="mt-1 shrink-0" />
                <span className="min-w-0">
                  <span className="font-[family-name:var(--font-outlier)]">{issue.code}</span>
                  <span className="mx-1.5 opacity-50">/</span>
                  {issue.message}
                </span>
              </li>
            ))}
          </ul>
        )}

        {question.source && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setExpandedSource(!expandedSource)}
              aria-expanded={expandedSource}
              className="inline-flex min-h-8 items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-accent)] underline-offset-4 hover:underline"
            >
              <Icon name="book" size={13} />
              出处:{question.source.locator_label ?? "(未知)"} · {expandedSource ? "收起原文" : "展开原文"}
              <Icon
                name="chevronDown"
                size={13}
                className={"transition-transform " + (expandedSource ? "rotate-180" : "")}
              />
            </button>
            {expandedSource && (
              <blockquote className="mt-2 max-h-48 overflow-y-auto border-l-2 border-[var(--color-rule-strong)] bg-[var(--color-paper-2)] p-3.5 text-[length:var(--text-xs)] leading-6 text-[var(--color-neutral)]">
                {question.source.block_text ?? "(原文缺失)"}
              </blockquote>
            )}
          </div>
        )}

        {editing && (
          <div className="mt-4 space-y-3 border-t border-[var(--color-rule)] bg-[var(--color-paper-2)]/55 p-4">
            <div>
              <Label htmlFor={`stem-${question.id}`}>题干</Label>
              <Textarea
                id={`stem-${question.id}`}
                rows={2}
                value={form.stem}
                onChange={(e) => setForm({ ...form, stem: e.target.value })}
              />
            </div>
            {question.question_type === "single_choice" && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {form.options.map((option, index) => (
                    <div key={index}>
                      <Label htmlFor={`opt-${question.id}-${index}`}>选项 {"ABCD"[index]}</Label>
                      <Input
                        id={`opt-${question.id}-${index}`}
                        value={option}
                        onChange={(e) => {
                          const next = [...form.options];
                          next[index] = e.target.value;
                          setForm({ ...form, options: next });
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div>
                  <Label htmlFor={`ans-${question.id}`}>正确答案内容(与某一选项完全一致)</Label>
                  <Input
                    id={`ans-${question.id}`}
                    value={form.answer_content}
                    onChange={(e) => setForm({ ...form, answer_content: e.target.value })}
                  />
                </div>
              </>
            )}
            {question.question_type === "true_false" && (
              <div>
                <Label htmlFor={`ans-${question.id}`}>答案</Label>
                <Select
                  id={`ans-${question.id}`}
                  value={form.answer}
                  onChange={(e) => setForm({ ...form, answer: e.target.value })}
                >
                  <option value="正确">正确</option>
                  <option value="错误">错误</option>
                </Select>
              </div>
            )}
            {question.question_type === "fill_blank" && (
              <>
                <div>
                  <Label htmlFor={`ans-${question.id}`}>答案(须逐字出现在原文)</Label>
                  <Input
                    id={`ans-${question.id}`}
                    value={form.answer}
                    onChange={(e) => setForm({ ...form, answer: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`acc-${question.id}`}>可接受答案(顿号分隔,可选)</Label>
                  <Input
                    id={`acc-${question.id}`}
                    value={form.acceptable_answers}
                    onChange={(e) => setForm({ ...form, acceptable_answers: e.target.value })}
                  />
                </div>
              </>
            )}
            {!question.knowledge_point_id && (
              <p className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-warning)]">
                <Icon name="alert" size={13} />
                空槽位手动填写需先在本页顶部“考点池”选择一个考点。
              </p>
            )}
            <div>
              <Label htmlFor={`exp-${question.id}`}>解析</Label>
              <Textarea
                id={`exp-${question.id}`}
                rows={2}
                value={form.explanation}
                onChange={(e) => setForm({ ...form, explanation: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[var(--color-rule)] bg-[var(--color-paper-2)]/45 px-4 py-3 sm:px-5">
        {editing ? (
          <>
            <Button
              loading={busy}
              onClick={() =>
                void run(async () => {
                  const body: Record<string, unknown> = {
                    stem: form.stem,
                    explanation: form.explanation,
                  };
                  if (question.question_type === "single_choice") {
                    body.options = form.options;
                    body.answer_content =
                      form.answer_content ||
                      form.options["ABCD".indexOf(question.answer ?? "A")] ||
                      "";
                  } else if (question.question_type === "true_false") {
                    body.answer = form.answer;
                  } else {
                    body.answer = form.answer;
                    body.acceptable_answers = form.acceptable_answers
                      .split("、")
                      .map((s) => s.trim())
                      .filter(Boolean);
                  }
                  await api.patchQuestion(question.id, body);
                  setEditing(false);
                }, "已保存并重新校验")
              }
            >
              保存(重新校验)
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>取消</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Icon name="pen" size={14} />
              编辑
            </Button>
            {question.stem && (
              <Button
                variant="secondary"
                loading={busy}
                disabled={!consentId}
                onClick={() => {
                  if (!consentId) return;
                  setBusy(true);
                  void api.regenerateQuestion(question.id, consentId)
                    .then((result) => {
                      setGenerationJobId(result.job_id);
                      push({ tone: "success", message: "已开始重新生成,正在显示实时进度" });
                      goto(5);
                    })
                    .catch((error: unknown) => push({
                      tone: "danger",
                      message: error instanceof ApiError ? `${error.message}(${error.action})` : "重新生成失败",
                    }))
                    .finally(() => setBusy(false));
                }}
              >
                <Icon name="refresh" size={14} />
                重新生成
              </Button>
            )}
            <Button
              variant="secondary"
              loading={busy}
              disabled={question.validation_state !== "passed"}
              onClick={() => void run(() => api.reviewQuestion(question.id, "approve"), "已通过复核")}
            >
              <Icon name="check" size={14} />
              通过
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={question.review_state === "rejected"}
              onClick={() => void run(() => api.reviewQuestion(question.id, "reject"), "已驳回,槽位计为缺失")}
            >
              <Icon name="x" size={14} />
              驳回
            </Button>
            <Button
              variant="ghost"
              loading={busy}
              disabled={!question.stem}
              onClick={() => void run(() => api.deleteQuestion(question.id), "已清空槽位")}
            >
              <Icon name="trash" size={14} />
              删除
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

export function ReviewPage() {
  const { quiz, quizRecordId, refreshQuiz, consentId, goto, setGenerationJobId } = useWorkflow();
  const { push } = useToast();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "issues" | "missing">("all");

  useEffect(() => {
    if (quizRecordId) void refreshQuiz(quizRecordId);
  }, [quizRecordId, refreshQuiz]);

  const questions = quiz?.questions ?? [];
  const progress = quiz?.progress;
  const passed = questions.filter((q) => q.validation_state === "passed" && q.review_state === "unreviewed");
  const visibleQuestions = questions.filter((question) => {
    if (filter === "pending") return question.validation_state === "passed" && question.review_state === "unreviewed";
    if (filter === "approved") return question.review_state === "approved";
    if (filter === "issues") return question.validation_state === "failed" || question.review_state === "rejected";
    if (filter === "missing") return !question.stem;
    return true;
  });

  async function bulkApprove() {
    if (!quizRecordId || !passed.length) return;
    if (!window.confirm(`确认一次通过 ${passed.length} 道已通过校验的题目?`)) return;
    setBulkBusy(true);
    try {
      await api.bulkReview(
        quizRecordId,
        passed.map((q) => q.id),
      );
      await refreshQuiz(quizRecordId);
      push({ tone: "success", message: "批量通过完成" });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "批量通过失败",
      });
    } finally {
      setBulkBusy(false);
    }
  }

  const reviewPercent = progress && progress.target > 0
    ? Math.min(100, (progress.approved / progress.target) * 100)
    : 0;

  return (
    <section className="space-y-6" aria-labelledby="review-title">
      <PageHeader
        step={7}
        kicker="人工复核"
        title="人工复核"
        description="逐题核对题干、选项、答案与解析。通过全部题目并补齐缺失槽位后，才能导出题目版与答案版。"
      />

      {progress && (
        <Card className="reveal" style={{ ["--i" as string]: 1 }}>
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
            <div className="flex items-center gap-4">
              <div className="stamp size-[4.5rem] shrink-0">
                <span className="font-[family-name:var(--font-display)] text-2xl font-medium leading-none text-[var(--color-accent)]">
                  {progress.approved}
                </span>
                <span className="mt-1 font-[family-name:var(--font-outlier)] text-[9px] text-[var(--color-muted)]">/ {progress.target}</span>
              </div>
              <div>
                <p className="flex items-center gap-2 font-[family-name:var(--font-display)] text-lg font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
                  目标 {progress.target} 题
                  {progress.export_ready && <Badge tone="success">可导出</Badge>}
                </p>
                <p className="mt-1.5 text-[length:var(--text-xs)] text-[var(--color-muted)]">
                  已通过复核 {progress.approved} · 待复核 {progress.unreviewed} · 缺失 {progress.missing}
                </p>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between text-[11px] text-[var(--color-muted)]">
                <span>复核完成度</span>
                <span className="font-[family-name:var(--font-outlier)] text-[var(--color-neutral)]">
                  {Math.round(reviewPercent)}%
                </span>
              </div>
              <div className="mt-2">
                <Progress value={reviewPercent} label="复核完成度" />
              </div>
            </div>
          </div>
        </Card>
      )}

      {quiz?.frozen_points && (
        <details
          className="group reveal rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]"
          style={{ ["--i" as string]: 2 }}
        >
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 py-2.5 text-[length:var(--text-sm)] text-[var(--color-neutral)]">
            <Icon name="layers" size={15} className="text-[var(--color-muted)]" />
            试卷考点池
            <span className="ml-auto font-[family-name:var(--font-outlier)] text-[11px] text-[var(--color-muted)]">
              {quiz.frozen_points.filter((p) => !p.used).length} 个未使用
            </span>
            <Icon
              name="chevronDown"
              size={14}
              className="text-[var(--color-muted)] transition-transform group-open:rotate-180"
            />
          </summary>
          <ul className="grid gap-2 border-t border-[var(--color-rule)] px-4 py-3 sm:grid-cols-2">
            {quiz.frozen_points.map((point) => (
              <li key={point.id} className="flex items-start gap-2 text-[length:var(--text-xs)] leading-5">
                <Icon
                  name={point.used ? "circleCheck" : "circle"}
                  size={13}
                  className={"mt-1 shrink-0 " + (point.used ? "text-[var(--color-success)]" : "text-[var(--color-muted)]")}
                />
                <span className={point.used ? "text-[var(--color-neutral)]" : "text-[var(--color-muted)]"}>
                  {point.content}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {progress && progress.missing > 0 && quizRecordId && (
        <Notice
          tone="warning"
          className="reveal"
          action={
            <Button
              variant="secondary"
              disabled={!consentId}
              onClick={() =>
                void api
                  .fillMissing(quizRecordId, consentId ?? "")
                  .then((result) => {
                    setGenerationJobId(result.job_id);
                    goto(5);
                  })
                  .catch((error: unknown) =>
                    push({
                      tone: "danger",
                      message: error instanceof ApiError ? error.message : "继续补题失败",
                    }),
                  )
              }
            >
              继续补题
            </Button>
          }
        >
          ▲ 还有 {progress.missing} 个槽位缺失，导出门槛未满足。
        </Notice>
      )}

      <div className="sticky top-[118px] z-20 border-y border-[var(--color-rule-strong)] bg-[color:var(--color-paper)]/95 p-2.5 backdrop-blur-md lg:top-[84px]">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="题目状态筛选"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部", count: questions.length },
              { value: "pending", label: "待复核", count: passed.length },
              { value: "approved", label: "已通过", count: questions.filter((q) => q.review_state === "approved").length },
              { value: "issues", label: "有问题", count: questions.filter((q) => q.validation_state === "failed" || q.review_state === "rejected").length },
              { value: "missing", label: "缺失", count: questions.filter((q) => !q.stem).length },
            ]}
          />
          {passed.length > 0 && (
            <Button className="ml-auto" loading={bulkBusy} onClick={() => void bulkApprove()}>
              <Icon name="check" size={15} />
              批量通过待复核
            </Button>
          )}
        </div>
      </div>

      <ul className="space-y-4" aria-label="题目列表">
        {visibleQuestions.map((question, index) => (
          <li key={`${question.id}-${question.attempt_count}-${question.stem ?? "empty"}`} className="reveal" style={{ ["--i" as string]: Math.min(index, 8) }}>
            <QuestionCard question={question} />
          </li>
        ))}
      </ul>

      {questions.length === 0 && (
        <EmptyState
          icon="clipboardCheck"
          title="还没有生成题目"
          description="完成生成后，题目会出现在这里等待复核。"
        />
      )}

      {questions.length > 0 && visibleQuestions.length === 0 && (
        <EmptyState
          icon="search"
          title="当前筛选下没有题目"
          description="切换状态筛选查看其他题目，或返回全部列表。"
          action={
            <Button variant="secondary" onClick={() => setFilter("all")}>查看全部题目</Button>
          }
        />
      )}

      <div className="sticky bottom-0 z-20 flex flex-row items-stretch gap-2 border-t border-[var(--color-rule-strong)] bg-[var(--color-paper)] py-2.5 shadow-[0_-16px_28px_-28px_rgb(27_23_17_/_0.4)] sm:items-center sm:justify-between sm:gap-3 sm:py-3">
        <Button variant="secondary" className="flex-1 sm:flex-none" onClick={() => goto(5)}>上一步</Button>
        <Button className="flex-1 sm:flex-none" disabled={!progress?.export_ready} onClick={() => goto(7)}>
          下一步:导出
          <Icon name="arrowRight" size={16} />
        </Button>
      </div>
    </section>
  );
}
