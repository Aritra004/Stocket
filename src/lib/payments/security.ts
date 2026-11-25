import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { PaymentConfig } from "./config";

export class PaymentError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "PaymentError"; }
}

export const opaqueToken = () => randomBytes(32).toString("base64url");
export const validToken = (token: string | undefined | null): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
export const tokenHash = (token: string, pepper: string, purpose = "session") => createHmac("sha256", pepper).update(`${purpose}:${token}`).digest("hex");
export const bodyHash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

export function validSignature(body: string | Uint8Array, signature: string | null, secret: string): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(body).digest(), Buffer.from(signature, "hex"));
}

export function assertBrowserRequest(request: Request, config: PaymentConfig): void {
  if (request.headers.get("origin") !== config.appUrl) throw new PaymentError(403, "origin_rejected", "This request must come from the application.");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new PaymentError(403, "origin_rejected", "Cross-site payment requests are not allowed.");
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new PaymentError(415, "invalid_content_type", "Send a JSON request.");
}

/** Read incrementally: Content-Length alone is not a trustworthy body limit. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new PaymentError(413, "body_too_large", "The request is too large.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new PaymentError(413, "body_too_large", "The request is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export async function readJson(request: Request): Promise<unknown> {
  const bytes = await readBody(request, 4096);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new PaymentError(400, "invalid_json", "The request must contain valid JSON."); }
}

export function cookieName(config: PaymentConfig): string { return config.appUrl.startsWith("https:") ? "__Host-stocky_session" : "stocky_session_test"; }
export function sessionCookie(request: Request, config: PaymentConfig): string | undefined {
  const name = cookieName(config);
  const value = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return validToken(value) ? value : undefined;
}

export function clientBucket(request: Request, config: PaymentConfig): string {
  // Enable only when the deployment's proxy overwrites this header. Never trust
  // arbitrary X-Forwarded-For; otherwise use a shared conservative fallback.
  const candidate = config.trustedProxyIpHeader ? request.headers.get(config.trustedProxyIpHeader)?.trim() : undefined;
  const address = candidate && isIP(candidate) ? candidate : "unattributed";
  return tokenHash(address, config.tokenPepper, "rate-ip");
}
