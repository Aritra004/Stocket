import Dexie, { type Collection } from "dexie";
import type { ArchiveDatabase } from "./database";
import type { DashboardOverview, DashboardQuery, DashboardSortField, OrderDetail, OrderPage, SupplierPage } from "./dashboard-types";
import type { StoredLineItem, StoredPurchaseOrder, StoredSourceReference } from "./types";

const SORT_FIELDS: DashboardSortField[] = ["purchaseOrderNumber", "supplier", "orderDate", "status"];
const MAX_PAGE_SIZE = 100;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function paging(pageIndex: number | undefined, pageSize: number | undefined, total: number) {
  const size = boundedInteger(pageSize, 20, 1, MAX_PAGE_SIZE);
  const last = Math.max(0, Math.ceil(total / size) - 1);
  return { pageIndex: boundedInteger(pageIndex, 0, 0, last), pageSize: size };
}

function value(record: StoredPurchaseOrder, field: DashboardSortField): string | null {
  const entry = record.fields[field];
  return entry.state === "observed" ? entry.value : null;
}

function index(field: DashboardSortField) {
  return `[fields.${field}.state+fields.${field}.value]`;
}

function observed(db: ArchiveDatabase, field: DashboardSortField) {
  return db.purchaseOrders.where(index(field)).between(["observed", Dexie.minKey], ["observed", Dexie.maxKey], true, true);
}

function validateDate(date: string | undefined) {
  if (!date) return;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("Choose a valid order date in YYYY-MM-DD format.");
  }
}

/** Indexed ordering and bounded result pages; full normalized payloads are never read. */
export async function queryOrders(db: ArchiveDatabase, query: DashboardQuery = {}): Promise<OrderPage> {
  validateDate(query.dateFrom);
  validateDate(query.dateTo);
  if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) throw new Error("The start date must be on or before the end date.");
  const sortBy = SORT_FIELDS.includes(query.sortBy!) ? query.sortBy! : "orderDate";
  const search = (query.search ?? "").toLowerCase();
  const filtered = Boolean(search || query.supplier !== undefined || query.dateFrom || query.dateTo);
  const matches = (record: StoredPurchaseOrder) => {
    const number = value(record, "purchaseOrderNumber");
    if (search && (number === null || !number.toLowerCase().includes(search))) return false;
    if (query.supplier !== undefined && value(record, "supplier") !== query.supplier) return false;
    if (query.dateFrom || query.dateTo) {
      const date = value(record, "orderDate");
      if (date === null || (query.dateFrom && date < query.dateFrom) || (query.dateTo && date > query.dateTo)) return false;
    }
    return true;
  };
  return db.transaction("r", db.purchaseOrders, db.importedFiles, async () => {
    // Pick a selective index for the count, then stream in the requested index
    // order for the page. Substring searches necessarily inspect candidates.
    let candidates: Collection<StoredPurchaseOrder, string> = db.purchaseOrders.toCollection();
    if (query.supplier !== undefined) candidates = db.purchaseOrders.where(index("supplier")).equals(["observed", query.supplier]);
    else if (query.dateFrom || query.dateTo) candidates = db.purchaseOrders.where(index("orderDate")).between(
      ["observed", query.dateFrom || Dexie.minKey], ["observed", query.dateTo || Dexie.maxKey], true, true,
    );
    const total = await (filtered ? candidates.filter(matches) : candidates).count();
    const page = paging(query.pageIndex, query.pageSize, total);
    if (total === 0) return { rows: [], total, ...page };
    let available = observed(db, sortBy);
    if (query.sortDirection === "desc") available = available.reverse();
    if (filtered) available = available.filter(matches);
    const observedTotal = await available.clone().count();
    const start = page.pageIndex * page.pageSize;
    const rows: StoredPurchaseOrder[] = start < observedTotal
      ? await available.offset(start).limit(page.pageSize).toArray()
      : [];
    if (rows.length < page.pageSize) {
      // Null values cannot be IndexedDB keys. Their state index retains every
      // unavailable field and puts these rows last for either sort direction.
      let unavailable = db.purchaseOrders.where(`fields.${sortBy}.state`).notEqual("observed");
      if (filtered) unavailable = unavailable.filter(matches);
      rows.push(...await unavailable.offset(Math.max(0, start - observedTotal)).limit(page.pageSize - rows.length).toArray());
    }
    return { rows: await withFileNames(db, rows), total, ...page };
  });
}

