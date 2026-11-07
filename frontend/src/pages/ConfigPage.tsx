import { useEffect, useState } from "react";
import * as api from "../api/endpoints";
import { isPublicMode } from "../demo/mode";
import { PUBLIC_LIMITS } from "../public/model";
import { useWorkflow } from "../store";
import { Badge, Card, Input, Label } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icons";
import { PageHeader, SectionHeading, Stat } from "../components/ui/layout";
import type { EstimateDto } from "../types/api";

const FIELDS: { key: "single_choice" | "true_false" | "fill_blank"; label: string; hint: string }[] = [
  { key: "single_choice", label: "单选题数量", hint: "四个选项，程序平衡 A/B/C/D" },
  { key: "true_false", label: "判断题数量", hint: "正误目标均衡分配" },
  { key: "fill_blank", label: "填空题数量", hint: "答案逐字来自原文" },
];

export function ConfigPage() {
  const {
    questionConfig, setQuestionConfig, selectedDocumentIds, activeProfileId,
    goto, setExtractionJobId,
  } = useWorkflow();
  const [estimate, setEstimate] = useState<EstimateDto | null>(null);
  const [checking, setChecking] = useState(false);

  const total = questionConfig.single_choice + questionConfig.true_false + questionConfig.fill_blank;
  const maxTotal = isPublicMode ? PUBLIC_LIMITS.maxQuestions : 200;
  const maxPerType = isPublicMode ? PUBLIC_LIMITS.maxPerType : 100;
  const valid = total >= 1 && total <= maxTotal;

  useEffect(() => {
    if (!activeProfileId || !valid || selectedDocumentIds.length === 0) {
      setEstimate(null);
      return;
    }
    const timer = setTimeout(() => {
      setChecking(true);
      api.estimate({
        document_ids: selectedDocumentIds,
        ai_profile_id: activeProfileId,
        question_config: questionConfig,
      })
        .then(setEstimate)
        .catch(() => setEstimate(null))
        .finally(() => setChecking(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [questionConfig, activeProfileId, selectedDocumentIds, valid]);

  function update(key: keyof typeof questionConfig, raw: string) {
    const value = Math.max(0, Math.min(maxPerType, Number(raw) || 0));
    setQuestionConfig({ ...questionConfig, [key]: value });
  }

  const distribution = [
    { key: "single_choice", label: "单选", value: questionConfig.single_choice, color: "var(--color-accent)" },
    { key: "true_false", label: "判断", value: questionConfig.true_false, color: "var(--color-accent-2)" },
    { key: "fill_blank", label: "填空", value: questionConfig.fill_blank, color: "var(--color-warning)" },
  ];

  return (
    <section className="space-y-8" aria-labelledby="config-title">
      <PageHeader
        step={3}
        kicker="配置题目"
        title="配置题型与数量"
        description={
          isPublicMode
            ? "公共体验每种题型 0–15 题，总题数 1–30。系统会为每题保留独立的固定槽位，生成失败时按槽位补位。"
            : "三种题型各 0–100 题，总题数 1–200。系统会为每题保留独立的固定槽位，生成失败时按槽位补位。"
        }
        aside={
          <div className="ui-folio">
            <Stat
              label="计划题数"
              value={total}
              unit="题"
              tone={valid ? "accent" : "danger"}
              hint={`有效范围 1–${maxTotal}`}
            />
            <span className="h-8 w-px bg-[var(--color-rule)]" aria-hidden="true" />
            <Stat label="已选文档" value={selectedDocumentIds.length} unit="份" />
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map((field, index) => (
          <Card
            key={field.key}
            className="reveal overflow-hidden p-0"
            style={{ ["--i" as string]: index + 1 }}
          >
            <div className="flex items-baseline justify-between border-b border-[var(--color-rule)] px-5 py-2.5">
              <span className="font-[family-name:var(--font-outlier)] text-[9px] uppercase tracking-[0.16em] text-[var(--color-muted)]">
                Question Type
              </span>
              <span className="font-[family-name:var(--font-display)] text-xl font-medium leading-none text-[var(--color-accent)]">
                {String(index + 1).padStart(2, "0")}
              </span>
            </div>
            <div className="p-5">
              <Label htmlFor={`cfg-${field.key}`} className="mb-2 font-[family-name:var(--font-display)] text-[15px] font-semibold text-[var(--color-ink)]">
                {field.label}
              </Label>
              <div className="flex items-baseline gap-2">
                <Input
                  id={`cfg-${field.key}`}
                  inputMode="numeric"
                  value={questionConfig[field.key]}
                  onChange={(event) => update(field.key, event.target.value)}
                  className="h-12 w-24 px-2 text-center font-[family-name:var(--font-outlier)] text-2xl"
                />
                <span className="text-[length:var(--text-sm)] text-[var(--color-muted)]">题</span>
              </div>
              <p className="mt-2 text-[length:var(--text-xs)] leading-5 text-[var(--color-muted)]">{field.hint}</p>
            </div>
          </Card>
        ))}
      </div>

      <Card className="reveal" style={{ ["--i" as string]: 4 }}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionHeading
            index="MIX"
            title="题型分布"
            description="建议选择的考点不少于总题数的 1.25 倍，给补位留余量。"
          />
          <Badge tone={valid ? "accent" : "danger"}>
            总题数 {total}
          </Badge>
        </div>
        <div className="mt-4 flex h-2 overflow-hidden border border-[var(--color-rule)] bg-[var(--color-paper-3)]">
          {distribution.map((item) =>
            item.value > 0 ? (
              <span
                key={item.key}
                className="h-full transition-[width] duration-[var(--dur-long)] ease-[var(--ease-in-out)]"
                style={{ width: `${(item.value / Math.max(total, 1)) * 100}%`, backgroundColor: item.color }}
              />
            ) : null,
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-[var(--color-muted)]">
          {distribution.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2" style={{ backgroundColor: item.color }} />
              {item.label} {item.value}
            </span>
          ))}
          {!valid && (
            <span className="ml-auto text-[var(--color-danger)]">总题数需在 1–{maxTotal} 之间</span>
          )}
        </div>
      </Card>

      <Card className="reveal" style={{ ["--i" as string]: 5 }} aria-label="费用估算">
        <SectionHeading
          index="BUDGET"
          title="最坏调用上限（预算参考）"
          description="按每个题目槽位最多 5 次逻辑调用估算；正常成功通常更低。这是预算上限，不代表最终实际消耗。"
        />
        {checking && (
          <div className="mt-5 flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--color-muted)]">
            <span className="live-dot" aria-hidden="true" />
            计算中…
          </div>
        )}
        {estimate && !checking && (
          <div className="mt-5 grid gap-px border border-[var(--color-rule)] bg-[var(--color-rule)] sm:grid-cols-3">
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat
                label="上限输入 token"
                value={estimate.estimated_input_tokens.toLocaleString()}
              />
            </div>
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat
                label="上限输出 token"
                value={estimate.estimated_output_tokens.toLocaleString()}
              />
            </div>
            <div className="bg-[var(--color-paper-2)] p-4">
              <Stat
                label="费用上限"
                tone="accent"
                value={
                  estimate.estimated_cost.available
                    ? `${estimate.estimated_cost.value} ${estimate.estimated_cost.currency}`
                    : "—"
                }
                hint={!estimate.estimated_cost.available ? estimate.estimated_cost.reason : undefined}
              />
            </div>
          </div>
        )}
        {!estimate && !checking && (
          <p className="mt-5 flex items-center gap-2 border-y border-dashed border-[var(--color-rule)] px-1 py-3.5 text-[length:var(--text-sm)] text-[var(--color-muted)]">
            <Icon name="info" size={15} />
            选择文档并填写数量后显示估算。
          </p>
        )}
      </Card>

      <div className="flex flex-col gap-3 border-t border-[var(--color-rule-strong)] pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="secondary" onClick={() => goto(1)}>上一步</Button>
        <Button
          disabled={!valid}
          onClick={() => {
            setExtractionJobId(null);
            goto(3);
          }}
        >
          下一步:抽取考点
          <Icon name="arrowRight" size={16} />
        </Button>
      </div>
    </section>
  );
}
