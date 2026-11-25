import { PRODUCT_AMOUNT, PRODUCT_CURRENCY, RECOVERY_MAX_AGE, type PaymentConfig } from "./config";
import type { PaymentGateway, ProviderOrder, ProviderPayment, RecoveryMailer } from "./provider-types";
import type { CheckoutSession, PaymentObservation, PaymentRepository } from "./repository-types";
import { bodyHash, opaqueToken, PaymentError, tokenHash, validSignature } from "./security";

export interface LicenseStatus { status: "active" | "pending" | "none" | "revoked"; licenseId?: string; mode: "test" | "live" }
const providerId = (value: unknown, prefix: string): value is string => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9]{1,80}$`).test(value);
const receiptFor = (session: CheckoutSession) => `shr_${session.id.replaceAll("-", "")}`;
const publicStatus = (session: CheckoutSession | null, config: PaymentConfig): LicenseStatus => ({
  status: !session ? "none" : session.entitlement_status === "active" ? "active" : session.entitlement_status || session.status === "revoked" ? "revoked" : "pending",
  ...(session?.entitlement_id ? { licenseId: session.entitlement_id } : {}), mode: config.mode,
});

/** Pure orchestration: provider and persistence boundaries are injectable in tests. */
export class PaymentService {
  constructor(readonly config: PaymentConfig, readonly repository: PaymentRepository, readonly gateway: PaymentGateway, readonly mailer: RecoveryMailer, private readonly recoveryDeliveryFailure: () => void = () => {}) {}

  async limit(key: string, maximum: number, seconds: number): Promise<void> {
    if (!await this.repository.rateLimit(tokenHash(`${this.config.mode}:${key}`, this.config.tokenPepper, "rate"), maximum, seconds)) throw new PaymentError(429, "rate_limited", "Too many requests. Please wait before trying again.");
  }

  async createOrder(sessionHash: string, email: string) {
    if (!this.config.usdEnabled) throw new PaymentError(503, "usd_unavailable", "USD checkout is unavailable until USD payments are enabled on the merchant account. No alternate currency will be charged.");
    if (this.config.mode === "live" && !this.config.liveEnabled) throw new PaymentError(503, "live_disabled", "Live payments have not been enabled.");
    const existing = await this.repository.getSession(sessionHash, this.config.mode);
    if (existing?.entitlement_status === "active") return publicStatus(existing, this.config);
    if (existing && existing.email !== email) throw new PaymentError(409, "checkout_email_mismatch", "A checkout already exists for this browser with a different recovery email. Use the original email or recover your license.");
    const { session, created } = await this.repository.reserveCheckout({ mode: this.config.mode, tokenHash: sessionHash, email });
    if (session.entitlement_status === "active") return publicStatus(session, this.config);
    if (session.status === "revoked" || session.entitlement_status) throw new PaymentError(403, "license_revoked", "This license is no longer active. Contact support before purchasing again.");
    if (session.email !== email) throw new PaymentError(409, "checkout_email_mismatch", "A checkout already exists for this browser with a different recovery email. Use the original email or recover your license.");
    let orderId = session.razorpay_order_id;
    if (!orderId) {
      const receipt = receiptFor(session);
      let order: ProviderOrder | undefined;
      if (created) {
        try { order = await this.gateway.createOrder(receipt); }
        catch { throw new PaymentError(503, "order_pending", "Order preparation could not be confirmed. Wait and retry; this checkout will reconcile the existing attempt rather than create a second order."); }
      } else {
        const matches = (await this.gateway.findOrders(receipt)).filter((candidate) => candidate.receipt === receipt);
        if (matches.length > 1) throw new PaymentError(503, "order_review_required", "This checkout needs support review before payment can continue.");
        order = matches[0];
        if (!order) return { status: "pending" as const, message: "Your order is still being prepared. Wait and retry. If this persists, contact support; no second order has been created." };
      }
      if (!providerId(order.id, "order") || order.amount !== PRODUCT_AMOUNT || order.currency !== PRODUCT_CURRENCY || order.receipt !== receipt) throw new PaymentError(502, "order_mismatch", "The payment provider returned an unexpected order. Checkout has been stopped.");
      await this.repository.saveOrder(session.id, this.config.mode, order.id);
      orderId = order.id;
    }
    return { keyId: this.config.keyId, orderId, amount: PRODUCT_AMOUNT, currency: PRODUCT_CURRENCY, mode: this.config.mode };
  }

  private observation(payment: ProviderPayment, expectedOrder?: string, forcedState?: "refunded" | "disputed"): PaymentObservation {
    if (!providerId(payment.id, "pay") || !providerId(payment.order_id, "order") || (expectedOrder && payment.order_id !== expectedOrder)) throw new PaymentError(400, "payment_order_mismatch", "The payment does not belong to this checkout.");
    if (payment.amount !== PRODUCT_AMOUNT || payment.currency !== PRODUCT_CURRENCY) throw new PaymentError(400, "payment_amount_mismatch", "The payment amount or currency does not match this license.");
    if (!Number.isSafeInteger(payment.amount_refunded) || payment.amount_refunded < 0 || payment.amount_refunded > payment.amount) throw new PaymentError(502, "payment_invalid", "The payment provider returned inconsistent payment information.");
    let status: PaymentObservation["status"];
    if (forcedState === "disputed") status = "disputed";
    else if (forcedState === "refunded" || payment.status === "refunded" || payment.amount_refunded > 0) status = "refunded";
    else if (payment.status === "captured" && payment.captured === true) status = "captured";
    else if (payment.status === "failed") status = "failed";
    else if (["created", "authorized"].includes(payment.status) && payment.captured === false) status = "authorized";
    else throw new PaymentError(502, "payment_pending", "Payment capture could not be confirmed. Please check again shortly.");
    return { mode: this.config.mode, orderId: payment.order_id, paymentId: payment.id, status, amount: payment.amount, currency: payment.currency };
  }

  async verify(sessionHash: string | undefined, response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }): Promise<LicenseStatus> {
    const session = sessionHash ? await this.repository.getSession(sessionHash, this.config.mode) : null;
    if (!session?.razorpay_order_id) throw new PaymentError(401, "session_required", "This checkout session is unavailable. Recover your license by email if you have already paid.");
    // Never build the HMAC from the order ID supplied by the browser.
    if (response.razorpay_order_id !== session.razorpay_order_id || !validSignature(`${session.razorpay_order_id}|${response.razorpay_payment_id}`, response.razorpay_signature, this.config.keySecret)) throw new PaymentError(400, "invalid_signature", "The payment confirmation could not be verified.");
    const payment = await this.gateway.fetchPayment(response.razorpay_payment_id);
    if (payment.id !== response.razorpay_payment_id) throw new PaymentError(400, "payment_mismatch", "The payment confirmation does not match this checkout.");
    await this.repository.applyPayment(this.observation(payment, session.razorpay_order_id));
    return publicStatus(await this.repository.getSession(sessionHash!, this.config.mode), this.config);
  }

  async status(sessionHash: string | undefined): Promise<LicenseStatus> {
    if (!sessionHash) return publicStatus(null, this.config);
    let session = await this.repository.getSession(sessionHash, this.config.mode);
    if (!session || session.status === "revoked" || session.entitlement_status && session.entitlement_status !== "active") return publicStatus(session, this.config);
    if (!session.razorpay_order_id) {
      // A timed-out create may have succeeded at Razorpay. Only attach its
      // exact server-created receipt; never issue a replacement order here.
      const receipt = receiptFor(session);
      const matches = (await this.gateway.findOrders(receipt)).filter((candidate) => candidate.receipt === receipt);
      if (matches.length > 1) throw new PaymentError(503, "order_review_required", "This checkout needs support review before payment can continue.");
      if (!matches.length) return publicStatus(session, this.config);
      const order = matches[0];
      if (!providerId(order.id, "order") || order.amount !== PRODUCT_AMOUNT || order.currency !== PRODUCT_CURRENCY) throw new PaymentError(502, "order_mismatch", "The payment provider returned an unexpected order. Checkout has been stopped.");
      session = await this.repository.saveOrder(session.id, this.config.mode, order.id);
    }
    // Polling reconciles a lost browser callback or delayed webhook. An API
    // failure fails closed, including on the export authorization boundary.
    let pending = false;
    if (session.razorpay_order_id) {
      const payments = await this.gateway.orderPayments(session.razorpay_order_id);
      for (const payment of payments) {
        const observation = this.observation(payment, session.razorpay_order_id);
        if (observation.status === "authorized") pending = true;
        if (["captured", "refunded"].includes(observation.status)) await this.repository.applyPayment(observation);
      }
    }
    const status = publicStatus(await this.repository.getSession(sessionHash, this.config.mode), this.config);
    // Empty or all-failed attempts are retryable on the same order. A canceled
    // checkout must not become permanently "pending" after a page reload.
    return status.status === "pending" && !pending ? { status: "none", mode: this.config.mode } : status;
  }

  async webhook(raw: Uint8Array, signature: string | null, eventId: string | null): Promise<void> {
    if (!validSignature(raw, signature, this.config.webhookSecret)) throw new PaymentError(400, "invalid_signature", "Webhook signature verification failed.");
    if (!eventId || !/^[A-Za-z0-9_-]{1,160}$/.test(eventId)) throw new PaymentError(400, "event_id_required", "A valid webhook event ID is required.");
    let event: { event?: unknown; payload?: Record<string, { entity?: Record<string, unknown> }> };
    try { event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch { throw new PaymentError(400, "invalid_json", "The webhook body must contain valid JSON."); }
    if (!event || typeof event !== "object" || typeof event.event !== "string") throw new PaymentError(400, "invalid_event", "The webhook event is invalid.");
    const type = event.event;
    const relevant = ["payment.captured", "order.paid", "payment.authorized", "payment.failed", "payment.refunded", "refund.processed", "payment.dispute.created", "payment.dispute.under_review", "payment.dispute.action_required", "payment.dispute.lost", "payment.dispute.closed", "payment.dispute.won"];
    if (!relevant.includes(type)) return;
    // Authenticate before consuming a durable bucket: invalid traffic cannot
    // exhaust the bucket used by authentic provider deliveries.
    await this.limit("signed-webhooks", 1200, 60);
    const paymentEntity = event.payload?.payment?.entity;
    const refund = event.payload?.refund?.entity;
    const dispute = event.payload?.dispute?.entity;
    const candidateId = paymentEntity?.id ?? refund?.payment_id ?? dispute?.payment_id;
    let payment: ProviderPayment | undefined;
    if (providerId(candidateId, "pay")) payment = await this.gateway.fetchPayment(candidateId);
    else if (type === "order.paid" && providerId(event.payload?.order?.entity?.id, "order")) {
      payment = (await this.gateway.orderPayments(event.payload!.order!.entity!.id as string)).find((item) => item.status === "captured" || item.status === "refunded");
    }
    if (!payment) throw new PaymentError(503, "payment_pending", "The event payment is not yet available. Retry delivery.");
    if (providerId(candidateId, "pay") && payment.id !== candidateId) throw new PaymentError(400, "payment_mismatch", "The event payment does not match.");
    const expectedOrder = event.payload?.order?.entity?.id ?? paymentEntity?.order_id;
    if (expectedOrder !== undefined && !providerId(expectedOrder, "order")) throw new PaymentError(400, "invalid_event", "The event order is invalid.");
    const forced = type.startsWith("payment.dispute.") ? "disputed" : ["payment.refunded", "refund.processed"].includes(type) ? "refunded" : undefined;
    const observation = this.observation(payment, expectedOrder as string | undefined, forced);
    if (["payment.captured", "order.paid"].includes(type) && !["captured", "refunded", "disputed"].includes(observation.status)) throw new PaymentError(503, "capture_pending", "Payment capture is not yet confirmed. Retry delivery.");
    await this.repository.applyPayment({ ...observation, eventId, eventType: type, bodyHash: bodyHash(raw) });
  }

  async requestRecovery(email: string, orderId?: string): Promise<void> {
    if (!this.config.emailApiKey || !this.config.emailFrom) throw new PaymentError(503, "recovery_unavailable", "License recovery email is temporarily unavailable. Please contact support.");
    const token = opaqueToken();
    const expiresAt = new Date(Date.now() + RECOVERY_MAX_AGE * 1000).toISOString();
    const issued = await this.repository.issueRecovery(email, this.config.mode, tokenHash(token, this.config.tokenPepper, "recovery"), expiresAt, orderId);
    if (issued) {
      try { await this.mailer.send(email, `${this.config.appUrl}/recover#token=${token}`); }
      catch { this.recoveryDeliveryFailure(); } // Same public response as an unknown email.
    }
  }

  async redeemRecovery(token: string, newSessionToken: string): Promise<LicenseStatus> {
    const session = await this.repository.redeemRecovery(tokenHash(token, this.config.tokenPepper, "recovery"), this.config.mode, tokenHash(newSessionToken, this.config.tokenPepper));
    if (!session || session.entitlement_status !== "active") throw new PaymentError(400, "recovery_invalid", "This recovery link is invalid, expired, already used, or belongs to an inactive license. Request a new link.");
    return publicStatus(session, this.config);
  }
}
