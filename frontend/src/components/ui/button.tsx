import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[image:var(--gradient-accent)] text-[var(--color-accent-ink)] font-medium " +
    "shadow-[0_1px_0_rgb(255_248_238_/_0.18)_inset,0_10px_22px_-18px_rgb(27_23_17_/_0.6)] " +
    "hover:brightness-[0.95] active:brightness-[1.02] " +
    "disabled:border disabled:border-[var(--color-rule)] disabled:bg-[var(--color-paper-3)] " +
    "disabled:bg-none disabled:font-normal disabled:text-[var(--color-muted)] disabled:shadow-none",
  secondary:
    "border border-[var(--color-rule-strong)] bg-transparent text-[var(--color-ink)] " +
    "hover:border-[var(--color-ink)] hover:bg-[var(--color-paper-2)] " +
    "disabled:border-[var(--color-rule)] disabled:text-[var(--color-muted)] disabled:opacity-60",
  ghost:
    "bg-transparent text-[var(--color-neutral)] hover:bg-[var(--color-paper-3)] hover:text-[var(--color-ink)] " +
    "disabled:text-[var(--color-muted)] disabled:opacity-40",
  danger:
    "border border-[var(--color-danger)]/45 bg-transparent text-[var(--color-danger)] " +
    "hover:border-[var(--color-danger)] hover:bg-[#f5e6e0] " +
    "disabled:border-[var(--color-rule)] disabled:text-[var(--color-muted)] disabled:opacity-60",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", loading = false, className = "", children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      data-loading={loading ? "true" : undefined}
      className={
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] " +
        "px-5 py-2.5 text-[length:var(--text-sm)] tracking-[0.01em] transition-[transform,filter,box-shadow,border-color,background-color,color] " +
        "duration-[var(--dur-short)] ease-[var(--ease-paper)] " +
        "hover:-translate-y-px active:translate-y-0 " +
        "disabled:pointer-events-none disabled:translate-y-0 " +
        variantClasses[variant] +
        (className ? " " + className : "")
      }
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  ),
);
Button.displayName = "Button";
