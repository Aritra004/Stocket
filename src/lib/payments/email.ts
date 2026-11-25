import "server-only";
import { randomUUID } from "node:crypto";
import type { PaymentConfig } from "./config";
import type { RecoveryMailer } from "./provider-types";

export function recoveryMailer(config: PaymentConfig): RecoveryMailer {
  return {
    async send(email, link) {
      if (!config.emailApiKey || !config.emailFrom) throw new Error("Recovery email is unavailable.");
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${config.emailApiKey}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ from: config.emailFrom, to: [email], subject: "Recover your Stocky History Rescue license", text: `Use this link to recover your selected active Stocky History Rescue merchant archive license:\n\n${link}\n\nThe link expires in 15 minutes and can be used once. Confirm recovery on the page to transfer license access to this browser; the prior browser session loses access. Existing downloaded archives remain independent and work offline.\n\nIf you did not request this, ignore this email. No license changes happen until recovery is confirmed.` }),
      });
      // Never log the provider response, email address, or secret recovery URL.
      if (!response.ok) throw new Error("Recovery email could not be delivered. Please retry later.");
    },
  };
}
