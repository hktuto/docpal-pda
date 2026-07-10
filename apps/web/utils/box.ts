export function boxTotalQty(items: { qty: number }[]): number {
  return items.reduce((sum, item) => sum + item.qty, 0);
}
