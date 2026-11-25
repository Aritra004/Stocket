import type { SchemaDescriptor, SchemaDetection } from "./types";

/** These contracts describe our synthetic fixtures, NOT verified Stocky exports. */
export const SUMMARY_V1: SchemaDescriptor = {
  id: "stocky-rescue.provisional.po-summary.v1",
  version: 1,
  kind: "purchase-order-summary",
  label: "Provisional purchase-order summary",
  verification: "unverified",
  fixturePath: "src/lib/stocky/fixtures/provisional-po-summaries-v1.csv",
  requiredHeaders: ["__stocky_rescue_po_summary_v1", "PO Number"],
  mappedHeaders: ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Status", "Order Date", "Expected Date", "Currency", "Total Cost", "Ordered Quantity", "Received Quantity"],
};

export const LINE_ITEM_V1: SchemaDescriptor = {
  id: "stocky-rescue.provisional.po-line-item.v1",
  version: 1,
  kind: "purchase-order-line-item",
  label: "Provisional purchase-order line item",
  verification: "unverified",
  fixturePath: "src/lib/stocky/fixtures/provisional-po-line-items-v1.csv",
  requiredHeaders: ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU"],
  mappedHeaders: ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Product Name", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"],
};

export const STOCKY_SCHEMAS: readonly SchemaDescriptor[] = [SUMMARY_V1, LINE_ITEM_V1];

/** Exact required header sets only: no case folding, trimming, aliases, or scoring. */
export function detectStockySchema(headers: readonly string[], malformedHeader = false): SchemaDetection {
  if (malformedHeader) {
    return { status: "unknown", reason: "malformed-header", candidates: [], message: "The column names could not be read reliably, so no field mappings were applied." };
  }
  const names = new Set(headers);
  const matches = STOCKY_SCHEMAS.filter((schema) => schema.requiredHeaders.every((header) => names.has(header)));
  if (matches.length === 0) {
    return { status: "unknown", reason: "no-match", candidates: [], message: "This column layout does not match a supported fixture format. No automatic field mappings were attempted." };
  }
  if (matches.length > 1) {
    return { status: "unknown", reason: "ambiguous", candidates: matches.map((schema) => schema.id), message: "These column names match more than one format. No format was chosen and no fields were mapped." };
  }
  const adapter = matches[0];
  if (adapter.mappedHeaders.some((name) => headers.filter((header) => header === name).length > 1)) {
    return { status: "unknown", reason: "duplicate-mapped-header", candidates: [adapter.id], message: "A column needed for this format appears more than once. No fields were mapped because choosing one column could lose information." };
  }
  return {
    status: "matched",
    adapter,
    unmappedColumns: headers.flatMap((header, index) => adapter.mappedHeaders.includes(header) ? [] : [{ header, column: index + 1 }]),
  };
}
