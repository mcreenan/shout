export function checkoutTotal(subtotal, discountPercent, taxPercent) {
  const tax = subtotal * taxPercent / 100;
  const discount = subtotal * discountPercent / 100;
  return Math.round((subtotal + tax - discount) * 100) / 100;
}
