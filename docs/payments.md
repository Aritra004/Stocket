# Razorpay payments and anonymous archive licenses

Stocky History Rescue sells a **one-time USD 19.00 license for one merchant archive**. There are no subscriptions or mandatory accounts. Razorpay Standard Checkout is the sole payment provider. This repository did not contain Paddle code or credentials to migrate.

The importer, IndexedDB archive, CSV normalization, and ZIP implementation remain local. Payment requests contain only checkout email, opaque payment/session identifiers, signatures, and license metadata. Never add CSV contents, merchant source filenames, supplier names, SKUs, purchase orders, or archive fingerprints to checkout notes, payment requests, database records, telemetry, or support logs.

## Local configuration

Copy `.env.example` to `.env.local` and supply secrets outside version control. Configuration is read on the server; no Razorpay secret or Supabase service-role key belongs in a `NEXT_PUBLIC_` variable.

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Exact application origin. Use the public HTTPS origin for staging/live; localhost is only for local tests. |
| `PAYMENTS_MODE` | `test` initially; use separate `live` infrastructure when approved. |
| `RAZORPAY_KEY_ID` | Test key beginning `rzp_test_`, or matching live key when explicitly enabled. The key ID is intentionally returned to Standard Checkout. |
| `RAZORPAY_KEY_SECRET` | Server-side key used for SDK requests and checkout HMAC verification. |
| `RAZORPAY_WEBHOOK_SECRET` | Dedicated mode-specific webhook HMAC secret, separate from the API secret. |
| `RAZORPAY_USD_ENABLED` | Must be explicitly `true` only after confirming USD capability for this merchant and mode. Otherwise order creation fails closed. |
| `LIVE_PAYMENTS_ENABLED` | Extra explicit opt-in for live operation; initially `false`. |
| `SUPABASE_URL` | Dedicated Supabase PostgreSQL project's API URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service-role credential. Browser roles receive no payment-table access. |
| `SESSION_TOKEN_PEPPER` | Unique random server secret, at least 32 characters, used to hash anonymous/session and abuse-control identifiers. Keep stable within an environment. |
| `TRUSTED_PROXY_IP_HEADER` | Optional trusted edge header (`x-real-ip`, `cf-connecting-ip`, or `x-vercel-forwarded-for`) only when the proxy overwrites client input. Unset uses a shared fallback bucket plus session/email limits. |
| `RESEND_API_KEY` | Transactional email API credential for requested license-recovery links. |
| `LICENSE_EMAIL_FROM` | Verified recovery email sender, for example `Stocky History Rescue <licenses@your-domain.example>`. |
| `NEXT_PUBLIC_EXPORT_TEST_BYPASS` | Explicit archive-development test bypass. Keep `false` when testing payment authorization. Never honored in production. |

The price is fixed in server code to **1900 USD minor units**. Browser-supplied amounts/currencies are rejected. The USD flag is an operator attestation after Dashboard/account confirmation, not automatic discovery of account capabilities. Gateway rejection also remains an error. There is no INR substitution or exchange-rate calculation.

Use separate Supabase projects, Razorpay accounts/keys where appropriate, webhook endpoints/secrets, email configuration, and session peppers for test and live. A test entitlement must never authorize a live-mode export. Do not reuse a database across an unreviewed environment switch.

## Application flow

1. `/unlock` collects the license-recovery email and explains the one-merchant scope. The backend establishes a high-entropy anonymous HttpOnly cookie and reserves an idempotent checkout before calling Razorpay.
2. `POST /api/payments/create-order` creates or reuses the server-priced Razorpay order. Standard Checkout receives only its public key ID and order details. An uncertain gateway result is not blindly retried as a new order.
3. Checkout success sends payment identifiers/signature to `POST /api/payments/verify`. The server uses the order ID stored for the cookie-bound checkout, checks the HMAC, and verifies the payment with Razorpay. Authorization without capture stays pending.
4. `POST /api/entitlements/status` reports the current server-backed license status. Closing Checkout or seeing its success callback never grants access. The UI supports failure, cancellation, pending, and verified access.
5. The archive gate checks the anonymous session before allowing the normal browser worker to build the ZIP. No CSV or archive data is sent with that check. The downloaded viewer still runs without our servers.
6. Signed events at `POST /api/webhooks/razorpay` reconcile capture/refund/dispute states even if the browser closes. Raw-body signature validation precedes parsing/persistence; event IDs are deduplicated atomically with payment/license updates.

An anonymous session is a bearer credential: do not expose it to JavaScript, log it, include it in checkout metadata, or accept a token supplied as a checkout field. Cookies require HTTPS in deployed environments. API responses are private and not cached. Same-origin request validation, strict body validation, body-size limits, and durable database rate limits protect customer endpoints.

## Recovery and revocation

