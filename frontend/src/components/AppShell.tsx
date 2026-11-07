import { useEffect, useRef } from "react";
import brandSeal from "../assets/brand-ti-seal.svg";
import { isDemoMode, isPublicMode } from "../demo/mode";
import { STEPS, useWorkflow } from "../store";
import { Icon } from "./ui/icons";

function BrandMark() {
  return (
    <img
      src={brandSeal}
      alt=""
      width={40}
      height={40}
      className="size-10 shrink-0"
    />
  );
}

function StepRail() {
  const { step, goto, maxUnlocked } = useWorkflow();
  return (
    <nav aria-label="流程步骤">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Contents</span>
        <span className="font-[family-name:var(--font-outlier)] text-[9px] tracking-[0.18em] text-[var(--color-muted)]">
          {String(step + 1).padStart(2, "0")} — {String(STEPS.length).padStart(2, "0")}
        </span>
      </div>
      <ol className="mt-4 border-t border-[var(--color-rule-strong)]">
        {STEPS.map((item, index) => {
          const current = index === step;
          const done = index < step;
          const reachable = index <= maxUnlocked;
          const locked = !reachable;
          return (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => goto(index)}
                disabled={locked}
                aria-current={current ? "step" : undefined}
                className={
                  "group relative flex min-h-[44px] w-full items-baseline gap-3 border-b border-dotted " +
                  "border-[var(--color-rule)] py-3 pl-3 pr-1 text-left transition-colors duration-[var(--dur-short)] " +
                  "ease-[var(--ease-paper)] " +
                  (locked ? "cursor-not-allowed " : "hover:bg-[var(--color-paper-2)]/70 ")
                }
              >
                {current && (
                  <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[2px] bg-[var(--color-accent)]" />
                )}
                <span
                  className={
                    "w-5 shrink-0 font-[family-name:var(--font-outlier)] text-[10px] tracking-[0.08em] " +
                    (current
                      ? "font-semibold text-[var(--color-accent)]"
                      : done
                        ? "text-[var(--color-accent)]/75"
                        : "text-[var(--color-muted)]" + (locked ? " opacity-55" : ""))
                  }
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={
                    "min-w-0 flex-1 font-[family-name:var(--font-display)] text-[13.5px] leading-5 tracking-[0.01em] " +
                    (current
                      ? "font-semibold text-[var(--color-ink)]"
                      : locked
                        ? "text-[var(--color-muted)] opacity-60"
                        : "text-[var(--color-neutral)] group-hover:text-[var(--color-accent)]")
                  }
                >
                  {item.label}
                </span>
                <span className="flex w-8 shrink-0 justify-end">
                  {current ? (
                    <span aria-hidden="true" className="size-[5px] translate-y-[-2px] bg-[var(--color-accent)]" />
                  ) : done ? (
                    <span className="font-[family-name:var(--font-outlier)] text-[8px] tracking-[0.12em] text-[var(--color-muted)]">
                      DONE
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function MobileStepNav() {
  const { step, goto, maxUnlocked } = useWorkflow();
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [step]);

  return (
    <nav aria-label="流程步骤" className="lg:hidden">
      <ol className="scroll-slim flex overflow-x-auto border-t border-[var(--color-rule)]">
        {STEPS.map((item, index) => {
          const current = index === step;
          const done = index < step;
          const locked = index > maxUnlocked;
          return (
            <li key={item.key} className="shrink-0 border-r border-[var(--color-rule)] last:border-r-0">
              <button
                ref={current ? activeRef : undefined}
                type="button"
                onClick={() => goto(index)}
                disabled={locked}
                aria-current={current ? "step" : undefined}
                className={
                  "flex min-h-11 items-center gap-2 px-3.5 transition-colors duration-[var(--dur-short)] " +
                  "ease-[var(--ease-paper)] " +
                  (current
                    ? "bg-[var(--color-ink)] text-[var(--color-paper)]"
                    : done
                      ? "text-[var(--color-accent)] hover:bg-[var(--color-paper-2)]"
                      : locked
                        ? "cursor-not-allowed text-[var(--color-muted)] opacity-55"
                        : "text-[var(--color-neutral)] hover:bg-[var(--color-paper-2)]")
                }
              >
                <span className="font-[family-name:var(--font-outlier)] text-[9px] tracking-[0.1em]">
                  {done ? "✓" : String(index + 1).padStart(2, "0")}
                </span>
                <span className="whitespace-nowrap font-[family-name:var(--font-body)] text-[11px] tracking-[0.02em]">
                  {item.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function SideNote({ mockMode }: { mockMode: boolean }) {
  const title = isDemoMode
    ? "交互演示环境"
    : isPublicMode
      ? "自带 Key 体验"
      : mockMode
        ? "测试模式"
        : "本地优先";

  return (
    <div className="mt-10 border-t border-[var(--color-rule-strong)] pt-4">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Colophon</span>
        <span className="font-[family-name:var(--font-outlier)] text-[8px] tracking-[0.16em] text-[var(--color-muted)]">
          {isDemoMode ? "DEMO" : isPublicMode ? "BYOK" : "LOCAL"}
        </span>
      </div>
      <p className="mt-2.5 font-[family-name:var(--font-display)] text-[14px] font-semibold tracking-[-0.01em] text-[var(--color-ink)]">
        {title}
      </p>
      <p className="mt-1.5 text-[11px] leading-[1.9] text-[var(--color-muted)]">
        {isDemoMode
          ? "页面使用内置示例数据，所有操作只发生在浏览器内存中，刷新后自动重置。真实文档解析与 AI 调用保留在桌面版。"
          : isPublicMode
            ? "文档与题目只保存在你的浏览器；AI 请求由浏览器直接发往你选择的服务商，Key 不会上传到本站，费用由你的服务商账户结算。"
            : mockMode
              ? "AI 调用使用本地 Mock，不访问网络，适合检查完整流程。"
              : "原始文档、题目与导出只写入本机 data 目录；API Key 保存在系统凭据管理器。"}
      </p>
      <div className="mt-3 flex items-center gap-2 border-t border-dotted border-[var(--color-rule)] pt-3">
        <span className="size-[5px] shrink-0 bg-[var(--color-accent)]" />
        <span className="font-[family-name:var(--font-outlier)] text-[8px] tracking-[0.16em] text-[var(--color-muted)]">
          {isDemoMode ? "SAMPLE DATA · RESETS ON RELOAD" : isPublicMode ? "KEY STAYS IN THIS BROWSER" : "DATA STAYS LOCAL"}
        </span>
      </div>
    </div>
  );
}

function AuthorNote() {
  return (
    <section
      aria-label="关于作者"
      className="ui-surface flex flex-col gap-5 rounded-[var(--radius-lg)] p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:p-6"
    >
      <div className="flex min-w-0 items-start gap-4">
        <span
          aria-hidden="true"
          className="flex size-[52px] shrink-0 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--color-ink)] font-[family-name:var(--font-display)] text-[25px] font-semibold leading-none text-[var(--color-paper-2)]"
        >
          D
        </span>
        <div className="min-w-0">
          <p className="eyebrow">本站作者 · 整理与维护</p>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-[family-name:var(--font-display)] text-[21px] font-semibold tracking-[-0.02em] text-[var(--color-ink)]">
              Dawson
            </span>
            <span className="text-[12.5px] text-[var(--color-muted)]">公众号「Dawson聊AI提效」主理人</span>
          </p>
          <p className="mt-2 max-w-[62ch] text-[12.5px] leading-[1.9] text-[var(--color-neutral)]">
            专注帮传统行业职场人用 AI 干掉重复性工作。这个站点由我独立选题、整理、设计并长期维护。
          </p>
        </div>
      </div>
      <a
        href="https://view.dawsondx.top/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 self-start rounded-[var(--radius-sm)] border border-[var(--color-rule-strong)] bg-[var(--color-paper-hi)] px-4 text-[13px] text-[var(--color-ink)] transition-[border-color,color] duration-[var(--dur-short)] ease-[var(--ease-paper)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] sm:self-auto"
      >
        我的个人网站
        <Icon name="external" size={13} className="text-[var(--color-muted)]" />
      </a>
    </section>
  );
}

export function AppShell({
  children,
  mockMode,
}: {
  children: React.ReactNode;
  mockMode: boolean;
}) {
  const { goto } = useWorkflow();
  const modeLabel = isDemoMode
    ? "交互演示 · 示例数据"
    : isPublicMode
      ? "自带 Key · 浏览器直连"
      : mockMode
        ? "测试模式 · Mock AI"
        : "本地运行 · 数据不出机";
  const modeShort = isDemoMode ? "演示" : isPublicMode ? "BYOK" : mockMode ? "Mock" : "本地";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-50 bg-[color:var(--color-paper)]/95 backdrop-blur-md">
        <div className="mx-auto flex h-[68px] w-full max-w-[1380px] items-center justify-between gap-4 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => goto(0)}
            className="group flex min-w-0 items-center gap-3 text-left"
            aria-label="回到第一步"
          >
            <BrandMark />
            <span className="min-w-0">
              <span className="block truncate font-[family-name:var(--font-display)] text-[18px] font-semibold leading-none tracking-[-0.01em] text-[var(--color-ink)] group-hover:text-[var(--color-accent)]">
                AI 出题精灵
              </span>
              <span className="mt-1.5 hidden font-[family-name:var(--font-outlier)] text-[8px] uppercase leading-none tracking-[0.22em] text-[var(--color-muted)] sm:block">
                Document · Intelligence · Paper
              </span>
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-3 sm:gap-4">
            <span className="inline-flex items-center gap-2 font-[family-name:var(--font-outlier)] text-[9px] tracking-[0.12em] text-[var(--color-muted)]">
              <span
                aria-hidden="true"
                className={
                  "size-[5px] " + (isDemoMode ? "bg-[var(--color-accent)]" : "bg-[var(--color-success)]")
                }
              />
              <span className="sm:hidden">{modeShort}</span>
              <span className="hidden sm:inline">{modeLabel}</span>
            </span>
            <span aria-hidden="true" className="hidden h-3 w-px bg-[var(--color-rule-strong)] sm:block" />
            <span className="hidden border border-[var(--color-rule)] px-2 py-1 font-[family-name:var(--font-outlier)] text-[9px] tracking-[0.14em] text-[var(--color-muted)] md:inline">
              NO. 1.1
            </span>
          </div>
        </div>
        <MobileStepNav />
        <div className="rule-double" aria-hidden="true" />
      </header>

      <div className="mx-auto flex w-full max-w-[1380px] flex-1 items-start gap-8 px-4 sm:px-6 lg:gap-12">
        <aside className="sticky top-[96px] hidden w-[236px] shrink-0 py-9 lg:block">
          <StepRail />
          <SideNote mockMode={mockMode} />
        </aside>
        <main className="min-w-0 flex-1 py-7 lg:py-10">
          <div className="mx-auto w-full max-w-[1020px]">{children}</div>
        </main>
      </div>

      <footer className="mt-auto border-t border-[var(--color-rule-strong)] px-4 pb-5 pt-7 sm:px-6">
        <div className="mx-auto w-full max-w-[1380px]">
          <AuthorNote />
          <div className="mt-6 flex flex-col gap-1.5 border-t border-dotted border-[var(--color-rule)] pt-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-2">
            <p className="font-[family-name:var(--font-display)] text-[12px] tracking-[0.01em] text-[var(--color-neutral)]">
              纸上学问，题上有据。
            </p>
            <p className="font-[family-name:var(--font-outlier)] text-[8px] tracking-[0.18em] text-[var(--color-muted)]">
              {isDemoMode
                ? "AI QUIZ ATELIER · VOL. 01 · DEMO"
                : isPublicMode
                  ? "AI QUIZ ATELIER · VOL. 01 · BYOK"
                  : "AI QUIZ ATELIER · VOL. 01 · LOCAL"}
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
