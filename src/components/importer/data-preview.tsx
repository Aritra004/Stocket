"use client";

import { useId } from "react";
import { AlertCircle, ChevronDown, Columns3, FileSpreadsheet, Info, LoaderCircle, Table2 } from "lucide-react";
import type { CsvImportResult } from "@/src/lib/importer/types";
import { ValidationIssues } from "./validation-issues";
import { PreservedRecords } from "./preserved-records";
import { NormalizedReview } from "./normalized-review";

interface PreviewFile {
  id: string;
  fileName: string;
  result: CsvImportResult;
}

interface DataPreviewProps {
  files: PreviewFile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  busy?: boolean;
}

function delimiterName(value: string | null): string {
  const names: Record<string, string> = {
    ",": "Comma", "\t": "Tab", ";": "Semicolon", "|": "Pipe",
    "\u001e": "Record separator", "\u001f": "Unit separator",
  };
  return value === null ? "Not detected" : names[value] ?? JSON.stringify(value);
}

export function DataPreview({ files, selectedId, onSelect, busy = false }: DataPreviewProps) {
  const selectId = useId();
  const headingId = useId();
  const selected = files.find((file) => file.id === selectedId) ?? files[0];
  const result = selected?.result;
  const failed = result?.status === "error" || result?.status === "unsupported";
  const width = result ? Math.max(result.columns.length, ...result.preview.map((record) => record.values.length)) : 0;

  return (
    <section aria-labelledby={headingId} className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
      <div className="flex flex-col gap-5 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500">
            <Table2 className="size-4" aria-hidden="true" />
          </div>
          <div>
            <h2 id={headingId} className="text-base font-semibold tracking-tight text-slate-900">Data preview</h2>
            <p className="mt-0.5 text-sm text-slate-500">A first look at your original data.</p>
          </div>
        </div>
        <div className="w-full min-w-0 sm:w-64">
          <label htmlFor={selectId} className="sr-only">Select an imported file</label>
          <div className="relative">
            <FileSpreadsheet className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <select
              id={selectId}
              value={selected?.id ?? ""}
              onChange={(event) => onSelect(event.target.value)}
              disabled={files.length === 0}
              className="h-10 w-full min-w-0 appearance-none truncate rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-sm text-slate-700 shadow-xs outline-none transition focus-visible:border-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-600/15 disabled:bg-slate-50 disabled:text-slate-400"
            >
              {files.length === 0 && <option value="">No imported files</option>}
              {files.map((file) => <option key={file.id} value={file.id}>{file.fileName}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          </div>
        </div>
      </div>

      {!result ? (
        <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-400 shadow-xs">
            {busy ? <LoaderCircle className="size-6 motion-safe:animate-spin" aria-hidden="true" /> : <Table2 className="size-6" aria-hidden="true" />}
          </div>
          <h3 className="text-sm font-medium text-slate-800">
            {busy ? "Reading your files locally" : "Your data preview will appear here"}
          </h3>
          <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">
            {busy ? "The preview will be ready as soon as the first file finishes." : "Import a file to inspect its columns and first 10 records."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-xs text-slate-500 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="inline-flex items-center gap-1.5"><Columns3 className="size-3.5" aria-hidden="true" />{result.columns.length.toLocaleString()} detected columns</span>
              <span>{result.totalRows.toLocaleString()} parsed rows</span>
              <span>{delimiterName(result.delimiter)} delimited</span>
            </div>
            <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-medium text-slate-600">Original values</span>
          </div>

          <div className="space-y-3 px-5 pb-4 sm:px-6">
            <ValidationIssues result={result} />
            <PreservedRecords key={selected.id} records={result.recordsWithIssues} fileName={selected.fileName} />
          </div>

          {failed && result.preview.length > 0 && (
            <p className="mx-5 mb-4 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-800 sm:mx-6">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              These are recovered records. This file has parsing errors and its data may be incomplete.
            </p>
          )}

          {width > 0 ? (
            <div className="max-h-96 max-w-full overflow-auto border-y border-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600" role="region" aria-label={`CSV preview for ${selected.fileName}`} tabIndex={0}>
              <table className="w-full border-collapse text-left text-xs">
                <caption className="sr-only">Detected CSV headers and the first {result.preview.length} records from {selected.fileName}</caption>
                <thead className="sticky top-0 z-10 bg-slate-50">
                  <tr className="border-b border-slate-200">
                    <th scope="col" className="w-14 px-5 py-3 text-xs font-medium text-slate-400">#</th>
                    {Array.from({ length: width }, (_, index) => (
                      <th key={index} scope="col" className="min-w-40 px-4 py-3 align-top font-medium text-slate-600">
                        <div className="max-w-64 whitespace-pre-wrap break-words">
                          {index >= result.columns.length ? `Extra field ${index + 1}` : result.columns[index] === "" ? `(empty header ${index + 1})` : result.columns[index]}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.preview.map((record) => (
                    <tr key={record.rowNumber} className="transition-colors hover:bg-slate-50/70">
                      <th scope="row" className="px-5 py-3.5 align-top font-normal tabular-nums text-slate-400">{record.rowNumber}</th>
                      {Array.from({ length: width }, (_, index) => (
                        <td key={index} className="px-4 py-3.5 align-top text-slate-700">
                          {index >= record.values.length ? (
                            <span className="text-xs italic text-slate-400">Missing cell</span>
                          ) : record.values[index] === "" ? (
                            <span className="text-xs italic text-slate-400">Empty</span>
                          ) : (
                            <div className="max-h-28 max-w-64 overflow-auto whitespace-pre-wrap break-words">{record.values[index]}</div>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {result.preview.length === 0 && (
                    <tr><td colSpan={width + 1} className="px-6 py-10 text-center text-sm text-slate-500">{failed ? "No data records could be recovered. Review the file errors above." : "The headers were detected, but this file contains no data records."}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex min-h-44 flex-col items-center justify-center border-y border-slate-100 px-6 py-8 text-center">
              <AlertCircle className="mb-3 size-6 text-slate-400" aria-hidden="true" />
              <h3 className="text-sm font-medium text-slate-800">No preview available</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">{failed ? "This file could not be imported. Review its errors above and select a valid CSV file." : "No columns or records were found in this file."}</p>
            </div>
          )}

          <div className="flex flex-col gap-2 px-5 py-3.5 text-xs leading-5 text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <span>Showing {result.preview.length} of {result.totalRows.toLocaleString()} parsed records</span>
            <span className="inline-flex items-center gap-1.5"><Info className="size-3.5 shrink-0" aria-hidden="true" />{result.normalized.schema.status === "matched" ? "Provisional normalized values can be reviewed below." : "Columns have not been mapped to Stocky fields."}</span>
          </div>
          <NormalizedReview key={selected.id} normalized={result.normalized} />
        </>
      )}
    </section>
  );
}
