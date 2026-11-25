"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Database, Eye, LoaderCircle, RefreshCw, Replace, Trash2 } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import type { StoredImport, StoredValidationIssue } from "@/src/lib/storage/types";
import { validateFile } from "@/src/lib/importer/validators";
import { formatFileSize } from "./file-results";

type PendingAction =
  | { kind: "clear" }
  | { kind: "remove"; target: StoredImport }
  | { kind: "replace"; target: StoredImport; file: File };

export function ArchiveConfirmation({ action, busy, onCancel, onConfirm }: {
  action: PendingAction; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const headingId = useId();
  const confirmation = useRef<HTMLElement>(null);
  useEffect(() => { confirmation.current?.focus(); }, []);
  return (
    <section ref={confirmation} tabIndex={-1} aria-labelledby={headingId} className="mx-5 mb-4 rounded-lg border border-red-200 bg-red-50/60 p-4 outline-none focus-visible:ring-2 focus-visible:ring-red-700/30 sm:mx-6">
      <h3 id={headingId} className="text-sm font-semibold text-slate-900">{action.kind === "clear" ? "Clear all saved data?" : action.kind === "remove" ? "Remove this saved import?" : "Replace this saved import?"}</h3>
      <p className="mt-2 break-words text-xs leading-5 text-slate-700">
        {action.kind === "clear" ? "This permanently removes every saved import, purchase order, line item, supplier observation, validation issue, and source reference from this browser. It also clears the current preview session. This cannot be undone. Your original files on disk are unchanged." : action.kind === "remove" ? <><strong>{action.target.fileName}</strong> and all records saved with this import will be removed from this browser. Other imports and your original file on disk are unchanged. This cannot be undone.</> : <><strong>{action.target.fileName}</strong> will be replaced by <strong>{action.file.name}</strong> ({formatFileSize(action.file.size)}). The original saved import will remain if the new file cannot be parsed or saved. Other imports are kept separate; matching order numbers will be flagged for review.</>}
      </p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" disabled={busy} onClick={onConfirm} className="bg-red-700 text-white hover:bg-red-800">{busy && <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />}{action.kind === "clear" ? "Yes, clear all saved data" : action.kind === "remove" ? "Yes, remove this import" : "Yes, replace this import"}</Button>
      </div>
    </section>
  );
}

export function LocalArchive({ imports, loading, error, busy, selectedId, onRefresh, onInspect, onReplace, onRemove, onClear }: {
  imports: StoredImport[]; loading: boolean; error: string; busy: boolean; selectedId: string | null;
  onRefresh: () => void; onInspect: (id: string) => void;
  onReplace: (id: string, file: File, expectedHash: string) => Promise<void>; onRemove: (id: string, expectedHash: string) => Promise<void>; onClear: () => Promise<void>;
}) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [replacementTarget, setReplacementTarget] = useState<StoredImport | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const disabled = busy || loading;

  async function confirm() {
    if (!pending || disabled) return;
    try {
      if (pending.kind === "clear") await onClear();
      else if (pending.kind === "remove") await onRemove(pending.target.id, pending.target.sha256);
      else await onReplace(pending.target.id, pending.file, pending.target.sha256);
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="archive-heading" className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-6">
        <div>
          <h2 id="archive-heading" className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Database className="size-4 text-emerald-800" aria-hidden="true" />Saved on this browser <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] tabular-nums text-emerald-900">{imports.length}</span></h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">Saved imports remain after refresh. Files with identical contents are stored once; overlapping orders stay separate for review.</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onRefresh} className="text-xs"><RefreshCw className="size-3.5" aria-hidden="true" />Refresh saved list</Button>
          <Button variant="ghost" size="sm" disabled={disabled || imports.length === 0} onClick={() => setPending({ kind: "clear" })} className="text-xs text-red-700">Clear all saved data</Button>
        </div>
      </div>
      <input ref={input} type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" className="hidden" aria-label="Choose replacement CSV file" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        // A focus-triggered metadata read may run when the native picker closes.
        if (!file || !replacementTarget || busy) return;
        const preflight = validateFile(file);
        if (preflight.errorCount) {
          setSelectionError(preflight.errors[0]?.message ?? "This file cannot be used as a replacement.");
          return;
        }
        setSelectionError("");
        setPending({ kind: "replace", target: replacementTarget, file });
      }} />
      {error && <p role="alert" className="mx-5 mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800 sm:mx-6">{error}</p>}
      {selectionError && <p role="alert" className="mx-5 mb-4 text-xs leading-5 text-red-700 sm:mx-6">{selectionError}</p>}
      {pending && <ArchiveConfirmation action={pending} busy={disabled} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />}
      {loading && <p role="status" className="flex items-center gap-2 px-5 pb-4 text-xs text-slate-500 sm:px-6"><LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />Reading saved imports from this browser…</p>}
      {imports.length === 0 ? <p className="border-t border-slate-100 px-5 py-7 text-center text-xs text-slate-500 sm:px-6">{error ? "Saved imports are unavailable. You can still preview files without saving them." : "No imports have been saved here yet. Import a CSV file to begin."}</p> : (
        <div role="region" aria-label="Locally saved imports" tabIndex={0} className="max-h-96 overflow-auto border-t border-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700">
          <table className="w-full min-w-[720px] text-left text-xs">
            <caption className="sr-only">Saved imports, normalized records, review issues, and local archive actions.</caption>
            <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th scope="col" className="px-5 py-3 font-medium sm:pl-6">Saved import</th><th scope="col" className="px-3 py-3 text-right font-medium">Parsed rows</th><th scope="col" className="px-3 py-3 text-right font-medium">Normalized</th><th scope="col" className="px-3 py-3 font-medium">Review</th><th scope="col" className="px-5 py-3 text-right font-medium sm:pr-6">Actions</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {imports.map((file, index) => {
                const label = `${file.fileName}, saved import ${index + 1}`;
                return <tr key={file.id} className={file.id === selectedId ? "bg-emerald-50/40" : "hover:bg-slate-50/60"}>
                  <th scope="row" className="max-w-72 px-5 py-4 font-normal sm:pl-6"><p className="truncate font-medium text-slate-800" title={file.fileName}>{file.fileName}</p><p className="mt-1 text-[10px] leading-5 text-slate-500">{formatFileSize(file.fileSize)} · {new Date(file.importedAt).toLocaleString()}</p><p className="font-mono text-[10px] text-slate-400" title={`SHA-256: ${file.sha256}`}>SHA-256 {file.sha256.slice(0, 12)}…</p></th>
                  <td className="px-3 py-4 text-right tabular-nums text-slate-600">{file.totalRows.toLocaleString()}</td>
                  <td className="px-3 py-4 text-right tabular-nums text-slate-600">{file.normalizedCount.toLocaleString()}</td>
                  <td className="px-3 py-4"><span className={file.reviewCount > 0 ? "font-medium text-amber-800" : "text-slate-500"}>{file.reviewCount > 0 ? `${file.reviewCount.toLocaleString()} issues` : "No review issues"}</span><p className="mt-1 text-[10px] text-slate-500">{file.status === "error" || file.status === "unsupported" ? "CSV needs attention" : "Saved locally"}</p></td>
                  <td className="px-5 py-4 sm:pr-6"><div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" disabled={disabled} onClick={() => onInspect(file.id)} aria-label={`Review ${label}`} title={`Review ${label}`} className="size-9 text-slate-500"><Eye className="size-4" aria-hidden="true" /></Button>
                    <Button variant="ghost" size="icon" disabled={disabled} onClick={() => { setReplacementTarget(file); setSelectionError(""); input.current?.click(); }} aria-label={`Replace ${label}`} title={`Replace ${label}`} className="size-9 text-slate-500"><Replace className="size-4" aria-hidden="true" /></Button>
                    <Button variant="ghost" size="icon" disabled={disabled} onClick={() => setPending({ kind: "remove", target: file })} aria-label={`Remove ${label}`} title={`Remove ${label}`} className="size-9 text-slate-400 hover:bg-red-50 hover:text-red-700"><Trash2 className="size-3.5" aria-hidden="true" /></Button>
                  </div></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-slate-100 px-5 py-3 text-[11px] leading-5 text-slate-500 sm:px-6">Stored in this browser profile on this device. Clearing site data, private browsing, or browser storage cleanup can remove saved imports. There is no server copy.</p>
    </section>
  );
}

export function ArchiveReviewIssues({ file, issues, imports, onInspect }: {
  file: StoredImport; issues: StoredValidationIssue[]; imports: StoredImport[]; onInspect: (id: string) => void;
}) {
  const [position, setPosition] = useState(0);
  const page = Math.min(position, Math.max(0, Math.ceil(issues.length / 20) - 1));
  const start = page * 20;
  const names = new Map(imports.map((item) => [item.id, item.fileName]));
  return <section aria-label={`Saved validation for ${file.fileName}`} className="mb-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
    <h2 className="text-sm font-semibold text-slate-900">Saved validation and overlapping orders</h2>
    <p className="mt-1 text-xs leading-5 text-slate-500">Reviewing {file.fileName}. Overlaps are possible matches, not confirmed identities. Records from different imports have not been merged.</p>
    {issues.length === 0 ? <p className="mt-3 text-xs text-slate-500">No saved validation issues.</p> : <>
      <ul className="mt-3 space-y-3">{issues.slice(start, start + 20).map((saved) => <li key={saved.id} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-xs leading-5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{saved.scope} · {saved.issue.severity}</p>
        <p className="mt-1 break-words text-slate-700">{saved.issue.message}</p>
        {(saved.issue.row !== undefined || saved.issue.column !== undefined) && <p className="mt-1 text-[11px] text-slate-500">{saved.issue.row !== undefined && `CSV record ${saved.issue.row}`}{saved.issue.column !== undefined && ` · Column ${saved.issue.column}`}</p>}
        {saved.relatedImportIds && saved.relatedImportIds.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-[11px] text-slate-500">Related saved imports:</span>{saved.relatedImportIds.slice(0, 5).map((id) => <button type="button" key={id} onClick={() => onInspect(id)} className="max-w-full truncate rounded text-[11px] font-medium text-emerald-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">{names.get(id) ?? "Saved import"}</button>)}{(saved.relatedImportCount ?? saved.relatedImportIds.length) > Math.min(5, saved.relatedImportIds.length) && <span className="text-[11px] text-slate-500">and {(saved.relatedImportCount ?? saved.relatedImportIds.length) - Math.min(5, saved.relatedImportIds.length)} more in the saved list</span>}</div>}
      </li>)}</ul>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2"><span className="text-[11px] tabular-nums text-slate-500">{start + 1}–{Math.min(start + 20, issues.length)} of {issues.length.toLocaleString()} saved issues</span><Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPosition(page - 1)} className="text-xs">Previous issues</Button><Button variant="outline" size="sm" disabled={start + 20 >= issues.length} onClick={() => setPosition(page + 1)} className="text-xs">Next issues</Button></div>
    </>}
  </section>;
}