`POST /api/entitlements/recovery/request` accepts the checkout email and an optional exact Razorpay order reference, and returns a generic result. Without a reference it selects the most recent active license; a matching reference can recover an older purchase under the same email. When an eligible license exists, the application sends an expiring link. The opaque token is carried in `/recover#token=...`, so it is not part of a normal HTTP request URL or Referer. The recovery page removes the fragment and submits it only to `POST /api/entitlements/recovery/redeem` after explicit confirmation. No account is created. Unknown emails and email-delivery failures receive the same public response.

Only a hash of the recovery token is stored. Redemption is atomic, expires, and is single use. It transfers the anonymous license session, preventing an old browser session from continuing to export. Recovery never restores CSVs: those remain on the original device unless the user has their own files/ZIP backups.

Any processed refund, including a partial refund, and dispute events update the license status and block subsequent application exports. Delayed capture/order-paid events cannot overwrite a revoked status. Dispute states are terminal for automatic granting, including closed/won notifications; an operator must review before restoring a license. Previously downloaded archives are never remotely disabled or made network-dependent.

One-merchant scope is a purchase/license term. The server cannot infer merchant identity from local CSVs without violating the privacy boundary. The supplied application enforces server-verified export authorization; it does not claim DRM against someone modifying JavaScript on their own device.

## Razorpay Dashboard configuration

1. Select **Test Mode**, generate Test API keys, and configure only their matching server environment. Never enter live keys to make a test pass.
2. Complete account onboarding and confirm that **international card payments and USD presentment are enabled** for the merchant. Only then set `RAZORPAY_USD_ENABLED=true`. If unavailable, leave checkout disabled and resolve eligibility with Razorpay.
3. Configure **automatic capture** under Account & Settings → Payment Capture. Authorized payments are not sufficient to deliver the license.
4. Add a public HTTPS webhook URL ending `/api/webhooks/razorpay`, with a strong secret matching `RAZORPAY_WEBHOOK_SECRET` for that mode. Localhost cannot receive Razorpay callbacks directly; use an approved public staging endpoint.
5. Subscribe to `payment.captured`, `order.paid`, `payment.authorized`, `payment.failed`, `payment.refunded`, `refund.processed`, `payment.dispute.created`, `payment.dispute.under_review`, `payment.dispute.action_required`, `payment.dispute.lost`, `payment.dispute.closed`, and `payment.dispute.won`. Unsupported events are acknowledged without granting licenses. Every relevant event is cross-checked against Razorpay's current payment API; a temporary API/database failure yields a retryable response.
6. Add an operational alert address and monitor failed deliveries. Razorpay retries non-2xx deliveries and may disable persistently failing webhooks. Check Dashboard delivery history after testing. Do not record full payloads in application logs.
7. Follow Razorpay's current website/domain and account verification requirements. Publish the merchant's genuine contact, privacy, license, cancellation/refund, and delivery policies before live review; do not invent legal/business details.

## Database deployment

Apply `supabase/migrations/202611250001_payments.sql` to the intended Supabase project using a privileged migration connection or the SQL Editor. It expects Supabase's `anon`, `authenticated`, and `service_role` roles. Do not paste the service-role key into the browser app. Back up an existing database before applying changes. No remote migration is performed by local tests.

The migration creates `checkout_sessions`, `payments`, `entitlements`, `webhook_events`, `license_recovery_tokens`, and `payment_rate_limits`. RLS and privilege restrictions deny browser roles direct access; server-only RPCs `shr_reserve_checkout`, `shr_save_order`, `shr_get_session`, `shr_find_order`, `shr_apply_payment`, `shr_issue_recovery`, `shr_redeem_recovery`, and `shr_rate_limit` implement transactional updates. Unique constraints on provider payment/order IDs and one entitlement per checkout prevent duplicate licenses. Event insertion and state changes share one transaction; rejected observations roll back their event receipt so a valid retry remains possible.

Keep `webhook_events` identifiers for deduplication. They retain selected metadata and a payload digest, not raw provider payloads. Each new recovery request replaces that license's previous recovery token, and redemption marks it used. Rate-limit calls prune buckets older than two days. Do not delete payment/license records merely to reset a test in a live database. Use a separate test project.

## Files created or modified

