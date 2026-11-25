import type { OfflineArchive, OfflineField, OfflineFieldState, OfflineFile, OfflineFinding, OfflineRecord, OfflineSource } from "./types";

const states: readonly OfflineFieldState[] = ["observed", "missing", "invalid", "conflicting", "derived"];
const decimalFields = new Set(["unitCost", "totalCost", "orderedQuantity", "receivedQuantity", "outstandingQuantity"]);
const dateFields = new Set(["orderDate", "expectedDate"]);
const summaryFields = ["purchaseOrderNumber", "supplier", "status", "orderDate", "expectedDate", "currency", "totalCost", "orderedQuantity", "receivedQuantity", "outstandingQuantity"];
const lineFields = ["purchaseOrderNumber", "lineId", "sku", "productName", "supplier", "orderDate", "currency", "unitCost", "orderedQuantity", "receivedQuantity", "outstandingQuantity"];

function fail(path: string, message: string): never { throw new TypeError(`${path}: ${message}`); }

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "expected a plain JSON object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail(`${path}.${key}`, "unexpected property for archive version 1");
  for (const key of keys) if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "required property is missing");
  return record;
}

function string(value: unknown, path: string, nonempty = false): string {
  if (typeof value !== "string") fail(path, "expected a string; values are never coerced");
  if (nonempty && value.length === 0) fail(path, "expected a nonempty string");
  return value;
}

function nullableString(value: unknown, path: string): string | null { return value === null ? null : string(value, path); }
function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(path, `expected a safe integer of at least ${minimum}`);
  return value;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}
function strings(value: unknown, path: string, unique = false): string[] {
  const result = array(value, path).map((entry, index) => string(entry, `${path}[${index}]`, unique));
  if (unique && new Set(result).size !== result.length) fail(path, "references must not repeat");
  return result;
}

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function exportedAt(value: unknown): string {
  const text = string(value, "archive.exportedAt");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(text);
  if (!match || !calendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || (match[5] !== "Z" && (Number(match[6]) > 23 || Number(match[7]) > 59)) || !Number.isFinite(Date.parse(text))) fail("archive.exportedAt", "expected a valid ISO timestamp with an explicit timezone");
  return text;
}

function field(value: unknown, path: string, name: string): OfflineField {
  const input = object(value, path, ["state", "value"]);
  if (!states.includes(input.state as OfflineFieldState)) fail(`${path}.state`, "unknown field state");
  const state = input.state as OfflineFieldState;
  if (state === "missing" || state === "invalid" || state === "conflicting") {
    if (input.value !== null) fail(`${path}.value`, `${state} fields must have a null value`);
    return { state, value: null };
  }
  const text = string(input.value, `${path}.value`);
  if (decimalFields.has(name)) {
    if (!/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(text)) fail(`${path}.value`, "expected an exact canonical nonnegative decimal string, without exponents, leading zeroes, or trailing fractional zeroes");
  } else if (dateFields.has(name)) {
    if (!calendarDate(text)) fail(`${path}.value`, "expected a real calendar date in YYYY-MM-DD format");
  } else if (name === "currency") {
    if (!/^[A-Z]{3}$/.test(text)) fail(`${path}.value`, "expected an explicit three-letter uppercase currency code");
  } else if (text.trim().length === 0) fail(`${path}.value`, "observed or derived text must not be empty or whitespace-only");
  return { state, value: text };
}

