import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import type { PaymentConfig } from "./config";
import { createPaymentHandlers } from "./http";
import type { PaymentGateway, ProviderOrder, ProviderPayment, RecoveryMailer } from "./provider-types";
import type { CheckoutSession, PaymentApplication, PaymentObservation, PaymentRepository } from "./repository-types";
import { opaqueToken, tokenHash } from "./security";
import { PaymentService } from "./service";

const config: PaymentConfig = {
  mode: "test", appUrl: "https://stocky.example.test", keyId: "rzp_test_example", keySecret: "checkout-secret-for-tests",
  webhookSecret: "webhook-secret-for-tests", tokenPepper: "token-pepper-for-tests-only-32-characters", supabaseUrl: "https://db.example.test",
  serviceRoleKey: "fake-test-service-key", usdEnabled: true, liveEnabled: false, emailApiKey: "fake-test-email-key", emailFrom: "license@example.test",
};
const email = "owner@example.test";

class MemoryRepository implements PaymentRepository {
  sessions = new Map<string, CheckoutSession>();
  observations: PaymentObservation[] = [];
  eventIds = new Set<string>();
  recovery = new Map<string, { sessionId: string; expires: number }>();
  limited = false;
  async reserveCheckout(input: { mode: "test" | "live"; tokenHash: string; email: string }) {
    const old = await this.getSession(input.tokenHash, input.mode);
    if (old) return { session: old, created: false };
    const now = new Date().toISOString();
    const session: CheckoutSession = { id: randomUUID(), mode: input.mode, token_hash: input.tokenHash, email: input.email, amount: 1900, currency: "USD", razorpay_order_id: null, status: "creating", session_expires_at: new Date(Date.now() + 86400_000).toISOString(), created_at: now, updated_at: now };
    this.sessions.set(session.id, session);
    return { session, created: true };
  }
  async saveOrder(id: string, mode: "test" | "live", order: string) { const session = this.sessions.get(id)!; assert.equal(session.mode, mode); session.razorpay_order_id = order; session.status = "pending"; return session; }
  async getSession(hash: string, mode: "test" | "live") { return [...this.sessions.values()].find((row) => row.token_hash === hash && row.mode === mode && Date.parse(row.session_expires_at) > Date.now()) ?? null; }
  async getSessionByOrder(order: string, mode: "test" | "live") { return [...this.sessions.values()].find((row) => row.razorpay_order_id === order && row.mode === mode) ?? null; }
  async applyPayment(input: PaymentObservation): Promise<PaymentApplication> {
    const session = await this.getSessionByOrder(input.orderId, input.mode);
    if (!session) throw new Error("Unknown order");
    const duplicate = Boolean(input.eventId && this.eventIds.has(input.eventId));
    if (!duplicate) {
      this.observations.push(input);
      if (input.eventId) this.eventIds.add(input.eventId);
      if (input.status === "refunded" || input.status === "disputed") { session.status = "revoked"; session.entitlement_status = input.status; }
      else if (input.status === "captured" && session.status !== "revoked") { session.status = "paid"; session.entitlement_status = "active"; session.entitlement_id ??= randomUUID(); }
    }
    return { duplicate, entitlement_id: session.entitlement_id ?? null, entitlement_status: session.entitlement_status ?? null };
  }
  async issueRecovery(address: string, mode: "test" | "live", hash: string, expires: string, orderId?: string) {
    const session = [...this.sessions.values()].find((row) => row.email === address && row.mode === mode && row.entitlement_status === "active" && (!orderId || row.razorpay_order_id === orderId));
    if (!session) return false;
    this.recovery.set(hash, { sessionId: session.id, expires: Date.parse(expires) }); return true;
  }
  async redeemRecovery(hash: string, mode: "test" | "live", replacement: string) {
    const entry = this.recovery.get(hash);
    if (!entry || entry.expires <= Date.now()) return null;
    const session = this.sessions.get(entry.sessionId)!;
    if (session.mode !== mode || session.entitlement_status !== "active") return null;
    this.recovery.delete(hash); session.token_hash = replacement; return session;
  }
  async rateLimit() { return !this.limited; }
}

