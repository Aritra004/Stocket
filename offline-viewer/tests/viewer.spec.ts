import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { buildOfflineViewer } from "../build";
import type { OfflineArchive } from "../types";
import { archiveFixture, archiveOfKind, emptyArchive, paginatedArchive, LITERAL_PAYLOAD, PRECISE_COST, PRECISE_QUANTITY, UNICODE_SKU } from "./fixtures";

let temporaryRoot = "";
let artifacts: { mixed: string; copied: string; summaries: string; lines: string; empty: string; unicode: string; paginated: string };
const LONG_ORIGINAL = "a".repeat(1999) + "🚚b";

test.beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "stocky-offline-browser-"));
  async function build(name: string, archive: OfflineArchive) {
    const input = join(temporaryRoot, `${name}.json`);
    await writeFile(input, JSON.stringify(archive), "utf8");
    return buildOfflineViewer(input, join(temporaryRoot, name));
  }
  const unicodeArchive = archiveFixture();
  unicodeArchive.sources[0].rawText = LONG_ORIGINAL;
  const [mixed, summaries, lines, empty, unicode, paginated] = await Promise.all([
    build("mixed", archiveFixture()), build("summaries", archiveOfKind("purchase-order-summary")),
    build("lines", archiveOfKind("purchase-order-line-item")), build("empty", emptyArchive()),
    build("unicode", unicodeArchive), build("paginated", paginatedArchive()),
  ]);
  const portableDirectory = join(temporaryRoot, "copied-alone");
  await mkdir(portableDirectory);
  const copied = join(portableDirectory, "My portable archive #1.html");
  await copyFile(mixed, copied);
  expect(await readdir(portableDirectory)).toEqual([basename(copied)]);
  artifacts = { mixed, copied, summaries, lines, empty, unicode, paginated };
});

test.afterAll(async () => {
  // Only remove the exact task-owned temporary directory created above.
  if (temporaryRoot && dirname(resolve(temporaryRoot)).toLowerCase() === resolve(tmpdir()).toLowerCase() && basename(temporaryRoot).startsWith("stocky-offline-browser-")) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function openOffline(page: Page, file: string) {
  const url = pathToFileURL(file).href;
  const requests: Array<{ url: string; type: string }> = [];
  const blocked: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => requests.push({ url: request.url(), type: request.resourceType() }));
  page.on("pageerror", (error) => errors.push(error.message));
  // The context is offline as well. This guard also blocks accidental file://
  // sibling dependencies, making the single-document requirement explicit.
  await page.route("**/*", async (route) => {
    if (route.request().isNavigationRequest() && route.request().url() === url) await route.continue();
    else { blocked.push(route.request().url()); await route.abort(); }
  });
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Purchase orders", exact: true })).toBeVisible();
  return () => {
    expect(errors).toEqual([]);
    expect(blocked).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.url === url && request.type === "document")).toBe(true);
  };
}

function orderButtons(page: Page) {
  return page.getByRole("table", { name: "Purchase orders", exact: true }).getByRole("button", { name: /^Open purchase order / });
}

async function selectExactSupplier(page: Page, supplier: string) {
  const filter = page.getByLabel("Filter by supplier", { exact: true });
  const key = await filter.locator("option").evaluateAll((options, name) => options.find((option) => option.textContent === name)?.getAttribute("value"), supplier);
  expect(key).toBeTruthy();
  await filter.selectOption(key!);
}

