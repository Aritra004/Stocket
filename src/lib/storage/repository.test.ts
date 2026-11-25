import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { parseFileContents } from "../importer/csv-parser-core";
import { createArchiveDatabase, DATABASE_VERSION, VERSION_1_STORES } from "./database";
import { clearArchive, findImportByHash, getImportResult, listImportIssues, listImports, removeImport, saveImport } from "./repository";

const summaryMarker = "__stocky_rescue_po_summary_v1";
const lineMarker = "__stocky_rescue_po_line_item_v1";
const summaryHeaders = [summaryMarker, "PO Number", "Supplier", "Currency", "Total Cost", "Order Date", "Ordered Quantity", "Received Quantity"];
const lineHeaders = [lineMarker, "PO Number", "Line ID", "SKU", "Supplier", "Currency", "Unit Cost", "Order Date", "Ordered Quantity", "Received Quantity"];

function csvText(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((row) => row.map((cell) => /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(",")).join("\n") + "\n";
}

async function input(text: string, name = "orders.csv") {
  const file = new File([text], name, { type: "text/csv", lastModified: 1_700_000_000_000 });
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }, sha256, result: await parseFileContents(file) };
}

function database(context: TestContext) {
  const dependencies = { indexedDB: new IDBFactory(), IDBKeyRange };
  const name = `stocky-test-${crypto.randomUUID()}`;
  const db = createArchiveDatabase(name, dependencies);
  context.after(async () => { db.close(); await db.delete(); });
  return { db, name, dependencies };
}

async function fixture(name: "summaries" | "line-items") {
  return readFile(new URL(`../stocky/fixtures/provisional-po-${name}-v1.csv`, import.meta.url), "utf8");
}

test("saved fixture data survives closing and reopening with every original value and adapter state", async (context) => {
  const { db, name, dependencies } = database(context);
  const summaries = await input(await fixture("summaries"), "summary.csv");
  const lines = await input(await fixture("line-items"), "lines.csv");
  const savedSummary = await saveImport(db, summaries);
  const savedLines = await saveImport(db, lines);
  assert.equal(savedSummary.kind, "saved");
  assert.equal(savedLines.kind, "saved");
  assert.equal(await db.table("purchaseOrders").count(), 2);
  assert.equal(await db.table("lineItems").count(), 2);
  assert.ok(await db.table("suppliers").count() > 0);
  assert.ok(await db.table("validationIssues").count() > 0);
  assert.ok(await db.table("sourceReferences").count() > 0);
  db.close();

  const reopened = createArchiveDatabase(name, dependencies);
  context.after(() => reopened.close());
  assert.equal((await listImports(reopened)).length, 2);
  assert.deepEqual(await getImportResult(reopened, savedSummary.file.id), summaries.result);
  assert.deepEqual(await getImportResult(reopened, savedLines.file.id), lines.result);
  const source = await reopened.sourceReferences.where("[importId+recordNumber]").equals([savedSummary.file.id, 2]).first();
  assert.deepEqual(source?.source, summaries.result.normalized.records[0].source);
  assert.equal((await findImportByHash(reopened, summaries.sha256))?.id, savedSummary.file.id);
  assert.equal(await getImportResult(reopened, "missing-import"), undefined);
  reopened.close();
});

test("matching hashes deduplicate renamed files while identical filenames with different bytes stay distinct", async (context) => {
  const { db } = database(context);
  const text = await fixture("summaries");
  const original = await input(text, "orders.csv");
  const renamed = await input(text, "renamed.csv");
  const changed = await input(text.replace("PO-DEMO-001", "PO-OTHER"), "orders.csv");
  const first = await saveImport(db, original);
  const duplicate = await saveImport(db, renamed);
  const different = await saveImport(db, changed);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.file.id, first.file.id);
  assert.equal(duplicate.file.fileName, "orders.csv");
  assert.equal(different.kind, "saved");
  assert.notEqual(different.file.id, first.file.id);
  assert.equal((await listImports(db)).length, 2);
  assert.equal(await db.table("purchaseOrders").count(), 4);
});

test("concurrent saves from independent connections cannot create duplicate hash records", async (context) => {
  const { db, name, dependencies } = database(context);
  const other = createArchiveDatabase(name, dependencies);
  context.after(() => other.close());
  const imported = await input(await fixture("summaries"));
  const outcomes = await Promise.all([saveImport(db, imported), saveImport(other, imported)]);
  assert.deepEqual(outcomes.map((item) => item.kind).sort(), ["duplicate", "saved"]);
  assert.equal(outcomes[0].file.id, outcomes[1].file.id);
  assert.equal((await listImports(db)).length, 1);
  assert.equal(await db.table("purchaseOrders").count(), 2);
  other.close();
});

