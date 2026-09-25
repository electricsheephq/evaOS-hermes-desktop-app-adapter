"""evaOS (r34): a plugin whose register() imports ``model_tools`` re-enters plugin discovery from the
load-deadline worker. The fork's process-wide discovery lock must not make that worker wait on the
sweep that is waiting on it (review item R5 on the r34 merge)."""

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]

_PROBE = textwrap.dedent("""
    import json, sys
    assert "model_tools" not in sys.modules
    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    discover_plugins()
    loaded = get_plugin_manager()._plugins["reenter"]
    print(json.dumps({"enabled": bool(loaded.enabled), "error": loaded.error,
                      "registered": bool(getattr(sys.modules.get("reenter_probe_flag"), "ok", False))}))
""")


def test_register_that_imports_model_tools_loads_within_the_default_deadline(tmp_path):
    home = tmp_path / "hermes_home"
    plugin = home / "plugins" / "reenter"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text(yaml.dump({"name": "reenter", "version": "0.1.0", "description": "t"}))
    (plugin / "__init__.py").write_text(textwrap.dedent("""
        import sys, types
        def register(ctx):
            import model_tools  # re-enters discover_plugins() on the load-deadline worker
            flag = types.ModuleType("reenter_probe_flag")
            flag.ok = True
            sys.modules["reenter_probe_flag"] = flag
    """))
    # The normal deadline: no plugins.load_timeout_seconds override.
    (home / "config.yaml").write_text(yaml.safe_dump({"plugins": {"enabled": ["reenter"]}}))
    (tmp_path / "empty-bundled").mkdir()
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_ENABLE_PROJECT_PLUGINS": "0",
           "HERMES_BUNDLED_PLUGINS": str(tmp_path / "empty-bundled"), "PYTHONPATH": str(REPO)}
    env.pop("HERMES_SAFE_MODE", None)
    started = time.monotonic()
    proc = subprocess.run([sys.executable, "-c", _PROBE], cwd=str(REPO), env=env,
                          capture_output=True, text=True, timeout=120)
    elapsed = time.monotonic() - started
    assert proc.returncode == 0, proc.stderr[-2000:]
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    assert result == {"enabled": True, "error": None, "registered": True}, (result, proc.stderr[-2000:])
    assert elapsed < 30, elapsed
