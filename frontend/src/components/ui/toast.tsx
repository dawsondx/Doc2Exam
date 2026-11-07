import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export interface ToastItem {
  id: number;
  tone: "info" | "success" | "warning" | "danger";
  message: string;
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<{ push: (item: Omit<ToastItem, "id">) => void }>({
  push: () => undefined,
});

export function useToast() {
  return useContext(ToastContext);
}

const toneClasses: Record<
  ToastItem["tone"],
  { edge: string; icon: string; label: string; iconName: IconName }
> = {
  info: {
    edge: "border-l-[var(--color-accent)]",
    icon: "text-[var(--color-accent)]",
    label: "NOTE",
    iconName: "info",
  },
  success: {
    edge: "border-l-[var(--color-success)]",
    icon: "text-[var(--color-success)]",
    label: "DONE",
    iconName: "circleCheck",
  },
  warning: {
    edge: "border-l-[var(--color-warning)]",
    icon: "text-[var(--color-warning)]",
    label: "CHECK",
    iconName: "alert",
  },
  danger: {
    edge: "border-l-[var(--color-danger)]",
    icon: "text-[var(--color-danger)]",
    label: "ERROR",
    iconName: "alert",
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((item: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-2), { ...item, id }]);
  }, []);

  useEffect(() => {
    if (!items.length) return;
    const timer = setTimeout(() => {
      setItems((prev) => prev.slice(1));
    }, 5000);
    return () => clearTimeout(timer);
  }, [items]);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[70] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[380px]"
      >
        {items.map((item) => {
          const style = toneClasses[item.tone];
          return (
            <div
              key={item.id}
              role="status"
              className={
                "flex w-full items-start gap-3 border border-[var(--color-rule-strong)] " +
                "border-l-[3px] bg-[var(--color-paper-hi)] px-4 py-3 text-[length:var(--text-sm)] " +
                "shadow-[0_20px_44px_-32px_rgb(27_23_17_/_0.65)] " +
                style.edge
              }
            >
              <Icon name={style.iconName} size={16} className={"mt-1 shrink-0 " + style.icon} />
              <div className="min-w-0 flex-1">
                <p className="font-[family-name:var(--font-outlier)] text-[8px] tracking-[0.2em] text-[var(--color-muted)]">
                  {style.label}
                </p>
                <p className="mt-0.5 leading-6 text-[var(--color-ink)]">{item.message}</p>
              </div>
              {item.action && (
                <button
                  type="button"
                  onClick={item.action.run}
                  className="pointer-events-auto shrink-0 border border-[var(--color-rule)] px-2.5 py-1 text-[11px] text-[var(--color-accent)] transition-colors hover:border-[var(--color-accent)]"
                >
                  {item.action.label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