test("a copied and renamed HTML alone supports order search and exact supplier filters offline", async ({ page }) => {
  const assertOffline = await openOffline(page, artifacts.copied);
  await expect(orderButtons(page)).toHaveCount(5);
  await page.getByLabel("Search purchase orders", { exact: true }).fill("po-002");
  await expect(orderButtons(page)).toHaveCount(1);
  await expect(orderButtons(page)).toHaveAccessibleName(/PO-002/);
  await page.getByLabel("Search purchase orders", { exact: true }).fill("");
  for (const [supplier, order] of [["Harbor & Co", "PO-001"], ["harbor & co", "PO-002"], [" Harbor & Co ", "PO-003"], ["__proto__", "PO-005"]]) {
    await selectExactSupplier(page, supplier);
    await expect(orderButtons(page)).toHaveCount(1);
    await expect(orderButtons(page)).toHaveAccessibleName(new RegExp(order));
  }
  await page.getByLabel("Filter by supplier", { exact: true }).selectOption("missing");
  await expect(orderButtons(page)).toHaveCount(1);
  await expect(orderButtons(page)).toHaveAccessibleName(/PO-004/);
  await orderButtons(page).click();
  await expect(page.getByText("Not provided", { exact: true }).first()).toBeVisible();
  await page.getByText("View source evidence", { exact: true }).first().click();
  await expect(page.getByText("orders-<&>.csv", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Data row 4.*CSV record 5/).first()).toBeVisible();
  await page.getByRole("button", { name: /Back to purchase orders$/ }).click();
  await page.getByLabel("Filter by supplier", { exact: true }).selectOption("all");
  await page.getByLabel("Search purchase orders", { exact: true }).fill("not-present");
  await expect(orderButtons(page)).toHaveCount(0);
  await page.getByLabel("Search purchase orders", { exact: true }).fill("PO-001");
  await orderButtons(page).click();
  await expect(page.getByRole("button", { name: "00123", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "00123", exact: true }).click();
  await expect(page.getByRole("table", { name: "SKU purchase costs", exact: true })).toBeVisible();
  assertOffline();
});

test("SKU history preserves leading zeros, currencies, exact decimals and absent amounts", async ({ page }) => {
  const assertOffline = await openOffline(page, artifacts.mixed);
  await page.getByRole("button", { name: "SKUs", exact: true }).click();
  const directory = page.getByRole("table", { name: "SKU directory", exact: true });
  await expect(directory.getByRole("row")).toHaveCount(5);
  for (const sku of ["00123", "123", "__proto__", UNICODE_SKU]) await expect(directory.getByRole("button", { name: sku, exact: true })).toHaveCount(1);
  await page.getByLabel("Search SKU identifiers", { exact: true }).fill("00123");
  await expect(directory.getByRole("row")).toHaveCount(2);
  await directory.getByRole("button", { name: "00123", exact: true }).click();
  const history = page.getByRole("table", { name: "SKU purchase costs", exact: true });
  await expect(history.getByRole("row")).toHaveCount(4);
  await expect(history.getByText(PRECISE_COST, { exact: true })).toBeVisible();
  await expect(history.getByText(PRECISE_QUANTITY, { exact: true })).toBeVisible();
  await expect(history.getByText("USD", { exact: true })).toBeVisible();
  await expect(history.getByText("INR", { exact: true })).toBeVisible();
  const zero = history.getByRole("row").filter({ hasText: "PO-001" });
  await expect(zero.getByRole("cell").filter({ hasText: /^0$/ })).toHaveCount(3);
  const absent = history.getByRole("row").filter({ hasText: "PO-004" });
  await expect(absent.getByText("Not provided", { exact: true })).toHaveCount(6);
  await expect(history.getByRole("row").filter({ hasText: "PO-003" })).toHaveCount(0);
  await history.getByRole("row").filter({ hasText: "PO-002" }).getByRole("button", { name: "View line details", exact: true }).click();
  await expect(page.getByText("Precise product", { exact: true })).toBeVisible();
  await page.getByText("View source evidence", { exact: true }).first().click();
  await expect(page.getByText(PRECISE_QUANTITY, { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: /Open purchase order PO-002/ })).toBeVisible();
  await page.getByRole("button", { name: /Open purchase order PO-002/ }).click();
  await expect(page.getByRole("button", { name: /Back to purchase orders$/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "offline-viewer/test-results/offline-order-mobile.png", fullPage: true });
  assertOffline();
});

test("embedded HTML-like text and prototype-named identifiers remain inert through source and quality views", async ({ page }) => {
  const assertOffline = await openOffline(page, artifacts.copied);
  const html = await readFile(artifacts.copied, "utf8");
  expect(html).not.toContain('</script><script>globalThis.__offlineInjected=1');
  expect(html).toContain("\\u003c/script\\u003e");
  await page.getByRole("button", { name: "SKUs", exact: true }).click();
  await page.getByRole("table", { name: "SKU directory", exact: true }).getByRole("button", { name: "__proto__", exact: true }).click();
  await expect(page.getByRole("table", { name: "SKU purchase costs", exact: true }).getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: /Back to SKUs$/ }).click();
  await page.getByRole("table", { name: "SKU directory", exact: true }).getByRole("button", { name: UNICODE_SKU, exact: true }).click();
  await page.getByRole("button", { name: "View line details", exact: true }).click();
  await expect.poll(() => page.getByText(LITERAL_PAYLOAD, { exact: true }).textContent()).toBe(LITERAL_PAYLOAD);
  await page.getByText("View source evidence", { exact: true }).first().click();
  await expect(page.getByText("2026-02-30", { exact: true })).toBeVisible();
  await expect(page.locator("img, iframe, object, embed, script[src], link[href]")).toHaveCount(0);
  await expect(page.locator("script")).toHaveCount(2);
  expect(await page.evaluate(() => "__offlineInjected" in window)).toBe(false);
  await page.getByRole("button", { name: "Data quality", exact: true }).click();
  await expect(page.getByRole("table", { name: "Import quality by file", exact: true }).getByRole("row")).toHaveCount(3);
  const findings = page.getByRole("table", { name: "Quality findings", exact: true });
  await expect(findings.getByRole("row")).toHaveCount(3);
  const invalid = findings.getByRole("row").filter({ hasText: "The recorded date 2026-02-30 is invalid" });
  await invalid.getByText("View source evidence", { exact: true }).click();
  await expect(invalid.getByText("2026-02-30", { exact: true })).toBeVisible();
  await expect.poll(() => invalid.getByText(LITERAL_PAYLOAD, { exact: true }).textContent()).toBe(LITERAL_PAYLOAD);
  expect(await page.evaluate(() => "__offlineInjected" in window)).toBe(false);
  assertOffline();
});

test("summary-only artifacts stay usable without invented SKUs", async ({ page }) => {
  const assertSummariesOffline = await openOffline(page, artifacts.summaries);
  await expect(orderButtons(page)).toHaveCount(5);
  await page.getByRole("button", { name: "SKUs", exact: true }).click();
  await expect(page.getByRole("table", { name: "SKU directory", exact: true })).toHaveCount(0);
  await expect(page.getByText(/No .*SKU|Summary-only/i).first()).toBeVisible();
  assertSummariesOffline();
});

test("line-only artifacts expose SKU history without purchase-order summaries", async ({ page }) => {
  const assertOffline = await openOffline(page, artifacts.lines);
  await expect(orderButtons(page)).toHaveCount(0);
  await page.getByRole("button", { name: "SKUs", exact: true }).click();
  await page.getByRole("table", { name: "SKU directory", exact: true }).getByRole("button", { name: "00123", exact: true }).click();
  await expect(page.getByRole("table", { name: "SKU purchase costs", exact: true }).getByRole("row")).toHaveCount(4);
  assertOffline();
});

test("empty artifacts provide honest empty views without network access", async ({ page }) => {
  const assertOffline = await openOffline(page, artifacts.empty);
  await expect(orderButtons(page)).toHaveCount(0);
  await page.getByRole("button", { name: "SKUs", exact: true }).click();
  await expect(page.getByRole("table", { name: "SKU directory", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Data quality", exact: true }).click();
  await expect(page.getByRole("table", { name: "Quality findings", exact: true })).toHaveCount(0);
  await expect(page.getByText(/No .*findings|No .*imports|No .*files/i).first()).toBeVisible();
  assertOffline();
});

test("original-text pagination keeps a surrogate-pair character intact at its boundary", async ({ page }) => {
  const assertOffline = await openOffline(page, artifacts.unicode);
  await page.getByLabel("Search purchase orders", { exact: true }).fill("PO-001");
  await orderButtons(page).click();
  const detail = page.getByRole("region", { name: "Purchase-order detail", exact: true });
  await detail.getByText("View source evidence", { exact: true }).click();
  await detail.getByText("Original CSV record", { exact: true }).click();
  const original = detail.locator("pre");
  await expect(original).toHaveText("a".repeat(1999));
  const first = await original.textContent();
  await detail.getByRole("button", { name: "Next text sections", exact: true }).click();
  await expect(original).toHaveText("🚚b");
  expect(first! + await original.textContent()).toBe(LONG_ORIGINAL);
  await expect(detail.getByRole("button", { name: "Next text sections", exact: true })).toBeDisabled();
  await detail.getByRole("button", { name: "Previous text sections", exact: true }).click();
  await expect(original).toHaveText("a".repeat(1999));
  assertOffline();
});

test("bounded order and SKU-history pages retain every record and reset after searching", async ({ page }) => {
  const assertOffline = await openOffline(page, artifacts.paginated);
  await expect(orderButtons(page)).toHaveCount(25);
  await page.getByRole("button", { name: "Next purchase orders", exact: true }).click();
  await expect(orderButtons(page)).toHaveCount(6);
  await expect(orderButtons(page).first()).toHaveAccessibleName(/PAGE-026/);
  await page.getByLabel("Search purchase orders", { exact: true }).fill("PAGE-001");
  await expect(orderButtons(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Previous purchase orders", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "SKUs", exact: true }).click();
  await page.getByRole("button", { name: "PAGED-SKU", exact: true }).click();
  const history = page.getByRole("table", { name: "SKU purchase costs", exact: true });
  await expect(history.getByRole("row")).toHaveCount(26);
  const firstPageOrders = await history.getByRole("row").evaluateAll((rows) => rows.slice(1).map((row) => row.textContent?.match(/PAGE-\d{3}/)?.[0]));
  await page.getByRole("button", { name: "Next SKU history lines", exact: true }).click();
  await expect(history.getByRole("row")).toHaveCount(7);
  const finalPageOrders = await history.getByRole("row").evaluateAll((rows) => rows.slice(1).map((row) => row.textContent?.match(/PAGE-\d{3}/)?.[0]));
  expect(new Set([...firstPageOrders, ...finalPageOrders]).size).toBe(31);
  expect([...firstPageOrders, ...finalPageOrders]).not.toContain(undefined);
  await expect(page.getByRole("button", { name: "Next SKU history lines", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous SKU history lines", exact: true }).click();
  await expect(history.getByRole("row")).toHaveCount(26);
  assertOffline();
});
