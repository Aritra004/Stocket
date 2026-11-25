import { expect, test, type Page } from "@playwright/test";

// Explicit synthetic contracts are imported through the same UI and IndexedDB
// transaction as user files. Every test uses an isolated browser context.
function csv(headers: string[], rows: string[][]) {
  return [headers, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
}

const summaryContents = csv(
  ["__stocky_rescue_po_summary_v1", "PO Number", "Supplier", "Status", "Order Date", "Currency", "Total Cost", "Ordered Quantity", "Received Quantity"],
  Array.from({ length: 60 }, (_, index) => [
    "provisional", `PO-${String(index + 1).padStart(3, "0")}`,
    index % 2 === 0 ? "North & Co" : "South Works",
    index === 0 ? "" : "Open",
    `2026-01-${String(index % 28 + 1).padStart(2, "0")}`,
    "USD", index === 0 ? "0" : "125.50", "10", "4",
  ]),
);

const lineContents = csv(
  ["__stocky_rescue_po_line_item_v1", "PO Number", "Line ID", "SKU", "Product Name", "Supplier", "Order Date", "Currency", "Unit Cost", "Ordered Quantity", "Received Quantity"],
  Array.from({ length: 23 }, (_, index) => [
    "provisional", "PO-001", `LINE-${String(index + 1).padStart(2, "0")}`,
    index === 22 ? "" : `SKU-${String(index + 1).padStart(2, "0")}`,
    index === 0 ? "<script>literal product</script>" : "Imported item",
    "North & Co", "2026-01-01", "USD", "0", "10", "4",
  ]),
);

async function importArchive(page: Page) {
  await page.goto("/import");
  const picker = page.getByLabel("Select CSV or TSV files");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles([
    { name: "browser-orders.csv", mimeType: "text/csv", buffer: Buffer.from(summaryContents) },
    { name: "browser-lines.csv", mimeType: "text/csv", buffer: Buffer.from(lineContents) },
  ]);
  await page.getByRole("button", { name: "Import 2 files", exact: true }).click();
  await expect(page.getByText(/Processed locally: 2 saved/)).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Purchase orders", exact: true })).toBeVisible();
}

async function searchOrder(page: Page, value: string) {
  await page.getByRole("searchbox", { name: "Search purchase-order number", exact: true }).fill(value);
}

function orderButtons(page: Page) {
  return page.getByRole("table", { name: "Purchase orders", exact: true }).getByRole("button", { name: /^Open purchase order / });
}

async function expectMetric(page: Page, label: string, value: string) {
  // Metrics use semantic dt/dd pairs; select the sibling value, independent of
  // card styling or explanatory copy.
  const metric = page.locator('dl[aria-label="Archive overview"] dt').filter({ hasText: new RegExp(`^${label}$`) });
  await expect(metric.locator("..").locator("dd").first()).toHaveText(value);
}

test("an empty browser has useful import guidance and no sample orders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Purchase orders", exact: true })).toBeVisible();
  await expect(page.getByText(/No purchase orders yet|Your purchase history starts here|No saved purchase orders/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Import files/ }).first()).toHaveAttribute("href", "/import");
  await expect(page.getByText("PO-DEMO-001", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Open purchase order / })).toHaveCount(0);
  await expectMetric(page, "Total orders", "0");
  await expectMetric(page, "Observed suppliers", "0");
  await expectMetric(page, "Unique SKUs", "0");
});

test("real imports support persistent search, filters, sorting and bounded pagination", async ({ page }) => {
  await importArchive(page);
  await expectMetric(page, "Total orders", "60");
  await expectMetric(page, "Observed suppliers", "2");
  await expectMetric(page, "Unique SKUs", "22");
  await page.screenshot({ path: "test-results/dashboard-desktop.png", fullPage: true });
  const initialCount = await orderButtons(page).count();
  expect(initialCount).toBeGreaterThan(0);
  expect(initialCount).toBeLessThan(60);
  await page.getByRole("button", { name: "Sort by Purchase order", exact: true }).click();
  await expect(orderButtons(page).first()).toHaveAccessibleName(/PO-001/);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(orderButtons(page).first()).not.toHaveAccessibleName(/PO-001/);
  await searchOrder(page, "po-001");
  await expect(orderButtons(page)).toHaveCount(1);
  await expect(orderButtons(page).first()).toHaveAccessibleName(/PO-001/);
  await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();

  await searchOrder(page, "");
  await page.getByRole("button", { name: "Supplier filter", exact: true }).click();
  await page.getByRole("textbox", { name: "Search suppliers", exact: true }).fill("South");
  await page.getByRole("button", { name: "South Works", exact: true }).click();
  await page.getByLabel("Order date from", { exact: true }).fill("2026-01-02");
  await page.getByLabel("Order date to", { exact: true }).fill("2026-01-02");
  await expect(orderButtons(page)).toHaveCount(3);
  const table = page.getByRole("table", { name: "Purchase orders", exact: true });
  await expect(table.getByText("North & Co", { exact: true })).toHaveCount(0);
  await expect(table.getByText("South Works", { exact: true })).toHaveCount(3);
  await expect(table.getByText("2026-01-02", { exact: true })).toHaveCount(3);
  // Overview counts describe the saved archive, not the active table slice.
  await expectMetric(page, "Total orders", "60");

  await searchOrder(page, "does-not-exist");
  await expect(page.getByText(/No matching purchase orders|No orders match/)).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).first().click();
  await expect(orderButtons(page)).toHaveCount(initialCount);
  await page.reload();
  await expect(orderButtons(page)).toHaveCount(initialCount);
  await searchOrder(page, "PO-060");
  await expect(orderButtons(page)).toHaveCount(1);
});