function fixture(overrides: Partial<PaymentConfig> = {}) {
  const repository = new MemoryRepository();
  let creates = 0;
  let fetches = 0;
  const orders: ProviderOrder[] = [];
  const payments = new Map<string, ProviderPayment>();
  const sent: Array<{ email: string; link: string }> = [];
  const gateway: PaymentGateway = {
    async createOrder(receipt) { creates++; const order = { id: `order_${creates}`, amount: 1900, currency: "USD", receipt, status: "created" }; orders.push(order); return order; },
    async findOrders(receipt) { return orders.filter((order) => order.receipt === receipt); },
    async fetchPayment(id) { fetches++; if (!payments.has(id)) throw new Error("provider detail must never leak"); return payments.get(id)!; },
    async orderPayments(id) { return [...payments.values()].filter((payment) => payment.order_id === id); },
  };
  const mailer: RecoveryMailer = { async send(address, link) { sent.push({ email: address, link }); } };
  const service = new PaymentService({ ...config, ...overrides }, repository, gateway, mailer);
  const token = opaqueToken();
  const hash = tokenHash(token, config.tokenPepper);
  async function ready() { const order = await service.createOrder(hash, email); assert.ok("orderId" in order && typeof order.orderId === "string"); return order.orderId; }
  function payment(order: string, status = "captured"): ProviderPayment { const value = { id: `pay_${payments.size + 1}`, order_id: order, amount: 1900, currency: "USD", status, captured: status === "captured", amount_refunded: 0 }; payments.set(value.id, value); return value; }
  function confirmation(value: ProviderPayment) { return { razorpay_order_id: value.order_id!, razorpay_payment_id: value.id, razorpay_signature: createHmac("sha256", config.keySecret).update(`${value.order_id}|${value.id}`).digest("hex") }; }
  function webhook(value: ProviderPayment, event = "payment.captured") {
    const raw = new TextEncoder().encode(JSON.stringify({ event, payload: { payment: { entity: value }, order: { entity: { id: value.order_id } } } }));
    return { raw, signature: createHmac("sha256", config.webhookSecret).update(raw).digest("hex") };
  }
  return { repository, gateway, service, token, hash, ready, payment, confirmation, webhook, sent, mailer, orders, payments, get creates() { return creates; }, get fetches() { return fetches; } };
}

test("orders use the configured server price, reject disabled USD/live and reuse a session order", async () => {
  const f = fixture();
  const first = await f.service.createOrder(f.hash, email);
  const second = await f.service.createOrder(f.hash, email);
  assert.deepEqual(first, second); assert.equal(f.creates, 1);
  assert.equal("amount" in first && first.amount, 1900); assert.equal("currency" in first && first.currency, "USD");
  await assert.rejects(fixture({ usdEnabled: false }).ready(), /USD checkout is unavailable/);
  await assert.rejects(fixture({ mode: "live", liveEnabled: false }).ready(), /Live payments have not been enabled/);
});

test("captured payment requires a valid signature and trusted API amount/order before one license becomes active", async () => {
  const f = fixture(); const order = await f.ready(); const payment = f.payment(order);
  assert.equal((await f.service.verify(f.hash, f.confirmation(payment))).status, "active");
  const license = (await f.service.status(f.hash)).licenseId;
  await f.service.verify(f.hash, f.confirmation(payment));
  assert.equal((await f.service.status(f.hash)).licenseId, license);
  assert.equal((await f.service.createOrder(f.hash, email) as { status: string }).status, "active");
  assert.equal(f.creates, 1); assert.equal(f.repository.sessions.size, 1);
});

