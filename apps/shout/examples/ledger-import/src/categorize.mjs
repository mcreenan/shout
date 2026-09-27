const rules = [
  ['groceries', /\b(?:rewe|aldi|trader joe|whole foods|safeway)\b/i],
  ['coffee', /\b(?:starbucks|blue bottle|cafe)\b/i],
  ['shopping', /\b(?:amazon|target|ikea)\b/i],
  ['transport', /\b(?:uber|lyft|shell|deutsche bahn)\b/i],
  ['income', /\b(?:payroll|salary|gehalt)\b/i],
];

export function categorize(description) {
  return rules.find(([, pattern]) => pattern.test(description))?.[0] ?? 'uncategorized';
}
