"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/src/components/ui/button";
import { ARCHIVE_EXPORT_DISABLED, isArchiveExportEnabled } from "@/src/lib/export-access";
import { requestArchiveDownload } from "@/src/lib/download-archive";
import { startArchiveZipExport } from "@/src/lib/storage/zip-export-client";
import type { ExportProgress } from "@/src/lib/storage/zip-export";
import { zipExportErrorMessage } from "@/src/lib/storage/zip-export-errors";
import { getEntitlementStatus, type EntitlementStatus } from "@/src/lib/payments-client";

export function ArchiveZipExport({ hasImports, loading }: { hasImports: boolean; loading: boolean }) {
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const bypass = isArchiveExportEnabled();
  const [license, setLicense] = useState<EntitlementStatus | "checking">(bypass ? "active" : "checking");
  const enabled = bypass || license === "active";
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (bypass) return;
    const active = new AbortController();
    const refresh = () => {
      void getEntitlementStatus(active.signal).then((value) => { if (!active.signal.aborted) setLicense(value.status); })
        .catch(() => { if (!active.signal.aborted) setLicense("none"); });
    };
    refresh(); window.addEventListener("focus", refresh);
    return () => { active.abort(); window.removeEventListener("focus", refresh); };
  }, [bypass]);

  async function exportZip() {
    if (controller.current || !enabled) return;
    const active = new AbortController();
    controller.current = active;
    setExporting(true);
    setError("");
    setNotice("");
    setProgress({ phase: "starting", completed: 0, total: 1, percent: 0, message: "Starting background export…" });
    try {
      const archive = await startArchiveZipExport({ signal: active.signal, onProgress: setProgress });
      if (active.signal.aborted) return;
      requestArchiveDownload(archive.blob, archive.fileName);
      setNotice("ZIP download requested. Check your browser downloads and available disk space to confirm it saved. Extract the ZIP, then open index.html to browse offline.");
    } catch (failure) {
      if (!active.signal.aborted) setError(zipExportErrorMessage(failure));
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setExporting(false);
        setProgress(null);
      }
    }
  }

  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setExporting(false);
    setProgress(null);
    setNotice("Archive export cancelled. Your saved imports have not been changed.");
  }

  return <section aria-label="Offline archive export" className="space-y-4 rounded-lg border bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="max-w-2xl"><h2 className="text-sm font-semibold">Complete offline ZIP archive</h2><p className="mt-1 text-xs leading-5 text-slate-500">Includes a standalone viewer, unchanged original CSV files, normalized purchase orders, line items and supplier observations, a data-quality report, and instructions. All saved imports are included, regardless of dashboard filters. The ZIP is created entirely in this browser.</p>
        <p className="mt-2 text-xs font-medium text-amber-800">{bypass ? "Development/test export bypass is enabled. No purchase is simulated." : license === "active" ? "License verified for this browser. Access is checked again before export." : license === "checking" ? "Checking archive license…" : license === "pending" ? "Payment confirmation is pending. Check payment status before trying checkout again." : ARCHIVE_EXPORT_DISABLED}</p>
        {!bypass && license !== "active" && <Link href="/unlock" className="mt-2 inline-block text-xs font-medium text-emerald-800 underline">Unlock archive or recover license</Link>}
      </div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!enabled || exporting || loading || !hasImports} onClick={() => void exportZip()}>{exporting ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : <Download className="size-3.5" aria-hidden="true" />}{exporting ? "Preparing ZIP…" : "Export offline ZIP"}</Button>{exporting && <Button variant="ghost" size="sm" onClick={cancel}>Cancel export</Button>}</div>
    </div>
    {exporting && progress && <div className="space-y-2"><label className="block text-xs text-slate-600" htmlFor="archive-export-progress">{progress.message}</label><progress id="archive-export-progress" aria-label="Offline ZIP export progress" value={progress.percent} max={100} className="h-2 w-full accent-emerald-700" /><p role="status" aria-live="polite" className="text-xs tabular-nums text-slate-500">{Math.round(progress.percent)}% · {progress.message}</p></div>}
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {notice && <p role="status" className="text-xs leading-5 text-slate-600">{notice}</p>}
  </section>;
}
