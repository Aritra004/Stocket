import { z } from "zod";
import { SESSION_MAX_AGE } from "./config";
import { PaymentService } from "./service";
import { assertBrowserRequest, clientBucket, cookieName, opaqueToken, PaymentError, readBody, readJson, sessionCookie, tokenHash, validToken } from "./security";

const email = z.string().trim().max(254).email().transform((value) => value.toLowerCase());
const orderId = z.string().regex(/^order_[A-Za-z0-9]{1,80}$/);
const createInput = z.object({ email }).strict();
const verificationInput = z.object({ razorpay_order_id: orderId, razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{1,80}$/), razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i) }).strict();
const recoveryInput = z.object({ email, orderId: orderId.optional() }).strict();
const redeemInput = z.object({ token: z.string().refine(validToken) }).strict();
const emptyInput = z.object({}).strict();
const recoveryMessage = "If an eligible license matches that email and purchase reference, a recovery link will arrive shortly. Check spam or try again later if it does not arrive.";
type Operation = "createOrder" | "verify" | "status" | "requestRecovery" | "redeemRecovery" | "webhook";

export function paymentResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
}

export function paymentFailure(error: unknown): Response {
  const known = error instanceof PaymentError;
  const response = paymentResponse({ error: { code: known ? error.code : "payment_unavailable", message: known ? error.message : "Payments or license verification are temporarily unavailable. Please retry shortly." } }, known ? error.status : 503);
  if (known && error.status === 429) response.headers.set("Retry-After", "60");
  return response;
}

/** Framework-neutral adapters exercise the same guards as the Next routes. */
export function createPaymentHandlers(service: PaymentService): Record<Operation, (request: Request) => Promise<Response>> {
  const config = service.config;
  const parse = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> => {
    const result = schema.safeParse(await readJson(request));
    if (!result.success) throw new PaymentError(400, "invalid_request", "The payment request contains invalid or unexpected fields.");
    return result.data;
  };
  async function handle(operation: Operation, request: Request): Promise<Response> {
    let issuedToken: string | undefined;
    let response: Response;
    try {
      if (request.method !== "POST") throw new PaymentError(405, "method_not_allowed", "Use POST for this endpoint.");
      if (operation === "webhook") {
        await service.webhook(await readBody(request, 256 * 1024), request.headers.get("x-razorpay-signature"), request.headers.get("x-razorpay-event-id"));
        return paymentResponse({ received: true });
      }
      assertBrowserRequest(request, config);
      const rawToken = sessionCookie(request, config);
      const hash = rawToken ? tokenHash(rawToken, config.tokenPepper) : undefined;
      const bucket = clientBucket(request, config);
      const rate = operation === "status" ? 600 : operation === "verify" ? 120 : 30;
      await service.limit(`${operation}:network:${bucket}`, rate, 60);
      if (hash) await service.limit(`${operation}:session:${hash}`, operation === "status" ? 120 : 20, 60);
      if (operation === "createOrder") {
        const data = await parse(request, createInput);
        await service.limit(`checkout-email:${data.email}`, 10, 3600);
        const existing = hash ? await service.repository.getSession(hash, config.mode) : null;
        if (!existing) issuedToken = opaqueToken();
        const sessionHash = issuedToken ? tokenHash(issuedToken, config.tokenPepper) : hash!;
        const result = await service.createOrder(sessionHash, data.email);
        response = paymentResponse(result, "status" in result && result.status === "pending" ? 202 : 200);
      } else if (operation === "verify") {
        response = paymentResponse(await service.verify(hash, await parse(request, verificationInput)));
      } else if (operation === "status") {
        await parse(request, emptyInput);
        response = paymentResponse(await service.status(hash));
      } else if (operation === "requestRecovery") {
        const data = await parse(request, recoveryInput);
        await service.limit(`recovery-email:${data.email}`, 3, 900);
        await service.requestRecovery(data.email, data.orderId);
        response = paymentResponse({ message: recoveryMessage });
      } else {
        const { token } = await parse(request, redeemInput);
        const replacement = opaqueToken();
        const result = await service.redeemRecovery(token, replacement);
        issuedToken = replacement;
        response = paymentResponse(result);
      }
    } catch (error) { response = paymentFailure(error); }
    if (issuedToken) response.headers.append("Set-Cookie", `${cookieName(config)}=${issuedToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}${config.appUrl.startsWith("https:") ? "; Secure" : ""}`);
    return response;
  }
  return Object.fromEntries(["createOrder", "verify", "status", "requestRecovery", "redeemRecovery", "webhook"].map((operation) => [operation, (request: Request) => handle(operation as Operation, request)])) as Record<Operation, (request: Request) => Promise<Response>>;
}
