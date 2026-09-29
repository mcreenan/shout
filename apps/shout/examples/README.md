# Real-world example: SHOUT vs stock Codex

`ledger-import/` is a small, dependency-free Node project that imports bank CSV exports into a household ledger. `ledger-import.prompt.md` is a bug ticket (LEDGER-142) with five requirements across CSV quoting, exact money parsing, a new bank profile, date formats and overlap de-duplication. `test/ticket-142.test.mjs` reproduces the ticket: 13 of 25 tests pass before the fix. A correct fix touches six source files.

Unlike the samples, this runs in a project you add yourself, so you paste the prompt.

## Run it

```sh
npm run compare -- prepare
```

This creates `.runs/compare/ledger-import-<time>/` with two identical git-initialized copies, `shout/` and `codex/`, runs the baseline tests, prints the steps below with the paths and the test command, and copies the prompt to your clipboard.

1. In SHOUT choose **Add project** and pick the printed `shout/` folder; it opens with a new thread. Right-click the thread, choose **Project settings** and set the test command to `node --test`. In the thread, pick a Codex model; stock Codex uses the model in your Codex config, so pick the same one for a like-for-like run.
2. Paste the prompt and send it. Switch the chat to **Flow** to watch the agent's step and, usually, the `/code` run: reading the workspace, the edit judgment, the approval and `tests.run`.
3. Open the run's program (the code button on its run card, or **Program** in the Inspector) to read the ALLEN source that ran, with how often each effect line ran. Usually it is the built-in `/code` skill (`skills/code.allen`); the agent may instead write its own program with `run_program`.
4. Review the proposed files (each chip on the approval card opens Changes at that file), then choose **Approve**. If tests fail, `/code` feeds the failure back and asks for up to two repairs, each needing its own approval.
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
- SHOUT's agent is a Codex app-server thread restricted to SHOUT's tools, and `/code`'s judgments are tool-less calls that see a snapshot of the selected files and return snippet edits, which SHOUT turns into a full diff for approval. Stock Codex runs as its normal agent with your config, skills and `AGENTS.md`, reading files and running tests through its shell.
- `codex exec` reports each shell command only after it finishes, so Codex's command time can't be separated from its model time.
- Model output varies between runs. Run the comparison more than once before drawing conclusions.
