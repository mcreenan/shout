# Unified agent runtime research

Research and proposal for evolving JOSH/ALLEN into an application that owns the conversation, agent harness, and program execution lifecycle.

**Recommendation:** test an owned harness around the existing ALLEN compiler/VM, alongside a native-adapter and familiar-language baseline. Establish native callbacks before investing in durable workflows or new language features.

- [Read the detailed proposal](docs/unified-agent-runtime-proposal.md)
- [Open the browser edition](docs/unified-agent-runtime-proposal.html) — rendered diagrams, navigation, and print styling; no network required
- [Printable PDF](docs/unified-agent-runtime-proposal.pdf)
- [JOSH/ALLEN source audit](docs/research/josh-allen-audit.md)
- [Harness and protocol research](docs/research/harness-protocols.md)
- [Durable runtime precedents](docs/research/runtime-precedents.md)

Research date: 23 September 2026. JOSH/ALLEN source pinned to [`abb8a978`](https://github.com/mcreenan/josh-allen/tree/abb8a9782fc438d1b87e8aa2fdaea65e5db633c3). The report distinguishes existing capabilities, proposed behavior, estimates, and untested hypotheses. No new harness has been implemented.

The main report includes architecture and lifecycle diagrams, four practical scenarios, a recovery trace, alternatives, obstacles, estimated effort, and explicit continue/pivot criteria. Supporting notes contain primary-source citations and the scope of verification.
