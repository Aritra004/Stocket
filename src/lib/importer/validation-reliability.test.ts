import assert from "node:assert/strict";
import test from "node:test";
import { parseFileContents } from "./csv-parser-core";
import { parseCsvFile, parseCsvFiles } from "./csv-parser";
import { createImportEntries, getImportFileLabels } from "./import-session";
import { addIssue, createImportResult, finalizeResult, validateRow } from "./validators";
import type { CsvWorkerRequest, CsvWorkerResponse, ValidationIssue } from "./types";

function csv(text: string, name = "orders.csv") {
  return new File([text], name, { type: "text/csv" });
}

async function inBrowser<T>(run: () => Promise<T>): Promise<T> {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "Worker", { value: undefined, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
}

test("stray quotes in unquoted cells are reported and the original record is retained", async () => {
  const raw = '1,unquoted"quote\n';
  const result = await parseFileContents(csv(`id,notes\n${raw}2,safe\n`));

  assert.equal(result.status, "error");
  assert.equal(result.totalRows, 2);
  assert.deepEqual(result.preview[0].values, ["1", 'unquoted"quote']);
  assert.equal(result.recordsWithIssues.length, 1);
  assert.equal(result.recordsWithIssues[0].rawText, raw);
  assert.equal(result.recordsWithIssues[0].recordNumber, 2);
  assert.equal(result.recordsWithIssues[0].dataRowNumber, 1);
  assert.ok(result.recordsWithIssues[0].issues.some((issue) => issue.severity === "error" && issue.category === "parsing"));
});

test("quoted commas, escaped quotes, and multiline content do not create false validation errors", async () => {
  const result = await parseFileContents(csv('id,notes\r\n001,"Hello, ""supplier""\r\nnext line"\r\n'));

  assert.equal(result.status, "success");
  assert.deepEqual(result.recordsWithIssues, []);
  assert.deepEqual(result.preview[0].values, ["001", 'Hello, "supplier"\r\nnext line']);
});

test("an invalid row after the ten-record preview retains all original values and text", async () => {
  const goodRows = Array.from({ length: 12 }, (_, index) => `${index},original ${index}\n`).join("");
  const raw = '0012,"extra, value",unmapped\n';
  const result = await parseFileContents(csv(`id,notes\n${goodRows}${raw}`));

  assert.equal(result.totalRows, 13);
  assert.equal(result.preview.length, 10);
  assert.equal(result.recordsWithIssues.length, 1);
  assert.deepEqual(result.recordsWithIssues[0].values, ["0012", "extra, value", "unmapped"]);
  assert.equal(result.recordsWithIssues[0].rawText, raw);
  assert.equal(result.recordsWithIssues[0].dataRowNumber, 13);
  assert.equal(result.recordsWithIssues[0].recordNumber, 14);
});

test("missing cells stay missing and are distinguishable from explicitly empty cells", async () => {
  const result = await parseFileContents(csv("id,value,total\n001,\n002,,\n"));

  assert.equal(result.totalRows, 2);
  assert.deepEqual(result.preview.map((record) => record.values), [["001", ""], ["002", "", ""]]);
  assert.equal(result.recordsWithIssues.length, 1);
  assert.deepEqual(result.recordsWithIssues[0].values, ["001", ""]);
  assert.equal(result.recordsWithIssues[0].rawText, "001,\n");
});

test("an unterminated quoted field retains the source without inventing later row boundaries", async () => {
  const raw = '1,"unfinished\n2,last';
  const result = await parseFileContents(csv(`id,notes\n${raw}`));

  assert.equal(result.status, "error");
  assert.equal(result.totalRows, 1);
  assert.equal(result.recordsWithIssues.length, 1);
  assert.equal(result.recordsWithIssues[0].rawText, raw);
  assert.deepEqual(result.recordsWithIssues[0].values, ["1", "unfinished\n2,last"]);
  assert.ok(result.recordsWithIssues[0].issues.some((issue) => issue.code === "MissingQuotes"));
});

test("diagnostic detail limits never discard later records with inconsistent field counts", async () => {
  const goodRows = Array.from({ length: 12 }, (_, index) => `${index},good\n`).join("");
  const badRows = Array.from({ length: 125 }, (_, index) => `bad${index},x,y\n`).join("");
  const result = await parseFileContents(csv(`id,notes\n${goodRows}${badRows}`));

  assert.equal(result.totalRows, 137);
  assert.equal(result.warningCount, 125);
  assert.equal(result.warnings.length, 100);
  assert.equal(result.recordsWithIssues.length, 125);
  const last = result.recordsWithIssues.at(-1)!;
  assert.equal(last.rawText, "bad124,x,y\n");
  assert.deepEqual(last.values, ["bad124", "x", "y"]);
  assert.equal(last.dataRowNumber, 137);
  assert.equal(last.recordNumber, 138);
  assert.equal(last.issues[0].category, "structure");
});

test("original invalid-record slices and positions stay correct across parser pauses", async () => {
  const rows = Array.from({ length: 1_205 }, (_, index) => `${index},good\n`);
  rows[499] = '00499,stray"quote\n';
  rows[1_000] = '01000,"two\nlines",extra\n';
  const result = await parseFileContents(csv(`id,notes\n${rows.join("")}`));

  assert.equal(result.totalRows, 1_205);
  assert.equal(result.recordsWithIssues.length, 2);
  assert.deepEqual(result.recordsWithIssues.map((record) => record.rawText), [rows[499], rows[1_000]]);
  assert.deepEqual(result.recordsWithIssues.map((record) => record.recordNumber), [501, 1_002]);
  assert.deepEqual(result.recordsWithIssues.map((record) => record.dataRowNumber), [500, 1_001]);
  assert.deepEqual(result.recordsWithIssues[1].values, ["01000", "two\nlines", "extra"]);
});

test("blank and duplicate headers retain their original positions and header source", async () => {
  const rawHeader = "sku, ,sku,__proto__\n";
  const result = await parseFileContents(csv(`${rawHeader}001,  unchanged  ,002,last\n`));

  assert.deepEqual(result.columns, ["sku", " ", "sku", "__proto__"]);
  assert.deepEqual(result.preview[0].values, ["001", "  unchanged  ", "002", "last"]);
  const header = result.recordsWithIssues.find((record) => record.dataRowNumber === null)!;
  assert.equal(header.recordNumber, 1);
  assert.equal(header.rawText, rawHeader);
  assert.deepEqual(header.values, result.columns);
  assert.ok(header.issues.some((issue) => issue.code === "EmptyHeader" && issue.column === 2));
  assert.ok(header.issues.some((issue) => issue.code === "DuplicateHeader" && issue.column === 3));
  assert.ok(header.issues.every((issue) => issue.category === "structure"));
});

test("an entirely missing header is reported without replacing it or dropping following data", async () => {
  const result = await parseFileContents(csv(",,\n001,002,003\n"));

  assert.equal(result.status, "error");
  assert.deepEqual(result.columns, ["", "", ""]);
  assert.equal(result.totalRows, 1);
  assert.deepEqual(result.preview[0].values, ["001", "002", "003"]);
  assert.ok(result.errors.some((issue) => issue.code === "MissingHeader" && issue.category === "structure"));
  assert.equal(result.recordsWithIssues[0].rawText, ",,\n");
});

test("numeric column labels are not guessed to be a missing header", async () => {
  const result = await parseFileContents(csv("001,002\n003,004\n"));

  assert.equal(result.status, "success");
  assert.deepEqual(result.columns, ["001", "002"]);
  assert.deepEqual(result.preview[0].values, ["003", "004"]);
  assert.equal(result.errorCount, 0);
  assert.equal(result.stockyValidation, "unsupported");
});

test("an unknown Stocky layout remains a successful CSV parse with a separate schema notice", async () => {
  const result = await parseFileContents(csv("arbitrary,columns\nalpha,beta\n"));

  assert.equal(result.status, "success");
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
  assert.equal(result.stockyValidation, "unsupported");
  assert.ok(result.info.some((issue) => issue.category === "schema" && issue.severity === "info"));
  assert.equal(result.infoCount, result.info.length);
  assert.deepEqual(result.preview[0].values, ["alpha", "beta"]);
});

test("skipped physical empty lines are disclosed while quoted empty cells remain data", async () => {
  const result = await parseFileContents(csv('\n\nid,value\n1,""\n\n2,kept\n'));

  assert.equal(result.skippedEmptyLines, 3);
  assert.equal(result.totalRows, 2);
  assert.deepEqual(result.preview[0].values, ["1", ""]);
  assert.ok(result.info.some((issue) => issue.category === "parsing" || issue.category === "structure"));
});

test("informational notices do not change parse success or warning and error counts", () => {
  const result = createImportResult(csv("a,b\n1,2"));
  addIssue(result, { severity: "info", category: "session", code: "SameFileName", message: "These files share a name and are handled separately." });
  finalizeResult(result);

  assert.equal(result.status, "success");
  assert.equal(result.infoCount, 1);
  assert.equal(result.warningCount, 0);
  assert.equal(result.errorCount, 0);
  assert.equal(result.info[0].category, "session");
});

test("reusable row validation reports both missing and extra cells without changing input", () => {
  const missing = ["001"];
  const extra = ["002", "  raw  ", "third"];
  const issues: ValidationIssue[] = [];
  validateRow(missing, 2, 4, (issue) => issues.push(issue));
  validateRow(extra, 2, 5, (issue) => issues.push(issue));

  assert.deepEqual(missing, ["001"]);
  assert.deepEqual(extra, ["002", "  raw  ", "third"]);
  assert.deepEqual(issues.map((issue) => issue.row), [4, 5]);
  assert.ok(issues.every((issue) => issue.category === "structure"));
});

test("duplicate filenames retain separate file contents and clear selection labels", async () => {
  const files = [csv("id,value\n1,first"), csv("id,value\n2,second")];
  const entries = createImportEntries(files);
  const labels = getImportFileLabels(entries);

  assert.notEqual(entries[0].id, entries[1].id);
  assert.equal(labels.get(entries[0].id), "orders.csv (file 1 of 2)");
  assert.equal(labels.get(entries[1].id), "orders.csv (file 2 of 2)");
  const results = await Promise.all(files.map((file) => parseFileContents(file)));
  assert.deepEqual(results.map((result) => result.preview[0].values), [["1", "first"], ["2", "second"]]);
});

test("one unexpected preflight failure does not prevent other selected files entering the queue", () => {
  const broken = csv("id,value\n2,unread", "broken.csv");
  Object.defineProperty(broken, "type", { get() { throw new Error("Unexpected metadata failure"); } });
  const entries = createImportEntries([
    csv("id,value\n1,before", "before.csv"),
    broken,
    csv("id,value\n3,after", "after.csv"),
  ]);

  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.phase), ["queued", "complete", "queued"]);
  assert.equal(entries[1].result?.status, "error");
  assert.equal(entries[1].result?.fileName, "broken.csv");
  assert.equal(entries[2].file.name, "after.csv");
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 3);
});