| Area | Files |
| --- | --- |
| Required API routes | `app/api/payments/create-order/route.ts`, `app/api/payments/verify/route.ts`, `app/api/webhooks/razorpay/route.ts`, `app/api/entitlements/status/route.ts` |
| Recovery API | `app/api/entitlements/recovery/request/route.ts`, `app/api/entitlements/recovery/redeem/route.ts` |
| Server implementation | `src/lib/payments/config.ts`, `security.ts`, `http.ts`, `runtime.ts`, `service.ts`, `gateway.ts`, `email.ts`, `repository.ts`, `repository-types.ts`, `provider-types.ts` |
| Database | `supabase/migrations/202611250001_payments.sql` |
| Checkout/recovery UI | `app/unlock/page.tsx`, `app/recover/page.tsx`, `src/components/payments/unlock-archive.tsx`, `recover-license.tsx`, `razorpay-checkout.ts`, `src/components/workspace-shell.tsx` |
| Browser API/export authorization | `src/lib/payments-client.ts`, `src/lib/export-access.ts`, `src/components/quality/archive-zip-export.tsx`; minimal authorization-only changes in `src/lib/storage/zip-export-client.ts`, `zip-export.worker.ts`, `zip-export.ts`, `dashboard-operations.ts` |
| New backend tests | `src/lib/payments/http-security.test.ts`, `repository.test.ts`, `service.test.ts` |
| Browser/regression tests | `tests/payments.spec.ts`, `tests/quality.spec.ts`, `src/lib/export-access.test.ts`, `src/lib/storage/zip-export-client.test.ts`, `zip-export.test.ts`, `dashboard-client.test.ts`, `src/components/quality/archive-zip-ui.test.ts` |
| Setup/documentation | `.env.example`, `.gitignore`, `package.json`, `package-lock.json`, `playwright.config.ts`, `README.md`, this guide |

No CSV importer, local database schema/repository, or ZIP serialization/compression algorithm change is required for payment integration. The local engine changes only await its authorization boundary.

## Validation and live release

Verified locally on 2026-11-25:

| Check | Result |
| --- | --- |
| `npm test` | 289 passed, including 26 payment configuration/security/orchestration/PostgreSQL tests |
| `npm run test:e2e` | 21 passed, including payment UI, actual route-loading/method guards, authorization, and extracted ZIP verification |
| `npm run test:offline:browser` | 8 passed; extracted/moved viewers work via `file://` without network access |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed; changed route/test files also checked after the final route fix |
| `npm run build` | Passed; all six payment/recovery routes build as dynamic handlers |

Tests cover captured success, failed/canceled checkout, invalid signatures, duplicate/delayed webhooks, uncaptured payments, amount/currency mismatches, replay across sessions, expiring/single-use recovery, refunds/disputes, and unauthorized export. API route files intentionally omit an explicit `runtime` export because this Next.js project uses Cache Components; the default Node runtime supports the SDK. The production client bundles contain no server credential-variable references.

Provider tests use mocked responses and database tests execute the migration/functions in local PostgreSQL via PGlite. Browser checkout tests replace Standard Checkout and API responses with deterministic fixtures. They do not prove merchant-account activation, real USD acceptance, Supabase deployment, webhook delivery from Razorpay, or email deliverability. Those require the configured staging acceptance steps below.

Before enabling live payments:

- Apply and review the migration in separate staging and live Supabase projects; verify RLS/RPC permissions and backups.
- Complete Test Mode checkout in a real Razorpay merchant account, including international/USD tests. Confirm **captured**, correct amount/currency, and exactly one entitlement in the database.
- Deliver duplicate, delayed, refund, and dispute webhooks through Dashboard/staging; confirm event deduplication and no resurrection of revoked licenses.
- Test email delivery with a verified sender/domain, expiring/single-use recovery, and invalidation of the previous session. Check SPF/DKIM/DMARC and delivery failures.
- Confirm HTTPS, exact allowed origin, secure cookies, rate limits at the application/edge, no sensitive body/header logging, and no exposed service keys.
- Set `NEXT_PUBLIC_EXPORT_TEST_BYPASS=false`, use live-prefixed Razorpay keys and a separate live webhook secret, set `PAYMENTS_MODE=live`, and enable `LIVE_PAYMENTS_ENABLED=true` only after review. USD still requires explicit enablement.
- Rebuild/deploy, confirm unauthenticated export rejection, and perform the merchant's controlled live acceptance check and reconciliation before advertising checkout availability.

## Official references

Reviewed on 2026-11-25:

- [Razorpay Standard Checkout integration and server signature verification](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
- [Create an order and currency subunits](https://razorpay.com/docs/api/orders/create/)
- [International payments activation](https://razorpay.com/docs/payments/international-payments/)
- [Raw webhook validation, event IDs, and out-of-order delivery](https://razorpay.com/docs/webhooks/validate-test/)
- [Webhook retry behavior](https://razorpay.com/docs/webhooks/best-practices/)
- [Refund events](https://razorpay.com/docs/webhooks/refunds/)
- [Dispute events](https://razorpay.com/docs/webhooks/disputes/)
- [Supabase row-level security and service-role access](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase database functions and execution privileges](https://supabase.com/docs/guides/database/functions)
- [Resend transactional email API](https://resend.com/docs/api-reference/emails/send-email)
