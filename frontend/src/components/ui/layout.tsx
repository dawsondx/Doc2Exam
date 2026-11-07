import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function PageHeader({
  step,
  kicker,
  title,
  description,
  aside,
}: {
  step: number;
  kicker: string;
  title: string;
  description: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="reveal" style={{ ["--i" as string]: 0 }}>
      <div className="flex items-center gap-3">
        <span className="eyebrow">
          {String(step).padStart(2, "0")} / {kicker}
        </span>
        <span className="h-px w-12 bg-[var(--color-rule-strong)]" aria-hidden="true" />
      </div>
      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-[58ch]">
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(2.1rem,3.6vw,3.25rem)] font-medium leading-[1.06] tracking-[-0.045em] text-[var(--color-ink)]">
            {title}
            <span aria-hidden="true" className="text-[var(--color-accent)]">.</span>
          </h2>
          <p className="mt-3 max-w-[60ch] text-[length:var(--text-sm)] leading-6 text-[var(--color-neutral)]">
            {description}
          </p>
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
    </header>
  );
}

export function SectionHeading({
  index,
  title,
  description,
  action,
}: {
  index?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-baseline gap-3">
          {index && (
            <span className="font-[family-name:var(--font-outlier)] text-[10px] tracking-[0.16em] text-[var(--color-accent)]">
              {index}
            </span>
          )}
          <h3 className="font-[family-name:var(--font-display)] text-[1.25rem] font-semibold tracking-[-0.025em] text-[var(--color-ink)]">
            {title}
          </h3>
        </div>
        {description && (
          <p className="mt-1.5 max-w-[60ch] text-[length:var(--text-sm)] leading-6 text-[var(--color-muted)]">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

const noticeTones = {
  info: {
    icon: "info" as IconName,
    className: "border-l-[var(--color-accent)] bg-[rgb(166_61_47_/_0.04)]",
    iconClass: "text-[var(--color-accent)]",
    titleClass: "text-[var(--color-accent)]",
  },
  warning: {
    icon: "alert" as IconName,
    className: "border-l-[var(--color-warning)] bg-[#f7f0e1]",
    iconClass: "text-[var(--color-warning)]",
    titleClass: "text-[var(--color-warning)]",
  },
  danger: {
    icon: "alert" as IconName,
    className: "border-l-[var(--color-danger)] bg-[#f7eae5]",
    iconClass: "text-[var(--color-danger)]",
    titleClass: "text-[var(--color-danger)]",
  },
  success: {
    icon: "circleCheck" as IconName,
    className: "border-l-[var(--color-success)] bg-[#edf0e6]",
    iconClass: "text-[var(--color-success)]",
    titleClass: "text-[var(--color-success)]",
  },
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
  className = "",
}: {
  tone?: keyof typeof noticeTones;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const style = noticeTones[tone];
  return (
    <div className={"flex items-start gap-3 border-l-2 px-4 py-3 " + style.className + " " + className}>
      <Icon name={style.icon} size={16} className={"mt-0.5 shrink-0 " + style.iconClass} />
      <div className="min-w-0 flex-1 text-[length:var(--text-sm)] leading-6 text-[var(--color-neutral)]">
        {title && <p className={"font-medium " + style.titleClass}>{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function EmptyState({
  icon = "layers",
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-surface flex flex-col items-center rounded-[var(--radius-lg)] px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full border border-[var(--color-rule-strong)] bg-[var(--color-paper-hi)] text-[var(--color-accent)]">
        <Icon name={icon} size={21} />
      </span>
      <p className="mt-4 font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--color-ink)]">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-[46ch] text-[length:var(--text-sm)] leading-6 text-[var(--color-muted)]">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
}) {
  const tones = {
    neutral: "text-[var(--color-ink)]",
    accent: "text-[var(--color-accent)]",
    success: "text-[var(--color-success)]",
    warning: "text-[var(--color-warning)]",
    danger: "text-[var(--color-danger)]",
  };
  return (
    <div className="min-w-0">
      <p className="font-[family-name:var(--font-outlier)] text-[9px] uppercase tracking-[0.14em] text-[var(--color-muted)]">
        {label}
      </p>
      <p className={"mt-1.5 font-[family-name:var(--font-display)] text-[1.65rem] font-medium leading-none tracking-[-0.03em] " + tones[tone]}>
        {value}
        {unit && <span className="ml-1.5 font-[family-name:var(--font-body)] text-[10px] font-normal tracking-normal text-[var(--color-muted)]">{unit}</span>}
      </p>
      {hint && <p className="mt-1.5 text-[10px] leading-4 text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className = "",
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: ReactNode; count?: number }[];
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={
        "inline-flex max-w-full flex-wrap rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] " +
        className
      }
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={
              "inline-flex min-h-8 items-center gap-1 px-2 text-[11px] transition-[background-color,color] duration-[var(--dur-short)] ease-[var(--ease-paper)] sm:min-h-9 sm:gap-1.5 sm:px-3 sm:text-[length:var(--text-xs)] " +
              (index > 0 ? "border-l border-[var(--color-rule)] " : "") +
              (active
                ? "bg-[var(--color-ink)] font-medium text-[var(--color-paper-2)]"
                : "text-[var(--color-muted)] hover:bg-[var(--color-paper-3)] hover:text-[var(--color-ink)]")
            }
          >
            {option.label}
            {typeof option.count === "number" && (
              <span className="font-[family-name:var(--font-outlier)] text-[9px] opacity-70 sm:text-[10px]">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