test("unknown schemas persist raw review without inventing orders, lines, or suppliers", async (context) => {
  const { db } = database(context);
  const imported = await input("Supplier,PO Number,Cost\nUnknown vendor,PO-1,15\n");
  const saved = await saveImport(db, imported);
  assert.deepEqual(await getImportResult(db, saved.file.id), imported.result);
  assert.equal(saved.file.normalizedCount, 0);
  assert.equal(await db.table("purchaseOrders").count(), 0);
  assert.equal(await db.table("lineItems").count(), 0);
  assert.equal(await db.table("suppliers").count(), 0);
  assert.ok((await listImportIssues(db, saved.file.id)).some((issue) => issue.issue.code === "UnsupportedStockySchema"));
});

test("overlapping order observations remain separate and conflicting fields are flagged for both imports", async (context) => {
  const { db } = database(context);
  const left = await input(csvText(summaryHeaders, [["provisional", "PO-1", "Alpha", "USD", "12.50", "2026-01-15", "10", "2"]]), "left.csv");
  const right = await input(csvText(summaryHeaders, [["provisional", "PO-1", "Beta", "EUR", "13", "2026-01-16", "10", "2"]]), "right.csv");
  const a = await saveImport(db, left);
  const b = await saveImport(db, right);
  assert.equal(await db.table("purchaseOrders").count(), 2);
  assert.deepEqual(await getImportResult(db, a.file.id), left.result);
  assert.deepEqual(await getImportResult(db, b.file.id), right.result);
  for (const [current, other] of [[a.file, b.file], [b.file, a.file]]) {
    const overlaps = (await listImportIssues(db, current.id)).filter((issue) => issue.scope === "overlap");
    assert.ok(overlaps.length > 0);
    assert.ok(overlaps.some((issue) => issue.relatedImportCount === 1 && issue.orderKey === "PO-1"));
    assert.notEqual(current.id, other.id);
    assert.ok(overlaps.some((issue) => /conflict|different/i.test(issue.issue.message)));
    assert.ok((await listImports(db)).find((item) => item.id === current.id)!.reviewCount > 0);
  }
});

test("overlap navigation samples contain only real peers and remain bounded as an order appears in many imports", async (context) => {
  const { db } = database(context);
  const savedIds: string[] = [];
  const count = 8;
  for (let index = 0; index < count; index += 1) {
    const imported = await input(csvText([...summaryHeaders, "Unmapped note"], [["provisional", "PO-1", "Alpha", "USD", "12", "2026-01-15", "10", "2", `Independent source ${index}`]]), `source-${index}.csv`);
    const saved = await saveImport(db, imported);
    savedIds.push(saved.file.id);
  }
  const allIds = new Set(savedIds);
  for (const importId of savedIds) {
    const overlaps = (await listImportIssues(db, importId)).filter((issue) => issue.scope === "overlap");
    assert.equal(overlaps.length, 1);
    const overlap = overlaps[0];
    assert.equal(overlap.relatedImportCount, count - 1);
    assert.equal(overlap.relatedImportIds?.length, 5);
    assert.equal(new Set(overlap.relatedImportIds).size, overlap.relatedImportIds?.length);
    assert.ok(overlap.relatedImportIds?.every((peer) => peer !== importId && allIds.has(peer)));
    assert.equal(overlap.issue.code, "AmbiguousOrderOverlap");
  }
  assert.equal(await db.purchaseOrders.count(), count);
});

test("different line identifiers are candidate overlaps without comparing unrelated SKU, cost, or quantities", async (context) => {
  const { db } = database(context);
  const left = await input(csvText(lineHeaders, [["provisional", "PO-1", "L-1", "SKU-A", "Alpha", "USD", "12", "2026-01-15", "10", "2"]]), "left.csv");
  const right = await input(csvText(lineHeaders, [["provisional", "PO-1", "L-2", "SKU-B", "Alpha", "USD", "13", "2026-01-15", "20", "3"]]), "right.csv");
  const a = await saveImport(db, left);
  const b = await saveImport(db, right);
  assert.equal(await db.lineItems.count(), 2);
  for (const item of [a, b]) {
    const issues = (await listImportIssues(db, item.file.id)).filter((issue) => issue.scope === "overlap");
    assert.ok(issues.some((issue) => issue.issue.code === "AmbiguousOrderOverlap"));
    assert.ok(issues.every((issue) => issue.conflictingFields?.length === 0));
  }
});

