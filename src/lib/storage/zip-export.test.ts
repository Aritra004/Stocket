import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import Papa from "papaparse";
import { parseFileContents } from "../importer/csv-parser-core";
import { createArchiveDatabase, type ArchiveDatabase } from "./database";
import { hashFile } from "./hash";
import { csvCell, csvRow } from "./normalized-csv";
import { saveImport } from "./repository";
import { EXPORT_LIMITS, exportErrorMessage, generateArchiveZip, originalArchivePath, type ExportProgress } from "./zip-export";

const summaryHeaders = ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Currency", "Total Cost", "Order Date", "Ordered Quantity", "Received Quantity", "Status"];
const itemHeaders = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Product Name", "Supplier", "Currency", "Unit Cost", "Order Date", "Ordered Quantity", "Received Quantity"];

function sourceCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n";
}

function inMode(context: TestContext, mode: string) {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  const previousBypass = env.NEXT_PUBLIC_EXPORT_TEST_BYPASS;
  env.NODE_ENV = mode;
  env.NEXT_PUBLIC_EXPORT_TEST_BYPASS = "true";
  context.after(() => { if (previous === undefined) delete env.NODE_ENV; else env.NODE_ENV = previous; });
  context.after(() => { if (previousBypass === undefined) delete env.NEXT_PUBLIC_EXPORT_TEST_BYPASS; else env.NEXT_PUBLIC_EXPORT_TEST_BYPASS = previousBypass; });
}

function database(context: TestContext, mode = "test") {
  inMode(context, mode);
  const db = createArchiveDatabase(`zip-integrity-${crypto.randomUUID()}`);
  context.after(async () => { db.close(); await db.delete(); });
  return db;
}

async function importOriginal(db: ArchiveDatabase, file: File, preserve = true) {
  return saveImport(db, {
    file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
    sha256: await hashFile(file), result: await parseFileContents(file), ...(preserve ? { originalFile: file } : {}),
  });
}

function simpleFile(name = "orders.csv", order = "PO-1") {
  return new File([sourceCsv(summaryHeaders, [["provisional", order, "Supplier", "USD", "12", "2026-01-01", "10", "4", "open"]])], name);
}

function csvRecords(bytes: Uint8Array): Record<string, string>[] {
  const parsed = Papa.parse<Record<string, string>>(strFromU8(bytes), { header: true, skipEmptyLines: true });
  assert.deepEqual(parsed.errors, []);
  return parsed.data;
}

interface ManifestEntry { path: string; bytes: number; sha256: string; importId?: string; originalName?: string }
interface Manifest { version: number; algorithm: string; entries: ManifestEntry[] }

