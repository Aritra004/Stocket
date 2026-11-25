# Stocky History Rescue

Stocky History Rescue explores purchase orders entirely in the browser using Dexie and IndexedDB. The dashboard at `/` searches saved history and traces values to original source rows. `/suppliers` and `/skus` browse observed names and SKU histories. The importer at `/import` provides versioned normalization review for explicitly defined provisional formats. File contents are not uploaded and no Shopify or other service API is called.

## Development

```bash
npm install
npm run dev
```

Open http://localhost:3000 and choose **Import files**. Drop or select one or more `.csv` or `.tsv` files, remove any unwanted files from the queue, then import them. Further selections append to the current session. Completed saves appear in the local archive and dashboard and survive refresh. Queued files and unsaved session previews are temporary.

The responsive upload workspace includes session totals, file-by-file status and removal, completion progress, a selectable raw-data preview, and a saved-import list. Validation appears directly beneath each selected file, with information, warnings, errors, and original records available for review. Unsupported/empty files can be inspected immediately. Successful parses include recoverable warnings; parsing success does not by itself mean a local save succeeded. Progress measures completed files, not estimated rows or bytes. All file handling, parsing, and database access stay on the device.

Files with matching names remain separate selections with unique IDs and visible numbered labels. Raw-byte SHA-256 fingerprints detect identical content independently of filenames; different content with the same name remains separate. A failed file, including an unexpected worker failure, does not stop later imports.

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

## Purchase-order dashboard

The dashboard uses shadcn/ui controls and TanStack Table with manual IndexedDB filtering, sorting, and pagination. It contains no seeded or mock business data. The existing provisional schema limitation described below still applies: unsupported CSVs remain reviewable in the importer but do not acquire invented purchase-order records.

- **Total orders** counts saved summary records, including records missing an identifier. Repeated numbers remain separate; this is not a deduplicated order-entity count. Line-only imports are not synthesized into summaries.
- **Observed suppliers** counts distinct exact names in observed supplier observations across summaries and line items. Conflicting observations are excluded. **Unique SKUs** counts distinct exact observed SKU strings. These three metrics cover the entire archive; table filters do not change them.
- Purchase-order search is a case-insensitive substring match. Supplier selection matches an exact observed name. Inclusive date bounds use observed order dates only; missing, conflicting, and invalid dates are excluded while a bound is set. Sorting supports purchase-order number, supplier, order date, and status, with unavailable fields last in both directions.
- Order drawers show observed values, explicit unavailable/calculated indicators, original filenames, one-based data rows and logical CSV record numbers, original cells, and raw CSV evidence. Decimal strings retain their precision; missing costs/currencies are not replaced with zero or an assumed symbol. Derived values are labeled without displaying them as imported values.
- Related line items are candidate matches by exact observed purchase-order number across imports. A shared number does not establish store/order identity; records are not merged. Lines and their individual source evidence are paged independently.

Database version 3 adds state/value indexes without rewriting business values. Queries run in cancellable browser workers; obsolete responses cannot overwrite the active query. Order pages are capped at 100 records, line pages default to 20, supplier search returns at most 100 choices, and source inspection pages columns and long text. The dashboard does not read full import payloads. Substring searches and filtered counts may scan matching indexes, so elapsed query time still grows with archive size. A worker-unavailable fallback reads locally, and loading/error/retry states remain explicit. Metadata subscriptions refresh results after writes from importer workers and other tabs.

`npm test` covers storage migration, combined filters, precise values, missing/conflicting fields, source fidelity, large result pages, query-worker cancellation, and UI rendering. `npm run test:e2e` starts a dedicated local server on port 3100 and imports generated test CSVs in isolated Chromium contexts to verify the real browser workflow. These test files never seed a normal workspace.

## Supplier and SKU histories

The supplier directory includes exact observed names from both summaries and line items. Similar names remain separate: case, spelling, and whitespace are never normalized into an identity. Counts describe source records, not deduplicated supplier entities or orders. A separate **Supplier not observed** view retains summaries and lines whose supplier is missing, invalid, conflicting, or calculated. It does not create an "unknown supplier" entity.

