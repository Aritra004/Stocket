import { dispatchPayment } from "@/src/lib/payments/runtime";
export async function POST(request: Request) { return dispatchPayment("redeemRecovery", request); }