test("the same order and line identifier flags observed line conflicts without changing either record", async (context) => {
  const { db } = database(context);
  const left = await input(csvText(lineHeaders, [["provisional", "PO-1", "L-1", "SKU-A", "Alpha", "USD", "12", "2026-01-15", "10", "2"]]), "left.csv");
  const right = await input(csvText(lineHeaders, [["provisional", "PO-1", "L-1", "SKU-B", "Alpha", "USD", "13", "2026-01-15", "20", "3"]]), "right.csv");
  const a = await saveImport(db, left);
  const b = await saveImport(db, right);
  for (const item of [a, b]) {
    const issues = (await listImportIssues(db, item.file.id)).filter((issue) => issue.scope === "overlap");
    assert.ok(issues.some((issue) => issue.issue.code === "ConflictingOrderRecords"));
    for (const field of ["sku", "unitCost", "orderedQuantity", "receivedQuantity"]) {
      assert.ok(issues.some((issue) => issue.conflictingFields?.includes(field)), field);
    }
  }
  assert.deepEqual(await getImportResult(db, a.file.id), left.result);
  assert.deepEqual(await getImportResult(db, b.file.id), right.result);
});

test("summary totals are never compared to line-unit cost or line quantities", async (context) => {
  const { db } = database(context);
  const summary = await saveImport(db, await input(csvText(summaryHeaders, [["provisional", "PO-1", "Alpha", "USD", "120", "2026-01-15", "10", "2"]]), "summary.csv"));
  const line = await saveImport(db, await input(csvText(lineHeaders, [["provisional", "PO-1", "L-1", "SKU-A", "Alpha", "USD", "12", "2026-01-15", "4", "1"]]), "line.csv"));
  for (const item of [summary, line]) {
    const issues = (await listImportIssues(db, item.file.id)).filter((issue) => issue.scope === "overlap");
    assert.ok(issues.some((issue) => issue.issue.code === "AmbiguousOrderOverlap"));
    assert.ok(issues.every((issue) => issue.conflictingFields?.length === 0));
  }
});

test("a missing observation stays missing when another import supplies a value", async (context) => {
  const { db } = database(context);
  const missing = await input(csvText(summaryHeaders, [["provisional", "PO-1", "", "", "", "", "", ""]]), "missing.csv");
  const known = await input(csvText(summaryHeaders, [["provisional", "PO-1", "Alpha", "USD", "12", "2026-01-15", "10", "2"]]), "known.csv");
  const a = await saveImport(db, missing);
  await saveImport(db, known);
  const restored = await getImportResult(db, a.file.id);
  assert.deepEqual(restored, missing.result);
  assert.equal(restored?.normalized.records[0].fields.supplier.state, "missing");
  assert.equal(restored?.normalized.records[0].fields.currency.state, "missing");
  assert.ok((await listImportIssues(db, a.file.id)).some((issue) => issue.issue.code === "AmbiguousOrderOverlap"));
  assert.equal(await db.suppliers.where("importId").equals(a.file.id).count(), 0);
});

