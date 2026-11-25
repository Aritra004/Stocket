import Dexie, { type Collection, type Table } from "dexie";
import type { ArchiveDatabase } from "./database";
import type { OrderPage } from "./dashboard-types";
import type { DirectoryQuery, HistoryLinePage, SkuDirectoryPage, SkuHistory, SkuHistoryQuery, SupplierDirectoryPage, SupplierHistory, SupplierHistoryQuery } from "./history-types";
import type { StoredLineItem, StoredPurchaseOrder } from "./types";

type HistoryRecord = StoredPurchaseOrder | StoredLineItem;

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function paging(total: number, pageIndex: number | undefined, pageSize: number | undefined, defaultSize: number) {
  const size = integer(pageSize, defaultSize, 1, 100);
  return { pageIndex: integer(pageIndex, 0, 0, Math.max(0, Math.ceil(total / size) - 1)), pageSize: size };
}

const fieldIndex = (field: "supplier" | "sku" | "orderDate") => `[fields.${field}.state+fields.${field}.value]`;

function exactField<T extends HistoryRecord>(table: Table<T, string>, field: "supplier" | "sku", literal: string) {
  return table.where(fieldIndex(field)).equals(["observed", literal]);
}

async function withFileNames<T extends HistoryRecord>(db: ArchiveDatabase, records: T[]) {
  const ids = [...new Set(records.map((record) => record.importId))];
  const files = await db.importedFiles.bulkGet(ids);
  const names = new Map(ids.map((id, i) => [id, files[i]?.fileName ?? null]));
  return records.map((record) => ({ record, fileName: names.get(record.importId) ?? null }));
}

/** One key-only pass retains at most one page, including out-of-range clamps. */
async function directoryKeys<T>(collection: Collection<T, string>, query: DirectoryQuery) {
  const search = (query.search ?? "").toLowerCase();
  const nameFromKey = (key: unknown) => (key as [string, string])[1];
  let ordered = collection;
  if (query.sortDirection === "desc") ordered = ordered.reverse();
  const requestedPage = integer(query.pageIndex, 0, 0, Number.MAX_SAFE_INTEGER);
  const size = integer(query.pageSize, 25, 1, 100);
  let total = 0;
  const keys: string[] = [];
  await ordered.eachUniqueKey((key) => {
    const literal = nameFromKey(key);
    if (!literal.toLowerCase().includes(search)) return;
    const position = total++;
    // Keep the latest complete/partial page until reaching the requested one.
    // If that page no longer exists after deletion, this is the actual last page.
    if (Math.floor(position / size) <= requestedPage) {
      if (position % size === 0) keys.length = 0;
      keys.push(literal);
    }
  });
  const page = paging(total, requestedPage, size, 25);
  return { keys, total, ...page };
}

export async function querySupplierDirectory(db: ArchiveDatabase, query: DirectoryQuery = {}): Promise<SupplierDirectoryPage> {
  return db.transaction("r", db.suppliers, db.purchaseOrders, db.lineItems, async () => {
    const { keys, ...page } = await directoryKeys(db.suppliers.where("[state+name]").between(["observed", Dexie.minKey], ["observed", Dexie.maxKey], true, true), query);
    const rows = await Promise.all(keys.map(async (name) => ({
      name,
      orderCount: await exactField(db.purchaseOrders, "supplier", name).count(),
      lineCount: await exactField(db.lineItems, "supplier", name).count(),
    })));
    const [unavailableOrderCount, unavailableLineCount] = await Promise.all([
      db.purchaseOrders.where("fields.supplier.state").notEqual("observed").count(),
      db.lineItems.where("fields.supplier.state").notEqual("observed").count(),
    ]);
    return { rows, ...page, unavailableOrderCount, unavailableLineCount };
  });
}

export async function querySkuDirectory(db: ArchiveDatabase, query: DirectoryQuery = {}): Promise<SkuDirectoryPage> {
  return db.transaction("r", db.lineItems, async () => {
    const { keys, ...page } = await directoryKeys(db.lineItems.where(fieldIndex("sku")).between(["observed", Dexie.minKey], ["observed", Dexie.maxKey], true, true), query);
    const rows = await Promise.all(keys.map(async (sku) => ({ sku, lineCount: await exactField(db.lineItems, "sku", sku).count() })));
    return { rows, ...page };
  });
}