Supplier history lists summaries and lines that explicitly record that exact name. A name on a summary is not copied onto a line with a missing supplier. A supplier observed only in line items still has a useful history even if no summary has been imported.

The searchable SKU directory uses exact observed string identifiers. `001`, `1`, `sku`, `SKU`, and ` SKU ` remain separate values throughout the directory, URLs, history, and source evidence. Search is a case-insensitive substring match for discovery; it does not change the matching identity used by a detail view. Summary-only imports produce an empty SKU directory with guidance to import line items.

SKU history retains every matching source line, ordered by newest observed order date with unavailable dates last. It shows that line's dates, supplier, product name, quantities, unit cost, currency, and source file/row references. Missing values stay unavailable; zero and exact decimal strings remain distinguishable. No prices, quantities, currencies, extended costs, or product identities are inferred. Shared SKUs across files or stores are observations of the same literal, not a confirmed product merge.

Supplier/SKU links appear in purchase-order details and histories. **Find purchase orders** performs an exact observed-number lookup and lists candidate summary records separately, including repeated numbers and their source locations. Each candidate opens its own purchase-order drawer. A line without a number or without a matching summary stays inspectable without a fabricated relationship.

Selections use URL fragments so literal names, SKU values, and local record IDs are not included in HTTP request paths or query strings. Reload and browser Back/Forward restore selections while IndexedDB remains scoped to the current origin/profile. Database version 4 adds literal/date indexes without altering the stored values. Directory pages default to 25 entries, histories to 20 line records, and every query caps pages at 100. Reads reuse cancellable browser workers and archive-change subscriptions; source evidence and candidate lookups load on demand.

The browser suite also covers supplier/SKU navigation, exact identities, missing fields, summary-only imports, source precision, and mobile histories. If a development server for this workspace is already running, set `PLAYWRIGHT_BASE_URL` to its origin (for example `http://localhost:3000`) before `npm run test:e2e`. This avoids starting a second Next.js development process against the same build directory. Tests still use isolated browser contexts and do not change the data in your normal browser profile.

## Recorded purchase costs and data quality

Each selected SKU includes a **Recorded purchase costs** table. It uses exact SKU matching and lists source lines by newest observed order date, with unavailable dates last. Unit costs remain decimal strings alongside each line's original currency. Zero is a recorded value; missing, invalid, conflicting, and calculated values remain labeled. No currency conversion, floating-point monetary arithmetic, cross-currency total, inferred unit price, or summary-to-line backfill is performed. The table links suppliers and exposes each line's original source and candidate purchase orders.

**Data quality** reads a consistent snapshot of the existing local archive. It summarizes each imported file and lists incomplete purchase-history records, exact source-value duplicates, invalid dates and values, conflicts, possible overlaps, and saved CSV/schema diagnostics. Incomplete means a missing PO number, supplier, order date, currency, cost, or ordered/received quantity, plus line ID and SKU for line records. Optional status, expected date, product name, and derived outstanding quantity are not completeness requirements; invalid optional values are still reported. Summary-only files do not require SKUs.

Exact duplicates require the same adapter/version, record kind, and ordered original header/value pairs, including unmapped columns. Both the first record and its copies count as duplicate members. Matching order numbers alone are possible overlaps, not confirmed duplicates. Category counts use distinct affected records within each category; categories overlap, and file/header diagnostics add findings without inventing affected data rows. No source data is changed.

File coverage notes disclose unsupported/provisional schemas, withheld records, unmapped columns, unavailable evidence, and capped parser diagnostic summaries. The quality scan runs in the existing cancellable local query worker, with the same browser fallback; a complete archive scan and HTML export require memory proportional to retained records and evidence. Findings are paginated in the UI. Original source inspection retains exact cells, absent versus empty values, filenames, data rows, and logical CSV record numbers.

**Download HTML report** creates a self-contained local report containing all file summaries, findings, counting rules, and original evidence retained for findings, regardless of active filters or pagination. It includes no scripts or external assets, escapes imported text, and links findings to an offline evidence appendix. Duplicate-group evidence lists are emitted once so repeated records do not cause quadratic report growth. The report is a snapshot; refresh quality after changing the archive to generate an updated download.