test("invalid signature, callback replay across sessions, amount mismatch and currency mismatch never grant access", async () => {
  const f = fixture(); const order = await f.ready(); const payment = f.payment(order); const valid = f.confirmation(payment);
  await assert.rejects(f.service.verify(f.hash, { ...valid, razorpay_signature: "0".repeat(64) }), /could not be verified/);
  assert.equal(f.fetches, 0); assert.equal(f.repository.observations.length, 0);
  const otherHash = tokenHash(opaqueToken(), config.tokenPepper); await f.service.createOrder(otherHash, "other@example.test");
  await assert.rejects(f.service.verify(otherHash, valid), /could not be verified/);
  payment.amount = 1; await assert.rejects(f.service.verify(f.hash, valid), /amount or currency/);
  payment.amount = 1900; payment.currency = "INR"; await assert.rejects(f.service.verify(f.hash, valid), /amount or currency/);
  assert.equal(f.repository.observations.length, 0);
});

test("authorized payments remain pending; canceled/failed attempts remain retryable on the same order after reload", async () => {
  const f = fixture(); const order = await f.ready();
  assert.equal((await f.service.status(f.hash)).status, "none", "Cancellation/no attempt can retry");
  const payment = f.payment(order, "failed");
  assert.equal((await f.service.status(f.hash)).status, "none");
  assert.deepEqual(await f.service.createOrder(f.hash, email), { keyId: config.keyId, orderId: order, amount: 1900, currency: "USD", mode: "test" });
  payment.status = "authorized";
  assert.equal((await f.service.verify(f.hash, f.confirmation(payment))).status, "pending");
  assert.equal((await f.service.status(f.hash)).status, "pending");
  assert.equal(f.creates, 1); assert.ok(![...f.repository.sessions.values()][0].entitlement_id);
});

test("a timed-out create reconciles the exact receipt and never blindly creates a replacement order", async () => {
  const f = fixture(); const original = f.gateway.createOrder;
  f.gateway.createOrder = async (receipt) => { await original(receipt); throw new Error("network timeout after provider accepted"); };
  await assert.rejects(f.ready(), /could not be confirmed/);
  assert.equal(f.creates, 1);
  assert.equal((await f.service.status(f.hash)).status, "none");
  assert.equal((await f.service.createOrder(f.hash, email) as { orderId: string }).orderId, "order_1");
  assert.equal(f.creates, 1);
});

test("signed duplicate and delayed webhooks plus order.paid cannot create duplicate entitlements; polling reconciles a lost callback", async () => {
  const f = fixture(); const order = await f.ready(); const payment = f.payment(order); const event = f.webhook(payment);
  await f.service.webhook(event.raw, event.signature, "evt_capture");
  const license = (await f.service.status(f.hash)).licenseId;
  await f.service.webhook(event.raw, event.signature, "evt_capture");
  const paid = f.webhook(payment, "order.paid"); await f.service.webhook(paid.raw, paid.signature, "evt_orderpaid");
  assert.equal((await f.service.status(f.hash)).licenseId, license);
  const delayed = fixture(); const delayedOrder = await delayed.ready(); delayed.payment(delayedOrder);
  assert.equal((await delayed.service.status(delayed.hash)).status, "active", "Trusted polling covers a lost callback/delayed webhook");
});

test("bad webhook signatures consume no database writes and signed uncaptured notices never grant", async () => {
  const f = fixture(); const payment = f.payment(await f.ready(), "authorized"); const event = f.webhook(payment);
  await assert.rejects(f.service.webhook(event.raw, "0".repeat(64), "evt_bad"), /signature verification failed/);
  assert.equal(f.fetches, 0); assert.equal(f.repository.eventIds.size, 0);
  await assert.rejects(f.service.webhook(event.raw, event.signature, "evt_uncaptured"), /capture is not yet confirmed/);
  assert.equal(f.repository.observations.length, 0);
});

