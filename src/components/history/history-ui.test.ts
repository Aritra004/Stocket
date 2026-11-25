import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFileContents } from "../../lib/importer/csv-parser-core";
import { supplierHref, skuHref, purchaseOrderHref } from "../../lib/history-navigation";
import type { DashboardLineRow, DashboardOrderRow } from "../../lib/storage/dashboard-types";
import type { StoredLineItem, StoredPurchaseOrder } from "../../lib/storage/types";
import { SupplierDirectoryResults } from "./supplier-browser";
import { SkuDirectoryResults } from "./sku-browser";
import { HistoryLineCard, HistoryOrders } from "./history-lines";
import { HistoryPagination } from "./history-controls";

const render = renderToStaticMarkup;

test("supplier directory retains exact names and separate unavailable-record counts", () => {
  const html = render(createElement(SupplierDirectoryResults, {
    search: "", onPageChange() {}, data: {
      rows: [{ name: " Harbor & Co ", orderCount: 0, lineCount: 3 }, { name: "harbor & co", orderCount: 2, lineCount: 0 }],
      total: 2, pageIndex: 0, pageSize: 25, unavailableOrderCount: 4, unavailableLineCount: 7,
    },
  }));
  assert.ok(html.includes(supplierHref(" Harbor & Co ").replaceAll("&", "&amp;")));
  assert.match(html, /> Harbor &amp; Co <\/a>/);
  assert.match(html, /harbor &amp; co/);
  assert.match(html, /Supplier not observed/);
  assert.match(html, /4 order records · 7 line records/);
  assert.match(html, /without creating a supplier/);
});

test("SKU directory keeps leading zeroes and separate whitespace identifiers", () => {
  const html = render(createElement(SkuDirectoryResults, {
    search: "", onPageChange() {}, data: { rows: [{ sku: "00123", lineCount: 2 }, { sku: "00123 ", lineCount: 1 }], total: 2, pageIndex: 0, pageSize: 25 },
  }));
  assert.ok(html.includes(`href="${skuHref("00123")}"`));
  assert.ok(html.includes(`href="${skuHref("00123 ")}"`));
  assert.match(html, />00123 <\/a>/);
  assert.match(html, /2 SKUs/);
});

test("empty directories distinguish missing observations from an unmatched search", () => {
  const empty = { rows: [], total: 0, pageIndex: 0, pageSize: 25 };
  const initial = render(createElement(SkuDirectoryResults, { data: empty, search: "", onPageChange() {} }));
  const filtered = render(createElement(SkuDirectoryResults, { data: empty, search: "none", onPageChange() {} }));
  assert.match(initial, /No observed SKUs yet/);
  assert.match(initial, /Import CSV files/);
  assert.match(initial, /not turned into identifiers/);
  assert.match(initial, /Summary-only imports contain no SKU history/);
  assert.match(filtered, /No SKUs match/);
  assert.doesNotMatch(filtered, /Import CSV files/);
});

async function lineFixture({ cost = "0", ordered = "10", received = "4" } = {}): Promise<DashboardLineRow> {
  const result = await parseFileContents(new File([`__stocky_rescue_po_line_item_v1,PO Number,Line ID,SKU,Product Name,Supplier,Order Date,Currency,Unit Cost,Ordered Quantity,Received Quantity\nprovisional,PO-DUP,0001,00123,<script>literal</script>, Harbor & Co ,2026-01-02,USD,${cost},${ordered},${received}\n`], "line-source.csv"));
  const normalized = result.normalized.records[0];
  assert.equal(normalized.kind, "purchase-order-line-item");
  const record: StoredLineItem = {
    id: "line-1", importId: "import-1", recordIndex: 0, sourceReferenceId: "source-line-1", rowNumber: 1, recordNumber: 2,
    adapterId: normalized.adapterId, adapterVersion: normalized.adapterVersion, kind: "purchase-order-line-item", orderKey: "PO-DUP",
    fields: Object.fromEntries(Object.entries(normalized.fields).map(([name, field]) => [name, { state: field.state, value: field.value, sourceReferenceId: "source-line-1" }])) as StoredLineItem["fields"],
  };
  return { record, fileName: "line-source.csv" };
}

test("history line cards retain observed quantities, zero costs, source references, and exact navigation", async () => {
  const row = await lineFixture();
  const html = render(createElement(HistoryLineCard, { row, revision: 0 }));
  assert.match(html, /href="\/skus#sku=00123"/);
  assert.match(html, /href="\/suppliers#name=\+Harbor\+%26\+Co\+"/);
  assert.match(html, /&lt;script&gt;literal&lt;\/script&gt;/);
  assert.match(html, /line-source\.csv/);
  assert.match(html, /Data row 1 · CSV record 2/);
  assert.match(html, /2026-01-02/);
  assert.match(html, />0<\/span>/);
  assert.match(html, /Calculated · not imported/);
  assert.doesNotMatch(html, />6<\/span>/);
  assert.match(html, /aria-label="Find purchase orders for PO-DUP"/);
  assert.match(html, /View original line source/);
  assert.doesNotMatch(html, /<script>/);
});

