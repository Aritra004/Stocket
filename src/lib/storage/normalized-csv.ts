import type { OfflineArchive, OfflineRecord } from "../../../offline-viewer/types";
import type { StoredSupplier } from "./types";

const summaryFields = ["purchaseOrderNumber", "supplier", "status", "orderDate", "expectedDate", "currency", "totalCost", "orderedQuantity", "receivedQuantity", "outstandingQuantity"];
const itemFields = ["purchaseOrderNumber", "lineId", "sku", "productName", "supplier", "orderDate", "currency", "unitCost", "orderedQuantity", "receivedQuantity", "outstandingQuantity"];
const snake = (value: string) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** Escape before RFC 4180 quoting, including formula triggers after whitespace. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvRow(values: Array<string | number | null | undefined>): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/** Rows are streamed into the compressor, not joined into another giant string. */
export function* normalizedCsvRows(archive: OfflineArchive, kind: OfflineRecord["kind"] | "supplier", suppliers: StoredSupplier[] = []): Generator<string> {
  const files = new Map(archive.files.map((file) => [file.id, file.name]));
  const sources = new Map(archive.sources.map((source) => [source.id, source]));
  const observations = new Map(suppliers.map((supplier) => [supplier.recordId, supplier]));
  const fields = kind === "supplier" ? ["supplier"] : kind === "purchase-order-summary" ? summaryFields : itemFields;
  yield csvRow(["record_id", "import_id", "source_reference_id", "source_file", "data_row_number", "csv_record_number", ...fields.flatMap((field) => [snake(field), `${snake(field)}_state`]), ...(kind === "supplier" ? ["original_supplier_observation"] : [])]);
  for (const record of archive.records) {
    if (kind !== "supplier" && record.kind !== kind) continue;
    const source = sources.get(record.sourceId);
    yield csvRow([record.id, record.fileId, record.sourceId, files.get(record.fileId), source?.dataRowNumber, source?.recordNumber,
      ...fields.flatMap((name) => { const field = record.fields[name]; return [field?.value ?? "", field?.state ?? "missing"]; }),
      ...(kind === "supplier" ? [observations.get(record.id)?.name ?? ""] : []),
    ]);
  }
}
