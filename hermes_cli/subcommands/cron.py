"""``hermes cron`` subcommand parser.

Extracted verbatim from ``hermes_cli/main.py:main()`` — same arguments, same
``func=cmd_cron`` dispatch. The handler is injected so this module does not
import ``main`` (cycle avoidance).
"""

from __future__ import annotations

from typing import Callable

from hermes_cli.subcommands._shared import add_accept_hooks_flag


def _configure_discord_monitor(args) -> int:
    """Create or re-save one exact-target Discord monitor without raw JSON edits."""
    from cron.jobs import create_job, get_job, update_job
    from cron.scheduler import _notify_provider_jobs_changed
    from hermes_cli.profiles import get_active_profile_name

    existing = get_job(args.job_id) if args.job_id else None
    if args.job_id and not existing:
        print(f"Job not found: {args.job_id}")
        return 1
    prior = (existing or {}).get("preflight") or {}
    same_target = all(str(prior.get(key) or "") == str(value or "") for key, value in {
        "guild_id": args.guild_id,
        "parent_channel_id": args.parent_channel_id,
        "thread_id": args.thread_id,
    }.items())
    checkpoint = args.checkpoint or (prior.get("checkpoint") if same_target else None)
    if not checkpoint:
        print("A checkpoint is required when creating or retargeting a Discord monitor")
        return 1
    preflight = {
        "provider": "discord_scoped",
        "profile": args.profile or get_active_profile_name(),
        "guild_id": args.guild_id,
        "parent_channel_id": args.parent_channel_id,
        "thread_id": args.thread_id,
        "checkpoint": checkpoint,
        "limit": args.limit,
        "max_pages": args.max_pages,
    }
    try:
        if existing:
            job = update_job(args.job_id, {
                "schedule": args.schedule, "prompt": args.prompt,
                "name": args.name or existing.get("name"),
                "deliver": args.deliver or existing.get("deliver"),
                "preflight": preflight,
            })
        else:
            job = create_job(
                args.prompt, args.schedule, name=args.name, deliver=args.deliver,
                preflight=preflight,
            )
    except (TypeError, ValueError) as exc:
        print(f"Failed to configure Discord monitor: {exc}")
        return 1
    _notify_provider_jobs_changed()
    print(f"Configured Discord monitor: {job['id']}")
    return 0


