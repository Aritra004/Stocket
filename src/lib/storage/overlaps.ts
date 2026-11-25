import type { ArchiveDatabase } from "./database";
import type { StoredLineItem, StoredPurchaseOrder, StoredValidationIssue } from "./types";

type IndexedRecord = StoredPurchaseOrder | StoredLineItem;
type OverlapTables = Pick<ArchiveDatabase, "purchaseOrders" | "lineItems" | "validationIssues" | "importedFiles">;
const BATCH_SIZE = 500;
const labels: Record<string, string> = {
  supplier: "supplier", currency: "currency", orderDate: "order date", status: "status",
  expectedDate: "expected date", totalCost: "total cost", orderedQuantity: "ordered quantity",
  receivedQuantity: "received quantity", sku: "SKU", productName: "product name", unitCost: "unit cost",
};

function conflictingNames(rows: IndexedRecord[], names: string[]): string[] {
  const conflicts: string[] = [];
  for (const name of names) {
    // Only compare explicit observations. Missing, invalid, derived, and already
    // conflicting values are never promoted to a canonical business value.
    const observations = new Map<string, Set<string>>();
    for (const row of rows) {
      const field = (row.fields as Record<string, { state: string; value: string | null }>)[name];
      if (field?.state !== "observed" || field.value === null) continue;
      const imports = observations.get(field.value) ?? new Set<string>();
      imports.add(row.importId);
      observations.set(field.value, imports);
    }
    if (observations.size > 1) {
      const importIds = new Set([...observations.values()].flatMap((ids) => [...ids]));
      if (importIds.size > 1) conflicts.push(name);
    }
  }
  return conflicts;
}

/** Run inside the same transaction as the save/removal; recalculate affected keys only. */
export async function refreshOverlaps(db: OverlapTables, orderKeys: Set<string>, affectedImports: Set<string>): Promise<void> {
  const keys = [...orderKeys];
  for (let offset = 0; offset < keys.length; offset += BATCH_SIZE) {
    const chunk = keys.slice(offset, offset + BATCH_SIZE);
    const prior = await db.validationIssues.where("orderKey").anyOf(chunk).toArray();
    for (const issue of prior) affectedImports.add(issue.importId);
    await db.validationIssues.where("orderKey").anyOf(chunk).delete();
    const rows: IndexedRecord[] = [
      ...await db.purchaseOrders.where("orderKey").anyOf(chunk).toArray(),
      ...await db.lineItems.where("orderKey").anyOf(chunk).toArray(),
    ];
    const groups = new Map<string, IndexedRecord[]>();
    for (const row of rows) {
      affectedImports.add(row.importId);
      const group = groups.get(row.orderKey!);
      if (group) group.push(row);
      else groups.set(row.orderKey!, [row]);
    }
    const newIssues: StoredValidationIssue[] = [];
    for (const [orderKey, group] of groups) {
      const importIds = new Set(group.map((row) => row.importId));
      if (importIds.size < 2) continue;
      const conflictFields = new Set(conflictingNames(group, ["supplier", "currency", "orderDate"]));
      const summaries = group.filter((row) => row.kind === "purchase-order-summary");
      for (const name of conflictingNames(summaries, ["status", "expectedDate", "totalCost", "orderedQuantity", "receivedQuantity"])) conflictFields.add(name);
      const lineGroups = new Map<string, StoredLineItem[]>();
      for (const row of group) {
        if (row.kind !== "purchase-order-line-item" || row.lineKey === undefined) continue;
        const lines = lineGroups.get(row.lineKey);
        if (lines) lines.push(row);
        else lineGroups.set(row.lineKey, [row]);
      }
      for (const lines of lineGroups.values()) {
        for (const name of conflictingNames(lines, ["sku", "productName", "unitCost", "orderedQuantity", "receivedQuantity"])) conflictFields.add(name);
      }
      // One notice per import/order, not every pair of matching records. The
      // exact orderKey index retrieves every related record without an O(n²)
      // graph of duplicate relation arrays.
      const firstByImport = new Map<string, IndexedRecord>();
      for (const row of group) if (!firstByImport.has(row.importId)) firstByImport.set(row.importId, row);
      // A small navigation sample makes related imports reachable without
      // creating a quadratic graph when many files share one order identifier.
      const relatedSample = [...importIds].slice(0, 6);
      for (const [importId, row] of firstByImport) {
        const conflicting = conflictFields.size > 0;
        newIssues.push({
          id: `${importId}:overlap:${JSON.stringify(orderKey)}`,
          importId, scope: "overlap", orderKey,
          recordId: row.id, sourceReferenceId: row.sourceReferenceId,
          relatedImportIds: relatedSample.filter((id) => id !== importId).slice(0, 5),
          relatedImportCount: importIds.size - 1,
          conflictingFields: [...conflictFields],
          issue: {
            severity: "warning", category: "schema",
            code: conflicting ? "ConflictingOrderRecords" : "AmbiguousOrderOverlap",
            message: conflicting
              ? `Purchase order ${orderKey} appears in ${importIds.size} saved imports with different ${[...conflictFields].map((name) => labels[name] ?? name).join(", ")} values. All records were kept separately; no value was chosen.`
              : `Purchase order ${orderKey} appears in ${importIds.size} saved imports. Its store and record identity are not confirmed. These may be overlapping records; none were merged.`,
            row: row.recordNumber,
          },
        });
      }
    }
    for (let start = 0; start < newIssues.length; start += BATCH_SIZE) await db.validationIssues.bulkPut(newIssues.slice(start, start + BATCH_SIZE));
  }
  for (const importId of affectedImports) {
    const reviewCount = await db.validationIssues.where("importId").equals(importId).filter((row) => row.issue.severity !== "info").count();
    await db.importedFiles.update(importId, { reviewCount });
  }
}
