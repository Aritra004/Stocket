import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ARCHIVE_EXPORT_DISABLED, assertArchiveExportEnabled, isArchiveExportEnabled } from "./export-access";

function environment(context: TestContext, mode: string, bypass: string) {
  for (const [key, value] of Object.entries({ NODE_ENV: mode, NEXT_PUBLIC_EXPORT_TEST_BYPASS: bypass })) {
    const previous = process.env[key]; Reflect.set(process.env, key, value);
    context.after(() => { if (previous === undefined) Reflect.deleteProperty(process.env, key); else Reflect.set(process.env, key, previous); });
  }
}
test("development and test bypass is explicit and can never enable production exports", async (context) => {
  environment(context, "development", "false");
  context.mock.method(globalThis, "fetch", async () => Response.json({ status: "none", mode: "test" }));
  for (const mode of ["development", "test", "production", "preview", ""]) {
    Reflect.set(process.env, "NODE_ENV", mode);
    for (const bypass of ["true", "false", ""]) {
      Reflect.set(process.env, "NEXT_PUBLIC_EXPORT_TEST_BYPASS", bypass);
      const enabled = (mode === "development" || mode === "test") && bypass === "true";
      assert.equal(isArchiveExportEnabled(), enabled);
      if (enabled) await assert.doesNotReject(assertArchiveExportEnabled());
      else await assert.rejects(assertArchiveExportEnabled(), { message: ARCHIVE_EXPORT_DISABLED });
    }
  }
});
test("export requires an active server entitlement using only the session cookie", async (context) => {
  environment(context, "production", "true");
  let status = "active";
  const fetch = context.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.equal(input, "/api/entitlements/status");
    assert.equal(init.method, "POST"); assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store");
    assert.equal(init.body, "{}", "No archive values or client-supplied license claims are transmitted");
    return Response.json({ status, mode: "live" });
  });
  await assert.doesNotReject(assertArchiveExportEnabled());
  for (status of ["pending", "none", "revoked"]) await assert.rejects(assertArchiveExportEnabled());
  assert.equal(fetch.mock.callCount(), 4, "License checks are not cached between export attempts");
});
test("malformed, unavailable and failed status checks fail closed", async (context) => {
  environment(context, "test", "false");
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json({ active: true }));
  await assert.rejects(assertArchiveExportEnabled(), /could not be verified/);
  fetch.mock.mockImplementation(async () => Response.json({ error: { message: "Service unavailable" } }, { status: 503 }));
  await assert.rejects(assertArchiveExportEnabled(), /Service unavailable/);
  fetch.mock.mockImplementation(async () => { throw new Error("network down"); });
  await assert.rejects(assertArchiveExportEnabled(), /could not be reached/);
});
