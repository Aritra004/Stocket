import type { CheckoutOrder, CheckoutResult } from "@/src/lib/payments-client";

interface CheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { email: string };
  theme: { color: string };
  retry: { enabled: boolean };
  handler: (response: CheckoutResult) => void;
  modal: { ondismiss: () => void; confirm_close: boolean };
}
export interface RazorpayCheckout {
  open: () => void;
  close: () => void;
  on: (event: "payment.failed", callback: () => void) => void;
}
type RazorpayConstructor = new (options: CheckoutOptions) => RazorpayCheckout;
declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}
let loading: Promise<RazorpayConstructor> | undefined;

/** Load only on explicit checkout, never on a page that renders imported data. */
function loadCheckout(): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.referrerPolicy = "no-referrer";
    const timer = window.setTimeout(() => fail(), 15_000);
    function fail() {
      clearTimeout(timer);
      script.remove();
      loading = undefined;
      reject(
        new Error(
          "Razorpay Checkout could not load. Check your connection or browser blocking settings and retry.",
        ),
      );
    }
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timer);
      if (window.Razorpay) resolve(window.Razorpay);
      else fail();
    };
    document.head.append(script);
  });
  return loading;
}

export async function createCheckout(
  order: CheckoutOrder,
  email: string,
  callbacks: {
    success: (result: CheckoutResult) => void;
    cancelled: () => void;
  },
): Promise<RazorpayCheckout> {
  // Protect presentation from malformed API replies. The server alone sets and
  // verifies the charged amount; the browser does not submit a price.
  if (
    order.amount !== 1900 ||
    order.currency !== "USD" ||
    !/^order_[A-Za-z0-9]+$/.test(order.orderId) ||
    !/^rzp_(test|live)_/.test(order.keyId)
  ) {
    throw new Error(
      "Checkout configuration is unavailable. No payment was started.",
    );
  }
  const Razorpay = await loadCheckout();
  return new Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amount,
    currency: order.currency,
    name: "Stocky History Rescue",
    description: "One merchant archive license — one-time purchase",
    prefill: { email },
    theme: { color: "#065f46" },
    retry: { enabled: false },
    handler: callbacks.success,
    modal: { ondismiss: callbacks.cancelled, confirm_close: true },
  });
}
