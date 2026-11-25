import "server-only";
import type { PaymentRepository, PaymentMode, CheckoutSession, PaymentObservation, PaymentApplication } from "./repository-types";

/** Structural subset permits testing the actual RPC mapping without credentials. */
export interface PaymentRpcClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

/** Credentials are supplied only by the server runtime, never by the browser. */
export class SupabasePaymentRepository implements PaymentRepository {
  constructor(private readonly client: PaymentRpcClient) {}

  private async rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
    const result = await this.client.rpc(name, parameters);
    if (result.error) throw new Error("Payment storage is temporarily unavailable. Please retry.");
    return result.data as T;
  }

  reserveCheckout(input: { mode: PaymentMode; tokenHash: string; email: string }) {
    return this.rpc<{ session: CheckoutSession; created: boolean }>("shr_reserve_checkout", { p_mode: input.mode, p_token_hash: input.tokenHash, p_email: input.email });
  }

  saveOrder(sessionId: string, mode: PaymentMode, orderId: string) {
    return this.rpc<CheckoutSession>("shr_save_order", { p_session_id: sessionId, p_mode: mode, p_order_id: orderId });
  }

  getSession(tokenHash: string, mode: PaymentMode) {
    return this.rpc<CheckoutSession | null>("shr_get_session", { p_mode: mode, p_token_hash: tokenHash });
  }

  getSessionByOrder(orderId: string, mode: PaymentMode) {
    return this.rpc<CheckoutSession | null>("shr_find_order", { p_mode: mode, p_order_id: orderId });
  }

  applyPayment(input: PaymentObservation) {
    return this.rpc<PaymentApplication>("shr_apply_payment", {
      p_mode: input.mode, p_order_id: input.orderId, p_payment_id: input.paymentId, p_status: input.status,
      p_amount: input.amount, p_currency: input.currency, p_event_id: input.eventId ?? null,
      p_event_type: input.eventType ?? null, p_body_hash: input.bodyHash ?? null,
    });
  }

  issueRecovery(email: string, mode: PaymentMode, tokenHash: string, expiresAt: string, orderId?: string) {
    return this.rpc<boolean>("shr_issue_recovery", { p_mode: mode, p_email: email, p_token_hash: tokenHash, p_expires_at: expiresAt, p_order_id: orderId ?? null });
  }

  redeemRecovery(tokenHash: string, mode: PaymentMode, newSessionHash: string) {
    return this.rpc<CheckoutSession | null>("shr_redeem_recovery", { p_mode: mode, p_token_hash: tokenHash, p_new_session_hash: newSessionHash });
  }

  rateLimit(key: string, maximum: number, windowSeconds: number) {
    return this.rpc<boolean>("shr_rate_limit", { p_key_hash: key, p_limit: maximum, p_window_seconds: windowSeconds });
  }
}