Validation covers decimal precision, mixed currencies, absent versus zero costs, exact duplicates versus repeated identifiers, field/overlap conflicts, invalid dates, unsupported schemas, source fidelity, replacement/removal, HTML escaping, full export coverage, and offline browser downloads.

## Standalone offline archive viewer

After unlocking a license, use **Data quality → Export offline ZIP**. Extraction produces `index.html`, unchanged CSV/TSV originals in `originals/`, `purchase_orders.csv`, `purchase_order_items.csv`, `suppliers.csv`, `data-quality.html`, `README.txt`, and a SHA-256 `manifest.json`. Open the extracted `index.html` directly; no build step, server, or network is required.

`src/lib/export-access.ts` checks a server-verified, anonymous session entitlement before ZIP generation. The browser and worker send only an empty status request with the HttpOnly cookie; they never send archive data. Local development/tests can explicitly set `NEXT_PUBLIC_EXPORT_TEST_BYPASS=true`, but production always ignores that bypass. Checkout callbacks or local-storage values cannot grant export access. The gate controls the product feature, not access to files already owned by the user.

## One-time payments

**Unlock archive** opens Razorpay Standard Checkout for a one-time **USD $19** purchase covering one merchant archive, without a subscription or mandatory account. The server creates the order at 1900 USD minor units, verifies its signature and captured status, and stores only payment/license metadata in Supabase PostgreSQL. USD checkout stays disabled until merchant support is explicitly confirmed; no INR conversion or substitution exists. Setup starts in Razorpay Test Mode.

Read [payment setup, migration, environment variables, Dashboard configuration, and release checklist](docs/payments.md). Copy [.env.example](.env.example) to `.env.local`, apply the SQL migration to a dedicated Supabase project, and configure real Test Mode credentials separately. No remote migration or live payment is performed by the local automated tests. Email recovery uses expiring, single-use links and transfers the license session. Refunds/disputes block future exports while downloaded archives remain fully offline.

The ZIP is assembled entirely in a dedicated browser worker using fflate's streaming ZIP writer, with progress, cancellation, bounded chunks, and meaningful worker/memory/storage errors. It reads one consistent IndexedDB snapshot and verifies original byte lengths and SHA-256 hashes before completing the ZIP. A manifest covers every other member, and ordinal-prefixed safe paths prevent filename collisions or path traversal after extraction. The download confirmation says it was requested; browsers cannot confirm a successful final disk save.

Normalized CSVs quote every cell, double embedded quotes, preserve exact decimal strings, and prefix formula-like values with an apostrophe. Every normalized field has a companion `*_state` column; missing/invalid/conflicting values remain empty. `suppliers.csv` contains one supplier-field observation per normalized record, including missing states and explicitly labeled original conflict evidence; names are never merged into invented identities. Unsupported mappings produce header-only normalized files while their original bytes remain in the ZIP.

Safety limits currently allow 1,000 files, 64 MiB of originals, 50,000 normalized records, 100,000 saved sources, 128 MiB per entry/compressed ZIP, and 256 MiB total uncompressed output. The snapshot and HTML still require memory proportional to saved evidence; devices with limited memory can fail below these caps. No incomplete archive is downloaded. Legacy imports without original bytes require re-importing the exact original file, which repairs/restores bytes without changing its saved records.

For the independent CLI, a version-1 archive JSON (for example, `offline-viewer/example.archive.json`) can still build a single offline HTML file with:

```sh
npm run build:offline -- --input "offline-viewer/example.archive.json" --out "offline-dist"
```

Open `offline-dist/index.html` directly through `file://`; it requires neither a server nor internet access. The viewer contains order search, exact supplier filters, SKU search/history, details, source evidence, and per-file quality information. Its CSS, classic JavaScript and safely serialized archive data are embedded. It has no dependency on Next.js, React, IndexedDB, remote assets, or runtime fetches.

See [the independent module documentation](offline-viewer/README.md) for its versioned input contract, standalone installation, security model, API and build commands. `npm run test:offline:browser` tests real local-file opening in offline Chromium without a web server; `npm run typecheck:offline` checks the module without the Next.js configuration.

