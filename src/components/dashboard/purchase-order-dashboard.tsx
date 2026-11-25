"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { Popover } from "radix-ui";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileSearch,
  FileUp,
  ListFilter,
  LoaderCircle,
  Package,
  RefreshCw,
  Search,
  Store,
  X,
} from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/src/components/ui/table";
import type {
  DashboardOrderRow,
  DashboardQuery,
} from "@/src/lib/storage/dashboard-types";
import { FieldValue, observedValue } from "./field-value";
import { ObservedSupplierLink, selectPurchaseOrder, useOrderSelection } from "../history-navigation";
import { OrderDetailDrawer } from "./order-detail";
import {
  useArchiveRevision,
  useDashboardQuery,
  useDebouncedValue,
} from "./use-dashboard";

const columnLabels = {
  purchaseOrderNumber: "Purchase order",
  supplier: "Supplier",
  orderDate: "Order date",
  status: "Status",
};
const noRows: DashboardOrderRow[] = [];

function SupplierFilter({
  value,
  onChange,
  revision,
}: {
  value?: string;
  onChange: (value?: string) => void;
  revision: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search);
  const result = useDashboardQuery(
    open ? { operation: "suppliers", search: debounced } : null,
    revision,
  );
  const choose = (next?: string) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="outline"
          aria-label="Supplier filter"
          className="h-10 w-full justify-between bg-white font-normal sm:w-48"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Store className="size-4 text-slate-400" aria-hidden="true" />
            <span className="truncate" title={value}>
              {value ?? "All suppliers"}
            </span>
          </span>
          <ChevronDown className="size-3.5 text-slate-400" aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-white p-2 shadow-xl outline-none"
          aria-label="Choose a supplier"
        >
          <Input
            aria-label="Search suppliers"
            placeholder="Find an observed supplier…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="mb-2"
          />
          <div className="max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={() => choose()}
              className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 focus-visible:bg-emerald-50"
            >
              All suppliers
            </button>
            {result.loading || search !== debounced ? (
              <p role="status" className="p-3 text-xs text-slate-500">
                Finding suppliers…
              </p>
            ) : result.error ? (
              <p role="alert" className="p-3 text-xs text-red-700">
                {result.error}
              </p>
            ) : (
              result.data?.suppliers.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => choose(name)}
                  aria-pressed={value === name}
                  title={name}
                  className="block w-full truncate rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 focus-visible:bg-emerald-50 aria-pressed:bg-emerald-50 aria-pressed:text-emerald-900"
                >
                  {name}
                </button>
              ))
            )}
            {!result.loading &&
              !result.error &&
              result.data?.suppliers.length === 0 && (
                <p className="p-3 text-xs text-slate-500">
                  No observed suppliers match this search.
                </p>
              )}
          </div>
          {result.data && result.data.total > result.data.suppliers.length && (
            <p className="border-t px-3 pt-2 text-xs text-slate-500">
              Showing {result.data.suppliers.length} of{" "}
              {result.data.total.toLocaleString()}. Search to narrow the list.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function PurchaseOrderDashboard() {
  const archiveRevision = useArchiveRevision();
  const [refresh, setRefresh] = useState(0);
  const revision = archiveRevision + refresh;
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [supplier, setSupplier] = useState<string>();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "orderDate", desc: true },
  ]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 25,
  });
  const selectedId = useOrderSelection();
  const [linePagination, setLinePagination] = useState<{ orderId: string | null; page: number }>({ orderId: null, page: 0 });
  const linePage = linePagination.orderId === selectedId ? linePagination.page : 0;
  const opener = useRef<HTMLElement | null>(null);
  const dateError =
    dateFrom && dateTo && dateFrom > dateTo
      ? "The start date must be on or before the end date."
      : "";
  const overview = useDashboardQuery({ operation: "overview" }, revision);
  const orders = useDashboardQuery(
    dateError
      ? null
      : {
          operation: "orders",
          query: {
            search: debouncedSearch,
            supplier,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
            sortBy: sorting[0]?.id as DashboardQuery["sortBy"],
            sortDirection: sorting[0]?.desc ? "desc" : "asc",
            ...pagination,
          },
        },
    revision,
  );
  const details = useDashboardQuery(
    selectedId
      ? { operation: "detail", id: selectedId, pageIndex: linePage }
      : null,
    revision,
  );
  const busy = orders.loading || search !== debouncedSearch;
  const hasFilters = Boolean(
    search || supplier !== undefined || dateFrom || dateTo,
  );
  const retry = () => setRefresh((value) => value + 1);
  const resetPage = () =>
    setPagination((value) => ({ ...value, pageIndex: 0 }));
  const clearFilters = () => {
    setSearch("");
    setSupplier(undefined);
    setDateFrom("");
    setDateTo("");
    resetPage();
  };
  const openOrder = (id: string) => {
    opener.current = document.activeElement as HTMLElement;
    setLinePagination({ orderId: id, page: 0 });
    selectPurchaseOrder(id);
  };

  const columns = useMemo<ColumnDef<DashboardOrderRow>[]>(
    () => [
      {
        id: "purchaseOrderNumber",
        accessorFn: (row) =>
          observedValue(row.record.fields.purchaseOrderNumber),
        header: "Purchase order",
        cell: ({ row }) => (
          <button
            type="button"
            className="flex max-w-56 items-center gap-2 rounded text-left font-medium text-emerald-900 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
            aria-label={`Open purchase order ${observedValue(row.original.record.fields.purchaseOrderNumber) ?? "with missing number"}, row ${row.original.record.rowNumber}`}
            onClick={() => openOrder(row.original.record.id)}
          >
            <span
              className="truncate"
              title={
                observedValue(row.original.record.fields.purchaseOrderNumber) ??
                undefined
              }
            >
              <FieldValue
                field={row.original.record.fields.purchaseOrderNumber}
              />
            </span>
            <ArrowUpRight
              className="size-3.5 shrink-0 text-emerald-700/60"
              aria-hidden="true"
            />
          </button>
        ),
      },
      {
        id: "supplier",
        accessorFn: (row) => observedValue(row.record.fields.supplier),
        header: "Supplier",
        cell: ({ row }) => (
          <ObservedSupplierLink field={row.original.record.fields.supplier} />
        ),
      },
      {
        id: "orderDate",
        accessorFn: (row) => observedValue(row.record.fields.orderDate),
        header: "Order date",
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums">
            <FieldValue field={row.original.record.fields.orderDate} />
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (row) => observedValue(row.record.fields.status),
        header: "Status",
        cell: ({ row }) => (
          <FieldValue field={row.original.record.fields.status} />
        ),
      },
      {
        id: "total",
        header: "Total cost",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="space-y-1 text-right tabular-nums">
            <FieldValue field={row.original.record.fields.totalCost} />
            <div className="text-[10px] text-slate-500">
              {observedValue(row.original.record.fields.currency) ??
                "Currency not available"}
            </div>
          </div>
        ),
      },
      {
        id: "source",
        header: "Source",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-48 text-xs">
            <p
              className="truncate text-slate-600"
              title={row.original.fileName ?? undefined}
            >
              {row.original.fileName ?? "Source file unavailable"}
            </p>
            <p className="mt-1 text-[10px] text-slate-400">
              Data row {row.original.record.rowNumber} · CSV record{" "}
              {row.original.record.recordNumber}
            </p>
          </div>
        ),
      },
      {
        id: "data",
        header: "Data notes",
        enableSorting: false,
        cell: ({ row }) => {
          const fields = Object.values(row.original.record.fields);
          const missing = fields.filter(
            (field) => field.state === "missing",
          ).length;
          const review = fields.filter(
            (field) =>
              field.state === "invalid" || field.state === "conflicting",
          ).length;
          const calculated = fields.filter(
            (field) => field.state === "derived",
          ).length;
          return (
            <div className="space-y-1 whitespace-nowrap text-[11px]">
              {missing > 0 && (
                <p className="text-slate-500">
                  {missing} missing {missing === 1 ? "field" : "fields"}
                </p>
              )}
              {review > 0 && (
                <p className="text-amber-800">
                  {review} {review === 1 ? "field needs" : "fields need"} review
                </p>
              )}
              {calculated > 0 && (
                <p className="text-slate-500">{calculated} calculated</p>
              )}
              {missing + review + calculated === 0 && (
                <span className="text-emerald-800">All fields observed</span>
              )}
            </div>
          );
        },
      },
    ],
    [],
  );

  // IndexedDB supplies the sorted, filtered page. TanStack controls the table
  // state without sorting or paginating this partial result a second time.
  // TanStack v8 exposes mutable table functions; keep this call outside compiler memoization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: orders.data?.rows ?? noRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.record.id,
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: orders.data?.total ?? 0,
    state: {
      pagination: {
        ...pagination,
        pageIndex: orders.data?.pageIndex ?? pagination.pageIndex,
      },
      sorting,
    },
    onSortingChange: (updater) => {
      setSorting(updater);
      resetPage();
    },
    onPaginationChange: (updater) => setPagination((previous) => {
      const displayed = { ...previous, pageIndex: orders.data?.pageIndex ?? previous.pageIndex };
      return typeof updater === "function" ? updater(displayed) : updater;
    }),
    enableSortingRemoval: false,
    enableMultiSort: false,
  });
  const total = orders.data?.total ?? 0;
  const currentPage = orders.data?.pageIndex ?? 0;
  const archiveEmpty = overview.data?.importCount === 0;
  const noSummaries = overview.data && overview.data.totalOrders === 0;

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-3 text-xs font-medium text-slate-500">
            Workspace{" "}
            <span aria-hidden="true" className="mx-2 text-slate-300">
              /
            </span>{" "}
            Purchase orders
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-[34px]">
            Your purchase history
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Find an order. Trace it to the source. Keep the full picture.
          </p>
        </div>
        <Button asChild className="h-10 shadow-sm">
          <Link href="/import">
            <FileUp className="size-4" aria-hidden="true" />
            Import files
          </Link>
        </Button>
      </div>

      <section aria-label="Archive summary">
        <dl aria-label="Archive overview" className="grid gap-4 sm:grid-cols-3">
          {[
            {
              label: "Total orders",
              value: overview.data?.totalOrders,
              note: "Saved purchase-order summary records",
              icon: Package,
            },
            {
              label: "Observed suppliers",
              value: overview.data?.observedSuppliers,
              note: "Distinct names explicitly present in data",
              icon: Store,
            },
            {
              label: "Unique SKUs",
              value: overview.data?.uniqueSkus,
              note: "Distinct SKUs observed in line items",
              icon: Boxes,
            },
          ].map(({ label, value, note, icon: Icon }) => (
            <div
              key={label}
              className="relative rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-sm shadow-slate-200/20 sm:px-6"
            >
              <dt className="text-xs font-medium text-slate-500">{label}</dt>
              <dd className="mt-3 text-3xl font-semibold tracking-tight tabular-nums text-slate-900">
                {value?.toLocaleString() ?? (
                  <span
                    aria-label={overview.error ? "Unavailable" : "Loading"}
                    className="text-slate-300"
                  >
                    —
                  </span>
                )}
              </dd>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                {note}
              </p>
              <Icon
                className="absolute top-5 right-5 size-4 text-emerald-700/60"
                strokeWidth={1.7}
                aria-hidden="true"
              />
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[11px] leading-5 text-slate-500">
          Across all saved imports. Repeated order numbers remain separate
          records; names and SKUs are counted exactly as observed. Filters below
          apply to the table.
        </p>
        {overview.error && (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
          >
            {overview.error}
            <Button variant="outline" size="sm" onClick={retry}>
              Retry archive summary
            </Button>
          </div>
        )}
      </section>

      <section
        aria-labelledby="orders-heading"
        className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-200/20"
      >
        <div className="flex items-center justify-between gap-4 px-5 py-5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <h2
              id="orders-heading"
              tabIndex={-1}
              className="text-sm font-semibold text-slate-900"
            >
              Purchase orders
            </h2>
            {orders.data && (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] tabular-nums text-slate-600">
                {total.toLocaleString()}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={retry}
            disabled={busy}
            className="text-xs text-slate-500"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-y border-slate-100 bg-slate-50/40 px-5 py-4 sm:px-6">
          <div className="min-w-48 flex-1">
            <label
              htmlFor="order-search"
              className="mb-1.5 block text-[11px] font-medium text-slate-500"
            >
              Purchase-order number
            </label>
            <div className="relative">
              <Search
                className="absolute top-3 left-3 size-4 text-slate-400"
                aria-hidden="true"
              />
              <Input
                id="order-search"
                aria-label="Search purchase-order number"
                type="search"
                placeholder="Search purchase-order number…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  resetPage();
                }}
                className="h-10 bg-white pl-9"
              />
            </div>
          </div>
          <div className="w-full sm:w-auto">
            <span className="mb-1.5 block text-[11px] font-medium text-slate-500">
              Supplier
            </span>
            <SupplierFilter
              value={supplier}
              onChange={(value) => {
                setSupplier(value);
                resetPage();
              }}
              revision={revision}
            />
          </div>
          <div className="min-w-0 flex-1 sm:flex-none">
            <label
              htmlFor="date-from"
              className="mb-1.5 block text-[11px] font-medium text-slate-500"
            >
              Order date from
            </label>
            <Input
              id="date-from"
              type="date"
              value={dateFrom}
              aria-invalid={!!dateError}
              aria-describedby={dateError ? "date-error" : undefined}
              onChange={(event) => {
                setDateFrom(event.target.value);
                resetPage();
              }}
              className="h-10 min-w-0 bg-white sm:w-36"
            />
          </div>
          <div className="min-w-0 flex-1 sm:flex-none">
            <label
              htmlFor="date-to"
              className="mb-1.5 block text-[11px] font-medium text-slate-500"
            >
              Order date to
            </label>
            <Input
              id="date-to"
              type="date"
              value={dateTo}
              aria-invalid={!!dateError}
              aria-describedby={dateError ? "date-error" : undefined}
              onChange={(event) => {
                setDateTo(event.target.value);
                resetPage();
              }}
              className="h-10 min-w-0 bg-white sm:w-36"
            />
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-10 text-xs text-slate-500"
            >
              <X className="size-3.5" aria-hidden="true" />
              Clear filters
            </Button>
          )}
        </div>
        {dateError && (
          <p
            id="date-error"
            role="alert"
            className="px-6 py-3 text-xs text-red-700"
          >
            {dateError}
          </p>
        )}
        {(dateFrom || dateTo) && !dateError && (
          <p className="border-b border-slate-100 px-6 py-2 text-[11px] text-slate-500">
            Includes both selected dates. Orders without an observed order date
            are excluded.
          </p>
        )}
        <div aria-busy={busy}>
          {busy ? (
            <div
              role="status"
              className="flex min-h-64 items-center justify-center gap-2 text-sm text-slate-500"
            >
              <LoaderCircle
                className="size-4 motion-safe:animate-spin"
                aria-hidden="true"
              />
              Reading purchase history…
            </div>
          ) : orders.error ? (
            <div role="alert" className="px-6 py-12 text-center">
              <CircleAlert
                className="mx-auto mb-3 size-6 text-amber-700"
                aria-hidden="true"
              />
              <p className="text-sm text-slate-600">{orders.error}</p>
              <Button variant="outline" onClick={retry} className="mt-4">
                Retry purchase orders
              </Button>
            </div>
          ) : !dateError && orders.data && total === 0 ? (
            <div className="px-6 py-14 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-emerald-100 bg-emerald-50 text-emerald-800">
                {hasFilters ? (
                  <ListFilter className="size-5" aria-hidden="true" />
                ) : (
                  <FileSearch className="size-5" aria-hidden="true" />
                )}
              </div>
              <h3 className="mt-4 text-base font-semibold text-slate-900">
                {hasFilters
                  ? "No matching purchase orders"
                  : archiveEmpty
                    ? "Your purchase history starts here"
                    : "No purchase-order summaries yet"}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
                {hasFilters
                  ? "Try another order number, supplier, or date range. Missing values cannot match supplier or date filters."
                  : archiveEmpty
                    ? "Import your CSV files to explore saved orders, suppliers, and line items in this browser."
                  : noSummaries && (overview.data?.lineItemCount ?? 0) > 0
                      ? "Your archive contains line items. Import a supported purchase-order summary file to list orders here; line items are not converted into guessed orders."
                      : "Your saved files have no supported summary records. Review their schema notices and source data in Import files."}
              </p>
              {hasFilters ? (
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              ) : (
                <Button asChild className="mt-5">
                  <Link href="/import">
                    <FileUp className="size-4" aria-hidden="true" />
                    {archiveEmpty
                      ? "Import your first file"
                      : "Review imported files"}
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            !dateError &&
            orders.data && (
              <div>
                <Table
                  containerProps={{ role: "region", "aria-label": "Purchase-order results", tabIndex: 0, className: "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700" }}
                  aria-label="Purchase orders"
                  className="min-w-[1000px] text-xs"
                >
                  <TableHeader>
                    {table.getHeaderGroups().map((group) => (
                      <TableRow
                        key={group.id}
                        className="bg-white hover:bg-white"
                      >
                        {group.headers.map((header) => (
                          <TableHead
                            key={header.id}
                            aria-sort={
                              header.column.getCanSort()
                                ? header.column.getIsSorted() === "asc"
                                  ? "ascending"
                                  : header.column.getIsSorted() === "desc"
                                    ? "descending"
                                    : "none"
                                : undefined
                            }
                            className="h-12 px-5 text-[11px] font-medium text-slate-500 first:pl-6"
                          >
                            {header.column.getCanSort() ? (
                              <button
                                type="button"
                                aria-label={`Sort by ${columnLabels[header.column.id as keyof typeof columnLabels]}`}
                                onClick={header.column.getToggleSortingHandler()}
                                className="flex items-center gap-2 rounded py-2 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700"
                              >
                                {flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                                {header.column.getIsSorted() === "desc" ? (
                                  <ArrowDown
                                    className="size-3"
                                    aria-hidden="true"
                                  />
                                ) : header.column.getIsSorted() === "asc" ? (
                                  <ArrowUp
                                    className="size-3"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <ArrowUpDown
                                    className="size-3 text-slate-300"
                                    aria-hidden="true"
                                  />
                                )}
                              </button>
                            ) : (
                              flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )
                            )}
                          </TableHead>
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id} className="hover:bg-slate-50/70">
                        {row.getVisibleCells().map((cell) => (
                          <TableCell
                            key={cell.id}
                            className="max-w-64 px-5 py-4 break-words first:pl-6"
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 px-5 py-4 text-xs text-slate-500 sm:px-6">
          <p role="status">
            {orders.data && !busy
              ? total
                ? `Showing ${(currentPage * pagination.pageSize + 1).toLocaleString()}–${Math.min((currentPage + 1) * pagination.pageSize, total).toLocaleString()} of ${total.toLocaleString()} orders`
                : "0 orders"
              : dateError
                ? "Correct the date range to view orders"
                : "Waiting for query results"}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              Rows per page
              <select
                aria-label="Rows per page"
                value={pagination.pageSize}
                onChange={(event) =>
                  setPagination({
                    pageIndex: 0,
                    pageSize: Number(event.target.value),
                  })
                }
                className="h-8 rounded-md border bg-white px-2 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
              >
                {[25, 50, 100].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[11px] tabular-nums">
              Page {total ? currentPage + 1 : 0} of{" "}
              {Math.ceil(total / pagination.pageSize)}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={busy || !table.getCanPreviousPage() || !total}
              onClick={() => table.previousPage()}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={busy || !table.getCanNextPage() || !total}
              onClick={() => table.nextPage()}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </section>
      <p className="flex items-start gap-2 text-[11px] leading-5 text-slate-500">
        <CircleAlert
          className="mt-0.5 size-3.5 shrink-0 text-slate-400"
          aria-hidden="true"
        />
        Only observed field values appear here. Missing, invalid, conflicting,
        and calculated fields stay labeled; original evidence is available in
        each order.
      </p>
      <OrderDetailDrawer
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) selectPurchaseOrder(null);
        }}
        detail={details.data}
        loading={details.loading}
        error={details.error}
        onRetry={retry}
        onLinePageChange={(page) => setLinePagination({ orderId: selectedId, page })}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
          else document.getElementById("orders-heading")?.focus();
        }}
      />
    </div>
  );
}
