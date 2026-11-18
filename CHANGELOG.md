# Changelog

Changes are grouped by source version. A version in this file does not imply that a machine has been upgraded or that a release archive has been published.

## 0.3.0 — public source baseline

- CMD launchers reset the child PowerShell module search path to avoid inherited PowerShell 7 modules breaking Windows PowerShell 5.1.
- Uninstall preserves the installation when owned-process shutdown cannot be verified and reports removal failures.

- Replace machine-specific defaults with portable first-run configuration.
- Make WSL and Codex Connect optional for the core agent.
- Add the portable `native` process runtime while retaining the legacy `windows` value.
- Require the current SHA when replacing an existing file through `write_file`.
- Publish reusable documentation, contributor routes, operator skill and development roadmap.
- Add public-package validation and privacy checks to the development workflow.
- Preserve structured file tools, owned process control, exact-target Codex workflows and the direct local MCP bridge.
- Exclude deployment state, machine configuration, private evidence and historical work logs from the public source.

## Earlier implementation history

The 0.2.x implementation introduced direct local MCP registration, supported stdio and Streamable HTTP transports, durable operation receipts and native MCP content forwarding. The earlier core provided file/process tools and a wrapper around a separately installed Codex Connect adapter.

Private deployment reports and machine-specific package snapshots are not part of this public repository.
