"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { FileSpreadsheet, FolderOpen, Upload, ShieldCheck } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { cn } from "@/src/lib/utils";

export function UploadDropzone({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // Dropping outside the target must not navigate away and discard the session.
    function preventFileNavigation(event: globalThis.DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      if (event.type === "drop") {
        dragDepth.current = 0;
        setDragging(false);
      }
    }
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (disabled || !event.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  return (
    <section aria-labelledby="upload-heading" className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/30 sm:p-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 id="upload-heading" className="text-sm font-semibold text-slate-900">Add your CSV files</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">Select your exports, then import them when you’re ready.</p>
        </div>
        <span className="rounded-md border border-slate-200 px-2 py-1 font-mono text-[10px] font-medium text-slate-500">.CSV</span>
      </div>
      <div
        onDragEnter={onDragEnter}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = disabled ? "none" : "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!disabled) onFiles(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "flex min-h-60 flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors",
          dragging && !disabled ? "border-emerald-600 bg-emerald-50" : "border-slate-200 bg-slate-50/60",
          disabled && "opacity-60",
        )}
      >
        <div className={cn("mb-4 flex size-12 items-center justify-center rounded-xl border bg-white shadow-sm", dragging ? "border-emerald-200 text-emerald-700" : "border-slate-200 text-slate-500")}>
          {dragging ? <FileSpreadsheet className="size-6" aria-hidden="true" strokeWidth={1.5} /> : <Upload className="size-5" aria-hidden="true" strokeWidth={1.8} />}
        </div>
        <p className="text-sm font-medium text-slate-800">{dragging ? "Drop your files here" : "Drag and drop your files here"}</p>
        <p className="mt-1.5 text-xs text-slate-500">or choose them from your computer</p>
        <Button variant="outline" disabled={disabled} onClick={() => inputRef.current?.click()} className="mt-5 h-9 gap-2 bg-white px-4 text-xs shadow-sm">
          <FolderOpen className="size-3.5" aria-hidden="true" /> Select files
        </Button>
        <input
          ref={inputRef}
          id="csv-files"
          type="file"
          multiple
          accept=".csv,.tsv,text/csv,text/tab-separated-values"
          aria-label="Select CSV or TSV files"
          hidden
          disabled={disabled}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length) onFiles(files);
          }}
        />
        <p className="mt-4 text-[11px] text-slate-500">UTF-8 CSV or TSV · Multiple files supported</p>
      </div>
      <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
        <ShieldCheck className="size-3.5 text-emerald-700" aria-hidden="true" />
        Processed on your device. Never uploaded.
      </p>
    </section>
  );
}