async function withFileNames<T extends StoredPurchaseOrder | StoredLineItem>(db: ArchiveDatabase, rows: T[]): Promise<Array<{ record: T; fileName: string | null }>> {
  const ids = [...new Set(rows.map((row) => row.importId))];
  const files = await db.importedFiles.bulkGet(ids);
  const names = new Map(ids.map((id, i) => [id, files[i]?.fileName ?? null]));
  return rows.map((record) => ({ record, fileName: names.get(record.importId) ?? null }));
}

export async function queryOverview(db: ArchiveDatabase): Promise<DashboardOverview> {
  return db.transaction("r", db.purchaseOrders, db.lineItems, db.suppliers, db.importedFiles, async () => {
    let observedSuppliers = 0;
    let uniqueSkus = 0;
    // Counting distinct indexed keys avoids retaining a potentially large Set
    // or cloning all line items just to calculate the archive-wide metrics.
    await db.suppliers.where("[state+name]").between(["observed", Dexie.minKey], ["observed", Dexie.maxKey], true, true).eachUniqueKey(() => { observedSuppliers += 1; });
    await db.lineItems.where("[fields.sku.state+fields.sku.value]").between(["observed", Dexie.minKey], ["observed", Dexie.maxKey], true, true).eachUniqueKey(() => { uniqueSkus += 1; });
    const [totalOrders, importCount, lineItemCount] = await Promise.all([db.purchaseOrders.count(), db.importedFiles.count(), db.lineItems.count()]);
    return { totalOrders, observedSuppliers, uniqueSkus, importCount, lineItemCount };
  });
}

/** Exact names remain distinct; the search only controls which choices appear. */
export async function querySuppliers(db: ArchiveDatabase, search = "", limit = 100): Promise<SupplierPage> {
  const maximum = boundedInteger(limit, 100, 1, 100);
  const needle = search.toLowerCase();
  const suppliers: string[] = [];
  let total = 0;
  await db.suppliers.where("[state+name]").between(["observed", Dexie.minKey], ["observed", Dexie.maxKey], true, true).eachUniqueKey((key) => {
    const name = (key as [string, string])[1];
    if (!name.toLowerCase().includes(needle)) return;
    total += 1;
    if (suppliers.length < maximum) suppliers.push(name);
  });
  return { suppliers, total, limit: maximum };
}

export async function queryOrderDetail(db: ArchiveDatabase, id: string, linePageIndex = 0, linePageSize = 20): Promise<OrderDetail | undefined> {
  return db.transaction("r", db.purchaseOrders, db.lineItems, db.importedFiles, db.sourceReferences, async () => {
    const record = await db.purchaseOrders.get(id);
    if (!record) return undefined;
    const [order] = await withFileNames(db, [record]);
    const source = await db.sourceReferences.get(record.sourceReferenceId);
    const key = value(record, "purchaseOrderNumber");
    const candidates = key === null ? undefined : db.lineItems.where("orderKey").equals(key);
    const lineTotal = candidates ? await candidates.clone().count() : 0;
    const page = paging(linePageIndex, linePageSize, lineTotal);
    const records = candidates ? await candidates.offset(page.pageIndex * page.pageSize).limit(page.pageSize).toArray() : [];
    return { order, source, lines: await withFileNames(db, records), lineTotal, linePageIndex: page.pageIndex, linePageSize: page.pageSize };
  });
}

export async function querySourceReference(db: ArchiveDatabase, id: string): Promise<StoredSourceReference | undefined> {
  return db.sourceReferences.get(id);
}
