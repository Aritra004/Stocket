import { Zip, ZipDeflate } from "fflate";
import { renderOfflineArchive } from "../../../offline-viewer/render";
import { assertArchiveExportEnabled } from "../export-access";
import { renderDataQualityReport } from "../quality-report";
import type { ArchiveDatabase } from "./database";
import { hashFile } from "./hash";
import { normalizedCsvRows } from "./normalized-csv";
import { queryOfflineArchive } from "./offline-export";
import { queryDataQuality } from "./quality-queries";

export interface ExportProgress { phase: string; completed: number; total: number; percent: number; message: string }
export interface ArchiveZipResult { blob: Blob; fileName: string }
export const EXPORT_LIMITS = {
  maxFiles: 1000, maxOriginalBytes: 64 * 1024 * 1024, maxRecords: 50_000, maxSourceRecords: 100_000,
  maxEntryBytes: 128 * 1024 * 1024, maxUncompressedBytes: 256 * 1024 * 1024, maxZipBytes: 128 * 1024 * 1024,
} as const;
type Limits = { [K in keyof typeof EXPORT_LIMITS]: number };
const CHUNK_BYTES = 256 * 1024;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const memoryLimit = () => new Error("This archive exceeds the browser export memory safety limit. Export a smaller set of imports in a separate browser profile. Keep your original files; no saved data was changed.");

/** Unique ordinal prefixes also prevent case-insensitive extraction collisions. */
export function originalArchivePath(name: string, index: number): string {
  const leaf = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  let short = "";
  let bytes = 0;
  const encoder = new TextEncoder();
  // Bound both Windows UTF-16 and Unix UTF-8 filename sizes without splitting
  // surrogate pairs. Truncation can expose another trailing dot or space.
  for (const character of leaf) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > 180 || short.length + character.length > 100) break;
    short += character;
  }
  short = short.replace(/[. ]+$/g, "");
  return `originals/${String(index + 1).padStart(4, "0")}-${short || "original.csv"}`;
}

export { zipExportErrorMessage as exportErrorMessage } from "./zip-export-errors";

interface ManifestEntry { path: string; bytes: number; sha256: string; importId?: string; originalName?: string }

function readme(exportedAt: string): string {
  return `Stocky History Rescue — offline ZIP archive\r\nExported: ${exportedAt}\r\n\r\nExtract the entire ZIP, then double-click index.html in a modern browser with JavaScript enabled. No server, account, internet connection, external fonts, or installation is needed. The viewer embeds all saved normalized records and source evidence; browser fetch/file permissions are not needed.\r\n\r\nContents\r\n- index.html: searchable offline viewer\r\n- originals/: original imported CSV/TSV bytes, unchanged (including BOM, encoding, quoting, and line endings)\r\n- purchase_orders.csv: saved summary records only\r\n- purchase_order_items.csv: saved line-item records only\r\n- suppliers.csv: one supplier field observation per normalized record, including missing states; names are not merged into supplier identities\r\n- data-quality.html: all saved quality findings and their coverage limits\r\n- manifest.json: SHA-256 and byte size of every other archive member; original import IDs and filenames map to unique safe extraction paths\r\n- README.txt: this guide\r\n\r\nNormalized CSVs are UTF-8, quoted, with CRLF row endings. Missing, invalid, and conflicting fields have an empty value and an explicit *_state column. Zero is retained as zero. Derived values are labeled derived. No absent totals, dates, currencies, supplier identities, or summary records are invented. Conflicting supplier source observations appear in original_supplier_observation; this is evidence, not a resolved supplier. Duplicate/overlapping records remain separate. Decimal precision is preserved as text; import CSV columns as text to prevent spreadsheet rounding or loss of leading zeros.\r\n\r\nFormula-like text starting with =, +, -, @ (including after whitespace/control characters), and leading tabs/newlines is prefixed with an apostrophe in normalized CSVs. CSV quotes are doubled. Original files and embedded source values remain unchanged. Opening original files in spreadsheet software can evaluate formulas; inspect them as plain text when needed.\r\n\r\nOnly supported mappings produce normalized rows. Unmapped or malformed rows may be absent from normalized exports; consult the report and byte-preserved originals. Existing mapping coverage may be provisional. Filters in the app do not limit this export.\r\n\r\nIntegrity: compare extracted bytes with manifest.json using a SHA-256 tool. The manifest detects accidental corruption; it is not a digital signature. Keep this ZIP and your original files backed up. This archive contains your imported information.\r\n\r\nGeneration happens entirely in your browser worker. Current safety limits: 1,000 files, 64 MiB original bytes, 50,000 normalized records, 100,000 preserved sources, 128 MiB per entry/ZIP, and 256 MiB total uncompressed output. Lower-memory devices may need smaller archives. The browser cannot confirm that a requested download was saved successfully; check your Downloads folder and free disk space.\r\n`;
}