test("a failed same-named file cannot replace or prevent another file's result", async () => {
  await inBrowser(async () => {
    const results = await parseCsvFiles([
      csv("id,value\n1,first"),
      csv('id,value\n2,"unfinished'),
      csv("id,value\n3,last"),
    ]);

    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.fileName === "orders.csv"));
    assert.deepEqual(results[0].preview[0].values, ["1", "first"]);
    assert.equal(results[1].status, "error");
    assert.deepEqual(results[2].preview[0].values, ["3", "last"]);
    assert.equal(results[2].errorCount, 0);
  });
});

test("an unexpected file failure is isolated and later files still import", async () => {
  await inBrowser(async () => {
    const broken = csv("id,value\n2,unread", "broken.csv");
    Object.defineProperty(broken, "type", { get() { throw new Error("Unexpected metadata failure"); } });
    const results = await parseCsvFiles([
      csv("id,value\n1,before", "before.csv"),
      broken,
      csv("id,value\n3,after", "after.csv"),
    ]);

    assert.equal(results.length, 3);
    assert.equal(results[1].status, "error");
    assert.equal(results[1].fileName, "broken.csv");
    assert.equal(results[1].totalRows, 0);
    assert.deepEqual(results[2].preview[0].values, ["3", "after"]);
    assert.equal(results[2].errorCount, 0);
  });
});

test("an explicit worker failure terminates it and retries the same file locally", { timeout: 3_000 }, async () => {
  await inBrowser(async () => {
    let terminated = false;
    const input = csv("id,value\n001,local");
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class FailedWorker {
        onmessage: ((event: MessageEvent<CsvWorkerResponse>) => void) | null = null;

        constructor() {
          queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent<CsvWorkerResponse>));
        }

        postMessage(request: CsvWorkerRequest) {
          assert.equal(request.file, input);
          queueMicrotask(() => this.onmessage?.({ data: { type: "failed" } } as MessageEvent<CsvWorkerResponse>));
        }

        terminate() { terminated = true; }
      },
    });
    const result = await parseCsvFile(input);

    assert.ok(terminated);
    assert.equal(result.parsingMode, "main-thread");
    assert.equal(result.errorCount, 0);
    assert.deepEqual(result.preview[0].values, ["001", "local"]);
    assert.ok([...result.info, ...result.warnings].some((issue) => issue.code === "WorkerUnavailable" && issue.category === "environment"));
  });
});
