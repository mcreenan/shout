# Real-world example: SHOUT vs stock Codex

`ledger-import/` is a small, dependency-free Node project that imports bank CSV exports into a household ledger. `ledger-import.prompt.md` is a bug ticket (LEDGER-142) with five requirements across CSV quoting, exact money parsing, a new bank profile, date formats and overlap de-duplication. `test/ticket-142.test.mjs` reproduces the ticket: 13 of 25 tests pass before the fix. A correct fix touches six source files.

Unlike the guided scenarios, this runs through **New session** with your own workspace path, so you paste the prompt yourself.

## Run it

```sh
npm run compare -- prepare
```

This creates `.runs/compare/ledger-import-<time>/` with two identical git-initialized copies, `shout/` and `codex/`, prints the exact session settings, and copies the prompt to your clipboard.

1. In SHOUT choose **New session**, select no sample, and set **Live (Codex)**, the printed `shout/` workspace path, and test command `node --test`.
2. Paste the prompt and send it. Watch the **Flow** tab: the router call, `program.loaded`, `workspace.inspect`, then one long model judgment (about 80 seconds in testing), the approval request, `apply_changes` and `run_tests`.
3. Select the **Program** node to read the ALLEN source that ran. It is the built-in `/code` skill (`skills/code.allen`); SHOUT doesn't generate ALLEN per task.
4. Review the six files in **Changes**, then choose **Approve & continue**. If tests fail, ALLEN feeds the failure back and asks for up to two repairs, each needing fresh approval.
5. Run the same prompt through stock Codex on the other copy. It streams a live transcript:

   ```sh
   npm run compare -- codex .runs/compare/ledger-import-<time>
   ```

6. Compare:

   ```sh
   npm run compare -- report .runs/compare/ledger-import-<time>
   ```

   The report re-runs both test suites, then tabulates wall clock, time spent waiting for your approval, machine time, model time, tool calls, test runs, tokens and whether tests were edited. It also shows both transcripts on one relative clock, plus both diffs. It is saved as `report.md` in the run directory.

## Reading the comparison

- Compare SHOUT's **machine time** with Codex's wall clock. SHOUT's wall clock includes the time you spend reviewing the patch.
- Both sides use the same Codex binary and default model. SHOUT calls it as a tool-less worker that returns one structured patch from a snapshot of the files. Stock Codex runs as its normal agent with your config, skills and `AGENTS.md`, reading files and running tests through its shell.
- SHOUT sends the files once, so it uses far fewer input tokens. It writes full before and after file contents, so it produces more output tokens.
- `codex exec` reports each shell command only after it finishes, so Codex's command time can't be separated from its model time.
- Model output varies between runs. Run the comparison more than once before drawing conclusions.
