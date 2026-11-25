import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

let db: PGlite;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const email = "owner@example.test";

before(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../../../supabase/migrations/202611250001_payments.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await db.exec("truncate public.license_recovery_tokens, public.entitlements, public.payments, public.webhook_events, public.checkout_sessions, public.payment_rate_limits cascade;");
});
after(async () => { await db?.close(); });

async function rpc<T = Record<string, unknown>>(name: string, args: unknown[]): Promise<T> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
  const result = await db.query<{ value: T }>(`select public.${name}(${placeholders}) as value`, args);
  return result.rows[0].value;
}

interface Session { id: string; mode: string; token_hash: string; status: string; entitlement_status?: string; entitlement_id?: string }
async function checkout(label = "owner", mode = "test", order = "order_One") {
  const reserved = await rpc<{ session: Session; created: boolean }>("shr_reserve_checkout", [mode, hash(label), email]);
  await rpc("shr_save_order", [reserved.session.id, mode, order]);
  return reserved.session;
}

async function payment(status: string, event = "evt_capture", order = "order_One", id = "pay_One", amount = 1900, mode = "test", body = hash(event)) {
  return rpc<{ duplicate: boolean; entitlement_status: string | null; entitlement_id: string | null }>("shr_apply_payment", [mode, order, id, status, amount, "USD", event, `payment.${status}`, body]);
}
async function count(table: string) {
  return Number((await db.query<{ count: number }>(`select count(*) as count from public.${table}`)).rows[0].count);
}

test("migration limits data access to service-role functions and defines no CSV storage", async () => {
  const tables = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname in ('checkout_sessions','payments','entitlements','webhook_events','license_recovery_tokens','payment_rate_limits') order by relname");
  assert.equal(tables.rows.length, 6);
  assert.ok(tables.rows.every((table) => table.relrowsecurity));
  for (const role of ["anon", "authenticated"]) {
    for (const table of tables.rows) {
      const privileges = await db.query<{ permitted: boolean }>("select has_table_privilege($1, $2, 'SELECT') as permitted", [role, `public.${table.relname}`]);
      assert.equal(privileges.rows[0].permitted, false);
    }
    assert.equal((await db.query<{ allowed: boolean }>("select has_function_privilege($1, 'public.shr_apply_payment(text,text,text,text,integer,text,text,text,text)', 'EXECUTE') as allowed", [role])).rows[0].allowed, false);
  }
  assert.equal((await db.query<{ allowed: boolean }>("select has_function_privilege('service_role', 'public.shr_apply_payment(text,text,text,text,integer,text,text,text,text)', 'EXECUTE') as allowed")).rows[0].allowed, true);
  const columns = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='public'");
  assert.ok(columns.rows.every((column) => !/csv|supplier|sku|filename|purchase_order|raw_body/.test(column.column_name)));
});

test("checkout reservation and order attachment are idempotent and mode/session bound", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => rpc<{ session: Session; created: boolean }>("shr_reserve_checkout", ["test", hash("owner"), email])));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.session.id)).size, 1);
  const id = results[0].session.id;
  await rpc("shr_save_order", [id, "test", "order_One"]);
  await rpc("shr_save_order", [id, "test", "order_One"]);
  await assert.rejects(rpc("shr_save_order", [id, "live", "order_One"]), /unknown_checkout/);
  await assert.rejects(rpc("shr_save_order", [id, "test", "order_Other"]), /checkout_order_conflict/);
  await assert.rejects(rpc("shr_reserve_checkout", ["test", hash("owner"), "different@example.test"]), /checkout_email_mismatch/);
  const mode = await rpc<Session | null>("shr_get_session", ["live", hash("owner")]);
  assert.equal(mode, null);
  assert.equal(await count("checkout_sessions"), 1);
});

