import type { Table } from "dexie";
import type { CsvImportResult, ValidationIssue } from "../importer/types";
import type { NormalizedRecord } from "../stocky/types";
import type { ArchiveDatabase } from "./database";
import { hashFile } from "./hash";
import { refreshOverlaps } from "./overlaps";
import type { SaveImportInput, SaveImportOutcome, StoredFields, StoredImport, StoredLineItem, StoredPurchaseOrder, StoredSourceReference, StoredSupplier, StoredValidationIssue } from "./types";

const BATCH_SIZE = 500;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function projectFields<F extends object>(fields: F, sourceReferenceId: string): StoredFields<F> {
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, {
    state: field.state, value: field.value, sourceReferenceId,
  }])) as StoredFields<F>;
}

async function prepareImport(input: SaveImportInput, importId: string) {
  const orders: StoredPurchaseOrder[] = [];
  const lines: StoredLineItem[] = [];
  const suppliers: StoredSupplier[] = [];
  const sources = new Map<string, StoredSourceReference>();
  const issues = new Map<string, StoredValidationIssue>();
  const orderKeys = new Set<string>();
  const addIssue = (scope: "csv" | "normalization", issue: ValidationIssue, recordId?: string, sourceReferenceId?: string) => {
    const key = JSON.stringify([scope, issue.severity, issue.category, issue.code, issue.message, issue.row, issue.column]);
    const prior = issues.get(key);
    if (prior) {
      if (recordId) prior.recordId = recordId;
      if (sourceReferenceId) prior.sourceReferenceId = sourceReferenceId;
      return;
    }
    issues.set(key, { id: `${importId}:issue:${issues.size}`, importId, scope, issue, ...(recordId ? { recordId } : {}), ...(sourceReferenceId ? { sourceReferenceId } : {}) });
  };
  for (const issue of [...input.result.info, ...input.result.warnings, ...input.result.errors]) addIssue("csv", issue);

  for (let index = 0; index < input.result.normalized.records.length; index += 1) {
    const record = input.result.normalized.records[index];
    const id = `${importId}:record:${index}`;
    const sourceId = `${importId}:source:${record.source.recordNumber}`;
    const order = record.fields.purchaseOrderNumber;
    const orderKey = order.state === "observed" ? order.value : undefined;
    if (orderKey !== undefined) orderKeys.add(orderKey);
    const common = {
      id, importId, recordIndex: index, sourceReferenceId: sourceId,
      rowNumber: record.source.rowNumber, recordNumber: record.source.recordNumber,
      adapterId: record.adapterId, adapterVersion: record.adapterVersion,
      ...(orderKey !== undefined ? { orderKey } : {}),
    };
    if (record.kind === "purchase-order-summary") {
      orders.push({ ...common, kind: record.kind, fields: projectFields(record.fields, sourceId) });
    } else {
      const line = record.fields.lineId;
      lines.push({ ...common, kind: record.kind, fields: projectFields(record.fields, sourceId),
        ...(orderKey !== undefined && line.state === "observed" ? { lineKey: JSON.stringify([orderKey, line.value]) } : {}),
      });
    }
    sources.set(sourceId, { id: sourceId, importId, recordId: id, kind: "normalized", recordNumber: record.source.recordNumber, dataRowNumber: record.source.rowNumber, source: record.source });
    for (const issue of record.issues) addIssue("normalization", issue, id, sourceId);
    if (orderKey === undefined && !record.issues.some((issue) => issue.code === "MissingRecordIdentity")) {
      addIssue("normalization", { severity: "warning", category: "schema", code: "AmbiguousOrderIdentity", message: "This record has no confirmed purchase-order identifier. It was saved separately without linking it to another order.", row: record.source.recordNumber }, id, sourceId);
    }
    addSupplierObservation(suppliers, record, importId, id, sourceId);
    if ((index + 1) % BATCH_SIZE === 0) await pause();
  }
  for (let index = 0; index < input.result.normalized.withheldRecords.length; index += 1) {
    const record = input.result.normalized.withheldRecords[index];
    const sourceId = `${importId}:source:${record.source.recordNumber}`;
    sources.set(sourceId, { id: sourceId, importId, kind: "withheld", recordNumber: record.source.recordNumber, dataRowNumber: record.source.rowNumber, source: record.source });
    for (const issue of record.issues) addIssue(issue.category === "schema" ? "normalization" : "csv", issue, undefined, sourceId);
    if ((index + 1) % BATCH_SIZE === 0) await pause();
  }
  for (let index = 0; index < input.result.recordsWithIssues.length; index += 1) {
    const record = input.result.recordsWithIssues[index];
    const sourceId = `${importId}:source:${record.recordNumber}`;
    if (!sources.has(sourceId)) {
      sources.set(sourceId, {
        id: sourceId, importId, kind: "csv-issue", recordNumber: record.recordNumber, dataRowNumber: record.dataRowNumber,
        source: {
          fileName: input.file.name, rowNumber: record.dataRowNumber, recordNumber: record.recordNumber,
          values: record.values, rawText: record.rawText,
          cells: Array.from({ length: Math.max(record.values.length, input.result.columns.length) }, (_, column) => ({
            fileName: input.file.name, rowNumber: record.dataRowNumber, recordNumber: record.recordNumber,
            column: column + 1, header: input.result.columns[column] ?? null, rawValue: record.values[column] ?? null,
          })),
        },
      });
    }
    for (const issue of record.issues) addIssue("csv", issue, undefined, sourceId);
    if ((index + 1) % BATCH_SIZE === 0) await pause();
  }
  return { orders, lines, suppliers, sources: [...sources.values()], issues: [...issues.values()], orderKeys };
}

