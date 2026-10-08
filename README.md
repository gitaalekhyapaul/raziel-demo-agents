# Raziel Reconciliation Agents

Two persistent agents consume the packaged Raziel SDK. Agent A reads the processor
ledger. Agent B reads bank settlements and returns a bounded match result through
the authenticated task channel. The backend operator reviews their requests in a
third dashboard. All demonstration records are synthetic.

## Current Checkpoint

B-0067 implements identities, tasks, SDK-only request/sign/query flows, the message
channel, bounded OpenAI-compatible tools, and desktop dashboards. Focused checks use
the real SDK signing code with controlled request responses. The connected VM proof
and three-dashboard recording are not yet validated. There is no mock-proof switch.

Compatibility: backend `c5efbfb`, SDK runtime base `e7f1cd6`, public npm package
`@gitaalekhyapaul/raziel-sdk-ts@0.1.0`. The manifest pins the exact release and the
lockfile pins its registry integrity. Docker installs it from the public registry.
No npm token or login is needed to install. Both local development and VM builds
use this same exact dependency. pnpm reuses its local package store and downloads
missing content from npm. The earlier candidate archive is removed from this
checkout. Its checksum and source commit remain in Git history and the backend
release evidence.
The pnpm workspace setting exempts only this verified, freshly published `0.1.0`
from the package-age check. It does not disable that check for other packages.
Node `24.18.0` and pnpm `11.14.0` match the backend toolchain.

## Container Startup

Build the backend's pinned `raziel-toolchain:m0` image first. No host Rust, Go, SP1,
or pnpm install is needed. Run these commands in this repository:

```bash
cp .env.example .env.agents
chmod 0600 .env.agents
```

Edit `.env.agents` with a private dashboard password and two distinct random channel
tokens, each at least 32 characters. Never commit this file. For the SoC model, set
`SOCLAAS_ENV_PATH` to the private `soclaas.env` file outside this repository. It uses
`SOCLAAS_BASE_URL`, `SOCLAAS_MODEL`, and `SOCLAAS_API_KEY`. LLM-prefixed variables take
precedence. Without a model file the manual task commands remain available.
Do not set `LLM_ENV_FILE` for Compose env-file injection. That option is for native
processes which read a private file directly.

```bash
docker compose --env-file .env.agents build --pull=false agent-a
docker compose --env-file .env.agents up -d --wait
docker compose --env-file .env.agents ps
```

The dashboards bind VM loopback ports `3001` and `3002`. The channel publishes no
host port. Separate volumes retain keys, tokens, task attempts, and business messages.
The container filesystem is read-only and each process runs without root capabilities.
The default volume owner is UID/GID `1000`. Set `AGENT_UID` and `AGENT_GID` before the
first build for a different owner. Do not change those values on existing volumes.

Forward all three dashboard ports from the Mac:

```bash
ssh -N -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 -L 3002:127.0.0.1:3002 gapaul-vm-i
```

Open the operator at port `3000`, Agent A at `3001`, and Agent B at `3002`. Changed
browser ports or public URLs require their exact origins in `AGENT_A_ORIGINS` and
`AGENT_B_ORIGINS`. The API URL and audience are separate connection settings.

## Connection Boundary

In each agent's **Identity** view, copy its public key. Register that key in the
operator's **Agents** page and issue its own token. Return to **Identity** and save
the Raziel API URL, exact registration audience, and token. The token is write-only
in the browser and retained in the agent's private volume.

The URL must be reachable from the agent process. The SDK permits HTTP only for
loopback addresses and requires HTTPS elsewhere. A Docker service name or
`host.docker.internal` is not loopback. Supply a trusted HTTPS operator endpoint
for the container demo, such as the installation's existing HTTPS tunnel. SSH browser
forwarding alone does not create that container API endpoint. Do not weaken the SDK
transport checks or join agents to backend owner networks to bypass this boundary.

The backend runs its ngrok tunnel inside Docker Compose on the active backend host.
Set `RAZIEL_API_BASE_URL` in `.env.agents` to the same fixed HTTPS origin as the
backend's `RAZIEL_NGROK_URL`. Both agents receive that default, and their Identity
forms prefill it before the first connection. Save each agent's separate token and
exact registration audience through that form. A retained connection overrides the
startup default. No automatic connection, token migration, or identity change occurs.

