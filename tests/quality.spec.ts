import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import Papa from "papaparse";
import { expect, test, type Page } from "@playwright/test";

function csv(headers: string[], rows: string[][]) {
  return [headers, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
}

const lineHeaders = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Product Name", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"];
const summaryHeaders = ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Status", "Order Date", "Currency", "Total Cost", "Ordered Quantity", "Received Quantity"];
const sku = "0007-Q";
const preciseCost = "12345678901234567890.0000000000000001";
const unsafeProduct = '<img src="https://example.invalid/leak" onerror="window.__qualityInjected=1"><script>window.__qualityInjected=1</script> & preserved';
const duplicateLine = ["provisional", "PO-DUP", "DUP", sku, "Duplicate line", "Duplicate Co", "2026-01-04", "USD", "4", "4", "0"];
const lineContents = csv(lineHeaders, [
  ["provisional", "PO-ZERO", "ZERO", sku, "Zero-cost line", "Zero Co", "2026-01-01", "USD", "0", "0", "0"],
  ["provisional", "PO-PRECISE", "PRECISE", sku, "Precise-cost line", "Precise Co", "2026-01-02", "USD", preciseCost, "2", "1"],
  ["provisional", "PO-INR", "INR", sku, "Rupee-cost line", "Rupee Co", "2026-01-03", "INR", "7", "3", "0"],
  ["provisional", "PO-MISSING", "MISSING", sku, "Missing fields line", "", "", "", "", "", ""],
  ["provisional", "PO-INVALID", "INVALID", sku, unsafeProduct, "Invalid Co", "2026-02-30", "USD", "price?", "oops", ""],
  duplicateLine,
  [...duplicateLine],
  ["provisional", "PO-REPEAT", "REPEAT", sku, "Repeated identifier line", "Repeat Co", "2026-01-05", "USD", "5", "5", "0"],
  ["provisional", "PO-REPEAT", "REPEAT", sku, "Repeated identifier line", "Repeat Co", "2026-01-05", "USD", "6", "5", "0"],
  ["provisional", "PO-NOSKU", "NO-SKU", "", "Unidentified line", "", "", "USD", "", "", ""],
]);
const summaryContents = csv(summaryHeaders, [
  ["provisional", "PO-MISSING", "Summary supplier", "Open", "2026-01-06", "USD", "800", "8", "3"],
  ["provisional", "PO-ONLY", "", "Open", "", "", "", "", ""],
]);

async function importQualityArchive(page: Page) {
  await page.goto("/import");
  const picker = page.getByLabel("Select CSV or TSV files");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles([
    { name: "quality-&-lines.csv", mimeType: "text/csv", buffer: Buffer.from(lineContents) },
    { name: "quality-summaries.csv", mimeType: "text/csv", buffer: Buffer.from(summaryContents) },
  ]);
  await page.getByRole("button", { name: "Import 2 files", exact: true }).click();
  await expect(page.getByText(/Processed locally: 2 saved/)).toBeVisible();
}

