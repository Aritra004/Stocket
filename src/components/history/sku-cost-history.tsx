"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { FieldValue, observedValue } from "@/src/components/dashboard/field-value";
import { LineEvidence } from "@/src/components/dashboard/order-detail";
import { useDashboardQuery } from "@/src/components/dashboard/use-dashboard";
import { ObservedSupplierLink } from "@/src/components/history-navigation";
import type { SkuCostHistory } from "@/src/lib/storage/cost-types";
import type { DashboardLineRow } from "@/src/lib/storage/dashboard-types";
import { HistoryEmpty, HistoryPagination, HistoryState, HistoryTable, historyLinkClass } from "./history-controls";
import { OrderCandidates, SourceLocation } from "./history-lines";

function CostSource({ row, revision }: { row: DashboardLineRow; revision: number }) {
  const orderNumber = observedValue(row.record.fields.purchaseOrderNumber);
  return <div className="min-w-48">
    <p className="mb-2 font-medium"><FieldValue field={row.record.fields.purchaseOrderNumber} /></p>
    <SourceLocation row={row} />
    <details className="mt-3">
      <summary className={`${historyLinkClass} cursor-pointer text-xs`}>Inspect order and source</summary>
      {orderNumber !== null && <OrderCandidates orderNumber={orderNumber} revision={revision} />}
      <LineEvidence sourceReferenceId={row.record.sourceReferenceId} />
    </details>
  </div>;
}

export function SkuCostHistoryResults({ data, revision, onPageChange }: { data: SkuCostHistory; revision: number; onPageChange: (page: number) => void }) {
  const columns: ColumnDef<DashboardLineRow>[] = [
    { id: "date", header: "Order date", cell: ({ row }) => <FieldValue field={row.original.record.fields.orderDate} /> },
    { id: "cost", header: "Unit cost", cell: ({ row }) => <FieldValue field={row.original.record.fields.unitCost} className="font-mono tabular-nums" /> },
    { id: "currency", header: "Currency", cell: ({ row }) => <FieldValue field={row.original.record.fields.currency} /> },
    { id: "quantity", header: "Ordered quantity", cell: ({ row }) => <FieldValue field={row.original.record.fields.orderedQuantity} className="tabular-nums" /> },
    { id: "supplier", header: "Supplier", cell: ({ row }) => <ObservedSupplierLink field={row.original.record.fields.supplier} /> },
    { id: "source", header: "Purchase order and source", cell: ({ row }) => <CostSource row={row.original} revision={revision} /> },
  ];
  if (!data.exists) return <HistoryEmpty title="No recorded purchase costs">No saved line contains this exact observed SKU. Summary totals do not establish a SKU unit cost.</HistoryEmpty>;
  return <>
    <HistoryTable rows={data.entries.rows} columns={columns} getRowId={(row) => row.record.id} label="SKU purchase costs" />
    <HistoryPagination total={data.entries.total} pageIndex={data.entries.pageIndex} pageSize={data.entries.pageSize} count={data.entries.rows.length} label="cost history lines" onChange={onPageChange} />
  </>;
}

export function SkuCostHistorySection({ sku, revision }: { sku: string; revision: number }) {
  const [pageIndex, setPageIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const result = useDashboardQuery({ operation: "sku-cost-history", sku, pageIndex }, revision + retry);
  return <section aria-label="Recorded purchase costs" className="mb-6 min-w-0 overflow-hidden rounded-xl border bg-white">
    <div className="border-b px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-900">Recorded purchase costs</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">Newest observed order dates first; unavailable dates last. Unit costs keep their recorded currencies. Missing values remain unavailable, and currencies are never converted or combined.</p>
    </div>
    <HistoryState loading={result.loading} error={result.error} onRetry={() => setRetry((value) => value + 1)}>
      {result.data && <SkuCostHistoryResults data={result.data} revision={revision + retry} onPageChange={setPageIndex} />}
    </HistoryState>
  </section>;
}
