import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldValue, observedValue } from "./field-value";
import { OrderDetailContents, SourceReferenceView, SourceText } from "./order-detail";
import type { OrderDetail } from "../../lib/storage/dashboard-types";
import type { StoredPurchaseOrder, StoredSourceReference } from "../../lib/storage/types";
import { parseFileContents } from "../../lib/importer/csv-parser-core";

const render = renderToStaticMarkup;

test("dashboard field display preserves observed zero, exact decimals, and literal text", () => {
  assert.equal(observedValue({ state: "observed", value: "0" }), "0");
  assert.equal(observedValue({ state: "observed", value: "001-SKU" }), "001-SKU");
  const value = "99999999999999999999999.00001";
  assert.match(render(createElement(FieldValue, { field: { state: "observed", value } })), new RegExp(value.replace(".", "\\.")));
  assert.match(render(createElement(FieldValue, { field: { state: "observed", value: "<script>value</script>" } })), /&lt;script&gt;value&lt;\/script&gt;/);
});

test("missing, invalid, conflicting, and derived fields cannot masquerade as observed values", () => {
  const expected = { missing: "Not provided", invalid: "Invalid value", conflicting: "Conflicting values", derived: "Calculated · not imported" } as const;
  for (const [state, label] of Object.entries(expected)) {
    const field = { state: state as keyof typeof expected, value: "9988776655" };
    assert.equal(observedValue(field), null);
    const html = render(createElement(FieldValue, { field }));
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /9988776655/);
  }
});

function sourceRecord(): StoredSourceReference {
  return {
    id: "source-1", importId: "import-1", recordId: "order-1", kind: "normalized", recordNumber: 2, dataRowNumber: 1,
    source: {
      fileName: "<source>.csv", rowNumber: 1, recordNumber: 2, values: ["original"], rawText: "original\n",
      cells: Array.from({ length: 24 }, (_, index) => ({ fileName: "<source>.csv", rowNumber: 1, recordNumber: 2, column: index + 1, header: `Header-${index}`, rawValue: index === 0 ? "<script>literal</script>" : index === 1 ? "" : index === 2 ? null : `Original-${index}` })),
    },
  };
}

test("source evidence retains exact locations, escaped original values, and bounded column pages", () => {
  const html = render(createElement(SourceReferenceView, { source: sourceRecord() }));
  assert.match(html, /&lt;source&gt;\.csv/);
  assert.match(html, /Data row 1/);
  assert.match(html, /CSV record 2/);
  assert.match(html, /&lt;script&gt;literal&lt;\/script&gt;/);
  assert.match(html, /Empty string/);
  assert.match(html, /Cell absent/);
  assert.match(html, /Column 10/);
  assert.doesNotMatch(html, /Column 11/);
  assert.match(html, /Next columns/);
  assert.match(html, /Original CSV record/);
  assert.doesNotMatch(html, /<script>/);
});

test("long original text is paginated without losing the ability to inspect the remaining characters", () => {
  const html = render(createElement(SourceText, { value: "x".repeat(2000) + "END-OF-ORIGINAL" }));
  assert.match(html, /Characters 1–2000 of 2,015/);
  assert.match(html, /Next characters/);
  assert.doesNotMatch(html, /END-OF-ORIGINAL/);
});

async function detailFixture(): Promise<OrderDetail> {
  const result = await parseFileContents(new File(["__stocky_rescue_po_summary_v1,PO Number,Supplier,Total Cost,Ordered Quantity,Received Quantity\nprovisional,PO-001,Literal Supplier,0,10,4\n"], "original.csv"));
  const normalized = result.normalized.records[0];
  assert.equal(normalized.kind, "purchase-order-summary");
  const record: StoredPurchaseOrder = {
    id: "order-1", importId: "import-1", recordIndex: 0, sourceReferenceId: "source-1", rowNumber: 1, recordNumber: 2,
    adapterId: normalized.adapterId, adapterVersion: normalized.adapterVersion, kind: "purchase-order-summary", orderKey: "PO-001",
    fields: Object.fromEntries(Object.entries(normalized.fields).map(([name, field]) => [name, { state: field.state, value: field.value, sourceReferenceId: "source-1" }])) as StoredPurchaseOrder["fields"],
  };
  return { order: { record, fileName: "original.csv" }, source: sourceRecord(), lines: [], lineTotal: 0, linePageIndex: 0, linePageSize: 20 };
}

test("order detail reports literal fields, source references, unmerged candidates, and actionable absent lines", async () => {
  const detail = await detailFixture();
  const html = render(createElement(OrderDetailContents, { detail, onLinePageChange() {} }));
  assert.match(html, /PO-001/);
  assert.match(html, /Literal Supplier/);
  assert.match(html, /original\.csv/);
  assert.match(html, /Data row 1 · CSV record 2/);
  assert.match(html, /Calculated · not imported/);
  assert.match(html, /Not provided/);
  assert.match(html, /Candidate matches use the exact observed purchase-order number/);
  assert.match(html, /Records stay separate and are not merged/);
  assert.match(html, /No related line items found/);
  assert.match(html, /Import a supported line-item file/);
  assert.match(html, />0<\/span>/);
  assert.doesNotMatch(html, />6<\/span>/);
});

test("orders without observed identifiers explain why line relationships cannot be inferred", async () => {
  const detail = await detailFixture();
  detail.order.record.fields.purchaseOrderNumber = { state: "conflicting", value: null, sourceReferenceId: "source-1" };
  const html = render(createElement(OrderDetailContents, { detail, onLinePageChange() {} }));
  assert.match(html, /Line items cannot be matched/);
  assert.match(html, /No relationship has been inferred/);
  assert.doesNotMatch(html, /No related line items found/);
});
