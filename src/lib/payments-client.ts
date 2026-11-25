/** The payment API receives only billing/session metadata, never archive data. */
export type EntitlementStatus = "active" | "pending" | "none" | "revoked";
export interface EntitlementResponse { status: EntitlementStatus; licenseId?: string; mode: "test" | "live" }
export interface CheckoutOrder { keyId: string; orderId: string; amount: 1900; currency: "USD"; mode: "test" | "live" }
export type CreateOrderResponse = CheckoutOrder | { status: "active" | "pending"; message?: string };
export interface CheckoutResult { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }

export async function paymentRequest<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("The payment service could not be reached. Check your connection and retry. If you already paid, check payment status before trying checkout again.");
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error("The payment service returned an unreadable response. Check payment status before retrying checkout."); }
  if (!response.ok) {
    const value = data as { error?: { message?: unknown }; message?: unknown };
    const message = value?.error?.message ?? value?.message;
    throw new Error(typeof message === "string" ? message : "The payment request could not be completed. Please retry.");
  }
  return data as T;
}

export async function getEntitlementStatus(signal?: AbortSignal): Promise<EntitlementResponse> {
  const result = await paymentRequest<EntitlementResponse>("/api/entitlements/status", {}, signal);
  if (!result || !["active", "pending", "none", "revoked"].includes(result.status) || !["test", "live"].includes(result.mode)) {
    throw new Error("License status could not be verified. Please retry before exporting.");
  }
  return result;
}