After changing viewer runtime or CSS, run `npm run generate:offline` to refresh the browser-safe generated assets. A drift test verifies they match the sources and CSP hashes. `npm test` covers ZIP extraction, manifest integrity, original bytes, normalized CSV safety, legacy migration/repair, limits, and worker/gate behavior. `npm run test:e2e` covers browser import → ZIP download → extraction → offline viewer/report.

## Import API

Call the parser from a client component's event handler:

```ts
import { parseCsvFiles } from "@/src/lib/importer/csv-parser";

const results = await parseCsvFiles(fileInput.files ?? [], (result, index) => {
  // Optional per-file progress. Keep results in client-side state.
});
```

`parseCsvFile(file)` handles one file. `parseCsvFiles(files, onResult?)` accepts an iterable or array-like collection (including `FileList`), processes files sequentially to limit concurrent memory use, and returns a result for each file in selection order. Empty, malformed, unsupported, and unreadable files produce structured diagnostics. The public parser refuses to read files on the server.

Each `CsvImportResult` includes:

- `fileName`, original `fileSize` in bytes, and ordered `columns`.
- `totalRows` across the whole file and `preview` containing at most ten records.
- `info`, `warnings`, `errors`, their total counts, `status`, `delimiter`, and `parsingMode`.
- `recordsWithIssues`: every parsed logical record with quote or column-structure issues, including the header where applicable. Each contains original `rawText`, recovered string `values`, logical `recordNumber`, optional `dataRowNumber` (null for the header), and its issues. These records are not restricted to the preview or diagnostic-summary limits.
- `skippedEmptyLines`: the number of physically empty lines excluded from the data-row count. Papa's final empty placeholder is not counted as an actual line.
- `stockyValidation`: `"not-validated"` before header assessment, `"unsupported"` for unknown/ambiguous layouts, or `"provisional"` for an explicit unverified fixture contract. This is separate from CSV parsing status.
- `normalized`: detected adapter identity/version and verification status, every normalized record, original records withheld from normalization, and field-state totals. Unknown schemas produce no normalized records.

Issues have `severity: "info" | "warning" | "error"` and a `category` identifying file access/format, CSV parsing, row/column structure, Stocky schema support, browser processing, or session selection. Informational notices do not change a successful CSV parsing status.

Raw preview records use `{ rowNumber, values: string[] }`. The cell at index `i` corresponds to the header at `columns[i]`. Positional values preserve duplicate/blank column names and extra or missing cells without overwriting or inventing values. Raw values are never trimmed, coerced into numbers/dates/booleans, or sanitized. Normalized values are separate from this unchanged evidence. CSV quoting/escaping is decoded by Papa Parse, and leading encoding BOMs are removed. Render values as text, as the included React UI does.

The first nonempty CSV record is interpreted as the header, and an information notice makes this assumption explicit. Empty/whitespace-only names and exact duplicate names are reported without renaming them. Numeric-looking labels alone cannot establish that a header is missing, so no such inference is made. Physically empty lines are excluded with a notice; quoted empty strings, whitespace cells, and delimiter-only records are preserved. `totalRows` excludes the header and skipped empty lines, but includes malformed records Papa can recover. Preview row numbers are one-based data-record indexes. Diagnostic `row` positions are one-based logical CSV records including the header and excluding skipped empty lines; quoted multiline records count as one record. Diagnostic `column` positions are one-based.

Unclosed quotes can cause subsequent physical lines to be read as part of one logical record. The original text is retained, the uncertainty is reported, and no guessed row boundaries or missing values are inserted. All records with structural or quote issues can be inspected individually in the UI, even after the first ten preview records.

`success` means CSV parsing found no warnings or errors; `warning` indicates recoverable concerns such as uneven field counts, duplicate/blank headers, header-only input, ambiguous delimiters, or worker fallback. Invalid quoting, entirely missing headers, and read failures yield `error`. Unsupported extensions, binary content, and invalid UTF-8 yield `unsupported`. Recovered data from an error result may be incomplete and should be reviewed.

## Versioned schema detection and normalization

