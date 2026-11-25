export interface ProviderOrder { id: string; amount: number; currency: string; receipt?: string | null; status: string }
export interface ProviderPayment { id: string; order_id: string | null; amount: number; currency: string; status: string; captured: boolean; amount_refunded: number }
export interface PaymentGateway {
  createOrder(receipt: string): Promise<ProviderOrder>;
  findOrders(receipt: string): Promise<ProviderOrder[]>;
  fetchPayment(id: string): Promise<ProviderPayment>;
  orderPayments(id: string): Promise<ProviderPayment[]>;
}
export interface RecoveryMailer { send(email: string, link: string): Promise<void> }