test("detail drawer preserves missing states, exact source evidence and paged related lines on mobile", async ({ page }) => {
  await importArchive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await searchOrder(page, "PO-001");
  await expect(orderButtons(page)).toHaveCount(1);
  const results = page.getByRole("region", { name: "Purchase-order results", exact: true });
  await results.focus();
  await expect(results).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => results.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const trigger = orderButtons(page).first();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("PO-001", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard-mobile.png" });
  await expect(dialog.getByText("Not provided", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText(/Calculated.*not imported/).first()).toBeVisible();
  const importedFields = dialog.getByRole("region", { name: "Imported purchase-order fields", exact: true });
  await expect(importedFields.locator("dt").filter({ hasText: /^Total cost$/ }).locator("..").locator("dd")).toHaveText("0");
  await expect(importedFields.locator("dt").filter({ hasText: /^Outstanding quantity$/ }).locator("..").locator("dd")).toHaveText("Calculated · not imported");
  await expect(dialog.getByText("browser-orders.csv", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText(/CSV record 2/).first()).toBeVisible();
  await expect(dialog.getByText(/candidate|possible matches/i).first()).toBeVisible();
  await dialog.getByText("Inspect original cells", { exact: true }).click();
  await expect(dialog.getByText("Column 2 · PO Number", { exact: true })).toBeVisible();
  await dialog.getByText("Original CSV record", { exact: true }).click();
  await expect(dialog.locator("pre").filter({ hasText: '"provisional","PO-001","North & Co"' })).toBeVisible();
  await expect(dialog.getByText("<script>literal product</script>", { exact: true }).first()).toBeVisible();
  await expect(dialog.locator("script")).toHaveCount(0);
  await dialog.getByRole("button", { name: "View original line source", exact: true }).first().click();
  await expect(dialog.getByText("Column 4 · SKU", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Hide original line source", exact: true }).click();
  const firstPageSkus = await dialog.getByText(/^SKU-\d{2}$/).allTextContents();
  expect(firstPageSkus.length).toBeLessThanOrEqual(20);
  const nextLines = dialog.getByRole("button", { name: "Next lines", exact: true });
  await nextLines.click();
  await expect(nextLines).toBeDisabled();
  const lastPageSkus = await dialog.getByText(/^SKU-\d{2}$/).allTextContents();
  expect(lastPageSkus.length).toBeGreaterThan(0);
  expect(lastPageSkus.some((sku) => firstPageSkus.includes(sku))).toBe(false);
  expect(new Set([...firstPageSkus, ...lastPageSkus]).size).toBe(22);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("another tab updates the archive and a clamped last page still navigates backwards", async ({ page, context }) => {
  await importArchive(page);
  const importer = await context.newPage();
  await importer.goto("/import");
  const picker = importer.getByLabel("Select CSV or TSV files");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles({
    name: "browser-extra-orders.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(summaryContents.replaceAll("PO-", "EXTRA-")),
  });
  await importer.getByRole("button", { name: "Import 1 file", exact: true }).click();
  await expect(importer.getByText(/Processed locally: 1 saved/)).toBeVisible();
  // Read without reloading or focusing the dashboard: worker/tab commits must
  // invalidate its observed metadata and refresh its IndexedDB-backed queries.
  await expectMetric(page, "Total orders", "120");
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText(`Page ${index + 2} of 5`, { exact: true })).toBeVisible();
  }
  await importer.getByRole("button", { name: /^Remove browser-extra-orders\.csv, saved import \d+$/ }).click();
  await importer.getByRole("button", { name: "Yes, remove this import", exact: true }).click();
  await expectMetric(page, "Total orders", "60");
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  await expect(orderButtons(page)).toHaveCount(10);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(orderButtons(page)).toHaveCount(25);
  await importer.close();
});