No genuine anonymized Stocky export sample was available in the inspected sources. The two registered version-1 adapters therefore support only explicit **unverified synthetic fixture contracts**, one for purchase-order summaries and one for line items. See [fixture contracts and evidence](src/lib/stocky/fixtures/README.md) for the required headers, every mapping, and sources inspected. They do not claim compatibility with actual Stocky exports.

Detection uses exact required header sets, including a distinct fixture/version marker. Header order may vary; names are not trimmed, case-folded, aliased, or guessed. Missing required headers, duplicate mapped headers, ambiguous matches, and malformed headers prevent mapping. Extra unmapped columns are preserved. Ordinary Stocky files without a registered contract remain readable raw CSVs with an unsupported-schema notice; this does not mean the source is invalid or that CSV parsing failed.

Normalized records are typed separately as purchase-order summaries or line items. Every field has a `missing`, `observed`, `derived`, `conflicting`, or `invalid` state and source evidence containing the filename, data-row number, logical CSV record number, column position, original header, and original value. Absent columns/cells and explicitly empty values remain distinguishable. Each supported row also retains the full original parsed array and decoded raw CSV record, including unmapped columns. Structurally unsafe rows are withheld from mapping and retained for review.

Text remains verbatim. Decimals use exact canonical strings without floating-point conversion; dates accept only real `YYYY-MM-DD` calendar dates; currency accepts only an explicitly supplied uppercase three-letter literal, without claiming ISO registry membership. Ambiguous values remain invalid. Supplier, SKU, cost, currency, and dates are never fabricated or backfilled. The only derived field is outstanding quantity, calculated exactly from two explicit valid quantities, with its rule and sources attached.

Within each file, repeated order identifiers (and order/line pairs for line-specific fields) are checked for conflicting observations. All alternatives and records remain available; no winner is selected, missing fields remain missing, and dependent quantities are invalidated. Files are never merged by filename or order number. Schema/field issues remain distinct from CSV parsing diagnostics. An unexpected normalization failure retains the affected original records without mappings and does not stall subsequent imports.

The review interface retains the raw preview and adds adapter/version badges, explicit unverified messaging, field states, source evidence, conflict alternatives, and records kept without normalization. Navigation reaches every normalized record and every conflict alternative while keeping the rendered page bounded.

## Implementation

- `src/lib/importer/types.ts`: result, record, issue, and worker-message interfaces.
- `src/lib/importer/validators.ts`: non-coercing Zod metadata/header checks, reusable row-width and quote validation, friendly error messages, schema assessment, and bounded diagnostic summaries; no Stocky field assumptions.
- `src/lib/importer/csv-parser-core.ts`: UTF-8 decoding, Papa Parse dialect detection, raw records, counts, diagnostics, preview collection, and normalization integration.
- `src/lib/stocky/`: typed normalized models, exact schema registry, separate versioned adapters, field conversion/provenance utilities, conflict handling, synthetic fixtures, and regression tests.
- `src/lib/storage/`: Dexie schema/migrations, atomic repository operations, exact file hashing, overlap review, browser worker/client APIs, and IndexedDB integration tests.
- `src/lib/importer/csv-parser.worker.ts`: dedicated, locally bundled background worker with explicit unexpected-failure signaling. Returns the summary, raw preview, every flagged original record, and supported normalized records to the UI.
- `src/lib/importer/csv-parser.ts`: browser entry points, sequential multi-file imports, worker cleanup, and fallback.
- `src/lib/importer/csv-parser.test.ts` and `validation-reliability.test.ts`: parsing fidelity, failures, delimiter and newline regressions, record preservation, schema separation, large row counts, and mocked worker lifecycle tests.
- `src/lib/importer/import-session.ts` and its tests: typed queue transitions, stable file identities, batch protection, preview selection, and summary counts.
- `src/components/csv-importer.tsx`: session and parser integration with real progress and summary counts.
- `src/components/importer/`: accessible dropzone, file results table, shared validation messages, original-record inspection, selectable data preview, and rendering regression tests.
- `src/components/ui/`, `src/lib/utils.ts`, and `components.json`: shadcn/ui Button, Badge, and Progress controls with project aliases.
- `app/page.tsx` and `app/globals.css`: responsive application layout, branding, privacy information, and light-theme tokens.

