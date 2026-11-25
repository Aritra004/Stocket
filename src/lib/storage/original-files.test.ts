import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Dexie from "dexie";
import { parseFileContents } from "../importer/csv-parser-core";
import { executeArchiveRequest } from "./archive-operations";
import { createArchiveDatabase, VERSION_4_STORES } from "./database";
import { hashFile } from "./hash";
import { clearArchive, removeImport, saveImport } from "./repository";

const csv = "__stocky_rescue_po_summary_v1,PO Number,Supplier\r\nprovisional,PO-1,Original Supplier\r\n";

function database(context: TestContext) {
  const name = `original-bytes-${crypto.randomUUID()}`;
  const db = createArchiveDatabase(name);
  context.after(async () => { db.close(); await db.delete(); });
  return { name, db };
}

async function input(file: File) {
  return {
    file: { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified },
    sha256: await hashFile(file), result: await parseFileContents(file), originalFile: file,
  };
}

test("browser import preserves exact BOM, CRLF and unsupported encoding bytes across reopening", async (context) => {
  const { name, db } = database(context);
  const files = [
    new File(["\uFEFF", csv], "with-bom.csv", { type: "text/csv" }),
    new File([csv], "crlf.csv", { type: "text/csv" }),
    new File([new Uint8Array([0xff, 0xfe, 0x61, 0, 0x2c, 0, 0x62, 0])], "unsupported.csv", { type: "text/csv" }),
  ];
  const savedIds: string[] = [];
  for (const file of files) {
    const saved = await executeArchiveRequest({ operation: "import", file }, name);
    assert.ok(saved && "kind" in saved && saved.kind === "saved");
    savedIds.push(saved.file.id);
  }
  db.close();
  await db.open();
  for (let i = 0; i < files.length; i++) {
    const original = await db.originalFiles.get(savedIds[i]);
    assert.ok(original);
    assert.deepEqual(new Uint8Array(await original.blob.arrayBuffer()), new Uint8Array(await files[i].arrayBuffer()));
    assert.equal(await hashFile(original.blob), (await db.importedFiles.get(savedIds[i]))?.sha256);
  }
  assert.equal((await db.importedFiles.get(savedIds[2]))?.status, "unsupported");
});

test("v4 migration leaves originals unavailable and a matching reimport fills only missing bytes", async (context) => {
  const { db } = database(context);
  const file = new File(["\uFEFF", csv], "legacy.csv");
  const legacyInput = { ...await input(file), originalFile: undefined };
  const saved = await saveImport(db, legacyInput);
  const payload = await db.importPayloads.get(saved.file.id);
  const name = `v4-originals-${crypto.randomUUID()}`;
  const legacy = new Dexie(name);
  legacy.version(4).stores(VERSION_4_STORES);
  await legacy.open();
  for (const table of db.tables.filter((table) => table.name in VERSION_4_STORES)) {
    await legacy.table(table.name).bulkPut(await table.toArray());
  }
  legacy.close();
  const upgraded = createArchiveDatabase(name);
  context.after(async () => { upgraded.close(); await upgraded.delete(); });
  await upgraded.open();
  assert.equal(await upgraded.originalFiles.count(), 0, "Parsed text must never be presented as original bytes");
  assert.deepEqual(await upgraded.importPayloads.get(saved.file.id), payload);

  const duplicate = await executeArchiveRequest({ operation: "import", file: new File([await file.arrayBuffer()], "renamed.csv") }, name);
  assert.ok(duplicate && "kind" in duplicate && duplicate.kind === "duplicate");
  assert.deepEqual(duplicate.file, saved.file, "Original metadata and identity remain unchanged");
  assert.deepEqual(await upgraded.importPayloads.get(saved.file.id), payload);
  assert.deepEqual(new Uint8Array(await (await upgraded.originalFiles.get(saved.file.id))!.blob.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
  assert.equal(await upgraded.importedFiles.count(), 1);
  assert.equal(await upgraded.originalFiles.count(), 1);
});

test("original byte validation rejects mismatched hash and size without writing any table", async (context) => {
  const { db } = database(context);
  const prepared = await input(new File([csv], "orders.csv"));
  await assert.rejects(saveImport(db, { ...prepared, originalFile: new Blob([csv.replace("PO-1", "PO-2")]) }), /original CSV bytes do not match/);
  await assert.rejects(saveImport(db, { ...prepared, originalFile: new Blob([csv, "extra"]) }), /original CSV bytes do not match/);
  for (const table of db.tables) assert.equal(await table.count(), 0, table.name);
});

test("replacement and failed writes keep originals atomic with records; removal and clear cascade", async (context) => {
  const { db } = database(context);
  const first = await input(new File([csv], "first.csv"));
  const saved = await saveImport(db, first);
  const replacement = await input(new File([csv.replace("PO-1", "PO-2")], "second.csv"));
  const fail = () => { throw new DOMException("Simulated storage full", "QuotaExceededError"); };
  db.sourceReferences.hook("creating", fail);
  await assert.rejects(saveImport(db, { ...replacement, replaceId: saved.file.id }), /storage full|QuotaExceeded/);
  db.sourceReferences.hook("creating").unsubscribe(fail);
  assert.equal(await hashFile((await db.originalFiles.get(saved.file.id))!.blob), first.sha256);
  assert.equal((await db.importedFiles.get(saved.file.id))?.sha256, first.sha256);
  await saveImport(db, { ...replacement, replaceId: saved.file.id });
  assert.equal(await hashFile((await db.originalFiles.get(saved.file.id))!.blob), replacement.sha256);
  assert.equal(await db.originalFiles.count(), 1);
  await removeImport(db, saved.file.id);
  for (const table of db.tables) assert.equal(await table.count(), 0, table.name);
  await saveImport(db, first);
  await clearArchive(db);
  for (const table of db.tables) assert.equal(await table.count(), 0, table.name);
});

test("repository duplicate save backfills verified bytes without replacing existing records", async (context) => {
  const { db } = database(context);
  const prepared = await input(new File([csv], "original.csv"));
  const legacyInput = { ...prepared, originalFile: undefined };
  const saved = await saveImport(db, legacyInput);
  assert.equal(await db.originalFiles.count(), 0);
  const restored = await saveImport(db, prepared);
  assert.equal(restored.kind, "duplicate");
  assert.deepEqual(restored.file, saved.file);
  assert.equal(await hashFile((await db.originalFiles.get(saved.file.id))!.blob), prepared.sha256);
});

test("matching reimports repair corrupt originals without changing stored metadata or evidence", async (context) => {
  const { name, db } = database(context);
  const file = new File([csv], "original.csv");
  const prepared = await input(file);
  const saved = await saveImport(db, prepared);
  const payload = await db.importPayloads.get(saved.file.id);
  for (const operation of ["browser", "repository"] as const) {
    await db.originalFiles.put({ importId: saved.file.id, blob: new Blob(["truncated"]) });
    if (operation === "browser") {
      const result = await executeArchiveRequest({ operation: "import", file }, name);
      assert.ok(result && "kind" in result && result.kind === "duplicate");
    } else {
      assert.equal((await saveImport(db, prepared)).kind, "duplicate");
    }
    assert.equal(await hashFile((await db.originalFiles.get(saved.file.id))!.blob), prepared.sha256);
    assert.deepEqual(await db.importedFiles.get(saved.file.id), saved.file);
    assert.deepEqual(await db.importPayloads.get(saved.file.id), payload);
    assert.equal(await db.originalFiles.count(), 1);
  }
});
