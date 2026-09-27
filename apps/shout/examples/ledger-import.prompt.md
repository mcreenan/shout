LEDGER-142: Real bank exports break the import, and overlapping statements double-count spending.

Fix the importer so these cases work. test/ticket-142.test.mjs reproduces every case from the ticket; make it pass without editing any tests, and keep the existing tests passing.

1. CSV parsing (src/csv.mjs): support standard quoting. A quoted field can contain the delimiter, a doubled quote ("") meaning a literal quote, and newlines. Handle CRLF line endings. Keep trimming unquoted fields and skipping blank lines.
2. Amounts (src/money.mjs): parseAmount(text, { decimal }) returns exact integer cents. Accounting parentheses such as (12.50) or ($1,000.00) are negative. With decimal ',' the grouping separator is '.', for example 1.234,56. Reject malformed grouping and more than two decimal places with "Invalid amount" instead of rounding. Don't do money math in floating point.
3. Exports that start with a UTF-8 byte order mark must still find their first column.
4. Add the rheinbank profile: semicolon-delimited, columns Buchungstag / Verwendungszweck / Betrag, D.M.YYYY dates (day and month may be one digit), and comma decimal amounts.
5. mergeImports(existing, incoming) in src/ledger.mjs must not double-count overlapping statements. Two transactions match when date, amountCents and description agree, ignoring case, surrounding whitespace and repeated inner spaces. Genuine repeats are real spending: if the ledger holds N copies of a transaction and the import holds M, add only max(0, M - N) of them. Keep existing order, append new ones in import order, and don't mutate the inputs.

Keep all exported function names and signatures backwards compatible. Run the test suite with `node --test` to confirm.
