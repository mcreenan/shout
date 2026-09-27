// Splits exported statement text into rows of trimmed string fields.
export function parseCsv(text, { delimiter = ',' } = {}) {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.split(delimiter).map(field => field.trim()));
}
