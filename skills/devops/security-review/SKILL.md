---
name: security-review
description: Audit installed plugins, skills, and MCP servers.
version: 1.0.0
author: Eva (@100yenadmin), Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [security, plugins, skills, mcp]
    category: devops
---

# Security Review Skill

Audit profile-installed plugins, non-bundled skills, and configured MCP servers with Hermes' shipped scanners. The review is read-only: it installs nothing, deletes nothing, and sends nothing.

## When to Use

- Run after any external plugin, skill, or MCP server install.
- Run whenever the user asks for an extension security review.

## Prerequisites

- Use the active profile and its runtime Python interpreter as the profile user.
- Use `terminal`; never elevate privileges or switch users for this review.

## How to Run

Run the bundled script with `terminal`:

```text
hermes security review
```

Show the complete table to the user.

## Quick Reference

| Verdict | Action |
|---|---|
| `safe` | The shipped scanners found no blocking pattern. |
| `caution` | Show the findings. Re-run the install with `--force` only after the user's explicit yes. |
| `dangerous` | Do not install and never use `--force`. |

## Procedure

1. Run the script once after the external install or on request.
2. Explain the top findings without exposing secret values.
3. For `caution`, ask for an explicit yes before any `--force` install retry.
4. For `dangerous`, refuse the install path and offer removal or a trusted alternative.

To add an MCP server non-interactively after review, use:

```text
printf 'y\n' | hermes mcp add <name> --command … --args …
```

A newly installed or enabled plugin is picked up only when the Hermes agent and gateway processes restart — ask your operator. `/reload-mcp` re-reads MCP servers and `/reload-skills` re-scans skills in the current session; neither reloads plugins.

## Pitfalls

- A `safe` static scan is not proof that remote services are trustworthy.
- Never summarize `caution` as approval.
- Never bypass a `dangerous` result with `--force`.

## Verification

- The output contains one row per installed plugin, non-bundled skill, and configured MCP server.
- Every row has item, kind, verdict, and top findings.
- No files, configuration, network services, or installs were changed.
