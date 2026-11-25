export type PaymentMode = "test" | "live";
export const PRODUCT_AMOUNT = 1900;
export const PRODUCT_CURRENCY = "USD";
export const SESSION_MAX_AGE = 90 * 24 * 60 * 60;
export const RECOVERY_MAX_AGE = 15 * 60;

export interface PaymentConfig {
  mode: PaymentMode;
  appUrl: string;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  tokenPepper: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  usdEnabled: boolean;
  liveEnabled: boolean;
  emailApiKey?: string;
  emailFrom?: string;
  trustedProxyIpHeader?: string;
}

/** Read lazily on the server so builds never require credentials. */
export function readPaymentConfig(env: Record<string, string | undefined>): PaymentConfig {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error("Payments are not configured. Contact support or try again later.");
    return value;
  };
  const mode = env.PAYMENTS_MODE ?? "test";
  if (mode !== "test" && mode !== "live") throw new Error("Payment mode is not configured correctly.");
  const keyId = required("RAZORPAY_KEY_ID");
  if (!new RegExp(`^rzp_${mode}_[A-Za-z0-9]+$`).test(keyId)) throw new Error("The configured Razorpay key does not match the payment mode.");
  const app = new URL(required("APP_URL"));
  if (app.username || app.password || app.pathname !== "/" || app.search || app.hash) throw new Error("APP_URL must be a trusted application origin.");
  if (app.protocol !== "https:" && !(mode === "test" && app.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname))) throw new Error("Payments require HTTPS outside local test development.");
  const tokenPepper = required("SESSION_TOKEN_PEPPER");
  if (tokenPepper.length < 32) throw new Error("The session token pepper must contain at least 32 random characters.");
  const supabase = new URL(required("SUPABASE_URL"));
  if (supabase.protocol !== "https:" && !(mode === "test" && ["localhost", "127.0.0.1", "[::1]"].includes(supabase.hostname))) throw new Error("Supabase must use HTTPS outside local testing.");
  const proxy = env.TRUSTED_PROXY_IP_HEADER?.trim().toLowerCase();
  if (proxy && !["x-real-ip", "cf-connecting-ip", "x-vercel-forwarded-for"].includes(proxy)) throw new Error("The trusted proxy IP header is unsupported.");
  return {
    mode, appUrl: app.origin, keyId, keySecret: required("RAZORPAY_KEY_SECRET"), webhookSecret: required("RAZORPAY_WEBHOOK_SECRET"), tokenPepper,
    supabaseUrl: supabase.origin, serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    usdEnabled: env.RAZORPAY_USD_ENABLED === "true", liveEnabled: env.LIVE_PAYMENTS_ENABLED === "true",
    emailApiKey: env.RESEND_API_KEY?.trim(), emailFrom: env.LICENSE_EMAIL_FROM?.trim(), trustedProxyIpHeader: proxy,
  };
}