test("refunds and chargebacks revoke future access without a delayed capture reactivating it", async () => {
  for (const type of ["refund.processed", "payment.dispute.created", "payment.dispute.lost"]) {
    const f = fixture(); const payment = f.payment(await f.ready()); await f.service.verify(f.hash, f.confirmation(payment));
    const revoke = f.webhook(payment, type); await f.service.webhook(revoke.raw, revoke.signature, `evt_${type.replaceAll(".", "_")}`);
    const capture = f.webhook(payment); await f.service.webhook(capture.raw, capture.signature, "evt_late");
    assert.equal((await f.service.status(f.hash)).status, "revoked");
  }
});

test("recovery emails contain an expiring fragment token; one redemption transfers the license and rejects token replay", async () => {
  const f = fixture(); const payment = f.payment(await f.ready()); await f.service.verify(f.hash, f.confirmation(payment));
  await f.service.requestRecovery(email, payment.order_id!);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].email, email);
  const url = new URL(f.sent[0].link); assert.equal(url.search, ""); assert.equal(url.pathname, "/recover");
  const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
  assert.ok(![...f.repository.recovery.keys()].includes(token), "Only a hash is persisted");
  const fresh = opaqueToken(); assert.equal((await f.service.redeemRecovery(token, fresh)).status, "active");
  assert.equal((await f.service.status(f.hash)).status, "none");
  assert.equal((await f.service.status(tokenHash(fresh, config.tokenPepper))).status, "active");
  await assert.rejects(f.service.redeemRecovery(token, opaqueToken()), /invalid, expired, already used/);
});

test("HTTP adapters set only HttpOnly session cookies, reject unexpected financial/import fields, fail closed and keep errors private", async () => {
  const f = fixture(); const handlers = createPaymentHandlers(f.service);
  const request = (body: unknown, cookie?: string) => new Request(`${config.appUrl}/api/payments/create-order`, { method: "POST", headers: { Origin: config.appUrl, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const anonymous = await handlers.status(request({}));
  assert.equal((await anonymous.json()).status, "none"); assert.equal(anonymous.headers.get("set-cookie"), null);
  for (const extra of [{ amount: 1 }, { currency: "INR" }, { filename: "private.csv" }, { supplier: "private" }]) assert.equal((await handlers.createOrder(request({ email, ...extra }))).status, 400);
  const created = await handlers.createOrder(request({ email }));
  assert.equal(created.status, 200); assert.match(created.headers.get("set-cookie")!, /^__Host-stocky_session=.*HttpOnly; SameSite=Strict;.*Secure$/);
  assert.equal(created.headers.get("cache-control"), "private, no-store, max-age=0");
  const cookie = created.headers.get("set-cookie")!.split(";")[0]; const order = (await created.json()).orderId;
  const payment = f.payment(order); f.gateway.fetchPayment = async () => { throw new Error("provider-secret-and-email@example.test"); };
  const failed = await handlers.verify(request(f.confirmation(payment), cookie)); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /provider-secret|email@example/);
  assert.equal((await handlers.verify(request(f.confirmation(payment)))).status, 401);
  f.repository.limited = true; assert.equal((await handlers.status(request({}))).status, 429);
});

test("recovery email send failures and unknown addresses have the same public response", async () => {
  const f = fixture(); const payment = f.payment(await f.ready()); await f.service.verify(f.hash, f.confirmation(payment));
  f.mailer.send = async () => { throw new Error("provider sensitive details"); };
  const handlers = createPaymentHandlers(f.service);
  const request = (address: string) => new Request(`${config.appUrl}/api/entitlements/recovery/request`, { method: "POST", headers: { Origin: config.appUrl, "Content-Type": "application/json" }, body: JSON.stringify({ email: address }) });
  const known = await handlers.requestRecovery(request(email)); const unknown = await handlers.requestRecovery(request("unknown@example.test"));
  assert.equal(known.status, 200); assert.equal(unknown.status, 200); assert.deepEqual(await known.json(), await unknown.json());
});
