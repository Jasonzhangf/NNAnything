class Basket {
  requestedCount(items: readonly string[]): number {
    return items.length;
  }
}

const basket = new Basket();

export function countRequestedItems(items: readonly string[]): number {
  return basket.requestedCount(items);
}
