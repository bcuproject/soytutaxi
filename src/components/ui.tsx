import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { cx } from "../lib/format";

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "outline" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cab-400 disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-cab-500 text-ink-950 hover:bg-cab-400",
        variant === "outline" && "border border-ink-600 text-white hover:border-ink-400",
        variant === "ghost" && "text-ink-300 hover:text-white",
        className,
      )}
    />
  );
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-300">{label}</span>
      {children}
      {error ? <span role="alert" className="mt-1 block text-xs text-red-400">{error}</span>
        : hint ? <span className="mt-1 block text-xs text-ink-400">{hint}</span> : null}
    </label>
  );
}

const inputCls = (invalid?: boolean) => cx(
  "w-full rounded-xl border bg-ink-900 px-4 py-3 text-sm text-white placeholder:text-ink-400 focus:outline-none focus:ring-2",
  invalid ? "border-red-500/70 focus:ring-red-500/40" : "border-ink-700 focus:border-cab-500 focus:ring-cab-500/30",
);

export function Input({ invalid, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...p} aria-invalid={invalid || undefined} className={cx(inputCls(invalid), "[color-scheme:dark]", className)} />;
}

export function Select({ invalid, className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return <select {...p} aria-invalid={invalid || undefined} className={cx(inputCls(invalid), "appearance-none", className)}>{children}</select>;
}

export function Counter({ label, value, min, max, onChange, error }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; error?: string }) {
  const btn = "h-10 w-10 rounded-lg border border-ink-700 text-lg text-white hover:border-cab-500 disabled:opacity-30";
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-300">{label}</span>
      <div className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 p-1.5">
        <button type="button" aria-label={`${label} −`} className={btn} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
        <span className="flex-1 text-center text-lg font-semibold tabular-nums" aria-live="polite">{value}</span>
        <button type="button" aria-label={`${label} +`} className={btn} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
      </div>
      {error && <span role="alert" className="mt-1 block text-xs text-red-400">{error}</span>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  needs_driver: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  held: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  confirmed: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  requested: "bg-ink-700 text-ink-300 ring-ink-600",
  closed: "bg-ink-700 text-ink-300 ring-ink-600",
  cancelled: "bg-red-500/10 text-red-300 ring-red-500/25",
  neutral: "bg-ink-800 text-ink-300 ring-ink-600",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
};

export function Badge({ tone = "neutral", children }: { tone?: string; children: ReactNode }) {
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset", BADGE[tone] ?? BADGE.neutral)}>{children}</span>;
}

export function DemoBanner({ text }: { text: string }) {
  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-[repeating-linear-gradient(135deg,#f5c400_0_12px,#0a0a0a_12px_24px)] py-0.5">
      <span className="rounded bg-ink-950 px-3 py-0.5 font-mono text-[11px] font-bold tracking-wider text-cab-400">{text}</span>
    </div>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-cab-500 text-ink-950">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden><path d="M5 11l1.5-4.5A2 2 0 018.4 5h7.2a2 2 0 011.9 1.5L19 11h1a1 1 0 011 1v5h-2v1.5a1.5 1.5 0 01-3 0V17H8v1.5a1.5 1.5 0 01-3 0V17H3v-5a1 1 0 011-1h1zm2.1 0h9.8l-1.1-3.4a.7.7 0 00-.7-.6H8.9a.7.7 0 00-.7.6L7.1 11zM6.5 15a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5zm11 0a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5z" /></svg>
      </span>
      <span>SoyTu<span className="text-cab-500">Taxi</span></span>
    </span>
  );
}
