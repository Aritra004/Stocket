import { expect, test, type Page } from "@playwright/test";

function csv(headers: string[], rows: string[][]) {
  return [headers, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
}

const summaryHeaders = ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Status", "Order Date", "Currency", "Total Cost", "Ordered Quantity", "Received Quantity"];
const summaries = csv(summaryHeaders, [
  ["provisional", "PO-DUP", "Harbor & Co", "Open", "2026-01-01", "USD", "0", "0", "0"],
  ["provisional", "PO-LOWER", "harbor & co", "Open", "2026-02-01", "USD", "20", "2", "1"],
  ["provisional", "PO-SPACE", " Harbor & Co ", "Open", "2026-03-01", "USD", "30", "3", "0"],
  ["provisional", "PO-ONLY", "Summary Only", "Open", "2026-04-01", "USD", "40", "4", "0"],
  ["provisional", "PO-MISSING", "", "Draft", "", "", "", "", ""],
]);
const duplicateSummaries = csv(summaryHeaders, [
  ["provisional", "PO-DUP", "Harbor & Co", "Open", "2026-01-01", "USD", "1", "1", "0"],
]);
const preciseCost = "12345678901234567890.0000000000000001";
const lineHeaders = ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Product Name", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"];
const lines = csv(
  lineHeaders,
  [
    ["provisional", "PO-DUP", "L-001", "00123", "Zero-cost item", "Harbor & Co", "2026-01-01", "USD", "0", "0", "0"],
    ["provisional", "PO-MISSING", "L-002", "00123", "Missing fields item", "", "", "", "", "", ""],
    ["provisional", "PO-LOWER", "L-003", "00123 ", "Spaced SKU", "harbor & co", "2026-02-01", "INR", "2", "2", "1"],
    ["provisional", "PO-SPACE", "L-004", "Ab-7", "Uppercase SKU", " Harbor & Co ", "2026-03-01", "EUR", "1", "3", "0"],
    ["provisional", "PO-CASE", "L-005", "ab-7", "Lowercase SKU", "Line Only", "2026-05-01", "USD", "2", "4", "4"],
    ["provisional", "PO-PRECISE", "L-006", "00123", "Precise-cost item", "Harbor & Co", "2026-06-01", "USD", preciseCost, "2", "1"],
    ["provisional", "PO-NOSKU", "L-007", "", "Unidentified item", "Line Only", "2026-07-01", "USD", "3", "5", "2"],
  ],
);

async function importHistory(page: Page) {
  await page.goto("/import");
  const picker = page.getByLabel("Select CSV or TSV files");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles([
    { name: "history-orders.csv", mimeType: "text/csv", buffer: Buffer.from(summaries) },
    { name: "history-overlap.csv", mimeType: "text/csv", buffer: Buffer.from(duplicateSummaries) },
    { name: "history-lines.csv", mimeType: "text/csv", buffer: Buffer.from(lines) },
  ]);
  await page.getByRole("button", { name: "Import 3 files", exact: true }).click();
  await expect(page.getByText(/Processed locally: 3 saved/)).toBeVisible();
}

function exactSupplierLink(page: Page, name: string) {
  return page.locator(`a[href="/suppliers#${new URLSearchParams({ name })}"]`);
}

function exactSkuLink(page: Page, sku: string) {
  return page.locator(`a[href="/skus#${new URLSearchParams({ sku })}"]`);
}