test("complete ZIP contains every required member, verified SHA-256s and original BOM/CRLF/non-UTF bytes", async (context) => {
  const db = database(context);
  const files = [
    new File(["\uFEFF", sourceCsv(summaryHeaders, [["provisional", "PO-BOM", "Supplier", "USD", "1", "2026-01-01", "1", "0", "open"]])], "bom.csv"),
    simpleFile("crlf.csv"),
    new File([new Uint8Array([0xff, 0xfe, 0x61, 0, 0x2c, 0, 0x62, 0])], "unsupported.csv"),
  ];
  const originals = new Map<string, File>();
  for (const file of files) originals.set((await importOriginal(db, file)).file.id, file);
  const progress: ExportProgress[] = [];
  let eventLoopTicks = 0;
  const timer = setInterval(() => { eventLoopTicks++; }, 0);
  let result: Awaited<ReturnType<typeof generateArchiveZip>>;
  try { result = await generateArchiveZip(db, (value) => progress.push(value)); }
  finally { clearInterval(timer); }
  assert.ok(eventLoopTicks > 0, "Export yields while assembling and compressing members");
  assert.equal(result.blob.type, "application/zip");
  assert.match(result.fileName, /^stocky-history-rescue-\d{4}-\d{2}-\d{2}\.zip$/);
  const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const required = ["index.html", "purchase_orders.csv", "purchase_order_items.csv", "suppliers.csv", "data-quality.html", "README.txt", "manifest.json"];
  for (const path of required) assert.ok(entries[path], `Missing ${path}`);
  assert.equal(Object.keys(entries).length, required.length + files.length);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as Manifest;
  assert.equal(manifest.version, 1);
  assert.equal(manifest.algorithm, "SHA-256");
  assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(), Object.keys(entries).filter((path) => path !== "manifest.json").sort());
  for (const entry of manifest.entries) {
    const bytes = entries[entry.path];
    assert.equal(bytes.byteLength, entry.bytes, entry.path);
    assert.equal(await hashFile(new Blob([bytes as Uint8Array<ArrayBuffer>])), entry.sha256, entry.path);
    if (entry.importId) {
      const original = originals.get(entry.importId);
      assert.ok(original);
      assert.equal(entry.originalName, original.name);
      assert.deepEqual(bytes, new Uint8Array(await original.arrayBuffer()), entry.originalName);
    }
  }
  const viewer = strFromU8(entries["index.html"]);
  assert.match(viewer, /<script id="archive-data" type="application\/json">/);
  assert.match(viewer, /connect-src 'none'/);
  assert.doesNotMatch(viewer, /<(?:script|link)\b[^>]*(?:src|href)=["']https?:/i);
  assert.match(strFromU8(entries["README.txt"]), /Extract the entire ZIP/);
  assert.match(strFromU8(entries["README.txt"]), /original.*unchanged/i);
  assert.match(strFromU8(entries["data-quality.html"]), /Unsupported|unsupported|encoding/);
  assert.equal(progress[0].percent, 0);
  assert.equal(progress.at(-1)?.percent, 100);
  assert.equal(progress.at(-1)?.completed, progress.at(-1)?.total);
  assert.ok(progress.some((value) => value.phase === "compress"));
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].percent >= progress[i - 1].percent, "Progress never moves backward");
  assert.ok(progress.every((value) => value.percent >= 0 && value.percent <= 100 && value.message.length > 0));
});

test("duplicate and hostile original names use unique safe extraction paths with reversible manifest mapping", async (context) => {
  const db = database(context);
  const names = ["orders.csv", "orders.csv", "ORDERS.CSV", "../../orders.csv", "..\\..\\CON.csv", "NUL.csv"];
  for (let index = 0; index < names.length; index++) await importOriginal(db, simpleFile(names[index], `PO-${index}`));
  const result = await generateArchiveZip(db);
  const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as Manifest;
  const originals = manifest.entries.filter((entry) => entry.importId);
  assert.equal(originals.length, names.length);
  assert.equal(new Set(originals.map((entry) => entry.path.toLowerCase())).size, names.length);
  assert.deepEqual(originals.map((entry) => entry.originalName).sort(), [...names].sort());
  for (const original of originals) {
    assert.match(original.path, /^originals\/\d{4}-[^/\\:]+$/);
    assert.ok(!original.path.split("/").includes(".."));
    assert.ok(!original.path.endsWith(".") && !original.path.endsWith(" "));
  }
  assert.match(originalArchivePath("...", 0), /^originals\/0001-original\.csv$/);
  assert.doesNotMatch(originalArchivePath("\u202Eevil\u0000\n.csv", 1), /[\u202E\u0000\n]/);
  for (const name of ["a".repeat(99) + ".csv", "a".repeat(99) + " file.csv", "🛒".repeat(100) + ".csv"]) {
    const path = originalArchivePath(name, 0);
    assert.doesNotMatch(path, /[. ]$/);
    assert.ok(new TextEncoder().encode(path.split("/")[1]).byteLength <= 185);
    assert.ok(!path.includes("\uFFFD"));
  }
});

