import type { FieldState } from "@/src/lib/stocky/types";
import { cn } from "@/src/lib/utils";

export interface DisplayField { state: FieldState; value: unknown }

/** Only literal observations are displayed as imported business values. */
export function observedValue(field: DisplayField): string | null {
  return field.state === "observed" && field.value !== null && field.value !== undefined ? String(field.value) : null;
}

export function FieldValue({ field, className }: { field: DisplayField; className?: string }) {
  const value = observedValue(field);
  if (value !== null) return <span className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere]", className)}>{value}</span>;
  const labels = { missing: "Not provided", invalid: "Invalid value", conflicting: "Conflicting values", derived: "Calculated · not imported", observed: "Not provided" };
  return <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[11px] font-normal", field.state === "invalid" || field.state === "conflicting" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-500", className)}>{labels[field.state]}</span>;
}