test("version 1 migrates to version 2 without losing payloads and backfills candidate identity indexes", async (context) => {
  const { db, dependencies } = database(context);
  const original = await input(await fixture("summaries"));
  const lines = await input(await fixture("line-items"), "lines.csv");
  const imported = await saveImport(db, original);
  const importedLines = await saveImport(db, lines);
  const snapshot = await Promise.all(db.tables.filter((table) => table.name in VERSION_1_STORES).map(async (table) => ({ name: table.name, rows: await table.toArray() as Record<string, unknown>[] })));
  const name = `stocky-legacy-${crypto.randomUUID()}`;
  const legacy = new Dexie(name, dependencies);
  legacy.version(1).stores(VERSION_1_STORES);
  await legacy.open();
  for (const table of snapshot) {
    // v1 predates cross-import review notices; v2 must build them from evidence.
    const rows = structuredClone(table.rows).filter((row) => table.name !== "validationIssues" || row.scope !== "overlap");
    for (const row of rows) {
      if (table.name === "importedFiles") { delete row.hashVersion; delete row.reviewCount; }
      if (table.name === "purchaseOrders" || table.name === "lineItems") { delete row.orderKey; delete row.lineKey; }
    }
    await legacy.table(table.name).bulkPut(rows);
  }
  legacy.close();
  const upgraded = createArchiveDatabase(name, dependencies);
  context.after(async () => { upgraded.close(); await upgraded.delete(); });
  await upgraded.open();
  assert.equal(upgraded.verno, DATABASE_VERSION);
  assert.deepEqual(await getImportResult(upgraded, imported.file.id), original.result);
  assert.deepEqual(await getImportResult(upgraded, importedLines.file.id), lines.result);
  for (const stored of await listImports(upgraded)) {
    assert.equal(stored.hashVersion, "sha256/raw-v1");
    assert.equal(stored.reviewCount, (await listImportIssues(upgraded, stored.id)).filter((item) => item.issue.severity !== "info").length);
  }
  assert.equal(await upgraded.purchaseOrders.where("orderKey").equals("PO-DEMO-001").count(), 1);
  assert.equal(await upgraded.lineItems.where("lineKey").equals(JSON.stringify(["PO-DEMO-001", "LINE-DEMO-001"])).count(), 1);
  assert.ok((await listImportIssues(upgraded, imported.file.id)).some((item) => item.issue.code === "AmbiguousOrderOverlap"));
  const incoming = await saveImport(upgraded, await input(csvText(summaryHeaders, [["provisional", "PO-DEMO-001", "Changed", "EUR", "150", "2026-01-15", "10", "4"]]), "after-upgrade.csv"));
  assert.ok((await listImportIssues(upgraded, incoming.file.id)).some((item) => item.issue.code === "ConflictingOrderRecords"));
  assert.ok((await listImportIssues(upgraded, imported.file.id)).some((item) => item.issue.code === "ConflictingOrderRecords"));
});

test("missing order identifiers never create a false overlap or a fabricated supplier", async (context) => {
  const { db } = database(context);
  const a = await saveImport(db, await input(csvText(summaryHeaders, [["provisional", "", "", "USD", "12", "2026-01-15", "1", "0"]]), "missing-a.csv"));
  const b = await saveImport(db, await input(csvText(summaryHeaders, [["provisional", "", "", "EUR", "13", "2026-01-16", "2", "0"]]), "missing-b.csv"));
  assert.equal(await db.table("purchaseOrders").count(), 2);
  assert.equal(await db.table("suppliers").count(), 0);
  for (const imported of [a, b]) {
    const issues = await listImportIssues(db, imported.file.id);
    assert.ok(issues.some((issue) => issue.issue.code === "MissingRecordIdentity"));
    assert.equal(issues.filter((issue) => issue.scope === "overlap").length, 0);
  }
});

test("removing an import cascades its data and clears obsolete overlap issues from survivors", async (context) => {
  const { db } = database(context);
  const left = await input(csvText(summaryHeaders, [["provisional", "PO-1", "Alpha", "USD", "12", "2026-01-15", "10", "2"]]), "left.csv");
  const right = await input(csvText(summaryHeaders, [["provisional", "PO-1", "Beta", "EUR", "13", "2026-01-16", "10", "2"]]), "right.csv");
  const a = await saveImport(db, left);
  const b = await saveImport(db, right);
  await removeImport(db, b.file.id);
  assert.equal((await listImports(db)).length, 1);
  assert.equal(await getImportResult(db, b.file.id), undefined);
  for (const table of ["purchaseOrders", "lineItems", "suppliers", "validationIssues", "sourceReferences"]) {
    assert.equal(await db.table(table).where("importId").equals(b.file.id).count(), 0, table);
  }
  assert.equal((await listImportIssues(db, a.file.id)).filter((issue) => issue.scope === "overlap").length, 0);
  assert.deepEqual(await getImportResult(db, a.file.id), left.result);
  await removeImport(db, b.file.id);
  assert.equal((await listImports(db)).length, 1, "removing a missing import does not affect another import");
});