test("normalized exports keep precision, uncertainty, zero and supplier observations without inventing identities", async (context) => {
  const db = database(context);
  const formulaSupplier = '=HYPERLINK("https://invalid", "link")';
  const summary = new File([sourceCsv(summaryHeaders, [
    ["provisional", "0001", formulaSupplier, "USD", "9007199254740993.123456789", "2026-01-01", "10", "4", "-open"],
    ["provisional", "PO-MISSING", "", "", "", "", "", "", ""],
    ["provisional", "PO-INVALID", "Unresolved", "invalid", "NaN", "2025-02-30", "bad", "1", "open"],
    ["provisional", "PO-CONFLICT", "+Supplier A", "USD", "100", "2026-01-01", "2", "0", "open"],
    ["provisional", "PO-CONFLICT", "@Supplier B", "USD", "100", "2026-01-01", "2", "0", "open"],
  ])], "=summary.csv");
  const product = 'Quoted "product", with\r\nmultiple lines';
  const item = new File([sourceCsv(itemHeaders, [["provisional", "PO-ITEM", "001", "=SUM(1,2)", product, "Line supplier", "USD", "0.000000000000000001", "2026-01-01", "0", "0"]])], "items.csv");
  await importOriginal(db, summary);
  await importOriginal(db, item);
  const entries = unzipSync(new Uint8Array(await (await generateArchiveZip(db)).blob.arrayBuffer()));
  const orders = csvRecords(entries["purchase_orders.csv"]);
  const items = csvRecords(entries["purchase_order_items.csv"]);
  const suppliers = csvRecords(entries["suppliers.csv"]);
  assert.equal(orders.length, 5);
  assert.equal(items.length, 1);
  assert.equal(suppliers.length, 6, "One supplier field observation per normalized source record, including missing states");
  assert.equal(new Set(suppliers.map((row) => row.record_id)).size, 6);
  const precise = orders.find((row) => row.purchase_order_number === "0001")!;
  assert.equal(precise.total_cost, "9007199254740993.123456789");
  assert.equal(precise.supplier, `'${formulaSupplier}`);
  assert.equal(precise.source_file, "'=summary.csv");
  assert.equal(precise.status, "'-open");
  assert.equal(precise.outstanding_quantity, "6");
  assert.equal(precise.outstanding_quantity_state, "derived");
  const missing = orders.find((row) => row.purchase_order_number === "PO-MISSING")!;
  for (const field of ["supplier", "currency", "total_cost", "order_date", "ordered_quantity", "received_quantity"]) {
    assert.equal(missing[field], "", field);
    assert.equal(missing[`${field}_state`], "missing", field);
  }
  const invalid = orders.find((row) => row.purchase_order_number === "PO-INVALID")!;
  for (const field of ["currency", "total_cost", "order_date", "ordered_quantity"]) {
    assert.equal(invalid[field], "", field);
    assert.equal(invalid[`${field}_state`], "invalid", field);
  }
  const conflicts = orders.filter((row) => row.purchase_order_number === "PO-CONFLICT");
  assert.equal(conflicts.length, 2, "Overlapping source records are retained separately");
  assert.ok(conflicts.every((row) => row.supplier === "" && row.supplier_state === "conflicting"));
  const supplierConflicts = suppliers.filter((row) => row.supplier_state === "conflicting");
  assert.deepEqual(supplierConflicts.map((row) => row.original_supplier_observation).sort(), ["'+Supplier A", "'@Supplier B"]);
  const supplierMissing = suppliers.find((row) => row.record_id === missing.record_id)!;
  assert.equal(supplierMissing.supplier, "");
  assert.equal(supplierMissing.supplier_state, "missing");
  assert.equal(supplierMissing.original_supplier_observation, "");
  assert.equal(items[0].unit_cost, "0.000000000000000001");
  assert.equal(items[0].sku, "'=SUM(1,2)");
  assert.equal(items[0].line_id, "001");
  assert.equal(items[0].product_name, product);
  assert.equal(items[0].ordered_quantity, "0");
  assert.equal(items[0].received_quantity, "0");
  assert.equal(items[0].outstanding_quantity, "0");
  for (const bytes of [entries["purchase_orders.csv"], entries["purchase_order_items.csv"], entries["suppliers.csv"]]) assert.ok(strFromU8(bytes).endsWith("\r\n"));
});

