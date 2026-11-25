import assert from "node:assert/strict";
import test from "node:test";
import { purchaseOrderHref, readHistorySelection, readOrderSelection, skuHref, supplierHref } from "./history-navigation";

test("history links preserve exact identifiers and keep them out of request paths and queries", () => {
  for (const value of ["001", "1", "sku", "SKU", " SKU ", "A&B / #?%+", "名 🚚", "line\nname", "<script>literal</script>", " "]) {
    for (const [kind, href] of [["supplier", supplierHref(value)], ["sku", skuHref(value)]] as const) {
      const url = new URL(href, "https://local.invalid");
      assert.equal(url.search, "");
      assert.equal(url.pathname, kind === "supplier" ? "/suppliers" : "/skus");
      assert.equal(readHistorySelection(kind, url.hash), value);
    }
    assert.equal(readOrderSelection(new URL(purchaseOrderHref(value), "https://local.invalid").hash), value);
  }
  assert.equal(new Set(["001", "1", "sku", "SKU", " SKU "].map(skuHref)).size, 5);
});

test("the missing-supplier bucket cannot collide with a literal supplier name", () => {
  assert.equal(readHistorySelection("supplier", ""), undefined);
  assert.equal(readHistorySelection("sku", ""), undefined);
  assert.equal(readHistorySelection("supplier", new URL(supplierHref(null), "https://local.invalid").hash), null);
  assert.equal(readHistorySelection("supplier", new URL(supplierHref("missing"), "https://local.invalid").hash), "missing");
  assert.equal(readHistorySelection("supplier", "#name=&missing=1"), "");
  assert.equal(readHistorySelection("sku", "#missing=1"), undefined);
});
