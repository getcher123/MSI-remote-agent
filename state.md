# Development state

## Public baseline

The public source baseline is 0.3.0. It makes machine configuration portable, keeps WSL and Codex Connect optional, and includes the existing structured file/process tools and direct local MCP bridge.

This file describes repository development. It is not an inventory of installed machines and is not proof that a production deployment has been upgraded.

## Entry points

- Users: [README.md](README.md) → [installation](docs/INSTALLATION.md) → [runbook](docs/RUNBOOK.md).
- Agents operating a connected machine: [remote-machine skill](skills/remote-machine/SKILL.md).
- Contributors: [AGENTS.md](AGENTS.md) → [CONTRIBUTING.md](CONTRIBUTING.md) → [testing](docs/TESTING.md).
- Planning: [ROADMAP.md](ROADMAP.md).

## Current boundaries

- The agent is a trusted-user tool with the permissions of its OS account. General shell execution is not sandboxed by file roots.
- MCP integrations are selected from local definitions. An application name alone does not establish protocol compatibility.
- Codex Connect relies on separately installed compatible adapter and UI-sender scripts; these are not redistributed here.
- Process sessions are in memory. Durable MCP and Codex receipts remain local and require explicit reconciliation after an uncertain outcome.
- CI and synthetic tests cover repository behavior. Live application, tunnel and desktop UI acceptance require a separately authorized test in the target environment.

## Next development step

Use the prioritized acceptance criteria in [ROADMAP.md](ROADMAP.md). For each change, record its exact commit, test command and result in the pull request. Publish only sanitized, reproducible evidence; keep raw operational results outside the repository.