test("CSV cells neutralize formula triggers after controls/whitespace and quote commas, quotes and newlines", () => {
  const dangerous = ["=1+1", "+cmd", "-42", "@SUM(A1)", "   =1+1", "\u0000\t+cmd", "\rfoo", "\nfoo", "\tfoo", "\u00A0@cmd"];
  for (const value of dangerous) {
    const parsed = Papa.parse<string[]>(csvRow([value]), { skipEmptyLines: true });
    assert.equal(parsed.data[0][0], `'${value}`);
  }
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(0), '"0"');
  for (const value of ['a,b', 'a"b', 'a\r\nb', "0001", "9007199254740993.123456789"]) {
    assert.equal(Papa.parse<string[]>(csvRow([value]), { skipEmptyLines: true }).data[0][0], value);
  }
});

test("missing, truncated and corrupt originals fail instead of reconstructing an incomplete ZIP", async (context) => {
  const db = database(context);
  const file = simpleFile();
  const saved = await importOriginal(db, file, false);
  await assert.rejects(generateArchiveZip(db), /Original file bytes are unavailable.*Re-import.*cannot be reconstructed/);
  await db.originalFiles.put({ importId: saved.file.id, blob: new Blob(["truncated"]) });
  await assert.rejects(generateArchiveZip(db), /wrong byte length/);
  const bytes = new Uint8Array(await file.arrayBuffer());
  bytes[0] ^= 1;
  await db.originalFiles.put({ importId: saved.file.id, blob: new Blob([bytes]) });
  await assert.rejects(generateArchiveZip(db), /SHA-256 integrity check/);
  assert.equal((await db.importedFiles.get(saved.file.id))?.sha256, saved.file.sha256);
  assert.equal(await db.purchaseOrders.count(), 1, "Failures leave saved business data untouched");
});

test("each memory bound rejects clearly without completing an export or changing stored data", async (context) => {
  const db = database(context);
  const saved = await importOriginal(db, simpleFile());
  for (const name of Object.keys(EXPORT_LIMITS) as Array<keyof typeof EXPORT_LIMITS>) {
    const progress: ExportProgress[] = [];
    await assert.rejects(generateArchiveZip(db, (value) => progress.push(value), { ...EXPORT_LIMITS, [name]: 0 }), /memory safety limit/, name);
    assert.ok(!progress.some((value) => value.percent === 100), name);
    assert.equal((await db.importedFiles.get(saved.file.id))?.sha256, saved.file.sha256, name);
    assert.equal(await db.originalFiles.count(), 1, name);
  }
});

test("empty archives report the missing imports and production gate refuses before opening storage", async (context) => {
  const db = database(context);
  await assert.rejects(generateArchiveZip(db), /No saved imports/);
  db.close();
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  context.mock.method(globalThis, "fetch", async () => Response.json({ status: "none", mode: "live" }));
  await assert.rejects(generateArchiveZip(db), /verified one-time license/);
  assert.equal(db.isOpen(), false, "Production rejects before any archive read");
});

test("allocation, quota and inaccessible-storage failures receive actionable messages", () => {
  assert.match(exportErrorMessage(new RangeError("Invalid array buffer length")), /memory.*Close other tabs/);
  assert.match(exportErrorMessage(new Error("out of memory")), /memory.*more memory/);
  assert.match(exportErrorMessage(new DOMException("full", "QuotaExceededError")), /storage.*Free device space/);
  assert.match(exportErrorMessage(new DOMException("denied", "SecurityError")), /storage.*permissions.*free device space/);
  assert.match(exportErrorMessage(undefined), /could not be created.*try again/);
});
