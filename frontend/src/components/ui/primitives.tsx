import type { HTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Card({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={
        "ui-surface rounded-[var(--radius-lg)] p-5 transition-[border-color,box-shadow] duration-[var(--dur-short)] " +
        "ease-[var(--ease-paper)] hover:border-[var(--color-rule-strong)] " +
        className
      }
      {...rest}
    />
  );
}

const fieldBase =
  "w-full rounded-[var(--radius-sm)] border bg-[var(--color-paper-hi)] text-[length:var(--text-base)] " +
  "text-[var(--color-ink)] " +
  "transition-[border-color,box-shadow,background-color] duration-[var(--dur-short)] ease-[var(--ease-paper)] " +
  "placeholder:text-[var(--color-muted)] hover:border-[var(--color-rule-strong)] " +
  "focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-soft)] focus:outline-none ";

export function Input({ className = "", invalid = false, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={
        fieldBase +
        "min-h-11 px-3.5 py-2 " +
        (invalid ? "border-[var(--color-danger)] " : "border-[var(--color-rule)] ") +
        className
      }
      {...rest}
    />
  );
}

export function Textarea({ className = "", invalid = false, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={
        fieldBase +
        "px-3.5 py-2.5 " +
        (invalid ? "border-[var(--color-danger)] " : "border-[var(--color-rule)] ") +
        className
      }
      {...rest}
    />
  );
}

export function Label({ className = "", ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={
        "mb-1.5 block text-[12px] font-medium tracking-[0.02em] text-[var(--color-neutral)] " + className
      }
      {...rest}
    />
  );
}

export function Select({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={
        fieldBase +
        "min-h-11 appearance-none bg-[image:linear-gradient(45deg,transparent_50%,var(--color-muted)_50%),linear-gradient(135deg,var(--color-muted)_50%,transparent_50%)] bg-[position:calc(100%-17px)_50%,calc(100%-12px)_50%] bg-[size:5px_5px,5px_5px] bg-no-repeat px-3.5 py-2 pr-9 border-[var(--color-rule)] " +
        className
      }
      {...rest}
    />
  );
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "border-[var(--color-rule)] bg-[var(--color-paper-hi)]/70 text-[var(--color-neutral)]",
  accent: "border-[var(--color-accent)]/35 bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
  success: "border-[var(--color-success)]/35 bg-[#e9eee2] text-[var(--color-success)]",
  warning: "border-[var(--color-warning)]/35 bg-[#f4ead6] text-[var(--color-warning)]",
  danger: "border-[var(--color-danger)]/35 bg-[#f5e6e0] text-[var(--color-danger)]",
};

export function Badge({
  tone = "neutral",
  className = "",
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={
        "inline-flex min-h-6 items-center gap-1.5 rounded-[2px] border px-2 py-0.5 " +
        "text-[11px] leading-5 tracking-[0.01em] whitespace-nowrap " + badgeTones[tone] + " " + className
      }
      {...rest}
    />
  );
}

export function Progress({
  value,
  label,
  running = false,
}: {
  value: number;
  label: string;
  running?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-[7px] w-full overflow-hidden rounded-[1px] border border-[var(--color-rule)] bg-[var(--color-paper-3)]"
    >
      <div
        className={
          "progress-fill h-full transition-[width] duration-[var(--dur-long)] ease-[var(--ease-in-out)] " +
          (running ? "is-running" : "")
        }
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={
        "animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-paper-3)] " + className
      }
    />
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        "inline-flex min-h-11 cursor-pointer items-center gap-2.5 " +
        (disabled ? "cursor-not-allowed opacity-50" : "")
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-[17px] cursor-pointer rounded-[2px] accent-[var(--color-accent)]"
      />
      {label && <span className="text-[length:var(--text-sm)]">{label}</span>}
    </label>
  );
}
