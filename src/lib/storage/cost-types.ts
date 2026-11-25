import type { HistoryLinePage } from "./history-types";

export interface SkuCostHistoryQuery {
  sku: string;
  pageIndex?: number;
  pageSize?: number;
}

/**
 * Literal purchase-line observations, including lines whose cost is unavailable.
 * Currency, cost and quantity states remain independent; no money is aggregated.
 */
export interface SkuCostHistory {
  sku: string;
  exists: boolean;
  entries: HistoryLinePage;
}
