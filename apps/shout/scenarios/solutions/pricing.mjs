export function checkoutTotal(subtotal, discountPercent, taxPercent) {
  const discountedSubtotal = subtotal * (1 - discountPercent / 100);
  return Math.round(discountedSubtotal * (1 + taxPercent / 100) * 100) / 100;
}