The backend's `docs/runbooks/M7-AGENT-DEMO.md` documents VM startup with
`./scripts/start-m6-demo --ngrok` and Mac-only tunnel startup with `./scripts/start-ngrok`.
No host ngrok process or agent tunnel is needed. Keep only one backend tunnel active
for that fixed domain. Stop the VM tunnel before using the domain for a Mac backend.
Changing hosts does not transfer backend registrations, tasks, or capability state.
The public tunnel permits agent and protected-query APIs, not operator pages.
Dashboard access stays local or SSH-forwarded at `13000`, `13001`, and `13002`.

This development route passes agent API traffic through ngrok's cloud service.
Use synthetic demo records, not private production data. Local request inspection
is disabled. That setting is not a guarantee about provider-side access or retention.

## Desktop Flow

1. In the operator **Datasets** page, seed the two reconciliation ledgers. They are
   drafts. Edit rows as needed, then finalize each exact revision.
2. Publish a supported policy independently of the requests.
3. Agent A: **Tasks**, **New task**, select the processor dataset and revision, then
   request access. Its signed intent appears in the operator inbox.
4. Operator: approve the exact request and installed policy. The agent polls, signs
   the exact snapshot-bound proposal, retains that attempt, and waits for the serial
   Plonk proof. A timeout retries the retained intent or signing attempt.
5. Agent A: query the authorized rows. Send a settlement lookup using a returned
   transaction reference, or run the configured agent tool loop.
6. Agent B: start a task from that lookup, select the bank dataset, then request its
   own access. Approve it and wait for its separate proof.
7. Agent B: query the bank rows and send settlement evidence. Agent A displays the
   bounded reply. Amount differences use integer arithmetic, not model arithmetic.
8. Edit the authorized-row UTC window and query again with the same capability.
   The task, dataset, and agent binding stay fixed. The SDK refreshes request signatures.
   The receipt identifies `VERIFIER` or `CACHE`. Expiry and revocation remain enforced.

Pause stops new automatic agent actions, not an already admitted proof or an in-flight
API call. A signature completed during Pause stays private for exact reuse on Resume.
Cancel uses the SDK cancellation API. Paused cancellations keep status polling until
the terminal result. Resume explicitly handles `WAITING_FOR_AGENT`. Retry preserves
the original request or pending message ID. Restart retains the identity and task.
The model never receives tokens, keys, proof bytes, PolicyIR, or private graph facts.
A provider failure preserves task state for a manual retry.

The seed includes exact, missing, and ambiguous settlements. Matching is limited to
the authorized query range. A full 100-row page cannot establish an exhaustive match
or absence. Narrow the range before sending evidence. A receipt records access, not
cryptographic proof of business reconciliation correctness.

## Checks And State

### SDK Release Updates

SDK changes are made and validated in the sibling `raziel-sdk-ts` repository.
Publish a new version, then update this repository's exact dependency and lockfile:

```bash
pnpm add --save-exact @gitaalekhyapaul/raziel-sdk-ts@<released-version>
pnpm typecheck
pnpm test
```

Commit the agent dependency update after these checks. VM pulls use that committed
version, then rebuild the agent image. Frozen installs never follow `latest` or
silently update a running agent. An unchanged SDK release needs no new publication.

### Local Checks

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm format:check
```

With the required packages already in the local pnpm store, installation can run
without registry access:

```bash
pnpm install --frozen-lockfile --offline
```

An empty or incomplete cache requires the normal install command above. Do not
use a cache-directory path as a package dependency or switch manifests between
local development and the VM.

Run checks with the backend's pinned Docker toolchain. The package adds no LLM SDK or
agent framework. Native Node HTTP, fetch, crypto, and TypeScript support serve the app.
Local state is ignored under `.state/`. Secrets and raw provider failures must not
enter diagnostics. `docker compose config` can display interpolated secrets. Do not
paste that output. Stop/start retains state. Never use `down --volumes` to fix an error.
