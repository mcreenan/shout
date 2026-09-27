// Converts a statement amount such as "$1,234.56" or "-12.50" to integer cents.
export function parseAmount(text) {
  const value = parseFloat(String(text).replace(/[$,\s]/g, ''));
  if (Number.isNaN(value)) throw new Error(`Invalid amount: ${text}`);
  return Math.round(value * 100);
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
