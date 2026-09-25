---
title: "Security Review — Audit installed plugins, skills, and MCP servers"
sidebar_label: "Security Review"
description: "Audit installed plugins, skills, and MCP servers"
---

{/* This page is auto-generated from the skill's SKILL.md by website/scripts/generate-skill-docs.py. Edit the source SKILL.md, not this page. */}

# Security Review

Audit installed plugins, skills, and MCP servers.

## Skill metadata

| | |
|---|---|
| Source | Bundled (installed by default) |
| Path | `skills/devops/security-review` |
| Version | `1.0.0` |
| Author | Eva (@100yenadmin), Hermes Agent |
| License | MIT |
| Platforms | linux, macos |
| Tags | `security`, `plugins`, `skills`, `mcp` |

## Reference: full SKILL.md

:::info
The following is the complete skill definition that Hermes loads when this skill is triggered. This is what the agent sees as instructions when the skill is active.
:::

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
