"use client";

import { useId, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, GitBranch, Info } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import type { FieldState, NormalizedField, NormalizedImport, RecordSource, SourceCell } from "@/src/lib/stocky/types";

const stateLabels: Record<FieldState, string> = {
  observed: "Observed", missing: "Missing", derived: "Derived", conflicting: "Conflicting", invalid: "Invalid",
};
const stateStyles: Record<FieldState, string> = {
  observed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  missing: "border-slate-200 bg-slate-50 text-slate-600",
  derived: "border-blue-200 bg-blue-50 text-blue-800",
  conflicting: "border-amber-200 bg-amber-50 text-amber-900",
  invalid: "border-red-200 bg-red-50 text-red-800",
};
const fieldLabels: Record<string, string> = {
  purchaseOrderNumber: "Purchase order number", lineId: "Line ID", sku: "SKU", productName: "Product name",
  supplier: "Supplier", status: "Status", orderDate: "Order date", expectedDate: "Expected date", currency: "Currency",
  totalCost: "Total cost", unitCost: "Unit cost", orderedQuantity: "Ordered quantity", receivedQuantity: "Received quantity",
  outstandingQuantity: "Outstanding quantity",
};

function RecordNavigator({ count, index, onChange, label }: {
  count: number; index: number; onChange: (index: number) => void; label: string;
}) {
  const inputId = useId();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="icon" disabled={index === 0} onClick={() => onChange(index - 1)} aria-label={`Previous ${label}`} className="size-8"><ChevronLeft className="size-3.5" aria-hidden="true" /></Button>
      <span className="text-xs tabular-nums text-slate-600">{index + 1} of {count.toLocaleString()}</span>
      <Button type="button" variant="outline" size="icon" disabled={index >= count - 1} onClick={() => onChange(index + 1)} aria-label={`Next ${label}`} className="size-8"><ChevronRight className="size-3.5" aria-hidden="true" /></Button>
      <form className="ml-1 flex items-center gap-1.5" onSubmit={(event) => {
        event.preventDefault();
        const requested = Number(new FormData(event.currentTarget).get("record"));
        if (Number.isInteger(requested) && requested >= 1 && requested <= count) onChange(requested - 1);
      }}>
        <label htmlFor={inputId} className="sr-only">Go to {label}</label>
        <input key={index} id={inputId} name="record" type="number" min={1} max={count} step={1} required defaultValue={index + 1} className="h-8 w-17 rounded-md border border-slate-200 bg-white px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />
        <Button type="submit" variant="outline" size="sm" className="h-8 text-xs" aria-label={`Go to ${label}`}>Go</Button>
      </form>
    </div>
  );
}

function OriginalValue({ value }: { value: string | null }) {
  if (value === null) return <span className="italic text-slate-500">Cell absent</span>;
  if (value === "") return <span className="italic text-slate-500">Empty cell</span>;
  return <pre className="max-h-28 max-w-full overflow-auto whitespace-pre font-mono text-[11px] leading-5 text-slate-700">{value}</pre>;
}

function SourceEvidence({ sources }: { sources: SourceCell[] }) {
  const [position, setPosition] = useState(0);
  const index = Math.min(position, Math.max(0, sources.length - 1));
  const source = sources[index];
  if (!source) return <p className="text-[11px] text-slate-500">No source column was present. Nothing has been filled in.</p>;
  return (
    <div className="space-y-2">
      {sources.length > 1 && <RecordNavigator count={sources.length} index={index} onChange={setPosition} label="source value" />}
      <p className="break-all text-[11px] leading-5 text-slate-500">{source.fileName} · Data row {source.rowNumber} · CSV record {source.recordNumber} · Column {source.column}</p>
      <p className="text-[11px] text-slate-500">Original header: <span className="whitespace-pre-wrap text-slate-700">{source.header === null ? "No header for this column" : source.header === "" ? "Empty header" : source.header}</span></p>
      <div className="rounded-md border border-slate-200 bg-white px-2.5 py-2"><OriginalValue value={source.rawValue} /></div>
    </div>
  );
}

function ConflictingValues({ field }: { field: Extract<NormalizedField<string>, { state: "conflicting" }> }) {
  const [position, setPosition] = useState(0);
  const index = Math.min(position, Math.max(0, field.alternatives.length - 1));
  const alternative = field.alternatives[index];
  return (
    <div className="space-y-2">
      <p className="text-amber-900">{field.reason} No value has been chosen.</p>
      {alternative && <>
        <RecordNavigator count={field.alternatives.length} index={index} onChange={setPosition} label="conflicting alternative" />
        <div className="space-y-2 border-t border-slate-200 pt-2">
          <p className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-medium text-slate-800" aria-live="polite">Alternative {index + 1}: {alternative.value}</p>
          <SourceEvidence key={index} sources={alternative.sources} />
        </div>
      </>}
    </div>
  );
}

function FieldDetails({ field }: { field: NormalizedField<string> }) {
  return (
    <details className="mt-2 text-[11px]">
      <summary className="cursor-pointer rounded font-medium text-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">Source and original value</summary>
      <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-3">
        {field.state === "derived" && <p className="text-slate-600">Derived by rule: <code className="break-all">{field.rule}</code>. Source values are shown below.</p>}
        {field.state === "invalid" && <p className="text-red-700">{field.reason}</p>}
        {field.state === "missing" && <p className="text-slate-600">{field.reason === "column-absent" ? "This column is not in the file." : field.reason === "cell-absent" ? "This record has no cell at that column." : "The original cell is empty or contains only whitespace."}</p>}
        {field.state === "conflicting" ? <ConflictingValues field={field} /> : <SourceEvidence sources={field.sources} />}
      </div>
    </details>
  );
}

