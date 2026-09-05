"""Subprocess probe for old-runtime -> target -> old-runtime store continuity."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from hermes_cli.plugins import PluginManager


SESSION = "r31-subprocess-session"
CONVERSATION = "r31-subprocess-conversation"
FIRST_MARKER = "r31-pinned-subprocess-first-marker"
SECOND_MARKER = "r31-pinned-subprocess-target-marker"
THIRD_MARKER = "r31-pinned-subprocess-old-runtime-marker"


def _assert_highlighted_marker(payload: str, suffix: str) -> None:
    decoded = json.loads(payload)
    if not isinstance(decoded, dict) or "error" in decoded:
        raise AssertionError(decoded)
    results = decoded.get("results")
    if not isinstance(results, list):
        raise AssertionError(decoded)
    snippets = [
        str(result["snippet"])
        for result in results
        if isinstance(result, dict) and "snippet" in result
    ]
    if not any(">>>pinned<<<" in snippet and suffix in snippet for snippet in snippets):
        raise AssertionError({"suffix": suffix, "snippets": snippets})


def _manager(home: Path) -> PluginManager:
    empty_bundled = home / "_empty-bundled-plugins"
    empty_bundled.mkdir(exist_ok=True)
    os.environ["HOME"] = str(home / "_os-home")
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HERMES_BUNDLED_PLUGINS"] = str(empty_bundled)
    manager = PluginManager()
    manager.discover_and_load()
    loaded = manager._plugins.get("hermes-lcm")
    if loaded is None or not loaded.enabled or loaded.error is not None:
        raise AssertionError(
            {
                "plugin": "hermes-lcm",
                "enabled": getattr(loaded, "enabled", None),
                "error": getattr(loaded, "error", None),
            }
        )
    engine = manager._context_engine
    if engine is None or engine.name != "lcm":
        raise AssertionError({"context_engine": getattr(engine, "name", None)})
    return manager


def _run(phase: str, home: Path) -> dict[str, object]:
    manager = _manager(home)
    engine = manager._context_engine
    assert engine is not None
    engine.on_session_start(
        SESSION,
        hermes_home=str(home),
        platform="synthetic",
        conversation_id=CONVERSATION,
    )
    try:
        if phase == "old-seed":
            engine.ingest([{"role": "user", "content": FIRST_MARKER}])
            _assert_highlighted_marker(
                engine.handle_tool_call("lcm_grep", {"query": "pinned"}),
                "first-marker",
            )
            return {"phase": phase, "seen": ["first"]}

        if phase == "target-append":
            _assert_highlighted_marker(
                engine.handle_tool_call("lcm_grep", {"query": "pinned"}),
                "first-marker",
            )
            engine.ingest([{"role": "user", "content": SECOND_MARKER}])
            combined = engine.handle_tool_call("lcm_grep", {"query": "pinned"})
            _assert_highlighted_marker(combined, "first-marker")
            _assert_highlighted_marker(combined, "target-marker")
            return {"phase": phase, "seen": ["first", "target"]}

        if phase == "old-verify-append":
            combined = engine.handle_tool_call("lcm_grep", {"query": "pinned"})
            _assert_highlighted_marker(combined, "first-marker")
            _assert_highlighted_marker(combined, "target-marker")
            engine.ingest([{"role": "user", "content": THIRD_MARKER}])
            _assert_highlighted_marker(
                engine.handle_tool_call("lcm_grep", {"query": "pinned"}),
                "old-runtime-marker",
            )
            return {"phase": phase, "seen": ["first", "target", "old-runtime"]}

        raise ValueError(f"unknown phase: {phase}")
    finally:
        engine.shutdown()


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: runtime_store_probe.py PHASE HERMES_HOME")
    result = _run(sys.argv[1], Path(sys.argv[2]).expanduser())
    print(json.dumps({"ok": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
