import type { StoredLineItem, StoredPurchaseOrder, StoredSourceReference } from "./types";

export type DashboardSortField = "purchaseOrderNumber" | "supplier" | "orderDate" | "status";

export interface DashboardQuery {
  search?: string;
  supplier?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: DashboardSortField;
  sortDirection?: "asc" | "desc";
  pageIndex?: number;
  pageSize?: number;
}

export interface DashboardOrderRow { record: StoredPurchaseOrder; fileName: string | null }
export interface DashboardLineRow { record: StoredLineItem; fileName: string | null }

export interface OrderPage {
  rows: DashboardOrderRow[];
  total: number;
  pageIndex: number;
  pageSize: number;
}

/** Archive-wide counts, independent of table filters. No identities are inferred. */
export interface DashboardOverview {
  /** Number of saved summary records, including repeated order identifiers. */
  totalOrders: number;
  /** Distinct exact supplier names whose saved observation state is observed. */
  observedSuppliers: number;
  /** Distinct exact SKU strings whose normalized state is observed. */
  uniqueSkus: number;
  importCount: number;
  lineItemCount: number;
}

export interface SupplierPage { suppliers: string[]; total: number; limit: number }

export interface OrderDetail {
  order: DashboardOrderRow;
  source: StoredSourceReference | undefined;
  /** Candidate matches on exact observed PO number; never a confirmed cross-file join. */
  lines: DashboardLineRow[];
  lineTotal: number;
  linePageIndex: number;
  linePageSize: number;
}