def build_cron_parser(subparsers, *, cmd_cron: Callable) -> None:
    """Attach the ``cron`` subcommand (and its sub-actions) to ``subparsers``."""
    cron_parser = subparsers.add_parser(
        "cron", help="Cron job management", description="Manage scheduled tasks"
    )
    cron_subparsers = cron_parser.add_subparsers(dest="cron_command")

    # cron list
    cron_list = cron_subparsers.add_parser("list", help="List scheduled jobs")
    cron_list.add_argument("--all", action="store_true", help="Include disabled jobs")

    # cron create/add
    cron_create = cron_subparsers.add_parser(
        "create", aliases=["add"], help="Create a scheduled job"
    )
    cron_create.add_argument(
        "schedule", help="Schedule like '30m', 'every 2h', or '0 9 * * *'"
    )
    cron_create.add_argument(
        "prompt", nargs="?", help="Optional self-contained prompt or task instruction"
    )
    cron_create.add_argument("--name", help="Optional human-friendly job name")
    cron_create.add_argument(
        "--deliver",
        help="Delivery target: origin, local, telegram, discord, signal, or platform:chat_id",
    )
    cron_create.add_argument("--repeat", type=int, help="Optional repeat count")
    cron_create.add_argument(
        "--skill",
        dest="skills",
        action="append",
        help="Attach a skill. Repeat to add multiple skills.",
    )
    cron_create.add_argument(
        "--script",
        help=(
            "Path to a script under ~/.hermes/scripts/. Default mode: "
            "script stdout is injected into the agent's prompt each run. "
            "With --no-agent: the script IS the job and its stdout is "
            "delivered verbatim. .sh/.bash files run via bash, everything "
            "else via Python."
        ),
    )
    cron_create.add_argument(
        "--no-agent",
        dest="no_agent",
        action="store_true",
        default=False,
        help=(
            "Skip the LLM entirely — run --script on schedule and deliver "
            "its stdout directly. Empty stdout = silent. Classic watchdog "
            "pattern (memory alerts, disk alerts, CI pings)."
        ),
    )
    cron_create.add_argument(
        "--workdir",
        help="Absolute path for the job to run from. Injects AGENTS.md / CLAUDE.md / .cursorrules from that directory and uses it as the cwd for terminal/file/code_exec tools. Omit to preserve old behaviour (no project context files).",
    )
    cron_create.add_argument(
        "--model",
        help=(
            "Pin this job to a specific inference model (user-owned; the "
            "agent's cronjob tool cannot set this). Omit to follow "
            "cron.model / model.default from config.yaml."
        ),
    )
    cron_create.add_argument(
        "--provider",
        dest="model_provider",
        help="Inference provider paired with --model (e.g. 'openrouter', 'nous').",
    )

    # cron edit
    cron_edit = cron_subparsers.add_parser(
        "edit", help="Edit an existing scheduled job"
    )
    cron_edit.add_argument("job_id", help="Job ID to edit")
    cron_edit.add_argument("--schedule", help="New schedule")
    cron_edit.add_argument("--prompt", help="New prompt/task instruction")
    cron_edit.add_argument("--name", help="New job name")
    cron_edit.add_argument("--deliver", help="New delivery target")
    cron_edit.add_argument("--repeat", type=int, help="New repeat count")
    cron_edit.add_argument(
        "--skill",
        dest="skills",
        action="append",
        help="Replace the job's skills with this set. Repeat to attach multiple skills.",
    )
    cron_edit.add_argument(
        "--add-skill",
        dest="add_skills",
        action="append",
        help="Append a skill without replacing the existing list. Repeatable.",
    )
    cron_edit.add_argument(
        "--remove-skill",
        dest="remove_skills",
        action="append",
        help="Remove a specific attached skill. Repeatable.",
    )
    cron_edit.add_argument(
        "--clear-skills",
        action="store_true",
        help="Remove all attached skills from the job",
    )
    cron_edit.add_argument(
        "--script",
        help=(
            "Path to a script under ~/.hermes/scripts/. Pass empty string to clear. "
            "With --no-agent the script IS the job; otherwise its stdout is "
            "injected into the agent's prompt each run."
        ),
    )
    cron_edit.add_argument(
        "--no-agent",
        dest="no_agent",
        action="store_const",
        const=True,
        default=None,
        help=(
            "Enable no-agent mode on this job (requires --script or an "
            "existing script on the job)."
        ),
    )
    cron_edit.add_argument(
        "--agent",
        dest="no_agent",
        action="store_const",
        const=False,
        help="Disable no-agent mode on this job (reverts to LLM-driven execution).",
    )
    cron_edit.add_argument(
        "--workdir",
        help="Absolute path for the job to run from (injects AGENTS.md etc. and sets terminal cwd). Pass empty string to clear.",
    )
    cron_edit.add_argument(
        "--model",
        help=(
            "Pin this job to a specific inference model (user-owned; the "
            "agent's cronjob tool cannot set this). Pass empty string to "
            "clear the pin and follow cron.model / model.default."
        ),
    )
    cron_edit.add_argument(
        "--provider",
        dest="model_provider",
        help="Inference provider paired with --model. Pass empty string to clear.",
    )

    monitor = cron_subparsers.add_parser(
        "discord-monitor", help="Create or re-save an exact-target Discord monitor"
    )
    monitor.add_argument("schedule")
    monitor.add_argument("prompt")
    monitor.add_argument("--job-id", help="Existing monitor to re-save")
    monitor.add_argument("--name")
    monitor.add_argument("--deliver")
    monitor.add_argument("--profile", help="Defaults to the active profile")
    monitor.add_argument("--guild-id", required=True)
    monitor.add_argument("--parent-channel-id", required=True)
    monitor.add_argument("--thread-id", default="")
    monitor.add_argument("--checkpoint", help="Required for create or retarget")
    monitor.add_argument("--limit", type=int, default=50)
    monitor.add_argument("--max-pages", type=int, default=3)
    monitor.set_defaults(func=_configure_discord_monitor)

    # lifecycle actions
    cron_pause = cron_subparsers.add_parser("pause", help="Pause a scheduled job")
    cron_pause.add_argument("job_id", help="Job ID to pause")

    cron_resume = cron_subparsers.add_parser("resume", help="Resume a paused job")
    cron_resume.add_argument("job_id", help="Job ID to resume")

    cron_run = cron_subparsers.add_parser(
        "run", help="Run a job on the next scheduler tick"
    )
    cron_run.add_argument("job_id", help="Job ID to trigger")
    add_accept_hooks_flag(cron_run)

    cron_remove = cron_subparsers.add_parser(
        "remove", aliases=["rm", "delete"], help="Remove a scheduled job"
    )
    cron_remove.add_argument("job_id", help="Job ID to remove")

    # cron status
    cron_subparsers.add_parser("status", help="Check if cron scheduler is running")

    cron_runs = cron_subparsers.add_parser(
        "runs", aliases=["history"], help="Show durable execution attempts"
    )
    cron_runs.add_argument("job_id", nargs="?", help="Optional job ID filter")
    cron_runs.add_argument("--limit", type=int, default=20, help="Rows to show (1-500)")

    # cron tick (mostly for debugging)
    cron_tick = cron_subparsers.add_parser("tick", help="Run due jobs once and exit")
    add_accept_hooks_flag(cron_tick)
    add_accept_hooks_flag(cron_parser)
    cron_parser.set_defaults(func=cmd_cron)