function addSupplierObservation(output: StoredSupplier[], record: NormalizedRecord, importId: string, recordId: string, sourceReferenceId: string): void {
  const supplier = record.fields.supplier;
  if (supplier.state !== "observed" && supplier.state !== "conflicting") return;
  // The registered adapter uses one fixed column per field in a file. Read only
  // this row's original cell, never duplicate every conflict alternative for
  // every row or choose a canonical supplier for the group.
  const column = supplier.sources[0]?.column;
  const cell = column === undefined ? undefined : record.source.cells[column - 1];
  if (!cell || cell.rawValue === null || cell.rawValue.trim() === "") return;
  output.push({ id: `${recordId}:supplier`, importId, recordId, sourceReferenceId, name: cell.rawValue, state: supplier.state, column: cell.column });
}

async function putBatches<T>(table: Table<T, string>, values: T[]): Promise<void> {
  for (let index = 0; index < values.length; index += BATCH_SIZE) await table.bulkPut(values.slice(index, index + BATCH_SIZE));
}

async function deleteImportRows(db: ArchiveDatabase, importId: string): Promise<void> {
  for (const table of [db.purchaseOrders, db.lineItems, db.suppliers, db.validationIssues, db.sourceReferences]) {
    await table.where("importId").equals(importId).delete();
  }
  await db.importPayloads.delete(importId);
  await db.originalFiles.delete(importId);
  await db.importedFiles.delete(importId);
}

async function affectedOrderKeys(db: ArchiveDatabase, importId: string): Promise<Set<string>> {
  const orders = await db.purchaseOrders.where("importId").equals(importId).toArray();
  const lines = await db.lineItems.where("importId").equals(importId).toArray();
  return new Set([...orders, ...lines].flatMap((row) => row.orderKey === undefined ? [] : [row.orderKey]));
}

