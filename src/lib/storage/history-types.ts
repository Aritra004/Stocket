import type { DashboardLineRow, OrderPage } from "./dashboard-types";

export interface DirectoryQuery {
  search?: string;
  pageIndex?: number;
  pageSize?: number;
  sortDirection?: "asc" | "desc";
}

export interface SupplierDirectoryPage {
  rows: Array<{ name: string; orderCount: number; lineCount: number }>;
  total: number;
  pageIndex: number;
  pageSize: number;
  /** Records without an observed supplier stay in a separate, explicit bucket. */
  unavailableOrderCount: number;
  unavailableLineCount: number;
}

export interface SkuDirectoryPage {
  rows: Array<{ sku: string; lineCount: number }>;
  total: number;
  pageIndex: number;
  pageSize: number;
}

export interface HistoryLinePage {
  rows: DashboardLineRow[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

export interface SupplierHistoryQuery {
  /** Null selects unavailable suppliers, never a fabricated supplier identity. */
  supplier: string | null;
  orderPageIndex?: number;
  orderPageSize?: number;
  linePageIndex?: number;
  linePageSize?: number;
}

export interface SupplierHistory {
  supplier: string | null;
  exists: boolean;
  orders: OrderPage;
  lines: HistoryLinePage;
}

export interface SkuHistoryQuery {
  sku: string;
  pageIndex?: number;
  pageSize?: number;
}

export interface SkuHistory {
  sku: string;
  exists: boolean;
  lines: HistoryLinePage;
}
