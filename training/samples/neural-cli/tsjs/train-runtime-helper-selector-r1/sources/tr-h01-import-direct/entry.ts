import { selectDelivery, type DeliveryMode } from "./lookup";

export function deliverMessage(mode: DeliveryMode, message: string): string {
  return selectDelivery(mode)(message);
}
