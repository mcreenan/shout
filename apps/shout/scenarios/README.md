# Guided coding scenarios

Start SHOUT, choose a scenario, and send its suggested prompt from the chat session. Each launch copies a small project into a unique local scratch workspace; the checked-in templates stay unchanged. All scenarios use real filesystem tools, a real ALLEN program executed by JOSH, an explicit approval before edits, and real Node tests. In **fixture mode**, the proposed code change is a labelled scripted solution; in **live mode**, the model proposes the change.

| Scenario | Starting problem | Expected result after approval |
| --- | --- | --- |
| Fix a checkout calculation | Discount does not reduce the taxable subtotal. Three of four tests fail. | Discount applied first; total rounded to cents; four tests pass. |
| Implement a missing slug utility | Stub returns its input unchanged. All five tests fail. | Lowercase, normalized accents, collapsed separators, and trimmed hyphens; five tests pass. |
| Unify inconsistent validation | Profile accepts names rejected by signup. Two of five tests fail. | Both exported functions share the same trimmed 3–20 character account-name rule; five tests pass. |

In the visualization, follow workspace inspection → model judgment → typed patch proposal → approval → file edits → test command → typed completion. A declined approval should leave the files unchanged. You can cancel a run and inspect its event history. Start a **fresh scenario session** to reset the exercise; rerunning a solved workspace intentionally keeps its edits.

The test command for every scenario is `node --test *.test.mjs`, configured by the app rather than selected by the model. You can also run that command directly from a scenario workspace. To compare behavior, try “Explain why these tests fail before proposing the smallest fix,” then review the proposed changes before approval. Live proposals may vary and must pass the supplied tests; passing tests do not prove arbitrary changes correct.

`solutions/` contains the scripted fixture-mode changes and is not copied into scenario workspaces or shown to the live model. Tests and templates require only Node.js.
