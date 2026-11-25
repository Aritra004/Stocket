import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { readPaymentConfig } from "./config";
import {
  assertBrowserRequest,
  bodyHash,
  clientBucket,
  cookieName,
  opaqueToken,
  readBody,
  readJson,
  sessionCookie,
  tokenHash,
  validSignature,
  validToken,
} from "./security";

const environment = {
  APP_URL: "https://stocky.example",
  PAYMENTS_MODE: "test",
  RAZORPAY_KEY_ID: "rzp_test_fixture",
  RAZORPAY_KEY_SECRET: "fixture-api-secret",
  RAZORPAY_WEBHOOK_SECRET: "fixture-webhook-secret",
  SESSION_TOKEN_PEPPER: "p".repeat(32),
  SUPABASE_URL: "https://fixture.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
};
const config = readPaymentConfig(environment);
function request(body = "{}", headers: Record<string, string> = {}): Request {
  return new Request("https://stocky.example/api/payments/create-order", {
    method: "POST",
    headers: {
      origin: config.appUrl,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

test("payment configuration defaults to Test Mode with USD/live disabled and rejects mixed credentials", () => {
  assert.equal(config.mode, "test");
  assert.equal(config.usdEnabled, false);
  assert.equal(config.liveEnabled, false);
  assert.equal(
    readPaymentConfig({ ...environment, PAYMENTS_MODE: undefined }).mode,
    "test",
  );
  assert.equal(
    readPaymentConfig({ ...environment, RAZORPAY_USD_ENABLED: "true" })
      .usdEnabled,
    true,
  );
  assert.equal(
    readPaymentConfig({ ...environment, RAZORPAY_USD_ENABLED: "TRUE" })
      .usdEnabled,
    false,
  );
  for (const change of [
    { RAZORPAY_KEY_SECRET: "" },
    { SUPABASE_SERVICE_ROLE_KEY: "" },
    { SESSION_TOKEN_PEPPER: "short" },
    { RAZORPAY_KEY_ID: "rzp_live_fixture" },
    { PAYMENTS_MODE: "live" },
    { PAYMENTS_MODE: "invalid" },
    { APP_URL: "http://stocky.example" },
    { APP_URL: "https://stocky.example/path" },
    { APP_URL: "https://user:password@stocky.example" },
    { APP_URL: "https://stocky.example?redirect=evil" },
    { TRUSTED_PROXY_IP_HEADER: "x-forwarded-for" },
    { SUPABASE_URL: "http://remote.example" },
  ])
    assert.throws(() => readPaymentConfig({ ...environment, ...change }));
  assert.equal(
    readPaymentConfig({ ...environment, APP_URL: "http://localhost:3000" })
      .appUrl,
    "http://localhost:3000",
  );
});

test("customer endpoints require exact origin, JSON and same-origin fetch context", () => {
  assert.doesNotThrow(() => assertBrowserRequest(request(), config));
  const invalidHeaders: Array<Record<string, string>> = [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "" },
    { origin: "https://stocky.example.evil.test" },
    { "sec-fetch-site": "cross-site" },
    { "content-type": "text/plain" },
    { "content-type": "application/json.evil" },
  ];
  for (const headers of invalidHeaders) {
    assert.throws(() => assertBrowserRequest(request("{}", headers), config));
  }
});

test("request reader limits actual streamed bytes even with missing or dishonest Content-Length", async () => {
  assert.equal(
    new TextDecoder().decode(await readBody(request("1234"), 4)),
    "1234",
  );
  await assert.rejects(readBody(request("12345"), 4), /too large/);
  await assert.rejects(
    readBody(request("12345", { "content-length": "1" }), 4),
    /too large/,
  );
  await assert.rejects(
    readBody(request("1", { "content-length": "5000" }), 4096),
    /too large/,
  );
  await assert.rejects(readJson(request('{"email":')), /valid JSON/);
  await assert.rejects(readJson(request(" ".repeat(4097))), /too large/);
});

test("webhook signatures cover exact raw bytes and reject whitespace changes and wrong secrets", () => {
  const raw = new TextEncoder().encode(
    '{ "event": "payment.captured", "x": "é" }\r\n',
  );
  const signature = createHmac("sha256", environment.RAZORPAY_WEBHOOK_SECRET)
    .update(raw)
    .digest("hex");
  assert.equal(
    validSignature(raw, signature, environment.RAZORPAY_WEBHOOK_SECRET),
    true,
  );
  assert.equal(
    validSignature(raw, signature, environment.RAZORPAY_KEY_SECRET),
    false,
  );
  assert.equal(
    validSignature(
      JSON.stringify(JSON.parse(new TextDecoder().decode(raw))),
      signature,
      environment.RAZORPAY_WEBHOOK_SECRET,
    ),
    false,
  );
  for (const invalid of [
    null,
    "",
    "abc",
    "0".repeat(64),
    "g".repeat(64),
    "a".repeat(65),
  ])
    assert.equal(
      validSignature(raw, invalid, environment.RAZORPAY_WEBHOOK_SECRET),
      false,
    );
  assert.equal(bodyHash(raw).length, 64);
});

test("anonymous cookie tokens use 256 random bits with purpose-separated hashed persistence", () => {
  const first = opaqueToken();
  const second = opaqueToken();
  assert.notEqual(first, second);
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.equal(validToken(first), true);
  assert.equal(validToken("short"), false);
  assert.notEqual(tokenHash(first, config.tokenPepper), first);
  assert.notEqual(
    tokenHash(first, config.tokenPepper),
    tokenHash(first, config.tokenPepper, "recovery"),
  );
  assert.equal(cookieName(config), "__Host-stocky_session");
  assert.equal(
    sessionCookie(
      request("{}", { cookie: `other=1; ${cookieName(config)}=${first}` }),
      config,
    ),
    first,
  );
  assert.equal(
    sessionCookie(
      request("{}", { cookie: `${cookieName(config)}=not-a-token` }),
      config,
    ),
    undefined,
  );
  assert.equal(
    sessionCookie(
      request("{}", { cookie: `stocky_session_test=${first}` }),
      config,
    ),
    undefined,
  );
});

test("rate-limit identifiers ignore untrusted IP headers and never retain raw addresses", () => {
  const base = clientBucket(request(), config);
  assert.equal(
    clientBucket(
      request("{}", {
        "x-forwarded-for": "203.0.113.1",
        "x-real-ip": "203.0.113.2",
      }),
      config,
    ),
    base,
  );
  const edgeConfig = { ...config, trustedProxyIpHeader: "cf-connecting-ip" };
  const trusted = clientBucket(
    request("{}", { "cf-connecting-ip": "203.0.113.1" }),
    edgeConfig,
  );
  assert.notEqual(trusted, base);
  assert.doesNotMatch(trusted, /203\.0\.113/);
  assert.equal(
    clientBucket(
      request("{}", { "cf-connecting-ip": "spoofed, 203.0.113.1" }),
      edgeConfig,
    ),
    base,
  );
});
