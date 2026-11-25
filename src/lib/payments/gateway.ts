import "server-only";
import Razorpay from "razorpay";
import { PRODUCT_AMOUNT, PRODUCT_CURRENCY, type PaymentConfig } from "./config";
import type { PaymentGateway, ProviderOrder, ProviderPayment } from "./provider-types";

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The payment provider did not respond in time.")), 15_000); })]);
  } finally { clearTimeout(timer); }
}

export function razorpayGateway(config: PaymentConfig): PaymentGateway {
  const client = new Razorpay({ key_id: config.keyId, key_secret: config.keySecret });
  // Orders carry only a random internal receipt. No email, filenames, supplier,
  // SKU, merchant history, line items, or arbitrary browser notes are forwarded.
  return {
    createOrder: async (receipt) => await bounded(client.orders.create({ amount: PRODUCT_AMOUNT, currency: PRODUCT_CURRENCY, receipt, partial_payment: false })) as ProviderOrder,
    findOrders: async (receipt) => (await bounded(client.orders.all({ receipt, count: 100 }))).items as ProviderOrder[],
    fetchPayment: async (id) => await bounded(client.payments.fetch(id)) as ProviderPayment,
    orderPayments: async (id) => (await bounded(client.orders.fetchPayments(id))).items as ProviderPayment[],
  };
}