test("replacement swaps only the chosen import and refuses another import's duplicate content", async (context) => {
  const { db } = database(context);
  const original = await input(csvText(summaryHeaders, [["provisional", "PO-1", "Alpha", "USD", "12", "2026-01-15", "10", "2"]]));
  const unrelated = await input(csvText(summaryHeaders, [["provisional", "PO-2", "Other", "GBP", "7", "2026-02-15", "1", "0"]]), "other.csv");
  const a = await saveImport(db, original);
  const b = await saveImport(db, unrelated);
  const duplicate = await saveImport(db, { ...unrelated, replaceId: a.file.id });
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.file.id, b.file.id);
  assert.deepEqual(await getImportResult(db, a.file.id), original.result);
  assert.equal((await listImports(db)).length, 2);

  const replacement = await input(csvText(summaryHeaders, [["provisional", "PO-NEW", "New", "CAD", "25", "2026-03-15", "2", "1"]]), "replacement.csv");
  const saved = await saveImport(db, { ...replacement, replaceId: a.file.id });
  assert.equal(saved.kind, "saved");
  assert.equal((await listImports(db)).length, 2);
  assert.equal(await findImportByHash(db, original.sha256), undefined);
  assert.deepEqual(await getImportResult(db, saved.file.id), replacement.result);
  assert.deepEqual(await getImportResult(db, b.file.id), unrelated.result);
  assert.equal(await db.table("purchaseOrders").count(), 2);
});

test("a failed storage write rolls back every collection and keeps an import being replaced", async (context) => {
  const { db } = database(context);
  const original = await input(await fixture("summaries"));
  const existing = await saveImport(db, original);
  const replacement = await input((await fixture("summaries")).replace("PO-DEMO-001", "PO-REPLACEMENT"), "new.csv");
  const counts = new Map(await Promise.all(db.tables.map(async (table) => [table.name, await table.count()] as const)));
  const fail = () => { throw new DOMException("Simulated disk full", "QuotaExceededError"); };
  db.table("sourceReferences").hook("creating", fail);
  await assert.rejects(saveImport(db, { ...replacement, replaceId: existing.file.id }), /disk full|QuotaExceeded/i);
  db.table("sourceReferences").hook("creating").unsubscribe(fail);
  for (const table of db.tables) assert.equal(await table.count(), counts.get(table.name), table.name);
  assert.deepEqual(await getImportResult(db, existing.file.id), original.result);
  assert.equal(await findImportByHash(db, replacement.sha256), undefined);
});

test("a malformed replacement never deletes the prior saved records", async (context) => {
  const { db } = database(context);
  const original = await input(await fixture("summaries"));
  const saved = await saveImport(db, original);
  const replacement = await input(`${summaryMarker},PO Number,Supplier\nprovisional,PO-1,"unclosed\n`, "broken.csv");
  assert.equal(replacement.result.status, "error");
  await assert.rejects(saveImport(db, { ...replacement, replaceId: saved.file.id }), /replacement|unchanged/i);
  assert.deepEqual(await getImportResult(db, saved.file.id), original.result);
  assert.equal((await listImports(db)).length, 1);
  assert.equal(await findImportByHash(db, replacement.sha256), undefined);
});

test("replacing an overlapping import recalculates the other import's review status", async (context) => {
  const { db } = database(context);
  const a = await saveImport(db, await input(csvText(summaryHeaders, [["provisional", "PO-1", "Alpha", "USD", "12", "2026-01-15", "10", "2"]]), "left.csv"));
  const b = await saveImport(db, await input(csvText(summaryHeaders, [["provisional", "PO-1", "Beta", "EUR", "13", "2026-01-16", "10", "2"]]), "right.csv"));
  assert.ok((await listImportIssues(db, a.file.id)).some((issue) => issue.scope === "overlap"));
  const replacement = await input(csvText(summaryHeaders, [["provisional", "PO-2", "Beta", "EUR", "13", "2026-01-16", "10", "2"]]), "replacement.csv");
  await saveImport(db, { ...replacement, replaceId: b.file.id });
  assert.equal((await listImportIssues(db, a.file.id)).filter((issue) => issue.scope === "overlap").length, 0);
  assert.equal((await listImports(db)).find((row) => row.id === a.file.id)?.reviewCount, 0);
  assert.equal(await db.purchaseOrders.count(), 2);
});

test("a stale replacement confirmation cannot overwrite content changed by another connection", async (context) => {
  const { db, name, dependencies } = database(context);
  const other = createArchiveDatabase(name, dependencies);
  context.after(() => other.close());
  const original = await input(await fixture("summaries"));
  const saved = await saveImport(db, original);
  const newer = await input((await fixture("summaries")).replace("PO-DEMO-001", "PO-NEWER"), "newer.csv");
  await saveImport(other, { ...newer, replaceId: saved.file.id, expectedHash: original.sha256 });
  const staleReplacement = await input((await fixture("summaries")).replace("PO-DEMO-001", "PO-STALE"), "stale.csv");
  await assert.rejects(saveImport(db, { ...staleReplacement, replaceId: saved.file.id, expectedHash: original.sha256 }), /changed|refresh|reload/i);
  assert.deepEqual(await getImportResult(db, saved.file.id), newer.result);
  assert.equal(await findImportByHash(db, staleReplacement.sha256), undefined);
  assert.equal((await listImports(db)).length, 1);
  other.close();
});

