"use client";

import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CsvImportResult } from "@/src/lib/importer/types";
import { Button } from "@/src/components/ui/button";

/** Inspect every flagged record, including records beyond the ten-row preview. */
export function PreservedRecords({ records, fileName }: {
  records: CsvImportResult["recordsWithIssues"];
  fileName: string;
}) {
  const [position, setPosition] = useState(0);
  const regionId = useId();
  if (records.length === 0) return null;
  const index = Math.min(position, records.length - 1);
  const record = records[index];

  return (
    <details className="rounded-lg border border-slate-200 bg-white px-3 py-3">
      <summary className="cursor-pointer rounded text-xs font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
        {records.length.toLocaleString()} original {records.length === 1 ? "record kept" : "records kept"} for review
      </summary>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        Records with issues are kept separately, including those after the first 10 rows. This is their original CSV text; no corrections have been made.
      </p>
      <div className="my-3 flex flex-wrap items-center justify-between gap-3">
        <p id={regionId} className="text-xs font-medium text-slate-700" aria-live="polite">
          {record.dataRowNumber === null ? "Header" : `Data row ${record.dataRowNumber}`} · CSV record {record.recordNumber}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" disabled={index === 0} onClick={() => setPosition(index - 1)} aria-label={`Previous record with issues in ${fileName}`} className="size-8"><ChevronLeft className="size-3.5" aria-hidden="true" /></Button>
          <span className="text-[11px] tabular-nums text-slate-500">{index + 1} of {records.length.toLocaleString()}</span>
          <Button type="button" variant="outline" size="icon" disabled={index === records.length - 1} onClick={() => setPosition(index + 1)} aria-label={`Next record with issues in ${fileName}`} className="size-8"><ChevronRight className="size-3.5" aria-hidden="true" /></Button>
        </div>
      </div>
      <ul className="mb-3 space-y-1 text-xs leading-5 text-slate-600">
        {record.issues.slice(0, 5).map((issue, issueIndex) => <li key={issueIndex}>{issue.message}</li>)}
      </ul>
      {record.issues.length > 5 && <p className="mb-3 text-[11px] text-slate-500">Showing 5 of {record.issues.length.toLocaleString()} issues for this record.</p>}
      <pre role="region" aria-labelledby={regionId} tabIndex={0} className="max-h-56 w-full max-w-[min(75vw,64rem)] overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-5 whitespace-pre text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600">
        {record.rawText}
      </pre>
    </details>
  );
}
