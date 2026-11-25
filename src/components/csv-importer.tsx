"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ArrowRight, CheckCheck, CircleAlert, Files, HardDrive, Info, List, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { parseCsvFile } from "@/src/lib/importer/csv-parser";
import { createImportEntries, getImportFileLabels, importSessionReducer, initialImportSession, summarizeImports } from "@/src/lib/importer/import-session";
import { unexpectedFailureResult } from "@/src/lib/importer/validators";
import { Button } from "@/src/components/ui/button";
import { Progress } from "@/src/components/ui/progress";
import { UploadDropzone } from "@/src/components/importer/upload-dropzone";
import { FileResults, formatFileSize } from "@/src/components/importer/file-results";
import { DataPreview } from "@/src/components/importer/data-preview";
import { ArchiveReviewIssues, LocalArchive } from "@/src/components/importer/local-archive";
import { clearLocalArchive, importAndSaveFile, listLocalImports, loadLocalReview, removeLocalImport } from "@/src/lib/storage/archive-client";
import type { StoredImport, StoredValidationIssue } from "@/src/lib/storage/types";
import type { CsvImportResult } from "@/src/lib/importer/types";

function storageNotice(result: CsvImportResult, code: string, message: string): CsvImportResult {
  return { ...result, infoCount: result.infoCount + 1, info: [{ severity: "info", category: "environment", code, message }, ...result.info] };
}

interface SavedPreview { file: StoredImport; result: CsvImportResult; issues: StoredValidationIssue[] }