test("supplier and SKU directories offer import guidance without invented entities", async ({ page }) => {
  await page.goto("/suppliers");
  await expect(page.getByRole("heading", { name: "Suppliers", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText(/No observed suppliers|No supplier names|No suppliers yet/)).toBeVisible();
  await expect(page.locator('a[href^="/suppliers#name="]')).toHaveCount(0);
  await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: "SKUs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SKUs", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText(/No observed SKUs|No SKU identifiers|No SKUs yet/)).toBeVisible();
  await expect(page.locator('a[href^="/skus#sku="]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Import files", exact: true }).first()).toHaveAttribute("href", "/import");
  await page.goto("/import");
  const picker = page.getByLabel("Select CSV or TSV files");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles({ name: "summary-only.csv", mimeType: "text/csv", buffer: Buffer.from(summaries) });
  await page.getByRole("button", { name: "Import 1 file", exact: true }).click();
  await expect(page.getByText(/Processed locally: 1 saved/)).toBeVisible();
  await page.goto("/skus");
  await expect(page.getByRole("heading", { name: "No observed SKUs yet", exact: true })).toBeVisible();
  await expect(page.getByText(/Summary-only imports contain no SKU history/)).toBeVisible();
  await expect(page.locator('a[href^="/skus#sku="]')).toHaveCount(0);
});

test("supplier history keeps case and spaces distinct, includes absent suppliers, and handles summary-only imports", async ({ page }) => {
  await importHistory(page);
  await page.goto("/suppliers");
  for (const name of ["Harbor & Co", "harbor & co", " Harbor & Co ", "Summary Only", "Line Only"]) {
    await expect(exactSupplierLink(page, name)).toHaveCount(1);
  }
  await expect(page.locator('a[href^="/suppliers#name="]')).toHaveCount(5);
  await page.screenshot({ path: "test-results/supplier-directory.png", fullPage: true });
  await page.getByLabel("Search supplier names", { exact: true }).fill("harbor");
  await expect(page.locator('a[href^="/suppliers#name="]')).toHaveCount(3);
  await exactSupplierLink(page, " Harbor & Co ").click();
  await expect(page).toHaveURL(new URL(`/suppliers#${new URLSearchParams({ name: " Harbor & Co " })}`, page.url()).href);
  await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe(" Harbor & Co ");
  await expect(page.getByRole("region", { name: "Purchase-order records", exact: true }).getByText("PO-SPACE", { exact: true })).toBeVisible();
  await expect(exactSkuLink(page, "Ab-7")).toHaveCount(1);
  await page.reload();
  await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe(" Harbor & Co ");
  await page.getByRole("link", { name: "All suppliers", exact: true }).click();
  await exactSupplierLink(page, "Summary Only").click();
  await expect(page.getByRole("region", { name: "Purchase-order records", exact: true }).getByText("PO-ONLY", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No directly observed line items", exact: true })).toBeVisible();
  await expect(page.locator('a[href^="/skus#sku="]')).toHaveCount(0);

  await page.getByRole("link", { name: "All suppliers", exact: true }).click();
  await page.getByRole("link", { name: "Supplier not observed", exact: true }).click();
  await expect(page).toHaveURL(/\/suppliers#missing=1$/);
  await expect(page.getByRole("heading", { level: 1, name: "Supplier not observed", exact: true })).toBeVisible();
  const orders = page.getByRole("region", { name: "Purchase-order records", exact: true });
  const history = page.getByRole("region", { name: "Line-item history", exact: true });
  await expect(orders.getByText("PO-MISSING", { exact: true })).toBeVisible();
  await expect(orders.getByText("history-orders.csv", { exact: true })).toBeVisible();
  await expect(history.getByText("Missing fields item", { exact: true })).toBeVisible();
  await expect(history.getByText(/history-lines\.csv/)).toBeVisible();
  await expect(exactSkuLink(page, "00123")).toHaveCount(1);
});

test("SKU history preserves exact identifiers and costs, traces candidate orders, and links back from order details", async ({ page }) => {
  await importHistory(page);
  await page.goto("/skus");
  for (const sku of ["00123", "00123 ", "Ab-7", "ab-7"]) {
    await expect(exactSkuLink(page, sku)).toHaveCount(1);
  }
  await expect(page.locator('a[href^="/skus#sku="]')).toHaveCount(4);
  await page.getByLabel("Search SKU identifiers", { exact: true }).fill("00123");
  await expect(page.locator('a[href^="/skus#sku="]')).toHaveCount(2);
  await exactSkuLink(page, "00123 ").click();
  await expect(page).toHaveURL(new URL(`/skus#${new URLSearchParams({ sku: "00123 " })}`, page.url()).href);
  await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe("00123 ");
  await expect(page.getByText("Spaced SKU", { exact: true })).toBeVisible();
  await page.reload();
  await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe("00123 ");
  await page.getByRole("link", { name: "All SKUs", exact: true }).click();
  await exactSkuLink(page, "00123").click();
  await expect(page).toHaveURL(/\/skus#sku=00123$/);
  const history = page.getByRole("region", { name: "Line-item history", exact: true });
  await expect(history.getByText("Zero-cost item", { exact: true })).toBeVisible();
  await expect(history.getByText("Missing fields item", { exact: true })).toBeVisible();
  await expect(history.getByText("Precise-cost item", { exact: true })).toBeVisible();
  await expect(history.getByText("Spaced SKU", { exact: true })).toHaveCount(0);
  await expect(history.getByText(preciseCost, { exact: true })).toBeVisible();
  await expect(history.getByText("2026-01-01", { exact: true })).toBeVisible();
  await expect(history.getByText("Not provided", { exact: true }).first()).toBeVisible();
  const zeroCostLine = history.getByRole("listitem").filter({ has: page.getByText("Zero-cost item", { exact: true }) });
  await expect(zeroCostLine.locator("dt").filter({ hasText: /^Unit cost$/ }).locator("..").locator("dd")).toHaveText("0");
  await expect(zeroCostLine.locator("dt").filter({ hasText: /^Ordered quantity$/ }).locator("..").locator("dd")).toHaveText("0");
  await expect(history.getByText(/history-lines\.csv/).first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/history-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: "Find purchase orders for PO-DUP", exact: true }).click();
  const candidates = page.locator('a[href^="/#order="]');
  await expect(candidates).toHaveCount(2);
  const candidateScroll = page.getByRole("region", { name: "matching orders table scroll area", exact: true });
  await candidateScroll.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => candidateScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const firstDestination = await candidates.first().getAttribute("href");
  const secondDestination = await candidates.last().getAttribute("href");
  expect(firstDestination).not.toBe(secondDestination);
  await expect(page.getByText("history-orders.csv", { exact: true })).toBeVisible();
  await expect(page.getByText("history-overlap.csv", { exact: true })).toBeVisible();
  await candidates.first().click();
  await expect(page).toHaveURL(new URL(firstDestination!, page.url()).href);
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "PO-DUP", exact: true })).toBeVisible();
  await expect(drawer.locator('a[href="/suppliers#name=Harbor+%26+Co"]').first()).toBeVisible();
  await expect(drawer.locator('a[href="/skus#sku=00123"]')).toBeVisible();
  await drawer.locator('a[href="/skus#sku=00123"]').click();
  await expect(page.getByRole("heading", { level: 1, name: "00123", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "PO-DUP", exact: true })).toBeVisible();
});

test("encoded identifiers round-trip without inheriting missing line fields from a matching summary", async ({ page }) => {
  const supplier = 'Müller + Co / 50% #? "East"';
  const sku = '00/β+50%#? & "7"';
  const summary = csv(summaryHeaders, [
    ["provisional", "PO-EXPLICIT", supplier, "Open", "2026-08-01", "USD", "800", "8", "3"],
  ]);
  const lineRows = [
    ["provisional", "PO-EXPLICIT", "SPECIAL", sku, "Only SKU observed", "", "", "", "", "", ""],
    ["provisional", "PO-PADDED", "PADDED", "00123", "Padded identifier", supplier, "2026-08-02", "USD", "1", "1", "0"],
    ["provisional", "PO-NUMERIC", "NUMERIC", "123", "Unpadded identifier", supplier, "2026-08-03", "USD", "2", "2", "0"],
  ];
  await page.goto("/import");
  const picker = page.getByLabel("Select CSV or TSV files");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles([
    { name: "explicit-summary.csv", mimeType: "text/csv", buffer: Buffer.from(summary) },
    { name: "identifier-lines.csv", mimeType: "text/csv", buffer: Buffer.from(csv(lineHeaders, lineRows)) },
  ]);
  await page.getByRole("button", { name: "Import 2 files", exact: true }).click();
  await expect(page.getByText(/Processed locally: 2 saved/)).toBeVisible();

  await page.goto("/skus");
  for (const identifier of [sku, "00123", "123"]) await expect(exactSkuLink(page, identifier)).toHaveCount(1);
  await exactSkuLink(page, "00123").click();
  await expect(page.getByText("Padded identifier", { exact: true })).toBeVisible();
  await expect(page.getByText("Unpadded identifier", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "All SKUs", exact: true }).click();
  await exactSkuLink(page, sku).click();
  await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe(sku);
  await page.reload();
  await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe(sku);
  const selectedUrl = page.url();
  await page.getByRole("link", { name: "Skip to main content", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expect(page).toHaveURL(selectedUrl);
  await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe(sku);
  const history = page.getByRole("region", { name: "Line-item history", exact: true });
  for (const label of ["Supplier on this line", "Order date", "Unit cost", "Currency", "Ordered quantity", "Received quantity", "Outstanding quantity"]) {
    await expect(history.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("..").locator("dd")).toHaveText("Not provided");
  }
  await history.getByRole("button", { name: "View original line source", exact: true }).click();
  await history.getByText("Original CSV record", { exact: true }).click();
  await expect(history.locator("details pre")).toHaveText(csv(lineHeaders, [lineRows[0]]).split("\n")[1] + "\n");

  await history.getByRole("button", { name: "Find purchase orders for PO-EXPLICIT", exact: true }).click();
  await history.locator('a[href^="/#order="]').click();
  const drawer = page.getByRole("dialog");
  const imported = drawer.getByRole("region", { name: "Imported purchase-order fields", exact: true });
  await expect(imported.locator("dt").filter({ hasText: /^Total cost$/ }).locator("..").locator("dd")).toHaveText("800");
  await imported.getByRole("link", { name: supplier, exact: true }).click();
  await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe(supplier);
  await expect(page.getByRole("region", { name: "Purchase-order records", exact: true }).getByText("PO-EXPLICIT", { exact: true })).toBeVisible();
  await expect(exactSkuLink(page, sku)).toHaveCount(0);
  await expect(exactSkuLink(page, "00123")).toHaveCount(1);
  await expect(exactSkuLink(page, "123")).toHaveCount(1);

  await page.getByRole("link", { name: "All suppliers", exact: true }).click();
  await page.getByRole("link", { name: "Supplier not observed", exact: true }).click();
  await expect(page.getByRole("region", { name: "Line-item history", exact: true }).getByText("Only SKU observed", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Purchase-order records", exact: true }).getByText("PO-EXPLICIT", { exact: true })).toHaveCount(0);
});

test("supplier and SKU views refresh across tabs after imports are added and removed", async ({ page, context }) => {
  await page.goto("/suppliers");
  await expect(page.getByRole("heading", { name: "No observed suppliers yet", exact: true })).toBeVisible();
  const skuPage = await context.newPage();
  await skuPage.goto("/skus");
  await expect(skuPage.getByRole("heading", { name: "No observed SKUs yet", exact: true })).toBeVisible();
  const importer = await context.newPage();
  await importer.goto("/import");
  const picker = importer.getByLabel("Select CSV or TSV files");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles({
    name: "lifecycle-lines.csv", mimeType: "text/csv", buffer: Buffer.from(csv(lineHeaders, [
      ["provisional", "PO-LIVE", "LIVE-LINE", "LIVE-SKU", "Live item", "Live Supplier", "2026-09-01", "USD", "7", "4", "0"],
    ])),
  });
  await importer.getByRole("button", { name: "Import 1 file", exact: true }).click();
  await expect(importer.getByText(/Processed locally: 1 saved/)).toBeVisible();
  // Neither directory is reloaded: archive revision notifications refresh them.
  await expect(exactSupplierLink(page, "Live Supplier")).toHaveCount(1);
  await expect(exactSkuLink(skuPage, "LIVE-SKU")).toHaveCount(1);
  await exactSupplierLink(page, "Live Supplier").click();
  await exactSkuLink(skuPage, "LIVE-SKU").click();
  await expect(page.getByRole("heading", { level: 1, name: "Live Supplier", exact: true })).toBeVisible();
  await expect(skuPage.getByRole("heading", { level: 1, name: "LIVE-SKU", exact: true })).toBeVisible();

  await importer.getByRole("button", { name: /^Remove lifecycle-lines\.csv, saved import \d+$/ }).click();
  await importer.getByRole("button", { name: "Yes, remove this import", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Supplier not found", exact: true })).toBeVisible();
  await expect(skuPage.getByRole("heading", { level: 1, name: "SKU not found", exact: true })).toBeVisible();
  await expect(page.getByText("Live item", { exact: true })).toHaveCount(0);
  await expect(skuPage.getByText("Live item", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "All suppliers", exact: true }).click();
  await skuPage.getByRole("link", { name: "All SKUs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No observed suppliers yet", exact: true })).toBeVisible();
  await expect(skuPage.getByRole("heading", { name: "No observed SKUs yet", exact: true })).toBeVisible();
  await skuPage.close();
  await importer.close();
});
