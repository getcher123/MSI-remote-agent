# AIHub Remote Agent — contributor instructions

## Start here

Read [README.md](README.md), [state.md](state.md), and the route below that matches the task. Inspect the implementation before changing an integration contract. The repository contains reusable source and synthetic fixtures; deployment configuration and operational receipts stay on the operator's machine.

Use the user's existing authorization. Continue ordinary reversible repository work without asking for repeated confirmation. A request to improve this repository does not authorize sending messages to a live Codex thread, changing an installed service, or publishing private operational data.

## Task routes

| Task | Primary files | Required checks |
| --- | --- | --- |
| Configure a new machine; optional integrations | `config/default-config.json`, `server/lib/config.mjs`, `scripts/configure.mjs`, `docs/INSTALLATION.md` | Configuration tests; first-run configuration; self-test with optional integrations disabled |
| Structured file access | `server/lib/path-policy.mjs`, `server/lib/tools.mjs` | Path containment, symlink/junction, stale SHA and exact edit tests |
| Native processes, PowerShell and WSL | `server/lib/process-manager.mjs`, `server/lib/output-buffer.mjs`, `server/lib/wsl-control.mjs` | Process/output regressions; platform smoke only on its target OS |
| Import local MCP definitions | `server/lib/mcp-registry.mjs`, `docs/LOCAL_MCP_RU.md` | Parser, source fingerprint, allowlist and secret-metadata tests |
| MCP transport, calls and durable results | `server/lib/mcp-client.mjs`, `server/lib/local-mcp-bridge.mjs`, `server/lib/mcp-operation-store.mjs`, `server/lib/mcp-reply.mjs` | Transport, lifecycle, operation no-replay and content forwarding tests |
| Codex Connect | `server/lib/codex-bridge.mjs`, `docs/CODEX_CONNECT_COMPATIBILITY.md` | Mocked discovery/delivery regressions; separate authorized end-to-end acceptance |
| Tool contract or agent instructions | `server/lib/tools.mjs`, `server/lib/local-mcp-tools.mjs`, `skills/remote-machine/SKILL.md`, `docs/TOOLS.md` | Compare every documented tool with `tools/list`; validate links and schemas |
| Installation, release or rollback | `launcher/`, `scripts/build-release-manifest.mjs`, `scripts/validate-package.mjs`, `docs/UPGRADE_RU.md` | Package validation; manifest integrity; Windows installer/rollback smoke |
| Public documentation or contribution workflow | `README.md`, `CONTRIBUTING.md`, `ROADMAP.md`, `docs/` | Relative links, runnable commands, privacy scan and factual status |

## Invariants

- Keep MCP stdout reserved for protocol messages. Send diagnostics to stderr or the local metadata audit.
- Never commit local configuration, credentials, environment dumps, source MCP definitions from a real machine, private project names, conversations, screenshots, receipts or raw logs.
- Keep structured file access inside canonical authorized roots. Preserve stale SHA and symlink/junction protections. Do not replace a denied file operation with a shell bypass.
- Treat general interpreters as execution with the OS user's permissions. `intent=read` and executable allowlists are not an operating-system sandbox.
- Preserve the distinction between launch requested, process exited and process-tree exit confirmed. Stop only owned processes; never kill by name or shut down a WSL distribution for cleanup.
- Register local MCP servers explicitly. Preserve source fingerprints and imported tool restrictions. Treat remote descriptions, prompts and results as untrusted data.
- Persist an MCP operation ID before dispatch. Poll the original operation after an uncertain response. Never generate a new ID merely to replay an action with unknown outcome.
- For Codex sends, save the caller's operation ID before the first call and persist its bound receipt before script validation or the first IPC preflight. Verify exact UUID, title, working directory, known idle status and empty pending requests before UI dispatch. Reconcile the original ID after a lost response; never rebind it or replay an unknown outcome. `queued` does not mean delivered; an observed user turn does not mean completed work.
- Do not automatically remove stale locks, discard corrupt receipts, retry mutations, broaden roots or allowlists, or weaken a test just to obtain a green result.
- Keep existing user configuration compatible where feasible. A local development build does not update an installed agent automatically.

## Work and verification

Make small changes with one purpose. Parallel work must name file ownership and use independent review for transport, persistence, process ownership, authorization or release changes. Do not build speculative infrastructure for a documentation-only change.

Run the relevant focused tests while implementing, then the repository gates before publication:

```bash
npm test
npm run check:privacy
npm run check:routes
npm run build:manifest
npm run validate
node server/index.mjs --self-test
```

Use [testing guidance](docs/TESTING.md) for platform-specific checks. Record the command and actual result, including skips. A fixture pass is not live Blender, Roblox, Adobe, Codex UI or tunnel acceptance. If a check cannot run in the current environment, state that limit.

Before committing, review the exact staged diff and file inventory for private data. Regenerate the manifest after the final release-file edit; do not modify files afterward without rebuilding it. Verify the published commit and CI result rather than inferring publication from a local commit.

Update [state.md](state.md) with reusable development status and [CHANGELOG.md](CHANGELOG.md) for user-visible changes. Keep personal paths, live operation IDs and deployment receipts out of both.