/** Validate and copy a versioned archive without coercing or normalizing any value. */
export function validateOfflineArchive(input: unknown): OfflineArchive {
  const root = object(input, "archive", ["version", "exportedAt", "files", "records", "sources", "findings", "qualityNotes"]);
  if (root.version !== 1) fail("archive.version", "unsupported archive version; expected 1");
  const timestamp = exportedAt(root.exportedAt);
  const ids = new Map<string, string>();
  function id(value: unknown, path: string): string {
    const valueString = string(value, path, true);
    const prior = ids.get(valueString);
    if (prior) fail(path, `duplicate ID; already used at ${prior}`);
    ids.set(valueString, path);
    return valueString;
  }
  const files: OfflineFile[] = array(root.files, "archive.files").map((value, index) => {
    const path = `archive.files[${index}]`;
    const item = object(value, path, ["id", "name", "totalRows", "status", "coverageNotes"]);
    return { id: id(item.id, `${path}.id`), name: string(item.name, `${path}.name`, true), totalRows: integer(item.totalRows, `${path}.totalRows`), status: string(item.status, `${path}.status`, true), coverageNotes: strings(item.coverageNotes, `${path}.coverageNotes`) };
  });
  const fileMap = new Map(files.map((file) => [file.id, file]));
  function fileId(value: unknown, path: string): string {
    const reference = string(value, path, true);
    if (!fileMap.has(reference)) fail(path, "references an unknown file ID");
    return reference;
  }
  const sources: OfflineSource[] = array(root.sources, "archive.sources").map((value, index) => {
    const path = `archive.sources[${index}]`;
    const item = object(value, path, ["id", "fileId", "dataRowNumber", "recordNumber", "cells", "rawText"]);
    const file = fileId(item.fileId, `${path}.fileId`);
    const dataRowNumber = item.dataRowNumber === null ? null : integer(item.dataRowNumber, `${path}.dataRowNumber`, 1);
    if (dataRowNumber !== null && dataRowNumber > fileMap.get(file)!.totalRows) fail(`${path}.dataRowNumber`, "exceeds the referenced file's totalRows");
    const seenColumns = new Set<number>();
    const cells = array(item.cells, `${path}.cells`).map((value, columnIndex) => {
      const cellPath = `${path}.cells[${columnIndex}]`;
      const cell = object(value, cellPath, ["column", "header", "rawValue"]);
      const column = integer(cell.column, `${cellPath}.column`, 1);
      if (seenColumns.has(column)) fail(`${cellPath}.column`, "duplicate source column position");
      seenColumns.add(column);
      return { column, header: nullableString(cell.header, `${cellPath}.header`), rawValue: nullableString(cell.rawValue, `${cellPath}.rawValue`) };
    });
    return { id: id(item.id, `${path}.id`), fileId: file, dataRowNumber, recordNumber: integer(item.recordNumber, `${path}.recordNumber`, 1), cells, rawText: string(item.rawText, `${path}.rawText`) };
  });
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  function sourceId(value: unknown, path: string, file: string): string {
    const reference = string(value, path, true);
    const source = sourceMap.get(reference);
    if (!source) fail(path, "references an unknown source ID");
    if (source.fileId !== file) fail(path, "source belongs to a different file");
    return reference;
  }
  const records: OfflineRecord[] = array(root.records, "archive.records").map((value, index) => {
    const path = `archive.records[${index}]`;
    const item = object(value, path, ["id", "fileId", "kind", "sourceId", "fields"]);
    const file = fileId(item.fileId, `${path}.fileId`);
    if (item.kind !== "purchase-order-summary" && item.kind !== "purchase-order-line-item") fail(`${path}.kind`, "unknown record kind");
    const names = item.kind === "purchase-order-summary" ? summaryFields : lineFields;
    const fields = object(item.fields, `${path}.fields`, names);
    const source = sourceId(item.sourceId, `${path}.sourceId`, file);
    if (sourceMap.get(source)!.dataRowNumber === null) fail(`${path}.sourceId`, "a normalized record must reference a data row, not a header");
    return { id: id(item.id, `${path}.id`), fileId: file, kind: item.kind, sourceId: source, fields: Object.fromEntries(names.map((name) => [name, field(fields[name], `${path}.fields.${name}`, name)])) };
  });
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const findings: OfflineFinding[] = array(root.findings, "archive.findings").map((value, index) => {
    const path = `archive.findings[${index}]`;
    const item = object(value, path, ["id", "fileId", "category", "severity", "message", "recordIds", "sourceIds"]);
    const file = fileId(item.fileId, `${path}.fileId`);
    if (item.severity !== "info" && item.severity !== "warning" && item.severity !== "error") fail(`${path}.severity`, "unknown finding severity");
    const recordIds = strings(item.recordIds, `${path}.recordIds`, true);
    recordIds.forEach((reference, referenceIndex) => {
      const record = recordMap.get(reference);
      if (!record) fail(`${path}.recordIds[${referenceIndex}]`, "references an unknown record ID");
      if (record.fileId !== file) fail(`${path}.recordIds[${referenceIndex}]`, "record belongs to a different file");
    });
    const sourceIds = strings(item.sourceIds, `${path}.sourceIds`, true).map((reference, referenceIndex) => sourceId(reference, `${path}.sourceIds[${referenceIndex}]`, file));
    return { id: id(item.id, `${path}.id`), fileId: file, category: string(item.category, `${path}.category`, true), severity: item.severity, message: string(item.message, `${path}.message`), recordIds, sourceIds };
  });
  return { version: 1, exportedAt: timestamp, files, records, sources, findings, qualityNotes: strings(root.qualityNotes, "archive.qualityNotes") };
}