test("a stale removal confirmation leaves newer data intact until its current hash is confirmed", async (context) => {
  const { db } = database(context);
  const original = await input(await fixture("summaries"));
  const saved = await saveImport(db, original);
  const newer = await input((await fixture("summaries")).replace("PO-DEMO-001", "PO-NEWER"), "newer.csv");
  await saveImport(db, { ...newer, replaceId: saved.file.id, expectedHash: original.sha256 });
  await assert.rejects(removeImport(db, saved.file.id, original.sha256), /changed|refresh|reload/i);
  assert.deepEqual(await getImportResult(db, saved.file.id), newer.result);
  await removeImport(db, saved.file.id, newer.sha256);
  for (const table of db.tables) assert.equal(await table.count(), 0, table.name);
});

test("clear-all removes all archive collections and permits a clean subsequent import", async (context) => {
  const { db } = database(context);
  const source = await input(await fixture("summaries"));
  await saveImport(db, source);
  await saveImport(db, await input(await fixture("line-items")));
  await clearArchive(db);
  for (const table of db.tables) assert.equal(await table.count(), 0, table.name);
  assert.deepEqual(await listImports(db), []);
  const savedAgain = await saveImport(db, source);
  assert.equal(savedAgain.kind, "saved");
  assert.deepEqual(await getImportResult(db, savedAgain.file.id), source.result);
});

test("withheld malformed records beyond the raw preview persist with their full original source", async (context) => {
  const { db } = database(context);
  const rows = Array.from({ length: 12 }, (_, index) => ["provisional", `PO-${index}`, "Alpha", "USD", "12", "2026-01-15", "10", "2"]);
  const malformed = "provisional,PO-MALFORMED,Alpha,USD,12,2026-01-15,10,2,extra cell\n";
  const imported = await input(csvText(summaryHeaders, rows) + malformed);
  assert.equal(imported.result.preview.length, 10);
  assert.equal(imported.result.normalized.withheldRecords.length, 1);
  const saved = await saveImport(db, imported);
  const restored = await getImportResult(db, saved.file.id);
  assert.deepEqual(restored, imported.result);
  assert.equal(restored?.normalized.withheldRecords[0].source.rawText, malformed);
  const sources = await db.sourceReferences.where("[importId+recordNumber]").equals([saved.file.id, 14]).toArray();
  assert.ok(sources.some((row) => row.source.rawText === malformed));
  assert.ok((await listImportIssues(db, saved.file.id)).some((row) => row.issue.code === "FieldCountMismatch" && row.issue.row === 14));
});

test("batched storage retains every record while indexed projections avoid duplicating conflict evidence", async (context) => {
  const { db } = database(context);
  const count = 600;
  const rows = Array.from({ length: count }, (_, index) => ["provisional", "PO-1", "Alpha", "USD", String(index + 1), "2026-01-15", "10", "2"]);
  const imported = await input(csvText(summaryHeaders, rows));
  const saved = await saveImport(db, imported);
  assert.equal(await db.purchaseOrders.count(), count);
  assert.equal(await db.sourceReferences.where("importId").equals(saved.file.id).count(), count);
  const restored = await getImportResult(db, saved.file.id);
  assert.equal(restored?.normalized.records.length, count);
  const first = restored?.normalized.records[0];
  const last = restored?.normalized.records[count - 1];
  if (first?.kind !== "purchase-order-summary" || last?.kind !== "purchase-order-summary") throw new Error("Expected summary records");
  assert.equal(first.fields.totalCost.state, "conflicting");
  assert.equal(first.fields.totalCost, last.fields.totalCost);
  const projection = await db.purchaseOrders.toCollection().first();
  assert.ok(projection);
  assert.equal(projection.fields.totalCost.state, "conflicting");
  assert.equal(projection.fields.totalCost.value, null);
  assert.ok(!("sources" in projection.fields.totalCost));
  assert.ok(!("alternatives" in projection.fields.totalCost));
  assert.deepEqual(restored?.normalized.records[count - 1].source, imported.result.normalized.records[count - 1].source);
});
