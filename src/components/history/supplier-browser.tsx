"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleHelp, Store } from "lucide-react";
import { useArchiveRevision, useDashboardQuery, useDebouncedValue } from "@/src/components/dashboard/use-dashboard";
import { useHistorySelection } from "@/src/components/history-navigation";
import { supplierHref } from "@/src/lib/history-navigation";
import type { SupplierDirectoryPage } from "@/src/lib/storage/history-types";
import { HistoryEmpty, HistoryHeader, HistoryPagination, HistorySearch, HistoryState, HistoryTable, historyLinkClass } from "./history-controls";
import { HistoryLines, HistoryOrders } from "./history-lines";

type SupplierRow = SupplierDirectoryPage["rows"][number];
const columns: ColumnDef<SupplierRow>[] = [
  { accessorKey: "name", header: "Supplier name", cell: ({ row }) => <a href={supplierHref(row.original.name)} className={historyLinkClass}>{row.original.name}</a> },
  { accessorKey: "orderCount", header: "Order records", cell: ({ row }) => <span className="tabular-nums">{row.original.orderCount.toLocaleString()}</span> },
  { accessorKey: "lineCount", header: "Line records", cell: ({ row }) => <span className="tabular-nums">{row.original.lineCount.toLocaleString()}</span> },
];

export function SupplierDirectoryResults({ data, search, onPageChange }: { data: SupplierDirectoryPage; search: string; onPageChange: (page: number) => void }) {
  return <>
    {data.rows.length > 0 ? <HistoryTable rows={data.rows} columns={columns} getRowId={(row) => row.name} label="Observed suppliers" /> : <HistoryEmpty title={search !== "" ? "No supplier names match" : "No observed suppliers yet"} importLink={search === ""}>{search !== "" ? "Try another search or clear it to see all observed supplier names." : "Import supported purchase-order summaries or line items to browse the supplier names recorded in your files."}</HistoryEmpty>}
    <HistoryPagination total={data.total} pageIndex={data.pageIndex} pageSize={data.pageSize} count={data.rows.length} label="suppliers" onChange={onPageChange} />
    <div className="flex flex-wrap items-start gap-3 border-t bg-slate-50/70 p-4 sm:p-5"><CircleHelp className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" /><div className="min-w-0"><a href={supplierHref(null)} className={`${historyLinkClass} text-xs`}>Supplier not observed</a><p className="mt-1 text-[11px] leading-5 text-slate-500">{data.unavailableOrderCount.toLocaleString()} order records · {data.unavailableLineCount.toLocaleString()} line records without an unambiguous observed supplier. These records are kept together for review, without creating a supplier.</p></div></div>
  </>;
}

function SupplierDirectory() {
  const revision = useArchiveRevision();
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [ascending, setAscending] = useState(true);
  const debounced = useDebouncedValue(search);
  const result = useDashboardQuery({ operation: "supplier-directory", query: { search: debounced, pageIndex, pageSize: 25, sortDirection: ascending ? "asc" : "desc" } }, revision + retry);
  return <>
    <HistoryHeader title="Suppliers" description="Browse supplier names observed in your saved summaries and line items. Exact spelling, case, and whitespace stay distinct; a shared name does not establish a supplier identity." onRefresh={() => setRetry((value) => value + 1)} />
    <section aria-label="Supplier directory" className="min-w-0 overflow-hidden rounded-xl border bg-white shadow-sm shadow-slate-200/30"><div className="flex items-center gap-2 border-b px-5 py-4"><Store className="size-4 text-emerald-800" aria-hidden="true" /><h2 className="text-sm font-semibold text-slate-900">Observed supplier names</h2></div><HistorySearch label="Search supplier names" placeholder="Find a supplier name…" value={search} onChange={(value) => { setSearch(value); setPageIndex(0); }} ascending={ascending} onSortChange={() => { setAscending(!ascending); setPageIndex(0); }} /><HistoryState loading={result.loading || search !== debounced} error={result.error} onRetry={() => setRetry((value) => value + 1)}>{result.data && <SupplierDirectoryResults data={result.data} search={search} onPageChange={setPageIndex} />}</HistoryState></section>
  </>;
}

function SupplierHistory({ supplier }: { supplier: string | null }) {
  const revision = useArchiveRevision();
  const [retry, setRetry] = useState(0);
  const [orderPageIndex, setOrderPageIndex] = useState(0);
  const [linePageIndex, setLinePageIndex] = useState(0);
  const result = useDashboardQuery({ operation: "supplier-history", supplier, orderPageIndex, linePageIndex }, revision + retry);
  const data = result.data;
  const title = supplier === null ? "Supplier not observed" : data?.exists ? supplier : data ? "Supplier not found" : "Supplier history";
  return <>
    <HistoryHeader title={title} description={supplier === null ? "Review records whose supplier field is missing, invalid, conflicting, or calculated. No supplier has been assigned to these records." : "Only records with this exact supplier name observed directly on the record are included. Names remain case and whitespace sensitive; line suppliers are never filled from purchase-order summaries."} back={{ href: "/suppliers", label: "All suppliers" }} onRefresh={() => setRetry((value) => value + 1)} />
    <HistoryState loading={result.loading} error={result.error} onRetry={() => setRetry((value) => value + 1)}>{data && <>
      {!data.exists && <div className="mb-5 rounded-xl border bg-white"><HistoryEmpty title={supplier === null ? "No records need supplier review" : "No saved records for this supplier"} importLink={supplier !== null}>{supplier === null ? "Every saved normalized record has an observed supplier, or this archive is empty." : "The selected name does not occur as an observed supplier in this archive. Its import may have been removed or replaced. Return to all suppliers to browse the current names."}</HistoryEmpty></div>}
      <div className="mb-5 grid gap-3 sm:grid-cols-2"><HistoryCount label="Purchase-order records" value={data.orders.total} /><HistoryCount label="Line-item records" value={data.lines.total} /></div>
      <section aria-label="Purchase-order records" className="mb-6 min-w-0 overflow-hidden rounded-xl border bg-white"><div className="border-b px-5 py-4"><h2 className="text-sm font-semibold text-slate-900">Purchase-order records</h2><p className="mt-1 text-xs leading-5 text-slate-500">Summary records stay separate, including repeated order numbers. Observed order dates are shown newest first.</p></div>{data.orders.total > 0 ? <HistoryOrders page={data.orders} onPageChange={setOrderPageIndex} /> : <HistoryEmpty title="No purchase-order summaries">No saved summary directly records this supplier selection. Line items below are still available when they contain it.</HistoryEmpty>}</section>
      <section aria-label="Line-item history" className="min-w-0 overflow-hidden rounded-xl border bg-white"><div className="border-b px-5 py-4"><h2 className="text-sm font-semibold text-slate-900">Line-item history</h2><p className="mt-1 text-xs leading-5 text-slate-500">SKU links open each exact identifier. Costs and quantities are literal observations; currencies and totals are never inferred.</p></div>{data.lines.total > 0 ? <HistoryLines page={data.lines} revision={revision + retry} onPageChange={setLinePageIndex} /> : <HistoryEmpty title="No directly observed line items">No saved line item directly records this supplier selection. A supplier on a summary does not establish the supplier of its possible line matches.</HistoryEmpty>}</section>
    </>}</HistoryState>
  </>;
}

function HistoryCount({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border bg-white px-5 py-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{value.toLocaleString()}</p></div>;
}

export default function SupplierBrowser() {
  const { value } = useHistorySelection("supplier");
  return value === undefined ? <SupplierDirectory /> : <SupplierHistory key={value === null ? "missing" : `name:${value}`} supplier={value} />;
}
