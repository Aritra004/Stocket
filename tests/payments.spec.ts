import { expect, test, type Page } from "@playwright/test";

test("payment route handlers load and reject GET without triggering provider operations", async ({ request }) => {
  for (const path of ["/api/payments/create-order", "/api/payments/verify", "/api/webhooks/razorpay", "/api/entitlements/status", "/api/entitlements/recovery/request", "/api/entitlements/recovery/redeem"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(405);
  }
});

type Status = "none" | "pending" | "active" | "revoked";
async function paymentFixture(page: Page, behavior: "success" | "cancel" | "failed" = "success") {
  const state = { status: "none" as Status, verifyStatus: "active" as Status, verifyError: false, createError: false, creates: [] as unknown[], verifies: [] as unknown[], recoveries: [] as unknown[], redeemed: [] as unknown[], statusRequests: 0, checkoutLoads: 0 };
  await page.context().route("**/api/entitlements/status", (route) => {
    state.statusRequests++;
    expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({ json: { status: state.status, mode: "test", ...(state.status === "active" ? { licenseId: "license_test" } : {}) } });
  });
  await page.route("**/api/payments/create-order", (route) => {
    state.creates.push(route.request().postDataJSON());
    return state.createError ? route.fulfill({ status: 503, json: { error: { code: "USD_NOT_ENABLED", message: "USD payments are not enabled. Checkout is unavailable." } } })
      : route.fulfill({ json: { keyId: "rzp_test_fixture", orderId: "order_fixture", amount: 1900, currency: "USD", mode: "test" } });
  });
  await page.route("**/api/payments/verify", (route) => {
    state.verifies.push(route.request().postDataJSON());
    if (state.verifyError) return route.fulfill({ status: 400, json: { error: { code: "INVALID_SIGNATURE", message: "Payment signature could not be verified." } } });
    state.status = state.verifyStatus;
    return route.fulfill({ json: { status: state.verifyStatus, mode: "test" } });
  });
  await page.route("**/api/entitlements/recovery/request", (route) => {
    state.recoveries.push(route.request().postDataJSON());
    return route.fulfill({ json: { message: "If an active license matches this email, a recovery link will be sent." } });
  });
  await page.route("**/api/entitlements/recovery/redeem", (route) => {
    state.redeemed.push(route.request().postDataJSON()); state.status = "active";
    return route.fulfill({ json: { status: "active", mode: "test", licenseId: "license_test" } });
  });
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) => {
    state.checkoutLoads++;
    return route.fulfill({ contentType: "application/javascript", body: `window.Razorpay = class {
      constructor(options) { this.options = options; window.__checkoutOptions = options; }
      on(name, callback) { this.failed = callback; }
      close() {}
      open() {
        if (${JSON.stringify(behavior)} === 'cancel') this.options.modal.ondismiss();
        else if (${JSON.stringify(behavior)} === 'failed') { this.failed(); this.options.modal.ondismiss(); }
        else this.options.handler({razorpay_order_id:'order_fixture',razorpay_payment_id:'pay_fixture',razorpay_signature:'a'.repeat(64),extraPrivateField:'never-forward-this'});
      }
    };` });
  });
  return state;
}
async function checkout(page: Page) {
  await page.goto("/unlock");
  await expect(page.getByRole("button", { name: "Pay $19 USD with Razorpay", exact: true })).toBeEnabled();
  await page.getByLabel("Email for license recovery", { exact: true }).fill("buyer@example.com");
  await page.getByRole("button", { name: "Pay $19 USD with Razorpay", exact: true }).click();
}

