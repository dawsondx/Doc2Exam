import { useMemo, useState } from "react";
import * as api from "../api/endpoints";
import { ApiError } from "../api/client";
import { useWorkflow } from "../store";
import { useToast } from "../components/ui/toast";
import { Badge, Card, Checkbox, Progress } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icons";
import { EmptyState, PageHeader, Segmented, Stat } from "../components/ui/layout";

const BLOOM_LABELS: Record<string, string> = {
  remember: "记忆", understand: "理解", apply: "应用", analyze: "分析",
};

const TYPE_LABELS: Record<string, string> = {
  single_choice: "单选", true_false: "判断", fill_blank: "填空",
};

export function PointsPage() {
  const { points, questionConfig, goto, refreshPoints, extractionJobId } = useWorkflow();
  const { push } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "selected" | "review">("all");

  const total = questionConfig.single_choice + questionConfig.true_false + questionConfig.fill_blank;
  const selected = points.filter((p) => p.selected);

  const coverage = useMemo(() => {
    const byType: Record<string, number> = { single_choice: 0, true_false: 0, fill_blank: 0 };
    for (const point of selected) {
      for (const type of point.eligible_types) {
        if (type in byType) byType[type] += 1;
      }
    }
    return byType;
  }, [selected]);

  const categories = useMemo(
    () => Array.from(new Set(points.map((p) => p.category))),
    [points],
  );

  const visible = points.filter((point) => {
    const categoryMatches = filter === "all" || point.category === filter;
    const statusMatches = statusFilter === "all" ||
      (statusFilter === "selected" && point.selected) ||
      (statusFilter === "review" && point.requires_source_review);
    return categoryMatches && statusMatches;
  });

  async function toggle(id: string, next: boolean) {
    try {
      await api.setPointSelected(id, next);
      if (extractionJobId) await refreshPoints(extractionJobId);
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? `${error.message}(${error.action})` : "选择失败",
      });
    }
  }

  async function bulk(next: boolean) {
    const ids = visible.filter((p) => p.selectable).map((p) => p.id);
    await api.bulkSelectPoints(ids, next).catch(() => undefined);
    if (extractionJobId) await refreshPoints(extractionJobId);
  }

  const gap = Math.max(0, total - selected.length);
  const progress = total > 0 ? Math.min(100, (selected.length / total) * 100) : 0;

  return (
    <section className="space-y-6" aria-labelledby="points-title">
      <PageHeader
        step={5}
        kicker="选择考点"
        title="选择考点"
        description="每道题使用一个考点。展开考点可核对原文出处；带“需人工核对”标记的考点请结合原文确认后再使用。"
        aside={
          <div className="ui-folio">
            <Stat label="已选考点" value={selected.length} unit="个" tone={gap === 0 ? "success" : "accent"} />
            <span className="h-8 w-px bg-[var(--color-rule)]" aria-hidden="true" />
            <Stat label="需要" value={total} unit="个" hint={`共 ${points.length} 个候选`} />
          </div>
        }
      />

      <Card
        className="reveal sticky top-[118px] z-20 rounded-none border-0 border-b border-[var(--color-rule-strong)] bg-[color:var(--color-paper)]/95 px-0 py-4 shadow-none backdrop-blur-md lg:top-[84px]"
        style={{ ["--i" as string]: 1 }}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[length:var(--text-sm)] text-[var(--color-neutral)]">
                已选 <span className="font-[family-name:var(--font-outlier)] text-lg text-[var(--color-accent)]">{selected.length}</span>
                <span className="text-[var(--color-muted)]"> / 需要至少 {total}</span>
              </p>
              <Badge tone={gap === 0 ? "success" : "warning"}>
                {gap === 0 ? "✓ 数量已满足" : `还缺 ${gap} 个`}
              </Badge>
            </div>
            <div className="mt-2.5">
              <Progress value={progress} label="考点选择进度" />
            </div>
          </div>
          <div className="grid grid-cols-3 divide-x divide-[var(--color-rule)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 lg:w-[19rem]">
            {[
              { key: "single_choice", label: "可覆盖单选" },
              { key: "true_false", label: "可覆盖判断" },
              { key: "fill_blank", label: "可覆盖填空" },
            ].map((item) => (
              <div key={item.key} className="px-3 py-2.5 text-center">
                <p className="font-[family-name:var(--font-outlier)] text-lg leading-none text-[var(--color-ink)]">
                  {coverage[item.key]}
                </p>
                <p className="mt-1.5 text-[10px] text-[var(--color-muted)]">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
        {gap > 0 && (
          <p className="mt-3 flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-warning)]">
            <Icon name="alert" size={13} />
            还缺 {gap} 个考点才能开始生成。
          </p>
        )}
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void bulk(true)}>
            <Icon name="check" size={14} />
            全选当前筛选
          </Button>
          <Button variant="ghost" onClick={() => void bulk(false)}>清空当前筛选</Button>
          <div className="ml-auto" role="group" aria-label="选择状态筛选">
            <Segmented
              label="选择状态筛选"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: "全部状态" },
                { value: "selected", label: "已选择", count: selected.length },
                { value: "review", label: "需核对", count: points.filter((p) => p.requires_source_review).length },
              ]}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] tracking-[0.05em] text-[var(--color-muted)]">分类</span>
          <Segmented
            label="分类筛选"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部分类" },
              ...categories.map((category) => ({ value: category, label: category })),
            ]}
          />
        </div>
      </div>

      <ul className="grid items-start gap-3 lg:grid-cols-2" aria-label="考点列表">
        {visible.map((point, index) => {
          const isExpanded = expanded === point.id;
          return (
            <li key={point.id} className="reveal" style={{ ["--i" as string]: Math.min(index, 8) }}>
              <Card
                className={
                  "relative overflow-hidden p-0 " +
                  (point.selected
                    ? "border-[var(--color-rule-strong)] bg-[var(--color-paper-hi)]/70"
                    : "")
                }
              >
                {point.selected && (
                  <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-[var(--color-accent)]" />
                )}
                <div className="flex items-start gap-3 p-4 sm:p-5">
                  <div className="pt-1">
                    <Checkbox
                      checked={point.selected}
                      disabled={!point.selectable}
                      onChange={(next) => void toggle(point.id, next)}
                      label=""
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[15px] leading-7 text-[var(--color-ink)]">{point.content}</p>
                      <span className="shrink-0 pt-1 font-[family-name:var(--font-outlier)] text-[10px] tracking-[0.08em] text-[var(--color-muted)]">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{point.category}</Badge>
                      <Badge tone="neutral">{BLOOM_LABELS[point.bloom_level] ?? point.bloom_level}</Badge>
                      {point.eligible_types.map((type) => (
                        <Badge key={type} tone="accent">{TYPE_LABELS[type] ?? type}</Badge>
                      ))}
                      {point.requires_source_review && <Badge tone="warning">▲ 需人工核对原文</Badge>}
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpanded(isExpanded ? null : point.id)}
                      aria-expanded={isExpanded}
                      className="mt-2.5 inline-flex min-h-8 items-center gap-1 text-[length:var(--text-xs)] text-[var(--color-accent)] underline-offset-4 hover:underline"
                    >
                      <Icon name="book" size={13} />
                      {isExpanded ? "收起原文" : "展开原文出处"}
                      <Icon
                        name="chevronDown"
                        size={13}
                        className={"transition-transform " + (isExpanded ? "rotate-180" : "")}
                      />
                    </button>
                    {isExpanded && point.source_text && (
                      <blockquote className="mt-2 max-h-48 overflow-y-auto border-l-2 border-[var(--color-rule-strong)] bg-[var(--color-paper-2)] px-4 py-3 text-[length:var(--text-xs)] leading-6 text-[var(--color-neutral)]">
                        {point.source_text}
                      </blockquote>
                    )}
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      {points.length === 0 && (
        <EmptyState
          icon="listChecks"
          title="还没有考点"
          description="请先完成“抽取考点”步骤，抽取结果会出现在这里供你筛选。"
          action={<Button variant="secondary" onClick={() => goto(3)}>返回抽取考点</Button>}
        />
      )}

      {points.length > 0 && visible.length === 0 && (
        <EmptyState
          icon="search"
          title="当前筛选下没有考点"
          description="试试切换分类或状态筛选，或者清空筛选查看全部候选。"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setFilter("all");
                setStatusFilter("all");
              }}
            >
              清空筛选
            </Button>
          }
        />
      )}

      <div className="sticky bottom-0 z-20 flex flex-row items-center justify-between gap-2 border-t border-[var(--color-rule-strong)] bg-[var(--color-paper)] py-2.5 shadow-[0_-16px_28px_-28px_rgb(27_23_17_/_0.4)] sm:gap-3 sm:py-3">
        <Button variant="secondary" onClick={() => goto(3)}>上一步</Button>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <span className="hidden text-[length:var(--text-xs)] text-[var(--color-muted)] sm:inline">
            {gap > 0 ? `还缺 ${gap} 个考点` : `已选 ${selected.length} 个考点`}
          </span>
          <Button disabled={gap > 0} onClick={() => goto(5)}>
            下一步:生成题目
            <Icon name="arrowRight" size={16} />
          </Button>
        </div>
      </div>
    </section>
  );
}
