import "server-only";
import { createClient } from "@supabase/supabase-js";
import { readPaymentConfig } from "./config";
import { recoveryMailer } from "./email";
import { razorpayGateway } from "./gateway";
import { createPaymentHandlers, paymentFailure } from "./http";
import { SupabasePaymentRepository } from "./repository";
import { PaymentService } from "./service";

type HandlerName = keyof ReturnType<typeof createPaymentHandlers>;
let handlers: ReturnType<typeof createPaymentHandlers> | undefined;

/** Only this server-only boundary reads credentials or constructs service clients. */
export async function dispatchPayment(name: HandlerName, request: Request): Promise<Response> {
  try {
    if (!handlers) {
      const config = readPaymentConfig(process.env);
      const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) }) },
      });
      const repository = new SupabasePaymentRepository(supabase);
      handlers = createPaymentHandlers(new PaymentService(config, repository, razorpayGateway(config), recoveryMailer(config), () => {
        console.error("License recovery email delivery failed.");
      }));
    }
    return await handlers[name](request);
  } catch (error) { return paymentFailure(error); }
}
