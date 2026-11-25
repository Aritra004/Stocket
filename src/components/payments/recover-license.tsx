"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/src/components/ui/button";
import {
  getEntitlementStatus,
  paymentRequest,
} from "@/src/lib/payments-client";

export function RecoverLicense() {
  const token = useRef("");
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // Strict Mode may repeat effects after the fragment has been cleared.
    // Keep the original in this component's memory until explicit redemption.
    if (!token.current) token.current =
      new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    // Fragments are not sent to the server. Remove the secret from address/history
    // before any request and redeem only after an explicit user click.
    window.history.replaceState(null, "", window.location.pathname);
    setAvailable(/^[A-Za-z0-9_-]{32,256}$/.test(token.current));
  }, []);
  async function redeem() {
    if (busy || !available) return;
    setBusy(true);
    setError("");
    try {
      await paymentRequest("/api/entitlements/recovery/redeem", {
        token: token.current,
      });
      token.current = "";
      setAvailable(false);
      if ((await getEntitlementStatus()).status !== "active")
        throw new Error(
          "The recovered license is not active. Return to Unlock archive to check its status.",
        );
      setDone(true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "This recovery link could not be used. Request a new link.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto max-w-xl space-y-4 rounded-xl border bg-white p-6">
      <h1 className="text-2xl font-semibold">Recover your archive license</h1>
      <p className="text-sm leading-6 text-slate-600">
        This transfers the license to this browser. Your original files and
        downloaded archives stay on their devices; recovery does not retrieve
        CSV data.
      </p>
      {done ? (
        <>
          <p role="status" className="text-sm font-medium text-emerald-800">
            License recovered and verified.
          </p>
          <Link
            href="/quality"
            className="text-sm font-medium text-emerald-800 underline"
          >
            Go to archive export
          </Link>
        </>
      ) : (
        <>
          <Button onClick={() => void redeem()} disabled={!available || busy}>
            {busy ? "Recovering license…" : "Recover license in this browser"}
          </Button>
          {!available && !busy && (
            <p className="text-sm text-slate-600">
              Open the complete recovery link from your email, or request a new
              one.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
      <p>
        <Link href="/unlock" className="text-sm text-emerald-800 underline">
          Return to Unlock archive
        </Link>
      </p>
    </section>
  );
}