No CSV-content network APIs, server actions, or upload endpoints are used. Loading the app and its bundled worker still requires the application assets; offline app installation/caching is not implemented.

## Local archive

IndexedDB stores are scoped to this app's origin and the current browser profile:

- `importedFiles`: filename, byte size, original-byte SHA-256, saved time, parsing status, and review counts. A unique hash index prevents racing tabs from saving the same bytes twice.
- `importPayloads`: one canonical parsed/normalized result per import, preserving shared conflict evidence without copying it into every indexed record.
- `originalFiles` (schema version 5): the byte-preserved original Blob for each new import; identical reimports can restore or repair originals for older records. Original bytes share the atomic save/replacement/deletion transaction.
- `purchaseOrders` and `lineItems`: typed, indexed projections linked to the canonical result and source references. Every source record stays separate.
- `suppliers`: literal source observations, not supplier entities inferred or merged by name.
- `validationIssues`: CSV, normalization, and overlap diagnostics, distinguished by scope.
- `sourceReferences`: original values, raw logical records, filename, row, and column evidence, including withheld and malformed records.

The browser worker hashes, parses, prepares indexes, and accesses IndexedDB. Bulk writes and a transaction covering every collection make each save/replacement/removal atomic. Hashing and parsing complete before a write transaction starts. Failed replacements preserve the old import, and duplicate replacement content does not delete the selected target. Database work falls back locally if a worker cannot start; an interrupted write is not automatically retried after it may have committed.

Exact observed purchase-order identifiers identify *candidate overlaps*, not confirmed identity across stores. Shared order fields, summary fields, and line fields scoped by order/line ID are compared at their own levels. Different observations are flagged; matching observations remain ambiguous because store identity is unavailable. No records are combined, no value wins automatically, and missing identifiers or business values are not filled. Removing or replacing an import updates overlap notices on the remaining affected imports.

Saved imports can be inspected after refresh, explicitly replaced, or removed with their linked records. **Clear all saved data** requires confirmation and empties every archive collection. The session queue is separate from saved data. Storage failures remain visible; session review can continue without claiming the data was saved.

Database version 1 defines the baseline collections. Version 2 adds candidate-identity/source indexes, migrates hash provenance and review counters, and calculates overlap notices for existing imports while preserving business values and source evidence. Keep old version declarations when adding migrations. Tests create a real version-1 IndexedDB database with `fake-indexeddb`, upgrade it through Dexie, and verify preservation, transactions, duplicate races, overlap refresh, and deletion.

Implementation follows Dexie's [transaction and bulk-write guidance](https://dexie.org/docs/Table/Table.bulkPut()) and [versioned upgrade API](https://dexie.org/docs/Version/Version.upgrade()).

## Current limits

- UTF-8 CSV/TSV only, with optional BOM. Other encodings must be converted before import. MIME types are not authoritative because browsers report CSV types inconsistently.
- Papa Parse guesses comma, tab, semicolon, pipe, record-separator, or unit-separator delimiters. Ambiguous/single-column input falls back to comma with a warning; there is no manual dialect override yet.
- Each file's bytes and decoded text are read into memory. Very large files remain limited by browser memory. Supported formats retain all normalized and withheld rows with source evidence; unknown formats retain the ten-record preview and every flagged record. The source file is never changed.
- Workers keep parsing, hashing, normalization, and storage preparation off the UI thread. If workers are absent, blocked, or fail to load, local parsing yields every 500 parsed records. Decoding, dialect detection, final conflict checks, and an individual unusually large record can still cause a pause in this fallback.
- Diagnostic summary details are capped at 100 per severity while total issue counts remain exact. The UI shows the first 20 summary details per severity and says when more exist. Records with issues and their per-record diagnostics are preserved independently of these summary limits.
- Browser storage is not a backup: clearing site data, private browsing, storage eviction, or switching browser profiles/origins can remove or hide the archive. Storage is local, without application-level encryption or cloud synchronization. Web Crypto hashing requires HTTPS or localhost. Browser memory and storage quota limit very large imports.
- No verified Stocky adapters, automatic cross-file merging, or import cancellation are included. Payment and license verification require configured Razorpay/Supabase services; archive contents and previously downloaded viewers remain local.
