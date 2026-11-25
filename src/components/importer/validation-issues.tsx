import { CircleAlert, Info, ShieldCheck } from "lucide-react";
import type { CsvImportResult, ValidationIssue } from "@/src/lib/importer/types";

const categoryLabels: Record<ValidationIssue["category"], string> = {
  file: "File",
  parsing: "CSV format",
  structure: "Rows and columns",
  schema: "Stocky support",
  environment: "Browser",
  session: "File selection",
};

function IssueText({ issue }: { issue: ValidationIssue }) {
  return (
    <li className="min-w-0 [overflow-wrap:anywhere]">
      <p className="text-xs leading-5 text-slate-700">
        <span className="font-medium">{categoryLabels[issue.category]}: </span>
        {issue.message}
      </p>
      {(issue.row !== undefined || issue.column !== undefined) && (
        <p className="mt-0.5 text-[11px] text-slate-500">
          {issue.row !== undefined && `CSV record ${issue.row}`}
          {issue.row !== undefined && issue.column !== undefined && " · "}
          {issue.column !== undefined && `Column ${issue.column}`}
        </p>
      )}
    </li>
  );
}

/** Shared file-level diagnostics. Information never implies CSV parsing failed. */
export function ValidationIssues({ result, extraIssues = [] }: {
  result?: CsvImportResult;
  extraIssues?: ValidationIssue[];
}) {
  const groups = [
    { severity: "error", label: "Errors", issues: result?.errors ?? [], count: result?.errorCount ?? 0, styles: "border-red-200 bg-red-50/60", icon: CircleAlert, iconStyle: "text-red-600" },
    { severity: "warning", label: "Warnings", issues: result?.warnings ?? [], count: result?.warningCount ?? 0, styles: "border-amber-200 bg-amber-50/60", icon: CircleAlert, iconStyle: "text-amber-600" },
    { severity: "info", label: "Information", issues: result?.info ?? [], count: result?.infoCount ?? 0, styles: "border-slate-200 bg-slate-50/80", icon: Info, iconStyle: "text-slate-500" },
  ] as const;

  return (
    <div className="space-y-2">
      {result && result.errorCount === 0 && result.warningCount === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-800">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" /> No CSV errors or warnings found.
        </p>
      )}
      {groups.map(({ severity, label, issues, count, styles, icon: Icon, iconStyle }) => {
        const extra = extraIssues.filter((issue) => issue.severity === severity);
        const total = count + extra.length;
        if (total === 0) return null;
        const visible = [...extra, ...issues].slice(0, 20);
        const first = visible.slice(0, 2);
        const remaining = visible.slice(2);
        return (
          <div key={severity} className={`rounded-lg border px-3 py-3 ${styles}`}>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <Icon className={`size-3.5 shrink-0 ${iconStyle}`} aria-hidden="true" />
              {label} <span className="font-normal text-slate-500">({total.toLocaleString()})</span>
            </p>
            <ul className="space-y-2">{first.map((issue, index) => <IssueText key={index} issue={issue} />)}</ul>
            {remaining.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer rounded text-xs font-medium text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
                  Show {remaining.length} more {severity === "info" ? "notes" : severity === "error" ? "errors" : "warnings"}
                </summary>
                <ul className="mt-2 space-y-2">{remaining.map((issue, index) => <IssueText key={index} issue={issue} />)}</ul>
              </details>
            )}
            {total > visible.length && (
              <p className="mt-2 text-[11px] leading-4 text-slate-500">
                Showing the first {visible.length} of {total.toLocaleString()} {severity === "info" ? "notes" : severity === "error" ? "errors" : "warnings"}.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
