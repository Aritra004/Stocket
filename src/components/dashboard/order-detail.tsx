"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Info, LoaderCircle, PackageSearch } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/src/components/ui/sheet";
import { FieldValue, observedValue, type DisplayField } from "./field-value";
import { ObservedSkuLink, ObservedSupplierLink } from "../history-navigation";
import { loadDashboardSource } from "@/src/lib/storage/dashboard-client";
import type { DashboardLineRow, OrderDetail } from "@/src/lib/storage/dashboard-types";
import type { StoredSourceReference } from "@/src/lib/storage/types";

const TEXT_CHUNK = 2000;
const SOURCE_COLUMNS_PER_PAGE = 10;

/** Long source cells remain fully inspectable without mounting huge text nodes. */
export function SourceText({ value }: { value: string }) {
  const [position, setPosition] = useState(0);
  const page = Math.min(position, Math.max(0, Math.ceil(value.length / TEXT_CHUNK) - 1));
  const start = page * TEXT_CHUNK;
  if (value === "") return <span className="italic text-slate-500">Empty string</span>;
  return <>
    <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-[11px] leading-5 [overflow-wrap:anywhere]">{value.slice(start, start + TEXT_CHUNK)}</pre>
    {value.length > TEXT_CHUNK && <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
      <span>Characters {start + 1}–{Math.min(start + TEXT_CHUNK, value.length)} of {value.length.toLocaleString()}</span>
      <Button variant="outline" size="xs" disabled={page === 0} onClick={() => setPosition(page - 1)}>Previous characters</Button>
      <Button variant="outline" size="xs" disabled={start + TEXT_CHUNK >= value.length} onClick={() => setPosition(page + 1)}>Next characters</Button>
    </div>}
  </>;
}

export function SourceReferenceView({ source }: { source: StoredSourceReference }) {
  const [position, setPosition] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const cells = source.source.cells;
  const page = Math.min(position, Math.max(0, Math.ceil(cells.length / SOURCE_COLUMNS_PER_PAGE) - 1));
  const start = page * SOURCE_COLUMNS_PER_PAGE;
  return <div className="mt-3 space-y-3 text-xs">
    <p className="break-words text-slate-600 [overflow-wrap:anywhere]"><span className="font-medium">{source.source.fileName}</span> · {source.dataRowNumber === null ? "Header record" : `Data row ${source.dataRowNumber}`} · CSV record {source.recordNumber}</p>
    <p className="text-[11px] leading-5 text-slate-500">Data rows exclude the header and empty lines. CSV record numbers include the header; a quoted multiline value is one record.</p>
    <dl className="divide-y rounded-lg border bg-white">
      {cells.slice(start, start + SOURCE_COLUMNS_PER_PAGE).map((cell, index) => <div key={`${page}:${index}`} className="px-3 py-3">
        <dt className="mb-1 break-words text-[10px] font-medium text-slate-500 [overflow-wrap:anywhere]">Column {cell.column} · {cell.header === null ? "Header absent" : cell.header === "" ? "Empty header" : cell.header}</dt>
        <dd className="min-w-0 text-slate-800">{cell.rawValue === null ? <span className="italic text-slate-500">Cell absent</span> : <SourceText value={cell.rawValue} />}</dd>
      </div>)}
    </dl>
    {cells.length === 0 && <p className="text-slate-500">No original cells are available for this record.</p>}
    {cells.length > SOURCE_COLUMNS_PER_PAGE && <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] text-slate-500">
      <span>Columns {start + 1}–{Math.min(start + SOURCE_COLUMNS_PER_PAGE, cells.length)} of {cells.length}</span>
      <Button variant="outline" size="xs" disabled={page === 0} onClick={() => setPosition(page - 1)}>Previous columns</Button>
      <Button variant="outline" size="xs" disabled={start + SOURCE_COLUMNS_PER_PAGE >= cells.length} onClick={() => setPosition(page + 1)}>Next columns</Button>
    </div>}
    <details onToggle={(event) => setShowRaw(event.currentTarget.open)} className="rounded-lg border bg-slate-50 p-3">
      <summary className="rounded text-xs font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-emerald-700">Original CSV record</summary>
      {showRaw && <div className="mt-3"><SourceText value={source.source.rawText} /></div>}
    </details>
  </div>;
}