/** Worker entry point. Never call this on the UI thread; the client enforces that. */
export async function generateArchiveZip(db: ArchiveDatabase, onProgress: (progress: ExportProgress) => void = () => {}, limits: Limits = EXPORT_LIMITS): Promise<ArchiveZipResult> {
  await assertArchiveExportEnabled();
  const progress = (phase: string, percent: number, message: string, completed = 0, total = 1) => onProgress({ phase, percent, message, completed, total });
  progress("snapshot", 0, "Checking saved files and export size…");
  // One read transaction prevents edits in other tabs from producing a mixed ZIP.
  // Only IndexedDB promises are awaited here; no hashing/compression keeps locks open.
  const snapshot = await db.transaction("r", db.tables, async () => {
    const [files, recordCount, lineCount, sourceCount] = await Promise.all([
      db.importedFiles.orderBy("importedAt").limit(limits.maxFiles + 1).toArray(), db.purchaseOrders.count(), db.lineItems.count(), db.sourceReferences.count(),
    ]);
    if (!files.length) throw new Error("No saved imports are available. Import your CSV files before exporting an archive.");
    if (files.length > limits.maxFiles || files.reduce((sum, file) => sum + file.fileSize, 0) > limits.maxOriginalBytes || recordCount + lineCount > limits.maxRecords || sourceCount > limits.maxSourceRecords) throw memoryLimit();
    const originals = await db.originalFiles.bulkGet(files.map((file) => file.id));
    const absent = files.filter((file, index) => !originals[index]?.blob);
    if (absent.length) throw new Error(`Original file bytes are unavailable for ${absent.length} saved import(s): ${absent.slice(0, 3).map((file) => file.fileName).join(", ")}. Re-import the exact original files to restore their bytes, then retry. A complete ZIP cannot be reconstructed from parsed rows.`);
    if (originals.some((original, index) => original!.blob.size !== files[index].fileSize)) throw new Error("A saved original file has the wrong byte length. Re-import the original file before exporting; no incomplete ZIP was produced.");
    progress("snapshot", 5, "Checking normalized records and data quality…");
    const quality = await queryDataQuality(db);
    const archive = await queryOfflineArchive(db, quality);
    const suppliers = await db.suppliers.toArray();
    return { files, originals, quality, archive, suppliers };
  });
  progress("prepare", 15, "Saved snapshot ready. Preparing offline files…");
  await pause();

  const output: BlobPart[] = [];
  const manifest: ManifestEntry[] = [];
  let outputSize = 0;
  let uncompressedSize = 0;
  let finished = false;
  let zipError: Error | undefined;
  const zip = new Zip((error, chunk, final) => {
    if (error) { zipError = error; return; }
    outputSize += chunk.byteLength;
    if (outputSize > limits.maxZipBytes) { zipError = memoryLimit(); return; }
    // fflate owns each output buffer; Blob construction does not require a full concat.
    output.push(chunk as Uint8Array<ArrayBuffer>);
    if (final) finished = true;
  });
  const total = snapshot.files.length + 7; // originals, viewer, three CSVs, report, README, manifest
  let completed = 0;
  async function add(path: string, blob: Blob, original?: { importId: string; originalName: string; expectedHash: string }) {
    uncompressedSize += blob.size;
    if (blob.size > limits.maxEntryBytes || uncompressedSize > limits.maxUncompressedBytes) throw memoryLimit();
    progress("compress", 15 + 80 * completed / total, `Checking and compressing ${path}…`, completed, total);
    const sha256 = await hashFile(blob);
    if (original && sha256 !== original.expectedHash) throw new Error(`The saved original ${original.originalName} failed its SHA-256 integrity check. Re-import that exact original before exporting. No incomplete ZIP was produced.`);
    const entry = new ZipDeflate(path, { level: 6 });
    // A stable, valid ZIP timestamp avoids invalid imported metadata.
    entry.mtime = new Date(snapshot.archive.exportedAt);
    zip.add(entry);
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, blob.size);
      entry.push(new Uint8Array(await blob.slice(offset, end).arrayBuffer()), end === blob.size);
      if (zipError) throw zipError;
      progress("compress", 15 + 80 * (completed + end / blob.size) / total, `Compressing ${path}…`, completed, total);
      await pause();
    }
    if (!blob.size) entry.push(new Uint8Array(), true);
    if (zipError) throw zipError;
    if (path !== "manifest.json") manifest.push({ path, bytes: blob.size, sha256, ...(original ? { importId: original.importId, originalName: original.originalName } : {}) });
    completed += 1;
  }
  async function csvBlob(rows: Generator<string>): Promise<Blob> {
    const chunks: BlobPart[] = [];
    let batch = "";
    let bytes = 0;
    for (const row of rows) {
      batch += row;
      if (batch.length >= CHUNK_BYTES) {
        const chunk = new TextEncoder().encode(batch);
        bytes += chunk.byteLength;
        if (bytes > limits.maxEntryBytes || bytes + uncompressedSize > limits.maxUncompressedBytes) throw memoryLimit();
        chunks.push(chunk); batch = ""; await pause();
      }
    }
    chunks.push(batch);
    return new Blob(chunks, { type: "text/csv;charset=utf-8" });
  }
  try {
    for (let index = 0; index < snapshot.files.length; index++) {
      const file = snapshot.files[index];
      await add(originalArchivePath(file.fileName, index), snapshot.originals[index]!.blob, { importId: file.id, originalName: file.fileName, expectedHash: file.sha256 });
    }
    await add("index.html", new Blob([await renderOfflineArchive(snapshot.archive)], { type: "text/html;charset=utf-8" }));
    await add("purchase_orders.csv", await csvBlob(normalizedCsvRows(snapshot.archive, "purchase-order-summary")));
    await add("purchase_order_items.csv", await csvBlob(normalizedCsvRows(snapshot.archive, "purchase-order-line-item")));
    await add("suppliers.csv", await csvBlob(normalizedCsvRows(snapshot.archive, "supplier", snapshot.suppliers)));
    await add("data-quality.html", new Blob([renderDataQualityReport(snapshot.quality)], { type: "text/html;charset=utf-8" }));
    await add("README.txt", new Blob([readme(snapshot.archive.exportedAt)], { type: "text/plain;charset=utf-8" }));
    await add("manifest.json", new Blob([JSON.stringify({ version: 1, exportedAt: snapshot.archive.exportedAt, algorithm: "SHA-256", entries: manifest }, null, 2)], { type: "application/json" }));
    progress("finalize", 97, "Finalizing ZIP directory…", completed, total);
    zip.end();
    if (zipError) throw zipError;
    if (!finished) throw new Error("The ZIP could not be finalized. No download was started; retry the export.");
    const blob = new Blob(output, { type: "application/zip" });
    progress("complete", 100, "ZIP ready to download.", completed, total);
    return { blob, fileName: `stocky-history-rescue-${snapshot.archive.exportedAt.slice(0, 10)}.zip` };
  } finally {
    zip.terminate();
  }
}
