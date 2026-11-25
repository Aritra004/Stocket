import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildOfflineViewer, renderOfflineArchive } from "./build";
import { renderOfflineArchive as renderInBrowser } from "./render";
import { generateViewerAssetModule } from "./generate-assets";
import type { OfflineArchive } from "./types";

const empty = (): OfflineArchive => ({ version: 1, exportedAt: "2026-11-24T00:00:00.000Z", files: [], records: [], sources: [], findings: [], qualityNotes: ["No files included."] });

test("checked-in browser assets match the viewer sources and CSP hashes", async () => {
  const actual = await readFile(new URL("./generated-assets.ts", import.meta.url), "utf8");
  assert.equal(actual.replace(/\r\n?/g, "\n"), await generateViewerAssetModule(), "Run npm run generate:offline after changing runtime.ts or viewer.css.");
});

test("browser renderer and CLI renderer share the same portable document", async () => {
  assert.equal(await renderInBrowser(empty()), await renderOfflineArchive(empty()));
  for (const name of ["render.ts", "generated-assets.ts", "validate.ts", "types.ts"]) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:from\s*["']node:|from\s*["']typescript|\b(?:fetch|XMLHttpRequest|importScripts)\s*\()/);
  }
});
async function directory(context: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "stocky-offline-build-"));
  context.after(async () => { if (resolve(path).startsWith(resolve(tmpdir()) + "/") || resolve(path).startsWith(resolve(tmpdir()) + "\\")) await rm(path, { recursive: true, force: true }); });
  return path;
}

test("embedded JSON round-trips hostile CSV text without terminating its data script", async () => {
  const value = '</script><script>globalThis.injected=true</script><img src="https://example.invalid/x" onerror="alert(1)"> & < > \u2028 \u2029 名 🚚';
  const archive = empty();
  archive.files.push({ id: "__proto__", name: value, totalRows: 1, status: "success", coverageNotes: [value] });
  archive.sources.push({ id: "constructor", fileId: "__proto__", dataRowNumber: 1, recordNumber: 2, cells: [{ column: 1, header: value, rawValue: value }], rawText: value });
  archive.qualityNotes = [value];
  const html = await renderOfflineArchive(archive);
  const data = /<script id="archive-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1];
  assert.doesNotMatch(data, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(data), archive);
  assert.equal([...html.matchAll(/<script\b/gi)].length, 2);
  assert.doesNotMatch(html, /<img\b|<script>globalThis/);
});

test("one HTML contains compiled classic JavaScript and CSS with matching CSP hashes", async () => {
  const html = await renderOfflineArchive(empty());
  const javascript = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  for (const content of [javascript, css]) assert.ok(html.includes(`sha256-${createHash("sha256").update(content).digest("base64")}`));
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|@import|@font-face|type="module"/i);
  assert.doesNotMatch(javascript, /\b(?:fetch|XMLHttpRequest|WebSocket|importScripts|require)\s*\(|\bimport\s*\(/);
  assert.doesNotMatch(javascript, /\.innerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/);
  assert.doesNotMatch(javascript, /\bexports\.|^import\s|^export\s/m);
});

test("build creates only index.html and refuses invalid JSON without replacing existing output", async (context) => {
  const dir = await directory(context);
  const input = join(dir, "archive data.json");
  const out = join(dir, "portable archive");
  await writeFile(input, "\uFEFF" + JSON.stringify(empty()));
  const destination = await buildOfflineViewer(input, out);
  assert.equal(destination, join(out, "index.html"));
  assert.deepEqual(await readdir(out), ["index.html"]);
  const valid = await readFile(destination, "utf8");
  await writeFile(input, "not JSON");
  await assert.rejects(buildOfflineViewer(input, out), /valid JSON/);
  assert.equal(await readFile(destination, "utf8"), valid);
  await writeFile(input, JSON.stringify({ ...empty(), version: 99 }));
  await assert.rejects(buildOfflineViewer(input, out), /version/i);
  assert.equal(await readFile(destination, "utf8"), valid);
});

test("CLI builds from normalized JSON and reports invalid flags without a Next process", async (context) => {
  const dir = await directory(context);
  const input = join(dir, "input.json");
  const out = join(dir, "output");
  await writeFile(input, JSON.stringify(empty()));
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const args = ["--import", "tsx", cli];
  const built = spawnSync(process.execPath, [...args, "--input", input, "--out", out], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  assert.match(await readFile(join(out, "index.html"), "utf8"), /^<!doctype html>/);
  const invalid = spawnSync(process.execPath, [...args, "--input", input, "--wat", out], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
});