function Field({ label, field }: { label: string; field: DisplayField }) {
  return <div className="min-w-0"><dt className="mb-1.5 text-[11px] text-slate-500">{label}</dt><dd className="text-sm font-medium leading-5 text-slate-800">{label === "Supplier" ? <ObservedSupplierLink field={field} /> : <FieldValue field={field} />}</dd></div>;
}

export function LineEvidence({ sourceReferenceId }: { sourceReferenceId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState<StoredSourceReference>();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function load() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      const result = await loadDashboardSource(sourceReferenceId, controller.signal);
      if (controller.signal.aborted) return;
      setSource(result);
      if (!result) setError("The original source record is no longer available. This import may have been removed.");
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The source record could not be read.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <div className="mt-4 border-t pt-3">
    <Button variant="ghost" size="sm" className="-ml-2 text-xs text-emerald-800" aria-expanded={open} onClick={() => {
      if (open) { setOpen(false); abort.current?.abort(); setLoading(false); }
      else if (source) setOpen(true);
      else void load();
    }}><FileText className="size-3.5" aria-hidden="true" />{open ? "Hide original line source" : "View original line source"}</Button>
    {open && <>
      {loading && <p role="status" className="mt-2 text-xs text-slate-500">Reading original source…</p>}
      {error && <div role="alert" className="mt-2 text-xs text-amber-900"><p>{error}</p><Button size="xs" variant="outline" className="mt-2" onClick={() => void load()}>Retry source</Button></div>}
      {source && !loading && <SourceReferenceView source={source} />}
    </>}
  </div>;
}

function RelatedLine({ line }: { line: DashboardLineRow }) {
  const { record, fileName } = line;
  const fields = record.fields;
  return <li className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">SKU</p><p className="mt-1 text-sm font-semibold text-slate-900"><ObservedSkuLink field={fields.sku} /></p></div><p className="text-xs text-slate-500">Line ID <FieldValue field={fields.lineId} /></p></div>
    <p className="mt-2 text-xs text-slate-600"><span className="sr-only">Product: </span><FieldValue field={fields.productName} /></p>
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
      <Field label="Supplier" field={fields.supplier} />
      <Field label="Order date" field={fields.orderDate} />
      <Field label="Unit cost" field={fields.unitCost} />
      <Field label="Currency" field={fields.currency} />
      <Field label="Ordered quantity" field={fields.orderedQuantity} />
      <Field label="Received quantity" field={fields.receivedQuantity} />
      <Field label="Outstanding quantity" field={fields.outstandingQuantity} />
    </dl>
    <p className="mt-4 break-words text-[11px] leading-5 text-slate-500 [overflow-wrap:anywhere]">{fileName ?? "Source file unavailable"} · Data row {record.rowNumber} · CSV record {record.recordNumber}</p>
    <LineEvidence key={record.sourceReferenceId} sourceReferenceId={record.sourceReferenceId} />
  </li>;
}

export interface OrderDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: OrderDetail | undefined;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onLinePageChange: (page: number) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export function OrderDetailContents({ detail, loading = false, onLinePageChange }: { detail: OrderDetail; loading?: boolean; onLinePageChange: (page: number) => void }) {
  const [showSource, setShowSource] = useState(false);
  const { fields } = detail.order.record;
  const start = detail.linePageIndex * detail.linePageSize;
  const identified = observedValue(fields.purchaseOrderNumber) !== null;
  return <div className="space-y-6">
    <section aria-label="Imported purchase-order fields">
      <h3 className="text-sm font-semibold text-slate-900">Order overview</h3>
      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-5">
        <Field label="Purchase-order number" field={fields.purchaseOrderNumber} />
        <Field label="Supplier" field={fields.supplier} />
        <Field label="Status" field={fields.status} />
        <Field label="Order date" field={fields.orderDate} />
        <Field label="Expected date" field={fields.expectedDate} />
        <Field label="Total cost" field={fields.totalCost} />
        <Field label="Currency" field={fields.currency} />
        <Field label="Ordered quantity" field={fields.orderedQuantity} />
        <Field label="Received quantity" field={fields.receivedQuantity} />
        <Field label="Outstanding quantity" field={fields.outstandingQuantity} />
      </dl>
      <p className="mt-4 text-[11px] leading-5 text-slate-500">Only observed values are shown. Missing, invalid, conflicting, and calculated fields are marked separately; no totals or currencies are inferred.</p>
    </section>

    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4" aria-label="Original source reference">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><FileText className="size-4 text-emerald-800" aria-hidden="true" />Original source</h3>
      <p className="mt-2 break-words text-xs font-medium text-slate-700 [overflow-wrap:anywhere]">{detail.order.fileName ?? "Source file unavailable"}</p>
      <p className="mt-1 text-[11px] text-slate-500">Data row {detail.order.record.rowNumber} · CSV record {detail.order.record.recordNumber}</p>
      {detail.source ? <details className="mt-3" onToggle={(event) => setShowSource(event.currentTarget.open)}>
        <summary className="rounded text-xs font-medium text-emerald-800 focus-visible:outline-2 focus-visible:outline-emerald-700">Inspect original cells</summary>
        {showSource && <SourceReferenceView key={detail.source.id} source={detail.source} />}
      </details> : <p className="mt-3 text-xs text-amber-900">The original source record is unavailable.</p>}
    </section>

    <section aria-label="Related line items">
      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-900">Related line items</h3><span className="rounded-md bg-slate-100 px-2 py-1 text-xs tabular-nums text-slate-600">{detail.lineTotal.toLocaleString()}</span></div>
      <div className="mt-3 flex gap-2 rounded-lg border border-amber-100 bg-amber-50/70 p-3 text-[11px] leading-5 text-amber-950"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><p>Candidate matches use the exact observed purchase-order number across saved imports. A shared number does not confirm the same order or store. Records stay separate and are not merged.</p></div>
      {detail.lines.length === 0 ? <div className="mt-3 rounded-xl border border-dashed p-6 text-center"><PackageSearch className="mx-auto size-6 text-slate-400" aria-hidden="true" /><p className="mt-2 text-sm font-medium text-slate-700">{identified ? "No related line items found" : "Line items cannot be matched"}</p><p className="mt-1 text-xs leading-5 text-slate-500">{identified ? "Import a supported line-item file containing this exact purchase-order number to inspect its possible matches." : "This summary has no unambiguous observed purchase-order number. No relationship has been inferred."}</p></div> : <>
        <ul className="mt-3 space-y-3">{detail.lines.map((line) => <RelatedLine key={line.record.id} line={line} />)}</ul>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2"><span className="mr-auto text-[11px] tabular-nums text-slate-500">{start + 1}–{Math.min(start + detail.lines.length, detail.lineTotal)} of {detail.lineTotal.toLocaleString()} line records</span><Button variant="outline" size="sm" disabled={loading || detail.linePageIndex === 0} onClick={() => onLinePageChange(detail.linePageIndex - 1)}>Previous lines</Button><Button variant="outline" size="sm" disabled={loading || start + detail.linePageSize >= detail.lineTotal} onClick={() => onLinePageChange(detail.linePageIndex + 1)}>Next lines</Button></div>
      </>}
    </section>
  </div>;
}

export function OrderDetailDrawer({ open, onOpenChange, detail, loading, error, onRetry, onLinePageChange, onCloseAutoFocus }: OrderDetailDrawerProps) {
  const title = detail ? observedValue(detail.order.record.fields.purchaseOrderNumber) : null;
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent onCloseAutoFocus={onCloseAutoFocus}>
      <SheetHeader><p className="text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-800">Purchase-order record</p><SheetTitle className="break-words [overflow-wrap:anywhere]">{title ?? "Order details"}</SheetTitle><SheetDescription>Inspect the imported values and trace them to their original source.</SheetDescription></SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7" aria-busy={loading}>
        {loading && <p role="status" className="mb-5 flex items-center gap-2 text-sm text-slate-500"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />Reading saved order…</p>}
        {error ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><p>{error}</p><Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>Retry order</Button></div> : detail ? <OrderDetailContents key={detail.order.record.id} detail={detail} loading={loading} onLinePageChange={onLinePageChange} /> : !loading && <div className="rounded-xl border border-dashed p-6 text-center"><p className="text-sm font-medium text-slate-700">This order is no longer available</p><p className="mt-2 text-xs leading-5 text-slate-500">The source import may have been removed or replaced. Close this drawer and refresh the purchase-order list.</p></div>}
      </div>
    </SheetContent>
  </Sheet>;
}