test("missing supplier, SKU, currency, and order fields never acquire inferred navigation or values", async () => {
  const row = await lineFixture();
  for (const key of ["supplier", "sku", "currency", "purchaseOrderNumber"] as const) row.record.fields[key] = { state: "missing", value: null, sourceReferenceId: "source-line-1" };
  const html = render(createElement(HistoryLineCard, { row, revision: 0 }));
  assert.match(html, /Not provided/);
  assert.match(html, /no summary relationship is inferred/);
  assert.doesNotMatch(html, /href="\/suppliers|href="\/skus|Find purchase orders for|>USD</);
});

test("history never substitutes missing or unreliable costs and quantities with numeric values", async () => {
  const row = await lineFixture();
  row.record.fields.unitCost = { state: "missing", value: null, sourceReferenceId: "source-line-1" };
  row.record.fields.orderedQuantity = { state: "invalid", value: null, sourceReferenceId: "source-line-1" };
  row.record.fields.receivedQuantity = { state: "conflicting", value: null, sourceReferenceId: "source-line-1" };
  const html = render(createElement(HistoryLineCard, { row, revision: 0 }));
  assert.match(html, /Unit cost<\/dt><dd[^>]*><span[^>]*>Not provided<\/span>/);
  assert.match(html, /Ordered quantity<\/dt><dd[^>]*><span[^>]*>Invalid value<\/span>/);
  assert.match(html, /Received quantity<\/dt><dd[^>]*><span[^>]*>Conflicting values<\/span>/);
  assert.match(html, /Outstanding quantity<\/dt><dd[^>]*><span[^>]*>Calculated · not imported<\/span>/);
  assert.doesNotMatch(html, />0<\/span>|>6<\/span>|>10<\/span>|>4<\/span>/);
});

test("history displays observed zero quantities and exact decimal costs without recalculation", async () => {
  const cost = "12345678901234567890.0000000000000001";
  const row = await lineFixture({ cost, ordered: "0", received: "0" });
  const html = render(createElement(HistoryLineCard, { row, revision: 0 }));
  assert.ok(html.includes(`>${cost}</span>`));
  assert.match(html, /Ordered quantity<\/dt><dd[^>]*><span[^>]*>0<\/span>/);
  assert.match(html, /Received quantity<\/dt><dd[^>]*><span[^>]*>0<\/span>/);
});

test("separate purchase-order records retain distinct direct links and original source locations", async () => {
  const parsed = await parseFileContents(new File(["__stocky_rescue_po_summary_v1,PO Number,Supplier\nprovisional,PO-DUP,Harbor\n"], "one.csv"));
  const fields = Object.fromEntries(Object.entries(parsed.normalized.records[0].fields).map(([key, field]) => [key, { state: field.state, value: field.value, sourceReferenceId: "source" }])) as StoredPurchaseOrder["fields"];
  const records: DashboardOrderRow[] = ["one", "two"].map((name, index) => ({ fileName: `${name}.csv`, record: { id: name, importId: name, recordIndex: index, sourceReferenceId: name, rowNumber: index + 1, recordNumber: index + 2, adapterId: "summary", adapterVersion: 1, kind: "purchase-order-summary", orderKey: "PO-DUP", fields } }));
  const html = render(createElement(HistoryOrders, { page: { rows: records, total: 2, pageIndex: 0, pageSize: 20 }, onPageChange() {} }));
  assert.ok(html.includes(purchaseOrderHref("one")));
  assert.ok(html.includes(purchaseOrderHref("two")));
  assert.match(html, /aria-label="Open purchase order PO-DUP, one\.csv, data row 1"/);
  assert.match(html, /aria-label="Open purchase order PO-DUP, two\.csv, data row 2"/);
  assert.match(html, /one\.csv/);
  assert.match(html, /two\.csv/);
  assert.match(html, /Data row 1 · CSV record 2/);
  assert.match(html, /Data row 2 · CSV record 3/);
  assert.match(html, /role="region" aria-label="order records table scroll area" tabindex="0"/);
  assert.match(html, /min-w-\[720px\]/);

  records[0].record.fields.purchaseOrderNumber = { state: "missing", value: null, sourceReferenceId: "source" };
  const missingNumber = render(createElement(HistoryOrders, { page: { rows: [records[0]], total: 1, pageIndex: 0, pageSize: 20 }, onPageChange() {} }));
  assert.match(missingNumber, /aria-label="Open purchase order without an observed number, one\.csv, data row 1"/);
  assert.ok(missingNumber.includes(purchaseOrderHref("one")));
});

test("history pagination communicates bounded page counts and disables unavailable navigation", () => {
  const html = render(createElement(HistoryPagination, { total: 57, pageIndex: 2, pageSize: 25, count: 7, label: "SKUs", onChange() {} }));
  assert.match(html, /51–57 of 57 SKUs/);
  assert.match(html, /Page 3 of 3/);
  assert.match(html, /aria-label="Next SKUs" disabled/);
  assert.doesNotMatch(html, /aria-label="Previous SKUs" disabled/);
});
