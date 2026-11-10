export type DeliveryMode = "email" | "sms";

const deliveryHandlers = {
  email: (message: string) => `email:${message}`,
  sms: (message: string) => `sms:${message}`,
} satisfies Record<DeliveryMode, (message: string) => string>;

export function selectDelivery(mode: DeliveryMode) {
  return deliveryHandlers[mode];
}
