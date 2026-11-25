"use client";

import type { ReactNode } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, ChevronLeft, ChevronRight, FileSearch, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";

export const historyLinkClass = "rounded font-medium text-emerald-800 underline decoration-emerald-800/30 underline-offset-4 hover:text-emerald-950 hover:decoration-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700 whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

export function HistoryHeader({ title, description, back, onRefresh }: { title: string; description: string; back?: { href: string; label: string }; onRefresh: () => void }) {
  return <div className="mb-7">
    {back && <a href={back.href} className={`${historyLinkClass} mb-5 inline-flex items-center gap-1.5 text-xs`}><ArrowLeft className="size-3.5" aria-hidden="true" />{back.label}</a>}
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 max-w-3xl"><p className="mb-2 text-xs font-medium text-slate-500">Your purchase history</p><h1 className="whitespace-pre-wrap break-words text-3xl font-semibold tracking-[-0.035em] text-slate-950 [overflow-wrap:anywhere]">{title}</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">{description}</p></div><Button variant="outline" onClick={onRefresh} size="sm" className="bg-white"><RefreshCw className="size-3.5" aria-hidden="true" />Refresh history</Button></div>
  </div>;
}

export function HistorySearch({ label, placeholder, value, onChange, ascending, onSortChange }: { label: string; placeholder: string; value: string; onChange: (value: string) => void; ascending: boolean; onSortChange: () => void }) {
  return <div className="flex flex-wrap items-center gap-3 border-b p-4 sm:p-5"><label className="relative min-w-0 flex-1 sm:max-w-md"><span className="sr-only">{label}</span><Search className="pointer-events-none absolute top-3 left-3 size-4 text-slate-400" aria-hidden="true" /><Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="pl-9" /></label><Button variant="outline" onClick={onSortChange} className="text-xs">Sort {ascending ? "A–Z" : "Z–A"}</Button>{value !== "" && <Button variant="ghost" size="sm" onClick={() => onChange("")} className="text-xs">Clear search</Button>}</div>;
}

export function HistoryPagination({ total, pageIndex, pageSize, count, label, loading = false, onChange }: { total: number; pageIndex: number; pageSize: number; count: number; label: string; loading?: boolean; onChange: (index: number) => void }) {
  const start = pageIndex * pageSize;
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-4 sm:px-5"><p className="text-xs tabular-nums text-slate-500">{total === 0 ? "0" : `${start + 1}–${Math.min(start + count, total)}`} of {total.toLocaleString()} {label}</p><div className="flex items-center gap-2"><Button variant="outline" size="sm" aria-label={`Previous ${label}`} disabled={loading || pageIndex === 0} onClick={() => onChange(pageIndex - 1)}><ChevronLeft className="size-3.5" aria-hidden="true" />Previous</Button><span className="px-1 text-xs tabular-nums text-slate-500">Page {pageIndex + 1} of {Math.max(1, Math.ceil(total / pageSize))}</span><Button variant="outline" size="sm" aria-label={`Next ${label}`} disabled={loading || start + pageSize >= total} onClick={() => onChange(pageIndex + 1)}>Next<ChevronRight className="size-3.5" aria-hidden="true" /></Button></div></div>;
}

export function HistoryState({ loading, error, onRetry, children }: { loading: boolean; error: string; onRetry: () => void; children: ReactNode }) {
  if (loading) return <p role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />Reading saved history…</p>;
  if (error) return <div role="alert" className="m-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p>{error}</p><Button variant="outline" size="sm" onClick={onRetry} className="mt-3">Retry history</Button></div>;
  return children;
}

export function HistoryEmpty({ title, children, importLink = false }: { title: string; children: ReactNode; importLink?: boolean }) {
  return <div className="px-5 py-10 text-center"><FileSearch className="mx-auto size-7 text-slate-400" aria-hidden="true" /><h3 className="mt-3 text-sm font-semibold text-slate-800">{title}</h3><p className="mx-auto mt-2 max-w-xl text-xs leading-6 text-slate-500">{children}</p>{importLink && <a href="/import" className={`${historyLinkClass} mt-3 inline-block text-xs`}>Import CSV files</a>}</div>;
}

export function HistoryTable<T>({ rows, columns, getRowId, label }: { rows: T[]; columns: ColumnDef<T>[]; getRowId: (row: T) => string; label: string }) {
  // TanStack renders only the bounded IndexedDB page supplied by the caller.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data: rows, columns, getRowId, getCoreRowModel: getCoreRowModel(), manualPagination: true, manualSorting: true, manualFiltering: true });
  return <Table aria-label={label} className={columns.length > 3 ? "min-w-[720px]" : columns.length > 2 ? "min-w-[480px]" : "min-w-[360px]"} containerProps={{ role: "region", "aria-label": `${label} table scroll area`, tabIndex: 0, className: "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700" }}><TableHeader className="bg-slate-50/80">{table.getHeaderGroups().map((group) => <TableRow key={group.id}>{group.headers.map((header) => <TableHead key={header.id} scope="col">{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.map((row) => <TableRow key={row.id}>{row.getVisibleCells().map((cell) => <TableCell key={cell.id} className="max-w-72 text-xs text-slate-700">{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>)}</TableBody></Table>;
}
