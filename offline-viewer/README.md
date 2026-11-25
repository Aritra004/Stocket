# Standalone offline archive viewer

This independent module renders a normalized archive into one `index.html`. All CSS, classic JavaScript, normalized records, original source evidence, and quality findings are embedded. Copy or rename that single file and open it directly in a browser through `file://`. No server, Next.js runtime, internet connection, sibling assets, browser storage, remote fonts, CDNs, or runtime requests are needed. Browser ZIP exports use this same renderer inside their export worker.

## Build from your saved archive

In a development or test build of Stocky History Rescue, open **Data quality** and choose **Export offline ZIP**. The browser creates the complete archive, including `index.html`, byte-preserved originals, normalized CSVs, and the quality report. Extract the ZIP and open `index.html` directly. Dashboard filters do not limit the export. Saved imports from versions that did not retain original file bytes must be re-imported from the exact originals first.

The independent Node.js CLI remains available when you already have a normalized archive JSON matching the contract below:

   ```sh
   npm run build:offline -- --input "path/to/stocky-archive.json" --out "offline-dist"
   ```

Open `offline-dist/index.html` directly. You may move it to another folder or device; the JSON input is not needed at runtime. The CLI generates the viewer only; complete ZIP generation is performed in the browser.

To check the build without exporting any records, use the explicitly empty example:

```sh
npm run build:offline -- --input offline-viewer/example.archive.json --out offline-dist
```

Build tooling uses Node.js, TypeScript and tsx, already installed by the parent project. Nothing from `next`, React, Dexie, or the host application's source is imported by this module. To use the folder on its own, copy it, run `npm install` in it, then:

```sh
npm run build -- --input archive.json --out dist
npm run typecheck
npm test
npm run test:browser
```

Playwright's Chromium browser must be installed to run browser tests (`npx playwright install chromium`). Installation is a development step; opening a built archive requires no installed tools.

## Module API and data contract

`render.ts` is browser-safe and exports `renderOfflineArchive(input: unknown): Promise<string>` plus `serializeArchiveData`. It imports only generated static assets and the independent validator. `build.ts` re-exports the renderer and provides the optional Node.js file-building wrapper:

- `renderOfflineArchive(input: unknown): Promise<string>` validates normalized data and returns the complete HTML document.
- `buildOfflineViewer(inputPath: string, outputDirectory: string): Promise<string>` reads UTF-8 JSON, writes `index.html`, and returns its absolute path. Invalid input is rejected before an existing output file is changed.

The runtime and CSS are compiled ahead of time into committed `generated-assets.ts`. After editing `runtime.ts` or `viewer.css`, run `npx tsx offline-viewer/generate-assets.ts` from the repository root (or `npm run generate` within this folder). Unit tests reject stale generated assets and verify the exact CSP hashes. No TypeScript compiler or Node.js dependency is shipped into the browser ZIP renderer.

`types.ts` is the versioned JSON contract. `validate.ts` validates it independently of the host app. Version 1 has these required properties:

| Property | Content |
| --- | --- |
| `version` | Literal `1` |
| `exportedAt` | Valid ISO timestamp with an explicit timezone |
| `files` | IDs, original names, parsed row counts, CSV status and coverage notes |
| `records` | Separate summary or line records, with file/source references and all normalized fields |
| `sources` | File IDs, data-row and logical CSV-record numbers, original cells and raw CSV text |
| `findings` | Category, severity, message and related record/source references |
| `qualityNotes` | Coverage limits and counting rules supplied with the archive |

IDs must be unique across the archive, and references must resolve to the appropriate file. A normalized record must reference a preserved data row. Unsupported or withheld rows may still have source evidence and findings without becoming normalized records.

Each normalized field has `{ "state": "observed", "value": "literal value" }`, or the corresponding `missing`, `invalid`, `conflicting`, or `derived` state. Missing, invalid and conflicting fields require `null`. Recorded decimal values use exact canonical nonnegative base-ten strings, never JavaScript numbers. Existing normalization removes redundant decimal zeros; original spelling remains in source cells. No values are coerced by the viewer build.

Summary fields are `purchaseOrderNumber`, `supplier`, `status`, `orderDate`, `expectedDate`, `currency`, `totalCost`, `orderedQuantity`, `receivedQuantity`, and `outstandingQuantity`. Line fields are `purchaseOrderNumber`, `lineId`, `sku`, `productName`, `supplier`, `orderDate`, `currency`, `unitCost`, `orderedQuantity`, `receivedQuantity`, and `outstandingQuantity`. Include unavailable fields explicitly. Observed dates use real `YYYY-MM-DD` dates and currency codes remain explicit three-letter uppercase strings. Unsupported versions, unknown properties, invalid states, numeric monetary values, and broken references produce an error with the input path.

`src/lib/storage/offline-export.ts` is the host application's adapter into this contract. The dependency points from the host to this module, never from this module to Next.js or IndexedDB.

## Viewing and interpretation

The viewer offers purchase-order search, exact supplier filters (including records without an observed supplier), supplier history, searchable exact SKU identifiers, order/line details, source inspection, and per-file quality findings. Tables and long evidence are paginated. Summary-only and line-only archives remain useful without inventing relationships.

Case, whitespace and leading zeros remain significant in identifiers. Search can ignore case for discovery, while selections retain exact values. Related lines and order summaries are candidate matches by exact observed order number; a shared number does not prove common store/order identity. Every record remains separate. Costs retain their own currencies and decimal strings; missing, invalid, conflicting and calculated fields remain labeled. The viewer does not calculate currency conversions, mixed-currency totals, inferred prices or quantities, or new quality judgments. Quality information is the exported snapshot, with its coverage limitations.

## Injection and offline safeguards

Archive JSON is embedded in a non-executable `application/json` element. `<`, `>`, `&`, U+2028 and U+2029 are escaped before embedding so source text cannot terminate the element or create markup. The runtime renders imported values only through text nodes and uses Maps for identity lookups. It does not use HTML-string rendering, eval, imported URLs, inline handlers, dynamic modules or fetch.

A hash-based Content Security Policy permits only the compiled script and stylesheet and blocks network connections, remote assets, embedded objects, form submissions and base URLs. Hashes are calculated after normalizing line endings. All source values remain inspectable as literal text. The resulting file includes the exported data and can be read by anyone who has the file.

## Checks

From the parent repository:

```sh
npm run typecheck:offline
npm run test:offline
npm run test:offline:browser
```

The independent browser config has no server or base URL. Tests open real local files with networking disabled, verify requests are limited to the document, move only the generated HTML to a second directory, and exercise search, exact filtering, sources, quality, hostile CSV values and empty/summary/line-only archives. The regular app suite also generates a real browser ZIP, checks original bytes and every manifest hash, extracts it, and opens its viewer and report through `file://` in a fresh offline context. All standalone unit tests are included in the parent `npm test` command.

Archives are read-only snapshots. Re-export and rebuild to include subsequent changes. Build and browser memory requirements grow with the amount of embedded data; the UI bounds rendered pages, but the entire archive is loaded in memory.