test("checkout unlocks only after server verification and uses the server's USD order", async ({ page }) => {
  const state = await paymentFixture(page);
  await checkout(page);
  await expect(page.getByText("License active", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to archive export" })).toHaveAttribute("href", "/quality");
  await expect(page.getByText(/Razorpay Test Mode/)).toBeVisible();
  expect(state.creates).toEqual([{ email: "buyer@example.com" }]);
  expect(state.verifies).toEqual([{ razorpay_order_id: "order_fixture", razorpay_payment_id: "pay_fixture", razorpay_signature: "a".repeat(64) }]);
  const options = await page.evaluate(() => {
    const value = (window as unknown as { __checkoutOptions: { amount: number; currency: string; order_id: string; notes?: unknown; subscription_id?: unknown; recurring?: unknown } }).__checkoutOptions;
    return { amount: value.amount, currency: value.currency, orderId: value.order_id, notes: value.notes ?? null, subscription: value.subscription_id ?? null, recurring: value.recurring ?? null };
  });
  expect(options).toEqual({ amount: 1900, currency: "USD", orderId: "order_fixture", notes: null, subscription: null, recurring: null });
  expect(state.statusRequests).toBeGreaterThanOrEqual(2);
});

test("uncaptured or delayed confirmation stays pending until a fresh server status becomes active", async ({ page }) => {
  const state = await paymentFixture(page); state.verifyStatus = "pending";
  await checkout(page);
  await expect(page.getByText(/Payment confirmation is pending/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to archive export" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pay $19 USD with Razorpay", exact: true })).toBeDisabled();
  state.status = "active";
  await page.getByRole("button", { name: "Check payment status", exact: true }).click();
  await expect(page.getByText("License active", { exact: true })).toBeVisible();
  expect(state.creates).toHaveLength(1);
});

for (const behavior of ["cancel", "failed"] as const) {
  test(`${behavior === "cancel" ? "cancelled checkout" : "failed payment"} keeps export locked and offers status checking`, async ({ page }) => {
    const state = await paymentFixture(page, behavior);
    await checkout(page);
    await expect(page.getByText(behavior === "cancel" ? /Checkout closed\. Access has not been granted/ : /Payment was not completed/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to archive export" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
    expect(state.verifies).toEqual([]);
    await page.reload();
    await expect(page.getByRole("button", { name: "Pay $19 USD with Razorpay", exact: true })).toBeEnabled();
    await page.getByLabel("Email for license recovery", { exact: true }).fill("buyer@example.com");
    await page.getByRole("button", { name: "Pay $19 USD with Razorpay", exact: true }).click();
    await expect(page.getByText(behavior === "cancel" ? /Checkout closed\. Access has not been granted/ : /Payment was not completed/)).toBeVisible();
    expect(state.creates).toHaveLength(2);
    expect(await page.evaluate(() => (window as unknown as { __checkoutOptions: { order_id: string } }).__checkoutOptions.order_id)).toBe("order_fixture");
  });
}

test("invalid callback signature cannot unlock and USD configuration failure never substitutes a currency", async ({ page }) => {
  const state = await paymentFixture(page); state.verifyError = true;
  await checkout(page);
  await expect(page.locator("main").getByRole("alert")).toContainText("signature could not be verified");
  await expect(page.getByRole("link", { name: "Go to archive export" })).toHaveCount(0);
  state.createError = true;
  await page.reload();
  await page.getByLabel("Email for license recovery", { exact: true }).fill("buyer@example.com");
  await expect(page.getByRole("button", { name: "Pay $19 USD with Razorpay", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pay $19 USD with Razorpay", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("USD payments are not enabled");
  expect(state.checkoutLoads).toBe(1);
});

test("recovery uses an expiring email link fragment and an explicit redeem action", async ({ page }) => {
  const state = await paymentFixture(page);
  await page.goto("/unlock");
  await page.getByLabel("Purchase email", { exact: true }).fill("buyer@example.com");
  await expect(page.getByRole("button", { name: "Email recovery link" })).toBeEnabled();
  await page.getByRole("button", { name: "Email recovery link" }).click();
  await expect(page.getByText(/If an active license matches this email/)).toBeVisible();
  expect(state.recoveries).toEqual([{ email: "buyer@example.com" }]);
  await page.getByLabel("Order reference (optional)", { exact: true }).fill("order_older");
  await page.getByRole("button", { name: "Email recovery link" }).click();
  await expect.poll(() => state.recoveries.length).toBe(2);
  expect(state.recoveries[1]).toEqual({ email: "buyer@example.com", orderId: "order_older" });
  const token = "R".repeat(43);
  await page.goto(`/recover#token=${token}`);
  await expect(page).toHaveURL(/\/recover$/);
  expect(state.redeemed).toEqual([]);
  await page.getByRole("button", { name: "Recover license in this browser" }).click();
  await expect(page.getByText("License recovered and verified.", { exact: true })).toBeVisible();
  expect(state.redeemed).toEqual([{ token }]);
  expect(state.checkoutLoads).toBe(0);
});

test("unpaid export stays disabled and a revoked license is checked again before worker generation", async ({ page }) => {
  const state = await paymentFixture(page);
  await page.goto("/import");
  await page.getByLabel("Select CSV or TSV files").setInputFiles({ name: "local-only.csv", mimeType: "text/csv", buffer: Buffer.from("__stocky_rescue_po_summary_v1,PO Number,Supplier\nprovisional,PRIVATE-PO,PRIVATE-SUPPLIER\n") });
  await page.getByRole("button", { name: "Import 1 file", exact: true }).click();
  await expect(page.getByText(/Processed locally: 1 saved/)).toBeVisible();
  await page.goto("/quality");
  await expect(page.getByRole("button", { name: "Export offline ZIP", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Unlock archive or recover license" })).toBeVisible();
  state.status = "active";
  await page.reload();
  await expect(page.getByRole("button", { name: "Export offline ZIP", exact: true })).toBeEnabled();
  state.status = "revoked";
  let downloads = 0; page.on("download", () => downloads++);
  await page.getByRole("button", { name: "Export offline ZIP", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("license is no longer active");
  expect(downloads).toBe(0);
  expect(state.creates).toEqual([]);
  expect(state.checkoutLoads).toBe(0);
});
