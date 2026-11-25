import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFileContents } from "../../lib/importer/csv-parser-core";
import type { SkuCostHistory } from "../../lib/storage/cost-types";
import type { StoredLineItem } from "../../lib/storage/types";
import { SkuCostHistoryResults } from "./sku-cost-history";

async function fixture(): Promise<SkuCostHistory> {
  const result = await parseFileContents(new File([
    "__stocky_rescue_po_line_item_v1,PO Number,Line ID,SKU,Supplier,Order Date,Currency,Unit Cost,Ordered Quantity\n" +
    "provisional,PO-precise,L1,00123, Exact Supplier ,2026-03-01,USD,12345678901234567890.0000000000000001,2\n" +
    "provisional,PO-zero,L2,00123,Exact Supplier,2026-02-01,INR,0,0\n" +
    "provisional,PO-absent,L3,00123,,,,,\n",
  ], "cost-source.csv"));
  const rows = result.normalized.records.map((normalized, index) => {
    assert.equal(normalized.kind, "purchase-order-line-item");
    const sourceReferenceId = `source-${index}`;
    const record: StoredLineItem = {
      id: `line-${index}`, importId: "cost-import", recordIndex: index, sourceReferenceId,
      rowNumber: index + 1, recordNumber: index + 2, adapterId: normalized.adapterId,
      adapterVersion: normalized.adapterVersion, kind: "purchase-order-line-item",
      fields: Object.fromEntries(Object.entries(normalized.fields).map(([key, field]) => [key, { state: field.state, value: field.value, sourceReferenceId }])) as StoredLineItem["fields"],
    };
    return { record, fileName: "cost-source.csv" };
  });
  return { sku: "00123", exists: true, entries: { rows, total: rows.length, pageIndex: 0, pageSize: 20 } };
}

test("cost table keeps precise decimals and original currency codes separate, with navigable evidence", async () => {
  const html = renderToStaticMarkup(createElement(SkuCostHistoryResults, { data: await fixture(), revision: 0, onPageChange() {} }));
  assert.match(html, /aria-label="SKU purchase costs"/);
  for (const heading of ["Order date", "Unit cost", "Currency", "Ordered quantity", "Supplier", "Purchase order and source"]) assert.ok(html.includes(`>${heading}</th>`));
  assert.match(html, />12345678901234567890\.0000000000000001<\/span>/);
  assert.match(html, />USD<\/span>/);
  assert.match(html, />INR<\/span>/);
  assert.match(html, />0<\/span>/);
  assert.match(html, />Not provided<\/span>/);
  assert.match(html, /href="\/suppliers#name=\+Exact\+Supplier\+"/);
  assert.match(html, /cost-source\.csv/);
  assert.match(html, /Data row 1 · CSV record 2/);
  assert.match(html, /Inspect order and source/);
  assert.match(html, /Find purchase orders for PO-precise/);
  assert.match(html, /View original line source/);
  assert.doesNotMatch(html, /\$|₹|Average cost|Total cost/);
});

test("cost table displays field states instead of calculated, conflicting or invalid money", async () => {
  const data = await fixture();
  const rows = data.entries.rows;
  rows[0].record.fields.unitCost.state = "derived";
  rows[1].record.fields.unitCost = { state: "conflicting", value: null, sourceReferenceId: "source-1" };
  rows[2].record.fields.unitCost = { state: "invalid", value: null, sourceReferenceId: "source-2" };
  const html = renderToStaticMarkup(createElement(SkuCostHistoryResults, { data, revision: 0, onPageChange() {} }));
  assert.match(html, /Calculated · not imported/);
  assert.match(html, /Conflicting values/);
  assert.match(html, /Invalid value/);
  assert.doesNotMatch(html, /12345678901234567890/);
});

test("cost history without exact SKU lines explains why summaries cannot supply unit costs", () => {
  const data: SkuCostHistory = { sku: "00123", exists: false, entries: { rows: [], total: 0, pageIndex: 0, pageSize: 20 } };
  const html = renderToStaticMarkup(createElement(SkuCostHistoryResults, { data, revision: 0, onPageChange() {} }));
  assert.match(html, /No recorded purchase costs/);
  assert.match(html, /Summary totals do not establish a SKU unit cost/);
  assert.doesNotMatch(html, /<table/);
});