/** Atomic unique-hash save/replacement. Hashing and parsing happen before this API. */
export async function saveImport(db: ArchiveDatabase, input: SaveImportInput): Promise<SaveImportOutcome> {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("A complete SHA-256 hash of the original file is required.");
  if (input.file.name !== input.result.fileName || input.file.size !== input.result.fileSize) throw new Error("The parsed result does not match this file.");
  if (!Number.isFinite(input.file.size) || input.file.size < 0 || !input.file.name) throw new Error("The file metadata is invalid.");
  if (input.originalFile && (input.originalFile.size !== input.file.size || await hashFile(input.originalFile) !== input.sha256)) {
    throw new Error("The original CSV bytes do not match this import's size and SHA-256 hash. No changes were saved.");
  }
  if (input.replaceId && (input.result.status === "error" || input.result.status === "unsupported")) throw new Error("The replacement file could not be read reliably. The saved import was kept unchanged.");
  const importId = input.replaceId ?? crypto.randomUUID();
  const prepared = await prepareImport(input, importId);
  // All reads that determine duplicate/replacement/overlap behavior and every
  // write share one transaction. Concurrent browser tabs cannot race the hash.
  return db.transaction("rw", db.tables, async () => {
    if (input.replaceId) {
      const current = await db.importedFiles.get(input.replaceId);
      if (!current) throw new Error("The import to replace no longer exists. Reload the local archive and try again.");
      if (input.expectedHash !== undefined && current.sha256 !== input.expectedHash) throw new Error("This saved import changed in another tab. Reload the local archive before replacing it.");
    }
    const duplicate = await db.importedFiles.where("sha256").equals(input.sha256).first();
    if (duplicate) {
      if (input.originalFile) {
        if (duplicate.fileSize !== input.originalFile.size) throw new Error("The saved import's file size does not match its original bytes. No changes were saved.");
        await db.originalFiles.put({ importId: duplicate.id, blob: input.originalFile });
      }
      return { kind: "duplicate", file: duplicate };
    }
    const affectedImports = new Set([importId]);
    if (input.replaceId) {
      for (const key of await affectedOrderKeys(db, input.replaceId)) prepared.orderKeys.add(key);
      await deleteImportRows(db, input.replaceId);
    }
    const stored: StoredImport = {
      id: importId, fileName: input.file.name, fileSize: input.file.size, fileType: input.file.type,
      lastModified: input.file.lastModified, sha256: input.sha256, hashVersion: "sha256/raw-v1",
      importedAt: Date.now(), totalRows: input.result.totalRows, status: input.result.status,
      normalizedCount: input.result.normalized.records.length,
      reviewCount: prepared.issues.filter((issue) => issue.issue.severity !== "info").length,
    };
    await db.importedFiles.add(stored);
    await db.importPayloads.add({ importId, result: input.result });
    if (input.originalFile) await db.originalFiles.add({ importId, blob: input.originalFile });
    await putBatches(db.purchaseOrders, prepared.orders);
    await putBatches(db.lineItems, prepared.lines);
    await putBatches(db.suppliers, prepared.suppliers);
    await putBatches(db.sourceReferences, prepared.sources);
    await putBatches(db.validationIssues, prepared.issues);
    await refreshOverlaps(db, prepared.orderKeys, affectedImports);
    return { kind: "saved", file: (await db.importedFiles.get(importId))! };
  });
}

export async function listImports(db: ArchiveDatabase): Promise<StoredImport[]> {
  return db.importedFiles.orderBy("importedAt").reverse().toArray();
}

export async function getImportResult(db: ArchiveDatabase, id: string): Promise<CsvImportResult | undefined> {
  return (await db.importPayloads.get(id))?.result;
}

export async function findImportByHash(db: ArchiveDatabase, hash: string): Promise<StoredImport | undefined> {
  return db.importedFiles.where("sha256").equals(hash).first();
}

export async function listImportIssues(db: ArchiveDatabase, id: string): Promise<StoredValidationIssue[]> {
  return db.validationIssues.where("importId").equals(id).toArray();
}

export async function removeImport(db: ArchiveDatabase, id: string, expectedHash?: string): Promise<void> {
  await db.transaction("rw", db.tables, async () => {
    if (expectedHash !== undefined) {
      const current = await db.importedFiles.get(id);
      if (!current || current.sha256 !== expectedHash) throw new Error("This saved import changed in another tab. Reload the local archive before removing it.");
    }
    const keys = await affectedOrderKeys(db, id);
    await deleteImportRows(db, id);
    await refreshOverlaps(db, keys, new Set());
  });
}

/** UI confirmation is required before calling this explicitly destructive action. */
export async function clearArchive(db: ArchiveDatabase): Promise<void> {
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
}
