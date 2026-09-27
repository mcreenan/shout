import { parseCsv } from './csv.mjs';
import { parseAmount } from './money.mjs';
import { parseDate } from './dates.mjs';
import { bankProfile } from './banks.mjs';
import { categorize } from './categorize.mjs';

// Converts one bank export into ledger transactions.
export function importStatement(text, { bank = 'northwind' } = {}) {
  const profile = bankProfile(bank);
  const [header = [], ...rows] = parseCsv(text, { delimiter: profile.delimiter });
  const column = name => {
    const index = header.indexOf(name);
    if (index === -1) throw new Error(`Missing column "${name}" in ${bank} export`);
    return index;
  };
  const at = { date: column(profile.date), description: column(profile.description), amount: column(profile.amount) };
  return rows.map(row => {
    const description = row[at.description];
    return {
      date: parseDate(row[at.date], profile.dateFormat),
      description,
      amountCents: parseAmount(row[at.amount]),
      category: categorize(description),
    };
  });
}
