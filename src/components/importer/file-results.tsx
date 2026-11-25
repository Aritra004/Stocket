"use client";

import { Fragment } from "react";
import { Check, CircleAlert, Eye, FileSpreadsheet, Files, LoaderCircle, Trash2 } from "lucide-react";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { getImportFileLabels, type ImportEntry } from "@/src/lib/importer/import-session";
import type { ValidationIssue } from "@/src/lib/importer/types";
import { cn } from "@/src/lib/utils";
import { ValidationIssues } from "./validation-issues";
import { PreservedRecords } from "./preserved-records";

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileStatus({ entry }: { entry: ImportEntry }) {
  if (entry.phase === "parsing") return <Badge variant="outline" className="gap-1.5 border-emerald-200 bg-emerald-50 font-medium text-emerald-800"><LoaderCircle aria-hidden="true" className="size-3 motion-safe:animate-spin" /> Importing</Badge>;
  if (!entry.result) return <Badge variant="outline" className="gap-1.5 border-slate-200 bg-slate-50 font-normal text-slate-600"><span className="size-1.5 rounded-full bg-slate-400" /> Ready to import</Badge>;
  const { status } = entry.result;
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", status === "success" ? "border-emerald-200/70 bg-emerald-50 text-emerald-800" : status === "warning" ? "border-amber-200/70 bg-amber-50 text-amber-800" : "border-red-200/70 bg-red-50 text-red-700")}>
      {status === "success" ? <Check className="size-3" aria-hidden="true" /> : <CircleAlert className="size-3" aria-hidden="true" />}
      {status === "success" ? "CSV parsed" : status === "warning" ? "CSV parsed with warnings" : status === "unsupported" ? "Unsupported file format" : "CSV errors"}
    </Badge>
  );
}

export function FileResults({ entries, selectedId, busy, onRemove, onInspect, onClear }: {
  entries: ImportEntry[];
  selectedId: string | null;
  busy: boolean;
  onRemove: (id: string) => void;
  onInspect: (id: string) => void;
  onClear: () => void;
}) {
  const fileLabels = getImportFileLabels(entries);
  const nameCounts = new Map<string, number>();
  entries.forEach((entry) => nameCounts.set(entry.file.name, (nameCounts.get(entry.file.name) ?? 0) + 1));

  return (
    <section aria-labelledby="files-heading" className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
      <div className="flex min-h-19 flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
        <div>
          <h2 id="files-heading" className="flex items-center gap-2 text-sm font-semibold text-slate-900">Your files <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-500">{entries.length}</span></h2>
          <p className="mt-1 text-xs text-slate-500">This session’s selection and previews. Removing these entries does not delete saved imports.</p>
        </div>
        {entries.length > 0 && <Button variant="ghost" size="sm" onClick={onClear} disabled={busy} className="h-9 text-xs text-slate-500">Clear preview session</Button>}
      </div>
      {entries.length === 0 ? (
        <div className="flex min-h-39 flex-col items-center justify-center border-t border-slate-100 px-5 py-8 text-center">
          <Files className="mb-3 size-6 text-slate-300" aria-hidden="true" strokeWidth={1.5} />
          <p className="text-xs font-medium text-slate-600">No files selected yet</p>
          <p className="mt-1.5 text-xs text-slate-500">Files you add will appear here, ready for import.</p>
        </div>
      ) : (
        <div className="max-h-[28rem] overflow-auto border-t border-slate-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-700" role="region" aria-label="Selected files and import results" tabIndex={0}>
          <table className="w-full min-w-[690px] text-left text-xs">
            <caption className="sr-only">Selected files with import status, parsed row counts, detected column counts, and actions.</caption>
            <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50 text-[10px] tracking-wide text-slate-500 uppercase">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium sm:pl-6">File name</th>
                <th scope="col" className="px-3 py-3 font-medium">Status</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Rows</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Columns</th>
                <th scope="col" className="px-5 py-3 text-right font-medium sm:pr-6">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((entry) => {
                const label = fileLabels.get(entry.id) ?? entry.file.name;
                const sameName = (nameCounts.get(entry.file.name) ?? 0) > 1;
                const extraIssues: ValidationIssue[] = sameName ? [{
                  severity: "info", category: "session", code: "DuplicateFileName",
                  message: "Another selected file has this name. Matching filenames alone do not mean matching contents. Each selection remains separate; saved duplicates are checked by content.",
                }] : [];
                return (
                <Fragment key={entry.id}>
                <tr className={cn("transition-colors hover:bg-slate-50/80", entry.id === selectedId && "bg-emerald-50/30")}>
                  <th scope="row" className="max-w-72 px-5 py-4 font-normal sm:pl-6">
                    <div className="flex items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-400"><FileSpreadsheet className="size-4" aria-hidden="true" strokeWidth={1.7} /></span>
                      <div className="min-w-0"><p id={`file-${entry.id}`} className="truncate font-medium text-slate-800" title={label}>{label}</p><p className="mt-1 text-[10px] text-slate-500">{formatFileSize(entry.file.size)}</p></div>
                    </div>
                  </th>
                  <td className="px-3 py-4"><FileStatus entry={entry} /></td>
                  <td className="px-3 py-4 text-right tabular-nums text-slate-600">{entry.result ? entry.result.totalRows.toLocaleString() : <span aria-label="Not parsed">—</span>}</td>
                  <td className="px-3 py-4 text-right tabular-nums text-slate-600">{entry.result ? entry.result.columns.length.toLocaleString() : <span aria-label="Not detected">—</span>}</td>
                  <td className="px-5 py-4 sm:pr-6"><div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon" disabled={!entry.result} onClick={() => onInspect(entry.id)} aria-label={`Preview ${label}`} title={`Preview ${label}`} className="size-9 text-slate-500"><Eye className="size-4" aria-hidden="true" /></Button>
                    <Button variant="ghost" size="icon" disabled={busy} onClick={() => onRemove(entry.id)} aria-label={`Remove ${label}`} title={`Remove ${label}`} className="size-9 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="size-3.5" aria-hidden="true" /></Button>
                  </div></td>
                </tr>
                {(entry.result || sameName) && (
                  <tr>
                    <td colSpan={5} className="bg-slate-50/20 px-5 pt-1 pb-5 sm:px-6">
                      <section aria-labelledby={`validation-${entry.id} file-${entry.id}`} className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 id={`validation-${entry.id}`} className="text-[11px] font-semibold text-slate-500">Validation results</h3>
                          {entry.result?.stockyValidation === "unsupported" && <span className="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600">Stocky field mapping unavailable</span>}
                          {entry.result?.normalized.schema.status === "matched" && <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">{entry.result.normalized.schema.adapter.label} · v{entry.result.normalized.schema.adapter.version} · Unverified fixture</span>}
                        </div>
                        <ValidationIssues result={entry.result} extraIssues={extraIssues} />
                        {entry.result && <PreservedRecords records={entry.result.recordsWithIssues} fileName={label} />}
                      </section>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
