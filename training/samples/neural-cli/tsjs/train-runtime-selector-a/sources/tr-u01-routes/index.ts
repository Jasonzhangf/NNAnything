type DeliveryChannel = "mail" | "chat";

const deliveryRoutes: Record<DeliveryChannel, (payload: string) => string> = {
  mail: payload => `mail:${payload}`,
  chat: payload => `chat:${payload}`,
};

export function routeMessage(channel: DeliveryChannel, payload: string): string {
  return deliveryRoutes[channel](payload);
}
