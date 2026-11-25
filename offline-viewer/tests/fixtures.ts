import type { OfflineArchive, OfflineField, OfflineRecord, OfflineSource } from "../types";

export const PRECISE_COST = "12345678901234567890.0000000000000001";
export const PRECISE_QUANTITY = "9007199254740993.0000000000000001";
export const UNICODE_SKU = "β-雪-0007";
export const LITERAL_PAYLOAD = '</script><script>globalThis.__offlineInjected=1</script><img src="https://example.invalid/leak" onerror="globalThis.__offlineInjected=1"> & 雪\u2028kept\u2029literal';

const observed = (value: string): OfflineField => ({ state: "observed", value });
const missing = (): OfflineField => ({ state: "missing", value: null });
const value = (input: string | null): OfflineField => input === null ? missing() : observed(input);

const headers: Record<string, string> = {
  purchaseOrderNumber: "PO Number", supplier: "Supplier", status: "Status", orderDate: "Order Date", expectedDate: "Expected Date",
  currency: "Currency", totalCost: "Total Cost", orderedQuantity: "Ordered Quantity", receivedQuantity: "Received Quantity",
  lineId: "Line ID", sku: "SKU", productName: "Product Name", unitCost: "Unit Cost",
};

function sourceFor(record: OfflineRecord, dataRowNumber: number, originals: Record<string, string> = {}): OfflineSource {
  const cells = Object.entries(record.fields).filter(([name]) => name !== "outstandingQuantity").map(([name, field], index) => ({
    column: index + 1,
    header: headers[name],
    rawValue: Object.hasOwn(originals, name) ? originals[name] : field.value ?? "",
  }));
  return {
    id: record.sourceId, fileId: record.fileId, dataRowNumber, recordNumber: dataRowNumber + 1,
    cells, rawText: cells.map((cell) => `"${cell.rawValue.replaceAll('"', '""')}"`).join(",") + "\n",
  };
}

function order(id: string, number: string, supplier: string | null, date: string | null): OfflineRecord {
  return {
    id, fileId: "__proto__", sourceId: `${id}-source`, kind: "purchase-order-summary",
    fields: {
      purchaseOrderNumber: observed(number), supplier: value(supplier), status: observed("Open"), orderDate: value(date), expectedDate: missing(),
      currency: date ? observed("USD") : missing(), totalCost: date ? observed("0") : missing(),
      orderedQuantity: date ? observed("0") : missing(), receivedQuantity: date ? observed("0") : missing(), outstandingQuantity: missing(),
    },
  };
}

function line(id: string, number: string, sku: string | null, supplier: string | null, date: string | null, currency: string | null, cost: string | null, quantity: string | null, product = "Imported product"): OfflineRecord {
  return {
    id, fileId: "line-file", sourceId: `${id}-source`, kind: "purchase-order-line-item",
    fields: {
      purchaseOrderNumber: observed(number), lineId: observed(id), sku: value(sku), productName: observed(product), supplier: value(supplier), orderDate: value(date),
      currency: value(currency), unitCost: value(cost), orderedQuantity: value(quantity), receivedQuantity: quantity === null ? missing() : observed("0"), outstandingQuantity: missing(),
    },
  };
}

export function archiveFixture(): OfflineArchive {
  const orders = [
    order("constructor", "PO-001", "Harbor & Co", "2026-01-01"),
    order("order-lower", "PO-002", "harbor & co", "2026-01-02"),
    order("order-spaced", "PO-003", " Harbor & Co ", "2026-01-03"),
    order("order-missing", "PO-004", null, null),
    order("order-prototype", "PO-005", "__proto__", "2026-01-04"),
  ];
  const lines = [
    line("line-zero", "PO-001", "00123", "Harbor & Co", "2026-01-01", "USD", "0", "0", "Zero-cost product"),
    line("line-precise", "PO-002", "00123", "harbor & co", "2026-01-02", "INR", PRECISE_COST, PRECISE_QUANTITY, "Precise product"),
    line("line-unpadded", "PO-003", "123", " Harbor & Co ", "2026-01-03", "USD", "2", "2", "Unpadded product"),
    line("line-missing", "PO-004", "00123", null, null, null, null, null, "Missing product"),
    line("line-prototype", "PO-005", "__proto__", "__proto__", "2026-01-04", "USD", "1", "1", "Prototype-named product"),
    line("line-unicode", "PO-006", UNICODE_SKU, "雪 & Co", null, "USD", "7", "3", LITERAL_PAYLOAD),
    line("line-nosku", "PO-007", null, "Other supplier", "2026-01-05", "USD", "4", "4", "Unidentified product"),
  ];
  lines[5].fields.orderDate = { state: "invalid", value: null };
  return {
    version: 1, exportedAt: "2026-11-24T09:00:00.000Z",
    files: [
      { id: "__proto__", name: "orders-<&>.csv", totalRows: orders.length, status: "success", coverageNotes: ["Summary fields only; no SKU values invented."] },
      { id: "line-file", name: "lines.csv", totalRows: lines.length, status: "warning", coverageNotes: ["Recorded values and source text are preserved."] },
    ],
    records: [...orders, ...lines],
    sources: [
      ...orders.map((record, index) => sourceFor(record, index + 1)),
      ...lines.map((record, index) => sourceFor(record, index + 1, record.id === "line-unicode" ? { orderDate: "2026-02-30" } : {})),
    ],
    findings: [
      { id: "finding-missing", fileId: "line-file", category: "incomplete", severity: "warning", message: "Supplier, date, currency, cost and quantities were not provided.", recordIds: ["line-missing"], sourceIds: ["line-missing-source"] },
      { id: "finding-date", fileId: "line-file", category: "invalid-date", severity: "warning", message: "The recorded date 2026-02-30 is invalid; no date was guessed.", recordIds: ["line-unicode"], sourceIds: ["line-unicode-source"] },
    ],
    qualityNotes: ["This supplied snapshot retains exact identifiers and original source evidence."],
  };
}

export function archiveOfKind(kind: OfflineRecord["kind"]): OfflineArchive {
  const fixture = archiveFixture();
  fixture.records = fixture.records.filter((record) => record.kind === kind);
  const fileIds = new Set(fixture.records.map((record) => record.fileId));
  fixture.files = fixture.files.filter((file) => fileIds.has(file.id));
  fixture.sources = fixture.sources.filter((source) => fileIds.has(source.fileId));
  fixture.findings = fixture.findings.filter((finding) => fileIds.has(finding.fileId));
  return fixture;
}

export function emptyArchive(): OfflineArchive {
  return { version: 1, exportedAt: "2026-11-24T09:00:00.000Z", files: [], records: [], sources: [], findings: [], qualityNotes: [] };
}

export function paginatedArchive(): OfflineArchive {
  const fixture = archiveFixture();
  const orders = Array.from({ length: 31 }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    return order(`paged-order-${suffix}`, `PAGE-${suffix}`, "Paged Supplier", "2026-01-01");
  });
  const lines = Array.from({ length: 31 }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    return line(`paged-line-${suffix}`, `PAGE-${suffix}`, "PAGED-SKU", "Paged Supplier", "2026-01-01", "USD", "1", "1");
  });
  fixture.files = fixture.files.map((file) => ({ ...file, totalRows: 31 }));
  fixture.records = [...orders, ...lines];
  fixture.sources = [...orders.map((record, index) => sourceFor(record, index + 1)), ...lines.map((record, index) => sourceFor(record, index + 1))];
  fixture.findings = [];
  return fixture;
}
