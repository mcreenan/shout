// Summarizes transactions per month, oldest first.
export function monthlySummary(transactions) {
  const months = new Map();
  for (const { date, amountCents, category } of transactions) {
    const key = date.slice(0, 7);
    const month = months.get(key) ?? { month: key, incomeCents: 0, spendingCents: 0, byCategory: {} };
    if (amountCents >= 0) month.incomeCents += amountCents;
    else {
      month.spendingCents += -amountCents;
      month.byCategory[category] = (month.byCategory[category] ?? 0) + -amountCents;
    }
    months.set(key, month);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}
