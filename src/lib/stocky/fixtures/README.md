# Provisional Stocky Rescue fixture contracts

These files are explicitly synthetic development fixtures. They are **not genuine anonymized Stocky exports** and do not establish compatibility with any official Stocky CSV format. Both registered adapters have `verification: "unverified"`. The format marker headers below intentionally prevent generic purchase-order CSVs from being mistaken for these contracts.

## Evidence and provenance

Before these mappings were introduced, the repository contained inline CSV parser test strings but no export sample files; the project README recorded that no authoritative Stocky schema had been supplied. A narrow connected Google Drive metadata search for `Stocky` returned no files. Public source inspection on 21 November 2026 found:

- [Shopify's Stocky purchase-order help](https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/stocky/inventory-management/purchase-orders) documents CSV download options but provides neither an export sample nor an exact header contract. Its form labels were not used as evidence for CSV mappings.
- [Stockie's purchase-order migration guide](https://stockie.helpscoutdocs.com/article/146-importing-your-stocky-purchase-order-history) distinguishes a purchase-order summary export from the Purchase order items report, but supplies no downloadable source sample or complete schema.
- [tappacific/stocky-export](https://github.com/tappacific/stocky-export) is a third-party API exporter with custom output, not a sample of Stocky's built-in CSV exports. Its inspected repository listed code, a README, and a license, without genuine export fixtures.
- Public mock data, anecdotal forum header lists, and templates for native Shopify purchase orders were not accepted as verification evidence.

This is a record of the sources inspected, not a claim that genuine samples do not exist. The linked documents are contextual evidence only, not proof that these fixture contracts match Stocky. Add separately reviewed, versioned adapters after obtaining genuine anonymized samples with known export provenance. Do not relabel these fixtures as verified.

## Summary fixture, version 1

File: `provisional-po-summaries-v1.csv`  
Adapter: `stocky-rescue.provisional.po-summary.v1`  
Required exact header set: `__stocky_rescue_po_summary_v1`, `PO Number`.

| CSV header | Normalized field | Format |
| --- | --- | --- |
| `PO Number` | `purchaseOrderNumber` | Verbatim text |
| `Supplier` | `supplier` | Verbatim text |
| `Status` | `status` | Verbatim text; no status vocabulary inferred |
| `Order Date` | `orderDate` | Calendar date |
| `Expected Date` | `expectedDate` | Calendar date |
| `Currency` | `currency` | Explicit currency code |
| `Total Cost` | `totalCost` | Exact nonnegative decimal |
| `Ordered Quantity` | `orderedQuantity` | Exact nonnegative decimal |
| `Received Quantity` | `receivedQuantity` | Exact nonnegative decimal |

## Line-item fixture, version 1

File: `provisional-po-line-items-v1.csv`  
Adapter: `stocky-rescue.provisional.po-line-item.v1`  
Required exact header set: `__stocky_rescue_po_line_item_v1`, `PO Number`, `Line ID`, `SKU`.

| CSV header | Normalized field | Format |
| --- | --- | --- |
| `PO Number` | `purchaseOrderNumber` | Verbatim text |
| `Line ID` | `lineId` | Verbatim text |
| `SKU` | `sku` | Verbatim text; leading zeroes preserved |
| `Product Name` | `productName` | Verbatim text |
| `Supplier` | `supplier` | Verbatim text |
| `Order Date` | `orderDate` | Calendar date |
| `Currency` | `currency` | Explicit currency code |
| `Unit Cost` | `unitCost` | Exact nonnegative decimal |
| `Ordered Quantity` | `orderedQuantity` | Exact nonnegative decimal |
| `Received Quantity` | `receivedQuantity` | Exact nonnegative decimal |

## Shared rules

- Header matching is exact and independent of order. It does not trim or case-fold names, infer aliases, or score similar columns. Marker headers identify the fixture contract; their cell text is preserved, not used as business data. An unknown version is unsupported. If both required sets match, detection is ambiguous and neither adapter runs.
- Non-required mapped columns may be absent. Absent columns, absent cells, and empty or whitespace-only cells are recorded as missing with distinct reasons and original source evidence. Missing supplier, SKU, cost, currency, or date is never guessed or filled from another record.
- Duplicate mapped headers prevent normalization. Unmapped columns remain in source records in their original positions, including duplicate or blank names. The fixture's `Unmapped note` column is deliberately not mapped.
- Text is observed verbatim. Decimal input accepts only digits and an optional decimal point with digits on both sides, such as `00125.50`. Normalized decimals use exact canonical strings (`125.5`), without floating-point conversion; the original string remains unchanged in source evidence. Currency symbols, grouping separators, signs, exponents, and locale-dependent notation are invalid for this version.
- Dates must be real calendar dates in `YYYY-MM-DD` form, from year 0001 through 9999. Timestamps and locale-dependent dates are invalid. Currency must be an explicit three-letter uppercase string. This checks the literal format, not membership in an ISO currency list, and never derives currency from a symbol or location.
- The only derived field is `outstandingQuantity`: exact ordered quantity minus received quantity, with both input sources and the rule retained. Missing or invalid inputs prevent derivation; received quantities above ordered quantities are invalid. Conflicting quantities invalidate dependent derived values. No supplier, SKU, money value, currency, or date is derived.
- Every normalized row retains its filename, one-based data-row number, one-based logical CSV record number, source columns, original Papa-parsed cells, and decoded raw CSV record. Logical records count a quoted multiline value once; physically empty skipped lines do not increase these row numbers. Structurally unsafe data rows are withheld from mapping and retained with their raw values and issues.
- Conflict detection does not merge records or select a winning value. Summary records sharing an observed purchase-order number are checked within one file. Line records sharing observed purchase-order and line identifiers are checked for line-specific conflicts; supplier, currency, and order date are checked across that order's lines. Missing identities do not group unrelated rows. Missing observations remain missing, and no inference is made across separate files, including files with identical names.

Run the fixture and normalization checks with `npx tsx --test src/lib/stocky/schema-normalization.test.ts`.
