"""Plugin grants for cron's per-job toolset overrides."""

import logging

logger = logging.getLogger(__name__)


def merge_plugins_into_per_job_toolsets(
    per_job: list[str], cfg: dict, mcp_merged: list[str],
) -> list[str]:
    """Add cron-enabled plugins only when the job has no explicit plugin selection.

    Stale and unknown names preserve an allowlist after a plugin is uninstalled or renamed.
    Discovery must be live: the persisted nowait cache is safe for exclusions, not grants.
    """
    try:
        from hermes_cli.plugins import discover_plugins, get_plugin_toolsets
        from hermes_cli.tools_config import (
            _coerce_platform_toolsets_value,
            _enabled_plugin_toolsets,
            enabled_mcp_server_names,
        )
        from toolsets import TOOLSETS

        discover_plugins()
        plugin_keys = {key for key, _, _ in get_plugin_toolsets()}
        known_plugins = {
            key
            for keys in (cfg.get("known_plugin_toolsets") or {}).values()
            for key in keys
        }
        non_plugin_keys = (
            set(TOOLSETS) | {"all", "*", "no_mcp"}
            | enabled_mcp_server_names(cfg) | set(cfg.get("mcp_servers") or {})
        )
        if any(
            name in plugin_keys or name in known_plugins or name not in non_plugin_keys
            for name in per_job
        ):
            return mcp_merged

        platform_toolsets = cfg.get("platform_toolsets") or {}
        saved = _coerce_platform_toolsets_value(platform_toolsets.get("cron"), "cron")
        enabled_plugins = _enabled_plugin_toolsets(
            cfg, "cron", saved if isinstance(saved, list) else [], plugin_keys,
        )
        return mcp_merged + sorted(enabled_plugins - set(mcp_merged))
    except Exception:
        logger.warning("Cron plugin toolset lookup failed; keeping the MCP-merged per-job list")
        return mcp_merged
