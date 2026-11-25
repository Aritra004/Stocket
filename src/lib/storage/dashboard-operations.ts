import { createArchiveDatabase } from "./database";
import {
  queryOrderDetail,
  queryOrders,
  queryOverview,
  querySourceReference,
  querySuppliers,
} from "./dashboard-queries";
import type {
  DashboardOverview,
  DashboardQuery,
  OrderDetail,
  OrderPage,
  SupplierPage,
} from "./dashboard-types";
import type { StoredSourceReference } from "./types";
import { queryPurchaseOrderCandidates, querySkuDirectory, querySkuHistory, querySupplierDirectory, querySupplierHistory } from "./history-queries";
import type { DirectoryQuery, SkuDirectoryPage, SkuHistory, SupplierDirectoryPage, SupplierHistory } from "./history-types";
import { querySkuCostHistory } from "./cost-queries";
import type { SkuCostHistory } from "./cost-types";
import { queryDataQuality } from "./quality-queries";
import type { DataQualitySnapshot } from "./quality-types";
import { queryOfflineArchive } from "./offline-export";
import type { OfflineArchive } from "../../../offline-viewer/types";
import { assertArchiveExportEnabled } from "../export-access";

export type DashboardRequest =
  | { operation: "orders"; query: DashboardQuery }
  | { operation: "overview" }
  | { operation: "suppliers"; search: string }
  | { operation: "detail"; id: string; pageIndex: number }
  | { operation: "source"; id: string }
  | { operation: "supplier-directory"; query: DirectoryQuery }
  | { operation: "sku-directory"; query: DirectoryQuery }
  | { operation: "supplier-history"; supplier: string | null; orderPageIndex: number; linePageIndex: number }
  | { operation: "sku-history"; sku: string; pageIndex: number }
  | { operation: "sku-cost-history"; sku: string; pageIndex: number }
  | { operation: "data-quality" }
  | { operation: "offline-archive" }
  | { operation: "order-candidates"; orderNumber: string | null; pageIndex: number };

export interface DashboardResponses {
  orders: OrderPage;
  overview: DashboardOverview;
  suppliers: SupplierPage;
  detail: OrderDetail | undefined;
  source: StoredSourceReference | undefined;
  "supplier-directory": SupplierDirectoryPage;
  "sku-directory": SkuDirectoryPage;
  "supplier-history": SupplierHistory;
  "sku-history": SkuHistory;
  "sku-cost-history": SkuCostHistory;
  "data-quality": DataQualitySnapshot;
  "offline-archive": OfflineArchive;
  "order-candidates": OrderPage;
}

export async function executeDashboardRequest<R extends DashboardRequest>(
  request: R,
  signal?: AbortSignal,
): Promise<DashboardResponses[R["operation"]]> {
  if (request.operation === "offline-archive") await assertArchiveExportEnabled(signal);
  const db = createArchiveDatabase();
  const abort = () => db.close();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    let result: DashboardResponses[keyof DashboardResponses];
    switch (request.operation) {
      case "orders":
        result = await queryOrders(db, request.query);
        break;
      case "overview":
        result = await queryOverview(db);
        break;
      case "suppliers":
        result = await querySuppliers(db, request.search);
        break;
      case "detail":
        result = await queryOrderDetail(db, request.id, request.pageIndex);
        break;
      case "source":
        result = await querySourceReference(db, request.id);
        break;
      case "supplier-directory":
        result = await querySupplierDirectory(db, request.query);
        break;
      case "sku-directory":
        result = await querySkuDirectory(db, request.query);
        break;
      case "supplier-history":
        result = await querySupplierHistory(db, request);
        break;
      case "sku-history":
        result = await querySkuHistory(db, request);
        break;
      case "sku-cost-history":
        result = await querySkuCostHistory(db, request);
        break;
      case "data-quality":
        result = await queryDataQuality(db);
        break;
      case "offline-archive":
        result = await queryOfflineArchive(db);
        break;
      case "order-candidates":
        result = await queryPurchaseOrderCandidates(db, request.orderNumber, request.pageIndex);
        break;
    }
    signal?.throwIfAborted();
    return result as DashboardResponses[R["operation"]];
  } finally {
    signal?.removeEventListener("abort", abort);
    db.close();
  }
}

export function dashboardErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "Error") return error.message;
  return "Saved purchase history could not be read. Browser storage may be blocked or unavailable. Retry to open the local archive.";
}
