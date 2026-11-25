export type PaymentMode = "test" | "live";
export type PaymentState = "authorized" | "captured" | "failed" | "refunded" | "disputed";
export type EntitlementState = "active" | "refunded" | "disputed";

export interface CheckoutSession {
  id: string;
  mode: PaymentMode;
  token_hash: string;
  email: string;
  amount: number;
  currency: "USD";
  razorpay_order_id: string | null;
  status: "creating" | "pending" | "paid" | "revoked";
  session_expires_at: string;
  created_at: string;
  updated_at: string;
  entitlement_status?: EntitlementState | null;
  entitlement_id?: string | null;
}

export interface PaymentObservation {
  mode: PaymentMode;
  orderId: string;
  paymentId: string;
  status: PaymentState;
  amount: number;
  currency: string;
  eventId?: string;
  eventType?: string;
  bodyHash?: string;
}

export interface PaymentApplication {
  duplicate: boolean;
  entitlement_status: EntitlementState | null;
  entitlement_id: string | null;
}

/** Only payment/license metadata crosses this boundary. No import fields exist. */
export interface PaymentRepository {
  reserveCheckout(input: { mode: PaymentMode; tokenHash: string; email: string }): Promise<{ session: CheckoutSession; created: boolean }>;
  saveOrder(sessionId: string, mode: PaymentMode, orderId: string): Promise<CheckoutSession>;
  getSession(tokenHash: string, mode: PaymentMode): Promise<CheckoutSession | null>;
  getSessionByOrder(orderId: string, mode: PaymentMode): Promise<CheckoutSession | null>;
  applyPayment(input: PaymentObservation): Promise<PaymentApplication>;
  issueRecovery(email: string, mode: PaymentMode, tokenHash: string, expiresAt: string, orderId?: string): Promise<boolean>;
  redeemRecovery(tokenHash: string, mode: PaymentMode, newSessionHash: string): Promise<CheckoutSession | null>;
  rateLimit(key: string, maximum: number, windowSeconds: number): Promise<boolean>;
}