test("quality has useful empty guidance without invented findings", async ({ page }) => {
  await page.goto("/quality");
  await expect(page.getByRole("heading", { level: 1, name: "Data quality", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No saved imports", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Import quality by file", exact: true })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Quality findings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Import files", exact: true }).last()).toHaveAttribute("href", "/import");
});

test("browser ZIP preserves originals and opens the extracted viewer and report completely offline", async ({ page, browser }, testInfo) => {
  await page.context().route("**/api/entitlements/status", (route) => route.fulfill({ json: { status: "active", mode: "test", licenseId: "test-license" } }));
  await importQualityArchive(page);
  await page.goto("/quality");
  await expect(page.getByRole("table", { name: "Import quality by file", exact: true })).toBeVisible();
  await page.getByLabel("Filter by category", { exact: true }).selectOption("invalid-date");
  const progressValues = await page.evaluateHandle(() => {
    const values: number[] = [];
    const region = document.querySelector('[aria-label="Offline archive export"]')!;
    const observer = new MutationObserver(() => {
      const progress = region.querySelector("progress");
      if (progress) values.push(progress.value);
    });
    observer.observe(region, { subtree: true, childList: true, attributes: true });
    return values;
  });
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export offline ZIP", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^stocky-history-rescue-.*\.zip$/);
  expect(await download.failure()).toBeNull();
  await expect(page.getByText(/ZIP download requested\./)).toBeVisible();
  const shownProgress = await progressValues.jsonValue();
  expect(shownProgress.length).toBeGreaterThan(0);
  expect(shownProgress.every((value) => value >= 0 && value <= 100)).toBe(true);
  const entries = unzipSync(await readFile((await download.path())!));
  expect(Object.keys(entries).sort()).toEqual([
    "README.txt", "data-quality.html", "index.html", "manifest.json",
    "originals/0001-quality-&-lines.csv", "originals/0002-quality-summaries.csv",
    "purchase_order_items.csv", "purchase_orders.csv", "suppliers.csv",
  ].sort());
  expect(Buffer.from(entries["originals/0001-quality-&-lines.csv"])).toEqual(Buffer.from(lineContents));
  expect(Buffer.from(entries["originals/0002-quality-summaries.csv"])).toEqual(Buffer.from(summaryContents));
  const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as {
    algorithm: string; entries: Array<{ path: string; bytes: number; sha256: string; originalName?: string }>;
  };
  expect(manifest.algorithm).toBe("SHA-256");
  expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(Object.keys(entries).filter((path) => path !== "manifest.json").sort());
  for (const entry of manifest.entries) {
    expect(entries[entry.path].byteLength).toBe(entry.bytes);
    expect(createHash("sha256").update(entries[entry.path]).digest("hex")).toBe(entry.sha256);
  }
  expect(manifest.entries.filter((entry) => entry.originalName).map((entry) => entry.originalName)).toEqual(["quality-&-lines.csv", "quality-summaries.csv"]);
  for (const [name, rows] of [["purchase_orders.csv", 2], ["purchase_order_items.csv", 10], ["suppliers.csv", 12]] as const) {
    const parsed = Papa.parse(strFromU8(entries[name]), { header: true, skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toHaveLength(rows);
  }
  const index = strFromU8(entries["index.html"]);
  const archive = JSON.parse(/<script id="archive-data" type="application\/json">([\s\S]*?)<\/script>/.exec(index)![1]);
  expect(archive.version).toBe(1);
  expect(archive.files).toHaveLength(2);
  expect(archive.records).toHaveLength(12);
  expect(archive.sources).toHaveLength(12);
  const precise = archive.records.find((record: { fields: { unitCost?: { value: string } } }) => record.fields.unitCost?.value === preciseCost);
  expect(precise.fields.currency.value).toBe("USD");
  expect(archive.sources.find((source: { id: string }) => source.id === precise.sourceId).rawText).toContain(preciseCost);
  expect(archive.sources.some((source: { rawText: string }) => source.rawText.includes(unsafeProduct.replaceAll('"', '""')))).toBe(true);
  expect(archive.findings.some((finding: { category: string }) => finding.category === "exact-duplicate")).toBe(true);

  const extracted = resolve(testInfo.outputPath("extracted archive"));
  for (const [name, bytes] of Object.entries(entries)) {
    const destination = resolve(join(extracted, name));
    expect(destination.startsWith(extracted + "/") || destination.startsWith(extracted + "\\")).toBe(true);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  const offline = await browser.newContext({ offline: true });
  try {
    const allowedDocuments = new Set([pathToFileURL(join(extracted, "index.html")).href, pathToFileURL(join(extracted, "data-quality.html")).href]);
    const requests: string[] = [];
    const blocked: string[] = [];
    const errors: string[] = [];
    offline.on("request", (request) => requests.push(request.url()));
    offline.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
    await offline.route("**/*", async (route) => {
      if (route.request().isNavigationRequest() && allowedDocuments.has(route.request().url())) await route.continue();
      else { blocked.push(route.request().url()); await route.abort(); }
    });
    const viewer = await offline.newPage();
    await viewer.goto(pathToFileURL(join(extracted, "index.html")).href);
    await expect(viewer.getByRole("button", { name: "Purchase orders", exact: true })).toBeVisible();
    await viewer.getByLabel("Search purchase orders", { exact: true }).fill("PO-ONLY");
    await expect(viewer.getByRole("table", { name: "Purchase orders", exact: true }).getByRole("button", { name: /^Open purchase order / })).toHaveCount(1);
    await viewer.getByRole("button", { name: "SKUs", exact: true }).click();
    await viewer.getByLabel("Search SKU identifiers", { exact: true }).fill(sku);
    await viewer.getByRole("table", { name: "SKU directory", exact: true }).getByRole("button", { name: sku, exact: true }).click();
    const history = viewer.getByRole("table", { name: "SKU purchase costs", exact: true });
    await expect(history.getByText(preciseCost, { exact: true })).toBeVisible();
    const invalid = history.getByRole("row").filter({ hasText: "PO-INVALID" });
    await invalid.getByRole("button", { name: "View line details", exact: true }).click();
    await expect(viewer.getByText(unsafeProduct, { exact: true })).toBeVisible();
    await viewer.getByText("View source evidence", { exact: true }).first().click();
    await expect(viewer.getByText("2026-02-30", { exact: true })).toBeVisible();
    expect(await viewer.evaluate(() => "__qualityInjected" in window)).toBe(false);
    await expect(viewer.locator("img, iframe, object, embed, script[src], link[href]")).toHaveCount(0);
    const report = await offline.newPage();
    await report.goto(pathToFileURL(join(extracted, "data-quality.html")).href);
    await expect(report.getByRole("heading", { level: 1 })).toHaveText("Data quality report");
    await expect(report.locator("body")).toContainText("quality-summaries.csv");
    await expect(report.locator("body")).toContainText("Exact duplicate records");
    await expect(report.locator("body")).toContainText(unsafeProduct);
    await expect(report.locator("script, img, iframe, object, embed, link[href]")).toHaveCount(0);
    expect(await report.evaluate(() => "__qualityInjected" in window)).toBe(false);
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.every((url) => allowedDocuments.has(url))).toBe(true);
  } finally {
    await offline.close();
  }
});

test("recorded SKU costs retain currencies, exact decimals, duplicate lines and unavailable values", async ({ page }) => {
  await importQualityArchive(page);
  await page.goto(`/skus#${new URLSearchParams({ sku })}`);
  const costs = page.getByRole("region", { name: "Recorded purchase costs", exact: true });
  const table = costs.getByRole("table", { name: "SKU purchase costs", exact: true });
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(10);
  const zero = table.getByRole("row").filter({ hasText: "PO-ZERO" });
  await expect(zero.getByRole("cell").nth(1)).toHaveText("0");
  await expect(zero.getByRole("cell").nth(2)).toHaveText("USD");
  await expect(zero.getByRole("cell").nth(3)).toHaveText("0");
  const precise = table.getByRole("row").filter({ hasText: "PO-PRECISE" });
  await expect(precise.getByRole("cell").nth(1)).toHaveText(preciseCost);
  await expect(precise.getByRole("cell").nth(2)).toHaveText("USD");
  const rupees = table.getByRole("row").filter({ hasText: "PO-INR" });
  await expect(rupees.getByRole("cell").nth(1)).toHaveText("7");
  await expect(rupees.getByRole("cell").nth(2)).toHaveText("INR");
  const absent = table.getByRole("row").filter({ hasText: "PO-MISSING" });
  for (const index of [0, 1, 2, 3, 4]) await expect(absent.getByRole("cell").nth(index)).toHaveText("Not provided");
  const invalid = table.getByRole("row").filter({ hasText: "PO-INVALID" });
  for (const index of [0, 1, 3]) await expect(invalid.getByRole("cell").nth(index)).toHaveText("Invalid value");
  await expect(table.getByRole("row").filter({ hasText: "PO-DUP" })).toHaveCount(2);
  const repeated = table.getByRole("row").filter({ hasText: "PO-REPEAT" });
  await expect(repeated).toHaveCount(2);
  for (const row of await repeated.all()) await expect(row.getByRole("cell").nth(1)).toHaveText("Conflicting values");
  await expect(table.getByRole("row").nth(1)).toContainText("2026-01-05");
  await expect(table.getByRole("row").filter({ hasText: "PO-NOSKU" })).toHaveCount(0);
  await expect(precise).toContainText("quality-&-lines.csv");
  await expect(precise).toContainText("Data row 2");
  await precise.getByText("Inspect order and source", { exact: true }).click();
  await precise.getByRole("button", { name: "View original line source", exact: true }).click();
  await precise.getByText("Original CSV record", { exact: true }).click();
  await expect(precise.locator("details details pre")).toContainText(preciseCost);
  await precise.getByText("Inspect order and source", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/sku-costs-mobile.png", fullPage: true });
});

test("quality filters separate exact duplicates from repeated identifiers and export a safe offline report", async ({ page, browser }) => {
  await importQualityArchive(page);
  await page.goto("/quality");
  await expect(page.getByRole("heading", { level: 1, name: "Data quality", exact: true })).toBeVisible();
  const files = page.getByRole("table", { name: "Import quality by file", exact: true });
  await expect(files.getByRole("row")).toHaveCount(3);
  const lineFile = files.getByRole("row").filter({ hasText: "quality-&-lines.csv" });
  await expect(lineFile).toBeVisible();
  await expect(lineFile.getByRole("cell").nth(1)).toHaveText("10");
  await expect(lineFile.getByRole("cell").nth(2)).toHaveText("10");
  await expect(lineFile.getByRole("cell").nth(5)).toHaveText("2");
  await expect(lineFile.getByRole("cell").nth(6)).toHaveText("1");
  await expect(lineFile.getByRole("cell").nth(7)).toHaveText("2");
  await expect(files.getByRole("row").filter({ hasText: "quality-summaries.csv" })).toBeVisible();
  const fileFilter = page.getByLabel("Filter by file", { exact: true });
  const fileId = await fileFilter.locator("option").filter({ hasText: "quality-&-lines.csv" }).getAttribute("value");
  expect(fileId).toBeTruthy();
  await fileFilter.selectOption(fileId!);
  const category = page.getByLabel("Filter by category", { exact: true });
  await category.selectOption("exact-duplicate");
  const findings = page.getByRole("region", { name: "Quality findings", exact: true });
  await expect(findings.getByText(/This record is one of 2 exact source-value matches/)).toHaveCount(2);
  await expect(findings.getByText(/Data row 6 .* CSV record 7/).first()).toBeVisible();
  await expect(findings.getByText(/Data row 7 .* CSV record 8/).first()).toBeVisible();
  await expect(findings.getByText(/Data row 8 .* CSV record 9/)).toHaveCount(0);
  await expect(findings.getByText(/Data row 9 .* CSV record 10/)).toHaveCount(0);
  await findings.getByText("View source evidence", { exact: true }).first().click();
  await expect(findings.getByText("Duplicate line", { exact: true })).toHaveCount(2);
  await expect(findings.getByText("Duplicate line", { exact: true }).first()).toBeVisible();
  await expect(findings.getByText("Repeated identifier line", { exact: true })).toHaveCount(0);

  await category.selectOption("invalid-date");
  await expect(findings.getByText(/Date values could not be validated/)).toHaveCount(1);
  await expect(findings.getByText(/Data row 5 .* CSV record 6/).first()).toBeVisible();
  await findings.getByText("View source evidence", { exact: true }).click();
  await expect(findings.getByText("2026-02-30", { exact: true }).first()).toBeVisible();
  await expect(findings.getByText(unsafeProduct, { exact: true })).toBeVisible();
  await expect(findings.locator("img, script")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/data-quality-mobile.png", fullPage: true });

  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download HTML report", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  expect(await download.failure()).toBeNull();
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const html = await readFile(downloadPath!, "utf8");
  expect(html).toContain("&lt;img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain('<img src="https://example.invalid/leak"');
  // Filters affect the interactive findings only; the report carries the whole snapshot.
  const reportContext = await browser.newContext({ offline: true });
  try {
    const report = await reportContext.newPage();
    const requests: string[] = [];
    report.on("request", (request) => requests.push(request.url()));
    await report.setContent(html, { waitUntil: "load" });
    await expect(report).toHaveTitle("Stocky History Rescue — Data quality report");
    await expect(report.getByRole("heading", { level: 1 })).toHaveText("Data quality report");
    await expect(report.locator("body")).toContainText("quality-&-lines.csv");
    await expect(report.locator("body")).toContainText("quality-summaries.csv");
    await expect(report.locator("body")).toContainText("Exact duplicate records");
    await expect(report.locator("body")).toContainText("Repeated identifier line");
    await expect(report.locator("body")).toContainText(unsafeProduct);
    await expect(report.locator("script, img, iframe, object, embed, link[href]")).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(await report.evaluate(() => "__qualityInjected" in window)).toBe(false);
  } finally {
    await reportContext.close();
  }
});