test("captured payment and order.paid atomically grant exactly one license and deduplicate webhook bodies", async () => {
  await checkout();
  const first = await payment("captured");
  assert.equal(first.entitlement_status, "active");
  assert.equal(first.duplicate, false);
  const repeatCheckout = await rpc<{ session: Session }>("shr_reserve_checkout", ["test", hash("owner"), email]);
  assert.equal(repeatCheckout.session.entitlement_status, "active");
  assert.equal(repeatCheckout.session.entitlement_id, first.entitlement_id);
  const duplicate = await payment("captured");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.entitlement_id, first.entitlement_id);
  const paid = await rpc<{ entitlement_id: string }>("shr_apply_payment", ["test", "order_One", "pay_One", "captured", 1900, "USD", "evt_paid", "order.paid", hash("paid")]);
  assert.equal(paid.entitlement_id, first.entitlement_id);
  await payment("captured", "evt_second_payment", "order_One", "pay_Two");
  assert.equal(await count("entitlements"), 1);
  assert.equal(await count("payments"), 2);
  assert.equal(await count("webhook_events"), 3);
  await assert.rejects(payment("captured", "evt_capture", "order_One", "pay_One", 1900, "test", hash("tampered")), /webhook_event_conflict/);
  assert.equal(await count("webhook_events"), 3);
});

test("authorized, failed, mismatched and replayed payments do not create unauthorized entitlements", async () => {
  await checkout();
  assert.equal((await payment("authorized", "evt_authorized")).entitlement_status, null);
  assert.equal((await payment("failed", "evt_failed")).entitlement_status, null);
  await assert.rejects(payment("captured", "evt_wrong_amount", "order_One", "pay_One", 1), /payment_amount_mismatch/);
  await assert.rejects(rpc("shr_apply_payment", ["test", "order_One", "pay_One", "captured", 1900, "INR", "evt_wrong_currency", "payment.captured", hash("currency")]), /payment_amount_mismatch/);
  await assert.rejects(payment("captured", "evt_unknown", "order_Missing"), /unknown_checkout_order/);
  assert.equal(await count("webhook_events"), 2, "failed processing does not consume webhook IDs");
  assert.equal(await count("entitlements"), 0);
  await payment("captured", "evt_verified");
  await checkout("other", "test", "order_Other");
  await assert.rejects(payment("captured", "evt_replay", "order_Other", "pay_One"), /payment_replay_conflict/);
  assert.equal(await count("entitlements"), 1);
  assert.equal(await count("webhook_events"), 3, "replay detection rolls back its already-inserted event receipt");
});

test("refunds and disputes remain terminal across delayed and out-of-order captures", async () => {
  await checkout();
  await payment("captured");
  await payment("failed", "evt_delayed_failure");
  assert.equal((await rpc<Session>("shr_get_session", ["test", hash("owner")])).entitlement_status, "active");
  await payment("disputed", "evt_disputed");
  await payment("captured", "evt_delayed_capture");
  let current = await rpc<Session>("shr_get_session", ["test", hash("owner")]);
  assert.equal(current.entitlement_status, "disputed");
  assert.equal(current.status, "revoked");
  await payment("refunded", "evt_refunded");
  await payment("captured", "evt_still_delayed");
  current = await rpc<Session>("shr_get_session", ["test", hash("owner")]);
  assert.equal(current.entitlement_status, "refunded");
  await checkout("refund-first", "test", "order_RefundFirst");
  await payment("refunded", "evt_refund_first", "order_RefundFirst", "pay_RefundFirst");
  await payment("captured", "evt_capture_late", "order_RefundFirst", "pay_RefundFirst");
  assert.equal((await rpc<Session>("shr_get_session", ["test", hash("refund-first")])).entitlement_status, null);
  assert.equal(await count("entitlements"), 1);
});

