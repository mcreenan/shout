# ledger-import

Imports bank CSV exports into one household ledger and prints a monthly summary.

```sh
node src/cli.mjs --bank northwind statements/july.csv statements/august.csv
```

Supported banks are listed in `src/banks.mjs`. Amounts are stored as integer cents. Dates are stored as `YYYY-MM-DD`.

## Layout

| File | Responsibility |
| --- | --- |
| `src/csv.mjs` | Split export text into rows and fields |
| `src/money.mjs` | Parse and format amounts as integer cents |
| `src/dates.mjs` | Normalize bank date formats to ISO dates |
| `src/banks.mjs` | Per-bank column names and formats |
| `src/importer.mjs` | Turn one export into transactions |
| `src/ledger.mjs` | Combine imports into one ledger |
| `src/categorize.mjs` | Keyword categories |
| `src/report.mjs` | Monthly income/spending summary |
| `src/cli.mjs` | Command-line entry point |

Run `npm test` (or `node --test`) before sending changes.
