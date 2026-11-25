import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchiveConfirmation, ArchiveReviewIssues, LocalArchive } from "./local-archive";
import type { StoredImport, StoredValidationIssue } from "../../lib/storage/types";

function storedFile(overrides: Partial<StoredImport> = {}): StoredImport {
  return {
    id: "saved-1", fileName: "purchase-orders.csv", fileSize: 250, fileType: "text/csv", lastModified: 0,
    sha256: "a".repeat(64), hashVersion: "sha256/raw-v1", importedAt: Date.UTC(2026, 0, 1), totalRows: 15,
    status: "success", normalizedCount: 15, reviewCount: 2, ...overrides,
  };
}

const emptyActions = { onRefresh() {}, onInspect() {}, async onReplace() {}, async onRemove() {}, async onClear() {} };

test("saved imports have distinct review, replace, and remove actions even with identical filenames", () => {
  const html = renderToStaticMarkup(createElement(LocalArchive, {
    imports: [storedFile(), storedFile({ id: "saved-2", sha256: "b".repeat(64) })], loading: false, error: "", busy: false, selectedId: null, ...emptyActions,
  }));
  assert.match(html, /Saved on this browser/);
  assert.match(html, /Review purchase-orders.csv, saved import 1/);
  assert.match(html, /Review purchase-orders.csv, saved import 2/);
  assert.match(html, /Replace purchase-orders.csv, saved import 1/);
  assert.match(html, /Remove purchase-orders.csv, saved import 2/);
  assert.match(html, /2 issues/);
  assert.match(html, /aaaaaaaaaaaa/);
  assert.match(html, /bbbbbbbbbbbb/);
  assert.match(html, /There is no server copy/);
});

test("clear-all requires explicit confirmation and explains its full local scope", () => {
  let confirmed = false;
  const html = renderToStaticMarkup(createElement(ArchiveConfirmation, { action: { kind: "clear" }, busy: false, onCancel() {}, onConfirm() { confirmed = true; } }));
  assert.equal(confirmed, false);
  assert.match(html, /Clear all saved data\?/);
  for (const text of ["purchase order", "line item", "supplier observation", "validation issue", "source reference", "This cannot be undone", "Cancel", "Yes, clear all saved data"]) assert.ok(html.includes(text));
});

test("replacement confirmation identifies the old and new file without exposing CSV as markup", () => {
  const html = renderToStaticMarkup(createElement(ArchiveConfirmation, {
    action: { kind: "replace", target: storedFile({ fileName: "old.csv" }), file: new File(["contents"], "<script>replacement.csv") },
    busy: false, onCancel() {}, onConfirm() {},
  }));
  assert.match(html, /old.csv/);
  assert.match(html, /&lt;script&gt;replacement.csv/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /will remain if the new file cannot be parsed or saved/);
  assert.match(html, /Yes, replace this import/);
});

test("an unavailable archive clearly offers local previews without claiming files are saved", () => {
  const html = renderToStaticMarkup(createElement(LocalArchive, {
    imports: [], loading: false, error: "Browser storage is unavailable.", busy: false, selectedId: null, ...emptyActions,
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Browser storage is unavailable/);
  assert.match(html, /preview files without saving them/);
  assert.match(html, /Refresh saved list/);
});

test("saved overlapping-record issues are paginated, retain locations, and link to separate imports", () => {
  const issues: StoredValidationIssue[] = Array.from({ length: 70 }, (_, index) => ({
    id: `issue-${index}`, importId: "saved-1", scope: "overlap", relatedImportIds: ["saved-2"], relatedImportCount: 8,
    issue: { code: "ConflictingOrder", category: "schema", severity: "warning", message: `Review conflict ${index}: <script>`, row: index + 2, column: 3 },
  }));
  const html = renderToStaticMarkup(createElement(ArchiveReviewIssues, { file: storedFile(), issues, imports: [storedFile({ id: "saved-2", fileName: "other.csv" })], onInspect() {} }));
  assert.match(html, /Records from different imports have not been merged/);
  assert.match(html, /Review conflict 0: &lt;script&gt;/);
  assert.match(html, /CSV record 2/);
  assert.match(html, /Column 3/);
  assert.match(html, /other.csv/);
  assert.match(html, /and 7 more in the saved list/);
  assert.match(html, /Next issues/);
  assert.match(html, /of 70 saved issues/);
  assert.doesNotMatch(html, /Review conflict 20:/);
  assert.doesNotMatch(html, /<script>/);
});
