# Guided coding scenarios

Start SHOUT, choose a sample on the welcome screen, and send its prefilled prompt. Each choice copies a small project into a new sample project under the state directory's `workspaces/`; the checked-in templates stay unchanged. All scenarios use real filesystem tools, a real ALLEN program executed by JOSH, an explicit approval before edits, and real Node tests. The model proposes the change.

| Scenario | Starting problem | Expected result after approval |
| --- | --- | --- |
| Fix a checkout calculation | Discount does not reduce the taxable subtotal. Three of four tests fail. | Discount applied first; total rounded to cents; four tests pass. |
| Implement a missing slug utility | Stub returns its input unchanged. All five tests fail. | Lowercase, normalized accents, collapsed separators, and trimmed hyphens; five tests pass. |
| Unify inconsistent validation | Profile accepts names rejected by signup. Two of five tests fail. | Both exported functions share the same trimmed 3–20 character account-name rule; five tests pass. |

In Flow mode, follow the agent's step and then, usually, the `/code` run: workspace inspection → the edit judgment → approval → file edits → `tests.run`, repeated inside the attempt loop when tests fail. A declined approval should leave the files unchanged. You can cancel a run and inspect its event history. Choose the sample again for a fresh copy; another thread in the same sample project keeps the earlier edits.

The test command for every scenario is `node --test *.test.mjs`, set as the sample project's test command rather than chosen by the model. You can also run that command directly from a scenario workspace. To compare behavior, try “Explain why these tests fail before proposing the smallest fix,” then review the proposed changes before approval. Live proposals may vary and must pass the supplied tests; passing tests do not prove arbitrary changes correct.

`solutions/` holds reference solutions: tests use them to check that each scenario is solvable, and the browser test's scripted judgments return them. They are never copied into scenario workspaces or shown to the model. Tests and templates require only Node.js.