/** Newest observed dates first, unavailable dates last; no date is synthesized. */
async function chronologicalPage<T extends HistoryRecord>(table: Table<T, string>, field: "supplier" | "sku", literal: string | null, pageIndex: number | undefined, pageSize: number | undefined, defaultSize: number) {
  const records = literal === null
    ? table.where("fields.supplier.state").notEqual("observed")
    : exactField(table, field, literal);
  const total = await records.count();
  const page = paging(total, pageIndex, pageSize, defaultSize);
  if (!total) return { records: [] as T[], total, ...page };
  const available = literal === null
    ? table.where(fieldIndex("orderDate")).between(["observed", Dexie.minKey], ["observed", Dexie.maxKey], true, true).reverse().filter((row) => row.fields.supplier.state !== "observed")
    : table.where(`[fields.${field}.state+fields.${field}.value+fields.orderDate.state+fields.orderDate.value]`).between(["observed", literal, "observed", Dexie.minKey], ["observed", literal, "observed", Dexie.maxKey], true, true).reverse();
  const availableTotal = await available.clone().count();
  const start = page.pageIndex * page.pageSize;
  const selected = start < availableTotal ? await available.offset(start).limit(page.pageSize).toArray() : [];
  if (total > availableTotal && selected.length < page.pageSize) {
    const unavailable = literal === null
      ? table.where("fields.orderDate.state").notEqual("observed").filter((row) => row.fields.supplier.state !== "observed")
      : table.where(`[fields.${field}.state+fields.${field}.value+fields.orderDate.state]`).between(["observed", literal, Dexie.minKey], ["observed", literal, Dexie.maxKey], true, true).filter((row) => row.fields.orderDate.state !== "observed");
    selected.push(...await unavailable.offset(Math.max(0, start - availableTotal)).limit(page.pageSize - selected.length).toArray());
  }
  return { records: selected, total, ...page };
}

export async function querySupplierHistory(db: ArchiveDatabase, query: SupplierHistoryQuery): Promise<SupplierHistory> {
  return db.transaction("r", db.purchaseOrders, db.lineItems, db.importedFiles, async () => {
    const orderResult = await chronologicalPage(db.purchaseOrders, "supplier", query.supplier, query.orderPageIndex, query.orderPageSize, 25);
    const lineResult = await chronologicalPage(db.lineItems, "supplier", query.supplier, query.linePageIndex, query.linePageSize, 20);
    const { records: orders, ...orderPage } = orderResult;
    const { records: lines, ...linePage } = lineResult;
    return {
      supplier: query.supplier,
      exists: orderPage.total + linePage.total > 0,
      orders: { rows: await withFileNames(db, orders), ...orderPage },
      lines: { rows: await withFileNames(db, lines), ...linePage },
    };
  });
}

export async function querySkuHistory(db: ArchiveDatabase, query: SkuHistoryQuery): Promise<SkuHistory> {
  return db.transaction("r", db.lineItems, db.importedFiles, async () => {
    const { records, ...page } = await chronologicalPage(db.lineItems, "sku", query.sku, query.pageIndex, query.pageSize, 20);
    const lines: HistoryLinePage = { rows: await withFileNames(db, records), ...page };
    return { sku: query.sku, exists: lines.total > 0, lines };
  });
}

/** Exact observed identifiers only; duplicate summary records stay separate. */
export async function queryPurchaseOrderCandidates(db: ArchiveDatabase, orderNumber: string | null, pageIndex = 0, pageSize = 20): Promise<OrderPage> {
  if (orderNumber === null) return { rows: [], total: 0, ...paging(0, pageIndex, pageSize, 20) };
  return db.transaction("r", db.purchaseOrders, db.importedFiles, async () => {
    const candidates = db.purchaseOrders.where("[fields.purchaseOrderNumber.state+fields.purchaseOrderNumber.value]").equals(["observed", orderNumber]);
    const total = await candidates.clone().count();
    const page = paging(total, pageIndex, pageSize, 20);
    const records = await candidates.offset(page.pageIndex * page.pageSize).limit(page.pageSize).toArray();
    return { rows: await withFileNames(db, records), total, ...page };
  });
}
