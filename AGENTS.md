# Demo Agent Repository

This repository owns the two reconciliation agents and their task message service.
The coordinating baton lives in sibling `hypha-backend/docs/agent/CURRENT-BATON.md`.
Follow its ADR-0019, Agent API v1, and M6-M7 plan. Backend proof contracts remain
authoritative. Use the packaged SDK, never backend source imports.

Keep keys, API tokens, signed issuance attempts, and capability bytes in private
agent runtime storage. Browser and model inputs receive only public identity,
request states, authorized query rows, and bounded task messages. Every data read
uses the SDK and protected gateway. A message grants no data access.

Use the pinned Node/pnpm toolchain and lockfile. Do not add dependencies without
maintainer approval. Run typecheck and focused native Node tests for changes.
Record changed files and evidence in the backend baton. Preserve unknown work.
