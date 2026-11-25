import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFileContents } from "@/src/lib/importer/csv-parser-core";
import { createImportEntries, getImportFileLabels, type ImportEntry } from "@/src/lib/importer/import-session";
import { FileResults } from "./file-results";
import { DataPreview } from "./data-preview";
import { PreservedRecords } from "./preserved-records";

async function completedFiles(...files: File[]): Promise<ImportEntry[]> {
  return Promise.all(createImportEntries(files).map(async (entry) => ({
    ...entry,
    phase: "complete" as const,
    result: await parseFileContents(entry.file),
  })));
}

function renderFiles(entries: ImportEntry[]) {
  return renderToStaticMarkup(createElement(FileResults, {
    entries,
    selectedId: entries[0]?.id ?? null,
    busy: false,
    onRemove: () => undefined,
    onInspect: () => undefined,
    onClear: () => undefined,
  }));
}

test("each file's validation messages appear in the row directly below its summary", async () => {
  const entries = await completedFiles(
    new File(["id,value\n1,ok\n2"], "uneven.csv"),
    new File(['id,value\n3,"unfinished'], "malformed.csv"),
  );
  const html = renderFiles(entries);
  const body = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(body);
  const rows = [...body.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((match) => match[0]);

  assert.equal(rows.length, 4);
  assert.ok(rows[0].includes(`id="file-${entries[0].id}"`));
  assert.ok(rows[1].includes(`aria-labelledby="validation-${entries[0].id} file-${entries[0].id}"`));
  assert.match(rows[1], /colspan="5"/i);
  assert.match(rows[1], /Warnings/);
  assert.match(rows[1], /Information/);
  assert.ok(rows[1].includes(entries[0].result!.warnings[0].message));
  assert.ok(rows[2].includes(`id="file-${entries[1].id}"`));
  assert.ok(rows[3].includes(`aria-labelledby="validation-${entries[1].id} file-${entries[1].id}"`));
  assert.match(rows[3], /Errors/);
  assert.ok(rows[3].includes(entries[1].result!.errors[0].message));
  assert.ok(!rows[1].includes(entries[1].result!.errors[0].message));
});

test("same-named files have distinct controls and preview options while schema notes do not mark valid CSV as failed", async () => {
  const entries = await completedFiles(
    new File(["id,value\n1,first"], "orders.csv"),
    new File(["id,value\n2,second"], "orders.csv"),
  );
  const labels = getImportFileLabels(entries);
  assert.ok(entries.every((entry) => entry.result?.status === "success" && entry.result.stockyValidation === "unsupported"));
  const fileHtml = renderFiles(entries);
  assert.ok(fileHtml.includes('aria-label="Preview orders.csv (file 1 of 2)"'));
  assert.ok(fileHtml.includes('aria-label="Preview orders.csv (file 2 of 2)"'));
  assert.ok(fileHtml.includes('aria-label="Remove orders.csv (file 1 of 2)"'));
  assert.ok(fileHtml.includes('aria-label="Remove orders.csv (file 2 of 2)"'));
  assert.match(fileHtml, /saved duplicates are checked by content/);
  assert.match(fileHtml, /CSV parsed/);
  assert.match(fileHtml, /Stocky field mapping unavailable/);
  assert.match(fileHtml, /Information/);
  assert.doesNotMatch(fileHtml, />(?:CSV errors|Unsupported file format)<\/span>/);

  const previewHtml = renderToStaticMarkup(createElement(DataPreview, {
    files: entries.map((entry) => ({ id: entry.id, fileName: labels.get(entry.id)!, result: entry.result! })),
    selectedId: entries[1].id,
    onSelect: () => undefined,
  }));
  assert.match(previewHtml, /<option\b[^>]*>orders\.csv \(file 1 of 2\)<\/option>/);
  assert.match(previewHtml, /<option\b[^>]*>orders\.csv \(file 2 of 2\)<\/option>/);
  assert.match(previewHtml, /second/);
  assert.doesNotMatch(previewHtml, /This file could not be imported/);
});

test("flagged source beyond the ten-record preview is rendered as escaped text rather than executable markup", async () => {
  const unsafeText = "<script>alert(1)</script>";
  const rawRecord = `12,${unsafeText},extra\n`;
  const file = new File([
    `id,value\n${Array.from({ length: 11 }, (_, index) => `${index + 1},ok\n`).join("")}${rawRecord}`,
  ], "unsafe.csv");
  const result = await parseFileContents(file);
  assert.equal(result.preview.length, 10);
  assert.equal(result.recordsWithIssues.length, 1);
  assert.equal(result.recordsWithIssues[0].rawText, rawRecord);

  const html = renderToStaticMarkup(createElement(PreservedRecords, { records: result.recordsWithIssues, fileName: file.name }));
  const rawHtml = html.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/)?.[1];
  assert.equal(rawHtml, "12,&lt;script&gt;alert(1)&lt;/script&gt;,extra\n");
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /Data row 12/);
  assert.match(html, /records after the first 10 rows|including those after the first 10 rows/);
});
