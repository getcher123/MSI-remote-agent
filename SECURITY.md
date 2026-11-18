# Security policy

Please do not publish credentials, private configuration, machine paths,
conversation content, screenshots or runtime logs in public issues.

Read the [security guidance and reporting procedure](docs/SECURITY.md) before
reporting a vulnerability. Use GitHub's private vulnerability reporting option
when it is available for this repository; do not assume that it is enabled.

The agent runs with its OS user's privileges. Executable allowlists and file
roots do not create an operating-system sandbox for spawned programs.

See the [threat model](docs/THREAT_MODEL.md) for supported boundaries and limits.
