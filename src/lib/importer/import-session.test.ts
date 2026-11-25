import assert from "node:assert/strict";
import test from "node:test";
import { parseFileContents } from "./csv-parser-core";
import {
  createImportEntries,
  importSessionReducer,
  initialImportSession,
  summarizeImports,
  type ImportSession,
} from "./import-session";

const csv = (contents = "id,value\n1,local", name = "orders.csv") => new File([contents], name, { type: "text/csv" });

function session(...files: File[]): ImportSession {
  return importSessionReducer(initialImportSession, { type: "add", entries: createImportEntries(files) });
}

test("valid preflight files remain queued and duplicate filenames have independent identities", () => {
  const sameFile = csv();
  const entries = createImportEntries([sameFile, sameFile]);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.ok(entries.every((entry) => entry.phase === "queued" && entry.result === undefined));
  const state = importSessionReducer(initialImportSession, { type: "add", entries });
  assert.equal(state.selectedId, null);
  assert.equal(summarizeImports(state.entries).successful, 0);
  assert.equal(summarizeImports(state.entries).pending, 2);
});

test("invalid and empty files are immediately reviewable without becoming queued imports", () => {
  const state = session(csv(), csv("unsupported", "orders.xlsx"), csv("", "empty.csv"));
  assert.deepEqual(state.entries.map((entry) => entry.phase), ["queued", "complete", "complete"]);
  assert.equal(state.entries[1].result?.status, "unsupported");
  assert.equal(state.entries[2].result?.status, "error");
  assert.equal(state.selectedId, state.entries[1].id);
  assert.equal(summarizeImports(state.entries).failed, 2);
});

test("batch start filters unknown and completed IDs and de-duplicates queued IDs", () => {
  const state = session(csv(), csv("bad", "wrong.pdf"));
  const [queued, failed] = state.entries;
  const started = importSessionReducer(state, { type: "start", ids: ["missing", failed.id, queued.id, queued.id] });
  assert.deepEqual(started.batch, { ids: [queued.id], completed: 0 });
  assert.equal(started.entries[0].phase, "queued");
  assert.equal(state.batch, null);
  assert.equal(importSessionReducer(state, { type: "start", ids: [failed.id] }), state);
});

test("results update stable file identities and count completion only once", async () => {
  let state = session(csv(), csv("id,value\n2,second"));
  const [first, second] = state.entries;
  state = importSessionReducer(state, { type: "start", ids: [first.id, second.id] });
  state = importSessionReducer(state, { type: "parsing", id: second.id });
  assert.equal(state.entries[0].phase, "queued");
  assert.equal(state.entries[1].phase, "parsing");
  const result = await parseFileContents(second.file);
  state = importSessionReducer(state, { type: "result", id: second.id, result });
  assert.equal(state.entries[1].result, result);
  assert.equal(state.entries[0].result, undefined);
  assert.equal(state.batch?.completed, 1);
  assert.equal(state.selectedId, second.id);
  assert.equal(importSessionReducer(state, { type: "result", id: second.id, result }), state);
  assert.equal(importSessionReducer(state, { type: "result", id: "missing", result }), state);
});

test("a running batch protects its file list and ignores another import start", () => {
  let state = session(csv(), csv("unsupported", "orders.pdf"));
  const queued = state.entries[0];
  state = importSessionReducer(state, { type: "start", ids: [queued.id] });
  assert.equal(importSessionReducer(state, { type: "add", entries: createImportEntries([csv()]) }), state);
  assert.equal(importSessionReducer(state, { type: "remove", id: queued.id }), state);
  assert.equal(importSessionReducer(state, { type: "clear" }), state);
  assert.equal(importSessionReducer(state, { type: "start", ids: [queued.id] }), state);
  assert.equal(importSessionReducer(state, { type: "parsing", id: state.entries[1].id }), state);
});

