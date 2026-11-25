import Dexie, { type DexieOptions, type Table } from "dexie";
import type { StoredImport, StoredImportPayload, StoredOriginalFile, StoredLineItem, StoredPurchaseOrder, StoredSourceReference, StoredSupplier, StoredValidationIssue } from "./types";
import { refreshOverlaps } from "./overlaps";

export const DATABASE_NAME = "stocky-history-rescue";
export const DATABASE_VERSION = 5;
export const VERSION_1_STORES = {
  importedFiles: "id,&sha256,importedAt",
  importPayloads: "importId",
  purchaseOrders: "id,importId",
  lineItems: "id,importId",
  suppliers: "id,importId,name",
  validationIssues: "id,importId,scope",
  sourceReferences: "id,importId",
};
export const VERSION_2_STORES = {
  ...VERSION_1_STORES,
  purchaseOrders: "id,importId,orderKey,[importId+orderKey]",
  lineItems: "id,importId,orderKey,lineKey,[importId+orderKey]",
  validationIssues: "id,importId,scope,orderKey,[importId+scope]",
  sourceReferences: "id,importId,[importId+recordNumber]",
};

// Nested field indexes preserve source values and are maintained automatically
// for both existing rows and future imports. No dashboard copy is backfilled.
export const VERSION_3_STORES = {
  ...VERSION_2_STORES,
  purchaseOrders: `${VERSION_2_STORES.purchaseOrders},${["purchaseOrderNumber", "supplier", "orderDate", "status"].flatMap((field) => [
    `fields.${field}.state`, `[fields.${field}.state+fields.${field}.value]`,
  ]).join(",")}`,
  lineItems: `${VERSION_2_STORES.lineItems},[fields.sku.state+fields.sku.value]`,
  suppliers: `${VERSION_2_STORES.suppliers},[state+name]`,
};

const historyDateIndexes = (field: "supplier" | "sku") => [
  `[fields.${field}.state+fields.${field}.value+fields.orderDate.state+fields.orderDate.value]`,
  `[fields.${field}.state+fields.${field}.value+fields.orderDate.state]`,
].join(",");

// History indexes retain literal names/SKUs and their field states. IndexedDB
// builds them for existing records without rewriting source or business data.
export const VERSION_4_STORES = {
  ...VERSION_3_STORES,
  purchaseOrders: `${VERSION_3_STORES.purchaseOrders},${historyDateIndexes("supplier")}`,
  lineItems: `${VERSION_3_STORES.lineItems},fields.supplier.state,[fields.supplier.state+fields.supplier.value],fields.orderDate.state,[fields.orderDate.state+fields.orderDate.value],${historyDateIndexes("supplier")},${historyDateIndexes("sku")}`,
};

// Earlier versions retained parsed evidence but not every original byte. Leave
// the new table empty for those imports; only matching reimports can fill it.
export const VERSION_5_STORES = { ...VERSION_4_STORES, originalFiles: "importId" };

export type ArchiveDependencies = Pick<DexieOptions, "indexedDB" | "IDBKeyRange">;

/** Construct lazily in browser code or a worker, never at module evaluation. */
export class ArchiveDatabase extends Dexie {
  importedFiles!: Table<StoredImport, string>;
  importPayloads!: Table<StoredImportPayload, string>;
  originalFiles!: Table<StoredOriginalFile, string>;
  purchaseOrders!: Table<StoredPurchaseOrder, string>;
  lineItems!: Table<StoredLineItem, string>;
  suppliers!: Table<StoredSupplier, string>;
  validationIssues!: Table<StoredValidationIssue, string>;
  sourceReferences!: Table<StoredSourceReference, string>;

  constructor(name = DATABASE_NAME, dependencies?: ArchiveDependencies) {
    super(name, dependencies);
    this.version(1).stores(VERSION_1_STORES);
    this.version(2).stores(VERSION_2_STORES).upgrade(async (transaction) => {
      // v1 stored exact hashes and complete results; v2 adds explicit hash
      // provenance, review counters, and candidate-identity indexes, without
      // transforming any business value or discarding old source evidence.
      const issues = transaction.table<StoredValidationIssue, string>("validationIssues");
      const reviewCounts = new Map<string, number>();
      await issues.each((row) => {
        if (row.issue.severity !== "info") reviewCounts.set(row.importId, (reviewCounts.get(row.importId) ?? 0) + 1);
      });
      await transaction.table("importedFiles").toCollection().modify((row: StoredImport) => {
        row.hashVersion = "sha256/raw-v1";
        row.reviewCount = reviewCounts.get(row.id) ?? 0;
      });
      for (const tableName of ["purchaseOrders", "lineItems"]) {
        await transaction.table(tableName).toCollection().modify((row: StoredPurchaseOrder | StoredLineItem) => {
          const order = row.fields.purchaseOrderNumber;
          if (order.state === "observed" && order.value !== null) row.orderKey = order.value;
          else delete row.orderKey;
          if (row.kind === "purchase-order-line-item") {
            const line = row.fields.lineId;
            if (row.orderKey !== undefined && line.state === "observed" && line.value !== null) row.lineKey = JSON.stringify([row.orderKey, line.value]);
            else delete row.lineKey;
          }
        });
      }
      // Existing v1 imports also need cross-file review after the index upgrade,
      // even when the user has not imported anything new in this session.
      const orderKeys = new Set<string>();
      const importIds = new Set<string>();
      const purchaseOrders = transaction.table<StoredPurchaseOrder, string>("purchaseOrders");
      const lineItems = transaction.table<StoredLineItem, string>("lineItems");
      const importedFiles = transaction.table<StoredImport, string>("importedFiles");
      await purchaseOrders.each((row) => { if (row.orderKey !== undefined) orderKeys.add(row.orderKey); });
      await lineItems.each((row) => { if (row.orderKey !== undefined) orderKeys.add(row.orderKey); });
      await importedFiles.each((row) => { importIds.add(row.id); });
      await refreshOverlaps({ purchaseOrders, lineItems, importedFiles, validationIssues: issues }, orderKeys, importIds);
    });
    this.version(3).stores(VERSION_3_STORES);
    this.version(4).stores(VERSION_4_STORES);
    this.version(5).stores(VERSION_5_STORES);
  }
}

export function createArchiveDatabase(name = DATABASE_NAME, dependencies?: ArchiveDependencies): ArchiveDatabase {
  return new ArchiveDatabase(name, dependencies);
}
