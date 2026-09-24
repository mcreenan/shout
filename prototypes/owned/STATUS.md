# Owned prototype status

Completed: owned chat/session loop, deterministic slash routing, model-selected registered workflow, reusable source runner, native josh/1.6 dispatch, typed judgment/tool/question/result slice, budgets, status/answer/cancel, real-model end-to-end evidence, independent worker restriction audit and automated real-VM/CLI tests.

Current blocker: none. Independent review completed; worker stream-completion gap fixed and regression-tested. No restart-resume claim.

Verification from this directory:

```sh
npm ci
npm test
npm run typecheck
npm run demo
npm run live
npm start -- --fixture
```

All 17 automated tests passed (real-VM/CLI lifecycle plus provider stream-boundary tests), along with JavaScript syntax checks. Direct live run and actual plain-chat -> workflow-selection -> live ALLEN judgment run completed using existing supported Codex login. Human answers in automated live runs are explicitly scripted fixtures. Runtime pin and environment details are in README.md; evidence/live-proof.json preserves the measured result. Ignored raw traces live under .scratch/.
