"use client";

import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/src/components/ui/button";
import { FieldValue, observedValue, type DisplayField } from "@/src/components/dashboard/field-value";
import { LineEvidence } from "@/src/components/dashboard/order-detail";
import { useDashboardQuery } from "@/src/components/dashboard/use-dashboard";
import { ObservedSkuLink, ObservedSupplierLink } from "@/src/components/history-navigation";
import { purchaseOrderHref } from "@/src/lib/history-navigation";
import type { DashboardLineRow, DashboardOrderRow, OrderPage } from "@/src/lib/storage/dashboard-types";
import type { HistoryLinePage } from "@/src/lib/storage/history-types";
import { HistoryEmpty, HistoryPagination, HistoryState, HistoryTable, historyLinkClass } from "./history-controls";

const orderColumns: ColumnDef<DashboardOrderRow>[] = [
  { id: "order", header: "Purchase order", cell: ({ row }) => <OrderRecordLink row={row.original} /> },
  { id: "date", header: "Order date", cell: ({ row }) => <FieldValue field={row.original.record.fields.orderDate} /> },
  { id: "supplier", header: "Supplier", cell: ({ row }) => <ObservedSupplierLink field={row.original.record.fields.supplier} /> },
  { id: "status", header: "Status", cell: ({ row }) => <FieldValue field={row.original.record.fields.status} /> },
  { id: "source", header: "Original source", cell: ({ row }) => <SourceLocation row={row.original} /> },
];

function OrderRecordLink({ row }: { row: DashboardOrderRow }) {
  const number = observedValue(row.record.fields.purchaseOrderNumber);
  const label = `Open purchase order ${number ?? "without an observed number"}, ${row.fileName ?? "source file unavailable"}, data row ${row.record.rowNumber}`;
  return <a href={purchaseOrderHref(row.record.id)} aria-label={label} className={historyLinkClass}><FieldValue field={row.record.fields.purchaseOrderNumber} /></a>;
}

export function SourceLocation({ row }: { row: DashboardOrderRow | DashboardLineRow }) {
  return <span className="block break-words text-[11px] leading-5 text-slate-500 [overflow-wrap:anywhere]"><span className="block whitespace-pre-wrap font-medium text-slate-700">{row.fileName ?? "Source file unavailable"}</span>Data row {row.record.rowNumber} · CSV record {row.record.recordNumber}</span>;
}

export function HistoryOrders({ page, label = "order records", onPageChange }: { page: OrderPage; label?: string; onPageChange: (page: number) => void }) {
  return <><HistoryTable rows={page.rows} columns={orderColumns} getRowId={(row) => row.record.id} label={label} /><HistoryPagination total={page.total} pageIndex={page.pageIndex} pageSize={page.pageSize} count={page.rows.length} label={label} onChange={onPageChange} /></>;
}

export function OrderCandidates({ orderNumber, revision }: { orderNumber: string; revision: number }) {
  const [open, setOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const result = useDashboardQuery(open ? { operation: "order-candidates", orderNumber, pageIndex } : null, revision + retry);
  return <div className="mt-4 border-t pt-3"><Button variant="outline" size="sm" className="max-w-full text-xs" aria-label={`Find purchase orders for ${orderNumber}`} aria-expanded={open} onClick={() => setOpen(!open)}>Find purchase orders<ChevronDown aria-hidden="true" className={`size-3.5 ${open ? "rotate-180" : ""}`} /></Button>
    {open && <div className="mt-3 overflow-hidden rounded-lg border bg-slate-50/50"><p className="flex gap-2 border-b p-3 text-[11px] leading-5 text-amber-950"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span>These are candidate matches for the exact observed order number. Repeated numbers may describe different orders or stores. Each source record remains separate.</span></p><HistoryState loading={result.loading} error={result.error} onRetry={() => setRetry((value) => value + 1)}>{result.data && (result.data.total > 0 ? <HistoryOrders page={result.data} label="matching orders" onPageChange={setPageIndex} /> : <HistoryEmpty title="No purchase-order summary found">This line is preserved, but no saved summary has this exact observed purchase-order number. Import its summary file to inspect possible matches.</HistoryEmpty>)}</HistoryState></div>}
  </div>;
}

function HistoryField({ label, field }: { label: string; field: DisplayField }) {
  return <div className="min-w-0"><dt className="mb-1.5 text-[11px] text-slate-500">{label}</dt><dd className="text-sm leading-5 text-slate-800"><FieldValue field={field} /></dd></div>;
}

export function HistoryLineCard({ row, revision }: { row: DashboardLineRow; revision: number }) {
  const fields = row.record.fields;
  const orderNumber = observedValue(fields.purchaseOrderNumber);
  return <li className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">SKU</p><p className="text-base font-semibold text-slate-900"><ObservedSkuLink field={fields.sku} /></p></div><div className="min-w-0"><p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">Purchase-order number</p><p className="text-sm font-medium text-slate-800"><FieldValue field={fields.purchaseOrderNumber} /></p></div></div>
    <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-3">
      <HistoryField label="Product name" field={fields.productName} />
      <div className="min-w-0"><dt className="mb-1.5 text-[11px] text-slate-500">Supplier on this line</dt><dd className="text-sm leading-5"><ObservedSupplierLink field={fields.supplier} /></dd></div>
      <HistoryField label="Order date" field={fields.orderDate} />
      <HistoryField label="Line ID" field={fields.lineId} />
      <HistoryField label="Unit cost" field={fields.unitCost} />
      <HistoryField label="Currency" field={fields.currency} />
      <HistoryField label="Ordered quantity" field={fields.orderedQuantity} />
      <HistoryField label="Received quantity" field={fields.receivedQuantity} />
      <HistoryField label="Outstanding quantity" field={fields.outstandingQuantity} />
    </dl>
    <div className="mt-5"><SourceLocation row={row} /></div>
    {orderNumber !== null ? <OrderCandidates orderNumber={orderNumber} revision={revision} /> : <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-500">No unambiguous purchase-order number was observed on this line, so no summary relationship is inferred.</p>}
    <LineEvidence key={row.record.sourceReferenceId} sourceReferenceId={row.record.sourceReferenceId} />
  </li>;
}

export function HistoryLines({ page, revision, onPageChange }: { page: HistoryLinePage; revision: number; onPageChange: (page: number) => void }) {
  return <><ul className="grid gap-4 p-4 sm:p-5">{page.rows.map((row) => <HistoryLineCard key={row.record.id} row={row} revision={revision} />)}</ul><HistoryPagination total={page.total} pageIndex={page.pageIndex} pageSize={page.pageSize} count={page.rows.length} label="line records" onChange={onPageChange} /></>;
}
