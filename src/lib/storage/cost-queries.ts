import type { ArchiveDatabase } from "./database";
import type { SkuCostHistory, SkuCostHistoryQuery } from "./cost-types";
import { querySkuHistory } from "./history-queries";

/**
 * Read exact-SKU observations newest-first with unavailable dates last. Reuse the
 * indexed history page so missing costs are not filtered out, original sources
 * remain inspectable, and decimal strings never pass through floating point.
 */
export async function querySkuCostHistory(db: ArchiveDatabase, query: SkuCostHistoryQuery): Promise<SkuCostHistory> {
  const history = await querySkuHistory(db, query);
  return { sku: history.sku, exists: history.exists, entries: history.lines };
}