test("recovery links expire, are single-use and transfer only an active license to the new session", async () => {
  await checkout();
  await payment("captured");
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  assert.equal(await rpc("shr_issue_recovery", ["test", "unknown@example.test", hash("unknown"), expires]), false);
  assert.equal(await rpc("shr_issue_recovery", ["test", email, hash("old-link"), expires]), true);
  assert.equal(await rpc("shr_issue_recovery", ["test", email, hash("recovery"), expires]), true);
  assert.equal(await rpc("shr_redeem_recovery", ["test", hash("old-link"), hash("new-browser")]), null);
  assert.equal(await rpc("shr_redeem_recovery", ["live", hash("recovery"), hash("new-browser")]), null);
  const recovered = await rpc<Session>("shr_redeem_recovery", ["test", hash("recovery"), hash("new-browser")]);
  assert.equal(recovered.entitlement_status, "active");
  assert.equal(await rpc("shr_get_session", ["test", hash("owner")]), null);
  assert.equal((await rpc<Session>("shr_get_session", ["test", hash("new-browser")])).entitlement_status, "active");
  assert.equal(await rpc("shr_redeem_recovery", ["test", hash("recovery"), hash("attacker")]), null);
  await rpc("shr_issue_recovery", ["test", email, hash("expired"), expires]);
  await db.query("update public.license_recovery_tokens set expires_at=now()-interval '1 second' where token_hash=$1", [hash("expired")]);
  assert.equal(await rpc("shr_redeem_recovery", ["test", hash("expired"), hash("newer")]), null);
  await rpc("shr_issue_recovery", ["test", email, hash("revoked"), expires]);
  await payment("refunded", "evt_refund");
  assert.equal(await rpc("shr_redeem_recovery", ["test", hash("revoked"), hash("newer")]), null);
  assert.equal(await rpc("shr_issue_recovery", ["test", email, hash("unavailable"), expires]), false);
});

test("expired browser sessions cannot authorize exports but a delayed valid capture remains recoverable", async () => {
  const session = await checkout();
  await db.query("update public.checkout_sessions set session_expires_at=now()-interval '1 second' where id=$1", [session.id]);
  assert.equal(await rpc("shr_get_session", ["test", hash("owner")]), null);
  await assert.rejects(rpc("shr_reserve_checkout", ["test", hash("owner"), email]), /checkout_session_expired/);
  await payment("captured");
  assert.equal(await count("entitlements"), 1);
  assert.equal(await rpc("shr_issue_recovery", ["test", email, hash("recover"), new Date(Date.now() + 15 * 60_000).toISOString()]), true);
});

test("recovery can select an older purchase by order reference without crossing email or mode", async () => {
  const first = await checkout("first", "test", "order_First");
  await payment("captured", "evt_first", "order_First", "pay_First");
  const second = await checkout("second", "test", "order_Second");
  await payment("captured", "evt_second", "order_Second", "pay_Second");
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  await rpc("shr_issue_recovery", ["test", email, hash("latest-link"), expires]);
  const latest = await rpc<Session>("shr_redeem_recovery", ["test", hash("latest-link"), hash("latest-session")]);
  assert.equal(latest.id, second.id);
  assert.equal(await rpc("shr_issue_recovery", ["test", email, hash("first-link"), expires, "order_First"]), true);
  const recoveredFirst = await rpc<Session>("shr_redeem_recovery", ["test", hash("first-link"), hash("first-session")]);
  assert.equal(recoveredFirst.id, first.id);
  assert.equal(await rpc("shr_issue_recovery", ["test", "wrong@example.test", hash("wrong-email"), expires, "order_First"]), false);
  assert.equal(await rpc("shr_issue_recovery", ["live", email, hash("wrong-mode"), expires, "order_First"]), false);
  assert.equal(await rpc("shr_issue_recovery", ["test", email, hash("wrong-order"), expires, "order_Missing"]), false);
});

test("database rate limiting consumes attempts atomically and survives independent calls", async () => {
  const allowed = await Promise.all(Array.from({ length: 10 }, () => rpc<boolean>("shr_rate_limit", [hash("endpoint-ip"), 3, 60])));
  assert.equal(allowed.filter(Boolean).length, 3);
  assert.equal(await rpc("shr_rate_limit", [hash("endpoint-ip"), 3, 60]), false);
  assert.equal(await rpc("shr_rate_limit", [hash("another-endpoint-ip"), 3, 60]), true);
  await assert.rejects(rpc("shr_rate_limit", [hash("bad"), 0, 60]), /invalid_rate_limit/);
});