export default function CsvImporter() {
  const [session, dispatch] = useReducer(importSessionReducer, initialImportSession);
  const [notice, setNotice] = useState("");
  const [savedImports, setSavedImports] = useState<StoredImport[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(true);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [savedPreview, setSavedPreview] = useState<SavedPreview | null>(null);
  const [reviewSaved, setReviewSaved] = useState(false);
  const importLock = useRef(false);
  const archiveReadVersion = useRef(0);
  const summary = summarizeImports(session.entries);
  const busy = session.batch !== null || archiveBusy || archiveLoading;
  const currentFile = session.entries.find((entry) => entry.phase === "parsing");
  const fileLabels = getImportFileLabels(session.entries);
  const sessionPreviews = session.entries.flatMap((entry) => entry.result ? [{ id: entry.id, fileName: fileLabels.get(entry.id) ?? entry.file.name, result: entry.result }] : []);
  const previews = savedPreview ? [{ id: `saved:${savedPreview.file.id}`, fileName: `${savedPreview.file.fileName} (saved locally)`, result: savedPreview.result }, ...sessionPreviews] : sessionPreviews;
  const selectedId = reviewSaved && savedPreview ? `saved:${savedPreview.file.id}` : sessionPreviews.find((file) => file.id === session.selectedId)?.id ?? sessionPreviews[0]?.id ?? null;

  const refreshArchive = useCallback(async () => {
    const version = ++archiveReadVersion.current;
    setArchiveLoading(true);
    try {
      const files = await listLocalImports();
      if (version !== archiveReadVersion.current) return;
      setSavedImports(files);
      setArchiveError("");
      // Overlap issues can change when any other import changes. Reload reviews
      // explicitly rather than retaining stale evidence from another tab.
      setSavedPreview(null);
      setReviewSaved(false);
    } catch {
      if (version === archiveReadVersion.current) setArchiveError("Saved imports could not be read. Browser storage may be unavailable or full. You can still preview files locally; refresh this list to retry.");
    } finally {
      if (version === archiveReadVersion.current) setArchiveLoading(false);
    }
  }, []);

  useEffect(() => {
    // IndexedDB is opened only after mount, never during server rendering.
    const version = ++archiveReadVersion.current;
    void listLocalImports().then((files) => {
      if (version !== archiveReadVersion.current) return;
      setSavedImports(files);
      setArchiveError("");
    }).catch(() => {
      if (version === archiveReadVersion.current) setArchiveError("Saved imports could not be read. Browser storage may be unavailable or full. You can still preview files locally; refresh this list to retry.");
    }).finally(() => {
      if (version === archiveReadVersion.current) setArchiveLoading(false);
    });
    const onFocus = () => { if (!importLock.current) void refreshArchive(); };
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("focus", onFocus); archiveReadVersion.current += 1; };
  }, [refreshArchive]);

  function addFiles(files: File[]) {
    // Returning from a native file picker can trigger a metadata refresh. That
    // background read must not discard the user's newly selected files.
    if (importLock.current || session.batch !== null || archiveBusy) return;
    if (!files.length) {
      setNotice("No readable files were found. Use Select files to choose CSV or TSV files.");
      return;
    }
    const entries = createImportEntries(files);
    const rejected = entries.filter((entry) => entry.result).length;
    dispatch({ type: "add", entries });
    setNotice(`${files.length} ${files.length === 1 ? "file" : "files"} added.${rejected ? ` ${rejected} could not be accepted. Review the messages below each file.` : " Ready to import."}`);
  }

  async function importFiles() {
    if (importLock.current || busy) return;
    const pending = session.entries.filter((entry) => entry.phase === "queued");
    if (!pending.length) return;
    importLock.current = true;
    setNotice("");
    setSavedPreview(null);
    setReviewSaved(false);
    dispatch({ type: "start", ids: pending.map((entry) => entry.id) });
    let saved = 0;
    let duplicate = 0;
    let unconfirmed = 0;
    try {
      for (const entry of pending) {
        dispatch({ type: "parsing", id: entry.id });
        let result;
        try {
          const outcome = await importAndSaveFile(entry.file);
          if (outcome.kind === "duplicate") {
            duplicate += 1;
            result = storageNotice(outcome.result, "DuplicateFileContent", `This file has exactly the same contents as the saved import ${outcome.file.fileName}. No second copy was saved. Source evidence uses the original saved filename.`);
          } else {
            saved += 1;
            result = storageNotice(outcome.result, "SavedLocally", "This import was saved in this browser and will be available after refresh.");
          }
        } catch {
          unconfirmed += 1;
          // A storage error must not prevent local review or later file imports.
          try { result = await parseCsvFile(entry.file); }
          catch { result = unexpectedFailureResult(entry.file); }
          result = storageNotice(result, "LocalSaveUnconfirmed", "Saving could not be confirmed. This preview is available for this session. Check the saved list before retrying; browser storage may be unavailable or full.");
        }
        dispatch({ type: "result", id: entry.id, result });
      }
      await refreshArchive();
      setNotice(`Processed locally: ${saved} saved, ${duplicate} identical ${duplicate === 1 ? "file" : "files"} already saved${unconfirmed ? `, ${unconfirmed} with saving unconfirmed` : ""}. Review each file below.`);
    } finally {
      dispatch({ type: "finish" });
      importLock.current = false;
    }
  }

  function inspectFile(id: string) {
    setReviewSaved(false);
    dispatch({ type: "select", id });
    document.getElementById("data-preview")?.scrollIntoView({ block: "start" });
    document.getElementById("data-preview")?.focus({ preventScroll: true });
  }

  async function inspectSavedFile(id: string) {
    if (importLock.current || busy) return;
    importLock.current = true;
    setArchiveBusy(true);
    try {
      const review = await loadLocalReview(id);
      if (!review) {
        setNotice("This saved import is no longer available. The saved list has been refreshed.");
        await refreshArchive();
        return;
      }
      setSavedPreview(review);
      setReviewSaved(true);
      document.getElementById("data-preview")?.scrollIntoView({ block: "start" });
      document.getElementById("data-preview")?.focus({ preventScroll: true });
    } catch {
      setNotice("This saved import could not be read. Refresh the saved list and try again.");
    } finally {
      importLock.current = false;
      setArchiveBusy(false);
    }
  }

  async function changeArchive(action: "remove" | "clear" | "replace", id?: string, file?: File, expectedHash?: string) {
    if (importLock.current || busy) return;
    importLock.current = true;
    setArchiveBusy(true);
    try {
      if (action === "clear") {
        await clearLocalArchive();
        dispatch({ type: "clear" });
        setNotice("All saved data and the current preview session were cleared from this browser.");
      } else if (action === "remove" && id) {
        await removeLocalImport(id, expectedHash);
        setNotice("The saved import and its linked records were removed. Other imports remain saved.");
      } else if (action === "replace" && id && file) {
        const outcome = await importAndSaveFile(file, id, expectedHash);
        setNotice(outcome.kind === "duplicate" ? `These contents are already saved as ${outcome.file.fileName}. No import was replaced.` : `${file.name} was saved as the replacement. Overlapping orders remain separate for review.`);
      }
      setSavedPreview(null);
      setReviewSaved(false);
    } catch (error) {
      setNotice(`The ${action === "replace" ? "replacement" : "archive change"} was not confirmed. ${error instanceof Error ? error.message : "Browser storage may be unavailable."} Check the refreshed saved list before trying again.`);
    } finally {
      await refreshArchive();
      importLock.current = false;
      setArchiveBusy(false);
    }
  }

  const metrics = [
    { label: "Files selected", value: summary.totalFiles, detail: summary.totalFiles ? `${formatFileSize(summary.totalBytes)} in this session` : "Your session starts here", icon: Files },
    { label: "Total parsed rows", value: summary.totalRows, detail: "Across processed files", icon: List },
    { label: "Successful imports", value: summary.successful, detail: summary.warnings ? `${summary.warnings} with warnings to review` : "Ready for preview", icon: CheckCheck },
    { label: "Failed imports", value: summary.failed, detail: summary.failed ? "Review the messages below each file" : "No issues to resolve", icon: CircleAlert },
  ];

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4" aria-label="Import summary">
        {metrics.map(({ label, value, detail, icon: Icon }) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm shadow-slate-200/20 sm:px-5 sm:py-5">
            <dt className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-500 sm:text-xs">{label}<Icon className="hidden size-4 text-slate-400 min-[380px]:block" aria-hidden="true" strokeWidth={1.7} /></dt>
            <dd className="mt-3 text-[28px] leading-none font-semibold tracking-tight tabular-nums text-slate-900">{value.toLocaleString()}</dd>
            <p className="mt-2.5 text-[10px] leading-4 text-slate-500 sm:text-[11px]">{detail}</p>
          </div>
        ))}
      </dl>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <UploadDropzone onFiles={addFiles} disabled={session.batch !== null || archiveBusy} />
        <aside id="privacy" aria-labelledby="privacy-heading" className="scroll-mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/30 sm:p-6">
          <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-800"><ShieldCheck className="size-5" aria-hidden="true" strokeWidth={1.6} /></div>
          <h2 id="privacy-heading" className="text-sm font-semibold text-slate-900">Your data stays yours.</h2>
          <p className="mt-2 text-xs leading-5 text-slate-500">Your purchase history belongs on your device. We keep it that way.</p>
          <ul className="mt-6 space-y-5">
            <li className="flex gap-3"><HardDrive className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" /><div><p className="text-xs font-medium text-slate-700">Processed in your browser</p><p className="mt-1 text-[11px] leading-4 text-slate-500">Your files are never sent to a server.</p></div></li>
            <li className="flex gap-3"><LockKeyhole className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" /><div><p className="text-xs font-medium text-slate-700">No Shopify connection needed</p><p className="mt-1 text-[11px] leading-4 text-slate-500">No access to your Shopify store.</p></div></li>
            <li className="flex gap-3"><CheckCheck className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" /><div><p className="text-xs font-medium text-slate-700">Original values, preserved</p><p className="mt-1 text-[11px] leading-4 text-slate-500">Inspect your data as it was exported.</p></div></li>
          </ul>
          <p className="mt-6 border-t border-slate-100 pt-4 text-[11px] leading-4 text-slate-500">Saved imports stay in this browser after refresh. Manage or clear them in the local archive below. No purchasing data leaves your device.</p>
        </aside>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/20 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0 flex-1">
          {session.batch ? (
            <div className="max-w-lg">
              <p className="flex items-center gap-2 text-xs font-medium text-slate-700"><LoaderCircle className="size-3.5 shrink-0 text-emerald-700 motion-safe:animate-spin" aria-hidden="true" /><span className="truncate">Importing {currentFile?.file.name ?? "your files"}</span></p>
              <Progress value={(session.batch.completed / session.batch.ids.length) * 100} max={100} aria-label="Files processed" aria-valuetext={`${session.batch.completed} of ${session.batch.ids.length} files complete`} className="mt-2.5 h-1.5 bg-slate-100" />
              <p className="mt-1.5 text-[11px] text-slate-500">{session.batch.completed} of {session.batch.ids.length} files complete · Processing locally</p>
            </div>
          ) : (
            <p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><Info className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" /><span>{summary.pending ? `${summary.pending} ${summary.pending === 1 ? "file is" : "files are"} ready. Import to check the structure and preview your data.` : summary.totalFiles ? "Add more files to continue, or explore your results below." : "Add your CSV exports above to get started."}</span></p>
          )}
          <p role="status" aria-live="polite" className={notice ? "mt-1.5 text-[11px] leading-5 text-slate-600" : "sr-only"}>
            {session.batch ? `${session.batch.completed} of ${session.batch.ids.length} files processed.` : archiveBusy ? "Working with the local archive…" : notice}
          </p>
        </div>
        <Button onClick={importFiles} disabled={busy || summary.pending === 0} className="h-10 shrink-0 gap-2 rounded-lg bg-emerald-900 px-5 text-xs shadow-sm hover:bg-emerald-950">
          {session.batch ? <><LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />Importing files…</> : <>Import {summary.pending > 0 ? `${summary.pending} ${summary.pending === 1 ? "file" : "files"}` : "files"}<ArrowRight className="size-3.5" aria-hidden="true" /></>}
        </Button>
      </div>

      <LocalArchive imports={savedImports} loading={archiveLoading} error={archiveError} busy={session.batch !== null || archiveBusy} selectedId={reviewSaved ? savedPreview?.file.id ?? null : null}
        onRefresh={() => { if (!importLock.current) void refreshArchive(); }} onInspect={(id) => void inspectSavedFile(id)}
        onReplace={(id, file, hash) => changeArchive("replace", id, file, hash)} onRemove={(id, hash) => changeArchive("remove", id, undefined, hash)} onClear={() => changeArchive("clear")} />
      <FileResults entries={session.entries} selectedId={reviewSaved ? null : selectedId} busy={busy}
        onRemove={(id) => {
          if (importLock.current) return;
          const file = session.entries.find((entry) => entry.id === id);
          dispatch({ type: "remove", id });
          setNotice(`${file?.file.name ?? "File"} removed from this session.`);
        }}
        onInspect={inspectFile}
        onClear={() => {
          if (importLock.current) return;
          dispatch({ type: "clear" });
          setNotice("Preview session cleared. Locally saved imports remain in the archive.");
        }}
      />
      <div id="data-preview" tabIndex={-1} className="scroll-mt-6 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-emerald-700/30">
        {reviewSaved && savedPreview && <ArchiveReviewIssues key={savedPreview.file.id} file={savedPreview.file} issues={savedPreview.issues} imports={savedImports} onInspect={(id) => void inspectSavedFile(id)} />}
        <DataPreview files={previews} selectedId={selectedId} onSelect={(id) => {
          if (savedPreview && id === `saved:${savedPreview.file.id}`) setReviewSaved(true);
          else { setReviewSaved(false); dispatch({ type: "select", id }); }
        }} busy={busy} />
      </div>
    </div>
  );
}