test("finishing an interrupted batch leaves completed results and returns unfinished files to the queue", async () => {
  let state = session(csv(), csv("id,value\n2,next"), csv("id,value\n3,last"));
  const [first, second, third] = state.entries;
  state = importSessionReducer(state, { type: "start", ids: [first.id, second.id, third.id] });
  const result = await parseFileContents(first.file);
  state = importSessionReducer(state, { type: "result", id: first.id, result });
  state = importSessionReducer(state, { type: "parsing", id: second.id });
  state = importSessionReducer(state, { type: "finish" });
  assert.equal(state.batch, null);
  assert.deepEqual(state.entries.map((entry) => entry.phase), ["complete", "queued", "queued"]);
  assert.equal(state.entries[0].result, result);
  assert.equal(importSessionReducer(state, { type: "result", id: second.id, result }), state);
});

test("removing a selected file falls back to another completed result, then clears selection", () => {
  let state = session(csv(), csv("first", "first.pdf"), csv("second", "second.pdf"));
  const [queued, first, second] = state.entries;
  state = importSessionReducer(state, { type: "remove", id: first.id });
  assert.equal(state.selectedId, second.id);
  state = importSessionReducer(state, { type: "remove", id: second.id });
  assert.equal(state.selectedId, null);
  assert.deepEqual(state.entries.map((entry) => entry.id), [queued.id]);
});

test("preview selection accepts only completed results and remains available during parsing", () => {
  let state = session(csv(), csv("first", "first.pdf"), csv("second", "second.pdf"));
  const [queued, , second] = state.entries;
  assert.equal(importSessionReducer(state, { type: "select", id: queued.id }), state);
  assert.equal(importSessionReducer(state, { type: "select", id: "missing" }), state);
  state = importSessionReducer(state, { type: "start", ids: [queued.id] });
  state = importSessionReducer(state, { type: "select", id: second.id });
  assert.equal(state.selectedId, second.id);
});

test("later imports append to the same session without replacing earlier results", async () => {
  let state = session(csv());
  const first = state.entries[0];
  const firstResult = await parseFileContents(first.file);
  state = importSessionReducer(state, { type: "start", ids: [first.id] });
  state = importSessionReducer(state, { type: "result", id: first.id, result: firstResult });
  state = importSessionReducer(state, { type: "finish" });
  state = importSessionReducer(state, { type: "add", entries: createImportEntries([csv("id,value\n2,next")]) });
  const second = state.entries[1];
  state = importSessionReducer(state, { type: "start", ids: [first.id, second.id] });
  assert.deepEqual(state.batch?.ids, [second.id]);
  state = importSessionReducer(state, { type: "result", id: second.id, result: await parseFileContents(second.file) });
  state = importSessionReducer(state, { type: "finish" });
  assert.equal(state.entries[0].result, firstResult);
  assert.equal(state.selectedId, first.id);
  assert.equal(summarizeImports(state.entries).successful, 2);
});

test("summary distinguishes pending, successful, warning, and failed files using real parser results", async () => {
  let state = session(
    csv(),
    csv("id,value\n1,ok\n2", "warning.csv"),
    csv('id,value\n1,"unfinished', "error.csv"),
    csv("wrong", "unsupported.xlsx"),
    csv("id,value\n5,pending", "pending.csv"),
  );
  const imports = state.entries.slice(0, 3);
  state = importSessionReducer(state, { type: "start", ids: imports.map((entry) => entry.id) });
  for (const entry of imports) {
    state = importSessionReducer(state, { type: "result", id: entry.id, result: await parseFileContents(entry.file) });
  }
  state = importSessionReducer(state, { type: "finish" });
  assert.deepEqual(summarizeImports(state.entries), {
    totalFiles: 5,
    totalRows: 4,
    successful: 2,
    failed: 2,
    warnings: 1,
    pending: 1,
    totalBytes: state.entries.reduce((sum, entry) => sum + entry.file.size, 0),
  });
  assert.deepEqual(summarizeImports([]), {
    totalFiles: 0, totalRows: 0, successful: 0, failed: 0, warnings: 0, pending: 0, totalBytes: 0,
  });
});

test("removing queued files and clearing a session update totals without mutating previous state", () => {
  const before = session(csv(), csv("id,value\n2,next"));
  const after = importSessionReducer(before, { type: "remove", id: before.entries[0].id });
  assert.equal(before.entries.length, 2);
  assert.equal(after.entries.length, 1);
  assert.equal(summarizeImports(after.entries).pending, 1);
  assert.deepEqual(importSessionReducer(after, { type: "clear" }), initialImportSession);
});