function OriginalRecord({ source }: { source: RecordSource }) {
  return (
    <details className="rounded-lg border border-slate-200 bg-white px-3 py-3">
      <summary className="cursor-pointer rounded text-xs font-medium text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">Original CSV record, including unmapped columns</summary>
      <p className="my-2 break-all text-[11px] text-slate-500">{source.fileName} · Data row {source.rowNumber} · CSV record {source.recordNumber}</p>
      <pre tabIndex={0} role="region" aria-label={`Original data row ${source.rowNumber}`} className="max-h-48 max-w-full overflow-auto rounded-md bg-slate-50 p-3 font-mono text-[11px] leading-5 whitespace-pre outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">{source.rawText}</pre>
    </details>
  );
}

export function NormalizedReview({ normalized }: { normalized: NormalizedImport }) {
  const headingId = useId();
  const [position, setPosition] = useState(0);
  const [withheldPosition, setWithheldPosition] = useState(0);
  const schema = normalized.schema;
  const index = Math.min(position, Math.max(0, normalized.records.length - 1));
  const record = normalized.records[index];
  const withheldIndex = Math.min(withheldPosition, Math.max(0, normalized.withheldRecords.length - 1));
  const withheld = normalized.withheldRecords[withheldIndex];

  return (
    <section aria-labelledby={headingId} className="border-t border-slate-200 bg-slate-50/40 px-5 py-5 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-slate-900"><GitBranch className="size-4 text-slate-500" aria-hidden="true" />Normalized review</h3>
        {schema.status === "matched" && <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-medium text-amber-900">Unverified provisional fixture</span>}
      </div>
      {schema.status !== "matched" ? (
        <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600">
          <Info className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />
          <div><p className="font-medium text-slate-700">No automatic mappings applied</p><p>{schema.status === "unknown" ? schema.message : "A supported format could not be detected from this file. Original data remains available above."}</p></div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs leading-5 text-slate-700">
            <p className="font-medium">{schema.adapter.label} · Version {schema.adapter.version}</p>
            <p className="mt-1">This adapter supports an explicitly defined synthetic fixture. It has not been verified against a genuine Stocky export. Review every normalized value before relying on it.</p>
            <p className="mt-1 break-all text-[11px] text-slate-500">Adapter: {schema.adapter.id} · {schema.adapter.kind}</p>
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs" aria-label="Normalized field states">
            {(Object.keys(stateLabels) as FieldState[]).map((state) => <div key={state} className="flex gap-1.5"><dt className="text-slate-500">{stateLabels[state]}</dt><dd className="font-medium tabular-nums text-slate-800">{normalized.fieldCounts[state].toLocaleString()}</dd></div>)}
          </dl>
          {schema.unmappedColumns.length > 0 && <p className="text-xs leading-5 text-slate-500">{schema.unmappedColumns.length} additional {schema.unmappedColumns.length === 1 ? "column is" : "columns are"} preserved in the original records without field mappings.</p>}
          {record ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs font-medium text-slate-700" aria-live="polite">Data row {record.source.rowNumber} · CSV record {record.source.recordNumber}</p>
                <RecordNavigator count={normalized.records.length} index={index} onChange={setPosition} label="normalized record" />
              </div>
              {record.issues.length > 0 && <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{record.issues.map((issue, issueIndex) => <li key={issueIndex}>{issue.message}</li>)}</ul>}
              <div role="region" aria-label="Normalized fields and source evidence" tabIndex={0} className="max-h-[36rem] overflow-auto rounded-lg border border-slate-200 bg-white outline-none focus-visible:ring-2 focus-visible:ring-emerald-700">
                <table className="w-full min-w-[470px] text-left text-xs">
                  <caption className="sr-only">Normalized fields for data row {record.source.rowNumber}, with field states and original source evidence.</caption>
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-500"><tr><th scope="col" className="px-3 py-3 font-medium">Field</th><th scope="col" className="px-3 py-3 font-medium">Value and source</th><th scope="col" className="px-3 py-3 font-medium">State</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {(Object.entries(record.fields) as Array<[string, NormalizedField<string>]>).map(([name, field]) => (
                      <tr key={`${index}-${name}`}>
                        <th scope="row" className="w-40 px-3 py-3 align-top font-medium text-slate-700">{fieldLabels[name] ?? name}</th>
                        <td className="max-w-lg px-3 py-3 align-top"><div className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-slate-800">{field.value === null ? <span className="italic text-slate-500">{field.state === "conflicting" ? "Conflicting values — no value selected" : field.state === "invalid" ? "Not normalized" : "Not provided"}</span> : field.value}</div><FieldDetails field={field} /></td>
                        <td className="px-3 py-3 align-top"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${stateStyles[field.state]}`}>{stateLabels[field.state]}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <OriginalRecord source={record.source} />
            </div>
          ) : <p className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-500">No records could be normalized for this format. Original CSV data and validation results remain available above.</p>}
          {withheld && (
            <details className="rounded-lg border border-amber-200 bg-white p-3">
              <summary className="cursor-pointer rounded text-xs font-medium text-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">{normalized.withheldRecords.length.toLocaleString()} {normalized.withheldRecords.length === 1 ? "record was" : "records were"} kept without normalization</summary>
              <div className="mt-3 space-y-3">
                <p className="flex gap-2 text-xs leading-5 text-slate-600"><AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />{withheld.reason}</p>
                <RecordNavigator count={normalized.withheldRecords.length} index={withheldIndex} onChange={setWithheldPosition} label="record kept without normalization" />
                <OriginalRecord source={withheld.source} />
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
