// Column layouts for supported bank CSV exports.
export const banks = {
  northwind: { delimiter: ',', date: 'Date', description: 'Description', amount: 'Amount', dateFormat: 'MM/DD/YYYY' },
  ledgerline: { delimiter: ',', date: 'posted', description: 'memo', amount: 'amount', dateFormat: 'YYYY-MM-DD' },
};

export function bankProfile(name) {
  const profile = banks[name];
  if (!profile) throw new Error(`Unsupported bank: ${name}. Supported: ${Object.keys(banks).join(', ')}`);
  return profile;
}
