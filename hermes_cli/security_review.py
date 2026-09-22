"""Read-only security review of profile-installed Hermes extensions."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from agent.skill_utils import get_all_skills_dirs, iter_skill_index_files, parse_frontmatter
from hermes_constants import get_hermes_home
from hermes_cli.config import load_config_readonly
from hermes_cli.mcp_security import validate_mcp_server_entry
from hermes_cli.plugins_discovery import discover_entrypoint_manifests, scan_directory
from tools.plugin_guard import scan_plugin
from tools.skills_guard import scan_skill
from tools.skills_sync import _matches_origin_hash, _read_manifest


def _clean(text: object, limit: int = 120) -> str:
    value = "".join(char if char.isprintable() else " " for char in str(text))
    value = " ".join(value.split()).replace("|", "¦")
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _top_findings(findings: Iterable[object]) -> str:
    severity = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    ranked = sorted(findings, key=lambda finding: severity.get(
        str(getattr(finding, "severity", "")).lower(), 4))
    summaries = []
    for finding in ranked[:3]:
        pattern = getattr(finding, "pattern_id", "finding")
        description = getattr(finding, "description", "review required")
        summaries.append(_clean(f"{pattern}: {description}"))
    return "; ".join(summaries) or "none"


def _skill_name(skill_md: Path) -> str:
    try:
        metadata, _body = parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return skill_md.parent.name
    return str(metadata.get("name") or skill_md.parent.name)


def _rows(home: Path) -> list[tuple[object, object, object, object]]:
    rows: list[tuple[object, object, object, object]] = []
    for manifest in scan_directory(home / "plugins", "user"):
        plugin_dir = Path(manifest.path)
        result = scan_plugin(plugin_dir, source="installed")
        rows.append((manifest.key or manifest.name, "plugin", result.verdict,
                     _top_findings(result.findings)))
    for manifest in discover_entrypoint_manifests():
        rows.append((manifest.key or manifest.name, "plugin", "caution",
                     "entry-point target cannot be statically scanned; review its package source"))

    bundled, seen = _read_manifest(), set()
    for skills_dir in get_all_skills_dirs():
        if not skills_dir.is_dir():
            continue
        for skill_md in iter_skill_index_files(skills_dir, "SKILL.md"):
            if skill_md in seen or any(part.startswith(".") for part in skill_md.relative_to(skills_dir).parts):
                continue
            seen.add(skill_md)
            name = _skill_name(skill_md)
            if name in bundled and _matches_origin_hash(skill_md.parent, bundled[name]):
                continue
            result = scan_skill(skill_md.parent, source="installed")
            rows.append((name, "skill", result.verdict, _top_findings(result.findings)))

    config = load_config_readonly() or {}
    servers = config.get("mcp_servers") if isinstance(config, dict) else None
    if isinstance(servers, dict):
        for name, entry in sorted(servers.items(), key=lambda pair: str(pair[0])):
            issues = validate_mcp_server_entry(str(name), entry) if isinstance(entry, dict) else []
            rows.append((name, "mcp", "dangerous" if issues else "safe",
                         "; ".join(_clean(issue) for issue in issues[:3]) or "none"))
    return rows


def _print_table(rows: list[tuple[object, object, object, object]]) -> None:
    all_rows = [("item", "kind", "verdict", "top findings"), *rows]
    safe_rows = [tuple(_clean(value) for value in row) for row in all_rows]
    widths = [max(len(row[index]) for row in safe_rows) for index in range(4)]
    for index, row in enumerate(safe_rows):
        print(" | ".join(value.ljust(widths[column]) for column, value in enumerate(row)))
        if index == 0:
            print("-+-".join("-" * width for width in widths))


def main() -> int:
    _print_table(_rows(get_hermes_home()))
    return 0
