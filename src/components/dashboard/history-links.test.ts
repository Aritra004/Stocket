import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ObservedSkuLink, ObservedSupplierLink } from "../history-navigation";

test("observed supplier and SKU links retain original values and escape source text", () => {
  const sku = renderToStaticMarkup(createElement(ObservedSkuLink, { field: { state: "observed", value: " 001/Ab+ " } }));
  assert.match(sku, /href="\/skus#sku=\+001%2FAb%2B\+"/);
  assert.ok(sku.includes(" 001/Ab+ "));
  const supplier = renderToStaticMarkup(createElement(ObservedSupplierLink, { field: { state: "observed", value: "<North & Co>" } }));
  assert.match(supplier, /href="\/suppliers#name=%3CNorth\+%26\+Co%3E"/);
  assert.match(supplier, /&lt;North &amp; Co&gt;/);
  assert.doesNotMatch(supplier, /<North/);
});

test("unavailable supplier and SKU fields never become entity links or invented identities", () => {
  for (const Component of [ObservedSupplierLink, ObservedSkuLink]) {
    for (const state of ["missing", "invalid", "conflicting", "derived"] as const) {
      const html = renderToStaticMarkup(createElement(Component, { field: { state, value: "must-not-appear" } }));
      assert.doesNotMatch(html, /href=|must-not-appear/);
      assert.ok(html.includes(state === "missing" ? "Not provided" : state === "invalid" ? "Invalid value" : state === "conflicting" ? "Conflicting values" : "Calculated"));
    }
  }
});
