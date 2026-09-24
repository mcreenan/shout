Native adapter working: real pinned ALLEN runtime + Codex 0.153.3 dynamic tool + nested real Codex model judgment + deterministic tool + correlated user answer + typed parent return.

Completed: reusable bounded source/input runner, interactive CLI, fixture/live demos, 8 real-VM lifecycle acceptance tests, budgets and cancellation, visible trace/counters, docs and protocol findings. Formatting, syntax checks, offline tests and a second successful live run completed. Root interactive smoke confirms answer/duplicate/cancel paths.

Commands: npm ci; npm run typecheck; npm test; npm run demo; npm run live; npm start.

Known limits: independent model.request, no same-agent agent.ask, Boolean user schema only, one pending question/run, no restart recovery, existing app-server configuration may advertise builtins (unexpected tool activity is detected and rejected, not claimed impossible).
