import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchiveZipExport } from "./archive-zip-export";

test("archive export advertises contents, explicit test bypass, and licensed production access", () => {
  const previous = process.env.NODE_ENV;
  const previousBypass = process.env.NEXT_PUBLIC_EXPORT_TEST_BYPASS;
  try {
    Reflect.set(process.env, "NODE_ENV", "test");
    Reflect.set(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS", "true");
    const ready = renderToStaticMarkup(createElement(ArchiveZipExport, { hasImports: true, loading: false }));
    assert.match(ready, /Complete offline ZIP archive/);
    assert.match(ready, /unchanged original CSV files/);
    assert.match(ready, /Development\/test export/);
    assert.match(ready, /Export offline ZIP/);
    assert.doesNotMatch(ready, /disabled=""/);
    const empty = renderToStaticMarkup(createElement(ArchiveZipExport, { hasImports: false, loading: false }));
    assert.match(empty, /disabled=""/);
    const loading = renderToStaticMarkup(createElement(ArchiveZipExport, { hasImports: true, loading: true }));
    assert.match(loading, /disabled=""/);
    Reflect.set(process.env, "NODE_ENV", "production");
    const gated = renderToStaticMarkup(createElement(ArchiveZipExport, { hasImports: true, loading: false }));
    assert.match(gated, /Checking archive license/);
    assert.match(gated, /Unlock archive or recover license/);
    assert.match(gated, /disabled=""/);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", previous);
    if (previousBypass === undefined) Reflect.deleteProperty(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS");
    else Reflect.set(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS", previousBypass);
  }
});
