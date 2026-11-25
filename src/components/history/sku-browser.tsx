"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PackageSearch } from "lucide-react";
import { useArchiveRevision, useDashboardQuery, useDebouncedValue } from "@/src/components/dashboard/use-dashboard";
import { useHistorySelection } from "@/src/components/history-navigation";
import { skuHref } from "@/src/lib/history-navigation";
import type { SkuDirectoryPage } from "@/src/lib/storage/history-types";
import { HistoryEmpty, HistoryHeader, HistoryPagination, HistorySearch, HistoryState, HistoryTable, historyLinkClass } from "./history-controls";
import { HistoryLines } from "./history-lines";
import { SkuCostHistorySection } from "./sku-cost-history";

type SkuRow = SkuDirectoryPage["rows"][number];
const columns: ColumnDef<SkuRow>[] = [
  { accessorKey: "sku", header: "SKU identifier", cell: ({ row }) => <a href={skuHref(row.original.sku)} className={`${historyLinkClass} font-mono`}>{row.original.sku}</a> },
  { accessorKey: "lineCount", header: "Line records", cell: ({ row }) => <span className="tabular-nums">{row.original.lineCount.toLocaleString()}</span> },
];

export function SkuDirectoryResults({ data, search, onPageChange }: { data: SkuDirectoryPage; search: string; onPageChange: (page: number) => void }) {
  return <>{data.rows.length > 0 ? <HistoryTable rows={data.rows} columns={columns} getRowId={(row) => row.sku} label="Observed SKUs" /> : <HistoryEmpty title={search !== "" ? "No SKUs match" : "No observed SKUs yet"} importLink={search === ""}>{search !== "" ? "Try another identifier or clear your search to see every observed SKU." : "Summary-only imports contain no SKU history. Import a supported line-item file with observed SKU values to browse their history. Missing, invalid, conflicting, and calculated SKU fields are not turned into identifiers."}</HistoryEmpty>}<HistoryPagination total={data.total} pageIndex={data.pageIndex} pageSize={data.pageSize} count={data.rows.length} label="SKUs" onChange={onPageChange} /></>;
}

function SkuDirectory() {
  const revision = useArchiveRevision();
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [ascending, setAscending] = useState(true);
  const debounced = useDebouncedValue(search);
  const result = useDashboardQuery({ operation: "sku-directory", query: { search: debounced, pageIndex, pageSize: 25, sortDirection: ascending ? "asc" : "desc" } }, revision + retry);
  return <><HistoryHeader title="SKUs" description="Explore exact SKU identifiers observed in saved line items. Leading zeros, spelling, case, and whitespace are preserved. A shared SKU does not establish a product identity across stores." onRefresh={() => setRetry((value) => value + 1)} /><section aria-label="SKU directory" className="min-w-0 overflow-hidden rounded-xl border bg-white shadow-sm shadow-slate-200/30"><div className="flex items-center gap-2 border-b px-5 py-4"><PackageSearch className="size-4 text-emerald-800" aria-hidden="true" /><h2 className="text-sm font-semibold text-slate-900">Observed SKU identifiers</h2></div><HistorySearch label="Search SKU identifiers" placeholder="Search SKU identifiers…" value={search} onChange={(value) => { setSearch(value); setPageIndex(0); }} ascending={ascending} onSortChange={() => { setAscending(!ascending); setPageIndex(0); }} /><HistoryState loading={result.loading || search !== debounced} error={result.error} onRetry={() => setRetry((value) => value + 1)}>{result.data && <SkuDirectoryResults data={result.data} search={search} onPageChange={setPageIndex} />}</HistoryState></section></>;
}

function SkuHistory({ sku }: { sku: string }) {
  const revision = useArchiveRevision();
  const [retry, setRetry] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const result = useDashboardQuery({ operation: "sku-history", sku, pageIndex }, revision + retry);
  const data = result.data;
  return <><HistoryHeader title={data?.exists ? sku : data ? "SKU not found" : "SKU history"} description="Each line below contains this exact observed SKU. Dates, suppliers, costs, quantities, and source references belong to the individual line; no product identity or cross-file relationship is assumed." back={{ href: "/skus", label: "All SKUs" }} onRefresh={() => setRetry((value) => value + 1)} /><SkuCostHistorySection sku={sku} revision={revision + retry} /><section aria-label="Line-item history" className="min-w-0 overflow-hidden rounded-xl border bg-white"><div className="border-b px-5 py-4"><h2 className="text-sm font-semibold text-slate-900">Line-item history{data && <span className="ml-2 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-normal tabular-nums text-slate-600">{data.lines.total.toLocaleString()}</span>}</h2><p className="mt-1 text-xs leading-5 text-slate-500">Newest observed order dates first, with unavailable dates last. Every original line remains separate.</p></div><HistoryState loading={result.loading} error={result.error} onRetry={() => setRetry((value) => value + 1)}>{data && (data.exists ? <HistoryLines page={data.lines} revision={revision + retry} onPageChange={setPageIndex} /> : <HistoryEmpty title="No saved lines for this SKU" importLink>The selected identifier is not observed in this archive. Its import may have been removed or replaced. Return to all SKUs to browse current identifiers.</HistoryEmpty>)}</HistoryState></section></>;
}

export default function SkuBrowser() {
  const { value } = useHistorySelection("sku");
  return value === undefined || value === null ? <SkuDirectory /> : <SkuHistory key={value} sku={value} />;
}
