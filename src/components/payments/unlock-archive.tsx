"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, LoaderCircle, LockKeyhole } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import {
  getEntitlementStatus,
  paymentRequest,
  type CheckoutResult,
  type CreateOrderResponse,
  type EntitlementResponse,
} from "@/src/lib/payments-client";
import { createCheckout, type RazorpayCheckout } from "./razorpay-checkout";

type ViewState =
  | "checking"
  | "ready"
  | "creating"
  | "checkout"
  | "verifying"
  | "pending"
  | "active"
  | "cancelled"
  | "failed"
  | "revoked";
export function UnlockArchive() {
  const [state, setState] = useState<ViewState>("checking");
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"test" | "live" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recoveryOrderId, setRecoveryOrderId] = useState("");
  const checkout = useRef<RazorpayCheckout | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackReceived = useRef(false);
  const currentState = useRef<ViewState>("checking");
  const busy = ["checking", "creating", "checkout", "verifying"].includes(
    state,
  );
  const update = (next: ViewState) => {
    currentState.current = next;
    setState(next);
  };
  function clearPoll() {
    if (polling.current) clearTimeout(polling.current);
    polling.current = null;
  }
  function applyStatus(status: EntitlementResponse) {
    setMode(status.mode);
    update(status.status === "none" ? "ready" : status.status);
    if (status.status === "active") {
      clearPoll();
      setError("");
      setMessage(
        "Payment verified. Your archive license is active in this browser.",
      );
    }
  }

  async function checkStatus(signal?: AbortSignal) {
    const status = await getEntitlementStatus(signal);
    if (!signal?.aborted) applyStatus(status);
    return status;
  }

  function poll(attempt = 0) {
    clearPoll();
    if (attempt >= 12 || lifecycle.current?.signal.aborted) return;
    polling.current = setTimeout(async () => {
      try {
        const status = await checkStatus(lifecycle.current?.signal);
        if (status.status === "pending") poll(attempt + 1);
      } catch (failure) {
        if (!lifecycle.current?.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Payment status could not be checked. Please retry.",
          );
      }
    }, 3000);
  }

  useEffect(() => {
    const active = new AbortController();
    lifecycle.current = active;
    void getEntitlementStatus(active.signal)
      .then((status) => {
        if (active.signal.aborted) return;
        applyStatus(status);
        if (status.status === "pending") poll();
      })
      .catch((failure) => {
        if (active.signal.aborted) return;
        update("ready");
        setError(
          failure instanceof Error
            ? failure.message
            : "License status could not be checked.",
        );
      });
    return () => {
      active.abort();
      clearPoll();
      checkout.current?.close();
    };
    // One initial status read; user actions and bounded pending polling refresh it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(result: CheckoutResult) {
    if (callbackReceived.current || lifecycle.current?.signal.aborted) return;
    callbackReceived.current = true;
    update("verifying");
    setError("");
    try {
      // Copy only the documented payment IDs and signature, never the provider's
      // full callback object or anything from the local archive.
      await paymentRequest<EntitlementResponse>(
        "/api/payments/verify",
        {
          razorpay_order_id: result.razorpay_order_id,
          razorpay_payment_id: result.razorpay_payment_id,
          razorpay_signature: result.razorpay_signature,
        },
        lifecycle.current?.signal,
      );
      const status = await checkStatus(lifecycle.current?.signal);
      if (status.status !== "active" && status.status !== "revoked") {
        update("pending");
        poll();
      }
    } catch (failure) {
      if (lifecycle.current?.signal.aborted) return;
      update("pending");
      setError(
        failure instanceof Error
          ? failure.message
          : "Payment could not yet be verified.",
      );
      poll();
    }
  }

  async function begin(event: FormEvent) {
    event.preventDefault();
    if (["checking", "creating", "checkout", "verifying", "active"].includes(currentState.current)) return;
    update("creating");
    setError("");
    setMessage("");
    clearPoll();
    callbackReceived.current = false;
    try {
      const order = await paymentRequest<CreateOrderResponse>(
        "/api/payments/create-order",
        { email: email.trim() },
        lifecycle.current?.signal,
      );
      if (lifecycle.current?.signal.aborted) return;
      if ("status" in order) {
        const status = await checkStatus(lifecycle.current?.signal);
        if (status.status !== "active" && status.status !== "revoked") {
          update("pending");
          setMessage(
            order.message ??
              "Your payment is being confirmed. Please check its status before paying again.",
          );
          poll();
        }
        return;
      }
      setMode(order.mode);
      const instance = await createCheckout(order, email.trim(), {
        success: (result) => void verify(result),
        cancelled: () => {
          if (
            lifecycle.current?.signal.aborted ||
            callbackReceived.current ||
            currentState.current === "failed"
          )
            return;
          update("cancelled");
          setMessage(
            "Checkout closed. Access has not been granted. If your bank shows a debit, check payment status before trying again.",
          );
        },
      });
      if (lifecycle.current?.signal.aborted) {
        instance.close();
        return;
      }
      instance.on("payment.failed", () => {
        if (callbackReceived.current || lifecycle.current?.signal.aborted)
          return;
        update("failed");
        setError(
          "Payment was not completed. You can retry checkout. If your bank shows a debit, check payment status first.",
        );
      });
      checkout.current = instance;
      update("checkout");
      instance.open();
    } catch (failure) {
      if (lifecycle.current?.signal.aborted) return;
      update("failed");
      setError(
        failure instanceof Error
          ? failure.message
          : "Checkout could not be started.",
      );
    }
  }

  async function refresh() {
    if (busy) return;
    setError("");
    update("checking");
    try {
      const status = await checkStatus(lifecycle.current?.signal);
      if (status.status === "pending") poll();
    } catch (failure) {
      if (!lifecycle.current?.signal.aborted) {
        update("pending");
        setError(
          failure instanceof Error
            ? failure.message
            : "Status could not be checked.",
        );
      }
    }
  }
  async function recover(event: FormEvent) {
    event.preventDefault();
    if (recovering || busy) return;
    setRecovering(true);
    setError("");
    setMessage("");
    try {
      const result = await paymentRequest<{ message: string }>(
        "/api/entitlements/recovery/request",
        { email: email.trim(), ...(recoveryOrderId.trim() ? { orderId: recoveryOrderId.trim() } : {}) },
        lifecycle.current?.signal,
      );
      if (!lifecycle.current?.signal.aborted) setMessage(result.message);
    } catch (failure) {
      if (!lifecycle.current?.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Recovery could not be requested.",
        );
    } finally {
      if (!lifecycle.current?.signal.aborted) setRecovering(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="mb-2 text-xs font-medium text-emerald-800">
          One-time archive license
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
          Unlock your offline archive
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Keep your Stocky history in a searchable archive you can open after
          extraction, without an account or internet connection.
        </p>
      </div>
      <section
        aria-label="Archive license"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Stocky History Rescue</h2>
            <p className="mt-1 text-sm text-slate-600">
              One merchant archive license per purchase. No subscription.
            </p>
          </div>
          <p className="text-3xl font-semibold">
            $19{" "}
            <span className="text-sm font-normal text-slate-500">
              USD, once
            </span>
          </p>
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Includes the offline viewer, unchanged original CSV files, normalized
          purchase orders, line items and supplier observations, a data-quality
          report, and instructions.
        </p>
        {mode === "test" && (
          <p className="mt-4 rounded-md bg-amber-50 p-3 text-sm font-medium text-amber-900">
            Razorpay Test Mode — use test payment details only. A test license
            does not grant live access.
          </p>
        )}
        {state === "active" ? (
          <div className="mt-5 space-y-3">
            <p
              role="status"
              className="flex items-center gap-2 font-medium text-emerald-800"
            >
              <CheckCircle2 className="size-5" aria-hidden="true" />
              License active
            </p>
            <Link
              href="/quality"
              className="inline-flex rounded-md bg-emerald-900 px-4 py-2 text-sm font-medium text-white"
            >
              Go to archive export
            </Link>
          </div>
        ) : (
          <form onSubmit={begin} className="mt-5 space-y-3">
            <label
              htmlFor="license-email"
              className="block text-sm font-medium"
            >
              Email for license recovery
            </label>
            <Input
              id="license-email"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy || recovering}
              placeholder="you@example.com"
            />
            <p className="text-xs leading-5 text-slate-500">
              Use an email address you control. We use it for payment and
              license recovery; you do not need to create an account.
            </p>
            <Button
              type="submit"
              disabled={busy || recovering || state === "pending"}
            >
              {busy && (
                <LoaderCircle
                  className="size-4 motion-safe:animate-spin"
                  aria-hidden="true"
                />
              )}
              {state === "creating"
                ? "Preparing secure checkout…"
                : state === "verifying"
                  ? "Verifying payment…"
                  : state === "checkout"
                    ? "Checkout is open…"
                    : "Pay $19 USD with Razorpay"}
            </Button>
          </form>
        )}
        {state === "pending" && (
          <p
            role="status"
            className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900"
          >
            Payment confirmation is pending. Access starts only after the server
            confirms a captured payment. Please do not pay again while
            confirmation is pending.
          </p>
        )}
        {state === "revoked" && (
          <p role="status" className="mt-4 text-sm text-amber-900">
            This license is no longer active because of a refund or payment
            dispute. Previously downloaded archives continue working offline.
          </p>
        )}
        {state === "checking" && (
          <p role="status" className="mt-4 text-sm text-slate-500">
            Checking license status…
          </p>
        )}
        <div className="mt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Check payment status
          </Button>
        </div>
      </section>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          {error}
        </p>
      )}
      {message && (
        <p
          role="status"
          className="rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          {message}
        </p>
      )}
      <section className="rounded-xl border bg-white p-6">
        <h2 className="text-lg font-semibold">Already purchased?</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Request a secure, expiring recovery link. Recovering a license
          transfers its browser session; it does not upload or restore your
          local CSV files.
          Without an order reference, recovery selects your most recent active license.
        </p>
        <form onSubmit={recover} className="mt-4 space-y-3">
          <label htmlFor="recovery-email" className="block text-sm font-medium">
            Purchase email
          </label>
          <Input
            id="recovery-email"
            type="email"
            autoComplete="email"
            maxLength={254}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy || recovering}
          />
          <label htmlFor="recovery-order" className="block text-sm font-medium">Order reference (optional)</label>
          <Input id="recovery-order" type="text" maxLength={80} pattern="order_[A-Za-z0-9]+" placeholder="order_…" value={recoveryOrderId} onChange={(event) => setRecoveryOrderId(event.target.value)} disabled={busy || recovering} />
          <p className="text-xs text-slate-500">For an older purchase, enter its Razorpay order reference.</p>
          <Button type="submit" variant="outline" disabled={recovering || busy}>
            {recovering ? "Requesting link…" : "Email recovery link"}
          </Button>
        </form>
      </section>
      <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
        <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Your CSV contents, filenames, suppliers, SKUs and purchase-order records
        stay in this browser. Razorpay handles checkout; our server stores only
        payment and license metadata. Keep your original files and exported ZIP
        backed up.
      </p>
    </div>
  );
}
