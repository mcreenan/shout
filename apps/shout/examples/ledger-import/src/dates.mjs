const pad = value => String(value).padStart(2, '0');

// Normalizes a bank date to YYYY-MM-DD.
export function parseDate(text, format) {
  const value = String(text).trim();
  let match;
  if (format === 'MM/DD/YYYY' && (match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value))) {
    return `${match[3]}-${pad(match[1])}-${pad(match[2])}`;
  }
  if (format === 'YYYY-MM-DD' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new Error(`Invalid ${format} date: ${text}`);
}
