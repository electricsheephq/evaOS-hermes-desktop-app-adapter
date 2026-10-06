"""Regression for adapter#425: replay paired Todo results without loading the executor."""

import json
import subprocess
import sys
from pathlib import Path
from types import MethodType, SimpleNamespace

import pytest

from run_agent import AIAgent
from tools.todo_tool import TodoStore
import tui_gateway.server as server


@pytest.mark.parametrize(
    "tool_name, bridge, restored",
    [("todo_list", False, True), ("todo", False, True),
     ("todo_list", True, True), ("memory", False, False)],
    ids=["todo_list", "todo_legacy", "tool_call_bridge", "unrelated_tool"],
)
def test_paired_history_restores_todo_state(tool_name, bridge, restored):
    todos = [{"id": "1", "content": "probe item", "status": "in_progress"}]
    arguments = {"todos": todos}
    if bridge:
        arguments = {"name": tool_name, "arguments": arguments}
    history = [
        {"role": "user", "content": "plan the work"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {
                "name": "tool_call" if bridge else tool_name,
                "arguments": json.dumps(arguments),
            }},
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": json.dumps({
            "todos": todos, "revision": 3,
        })},
        {"role": "assistant", "content": "done"},
    ]
    agent = SimpleNamespace(_todo_store=TodoStore(), session_id=None, quiet_mode=True)
    agent._latest_todo_response = MethodType(AIAgent._latest_todo_response, agent)
    agent._tool_response_matches_todo_call = AIAgent._tool_response_matches_todo_call

    AIAgent._hydrate_todo_store(agent, history)

    snapshot = agent._todo_store.snapshot()
    assert snapshot["todos"] == (todos if restored else [])
    assert snapshot["revision"] == (3 if restored else 0)
    assert server._todo_state_from_history(history) == (
        {"todos": todos, "revision": 3} if restored else None
    )
    # The shared predicate must still require the response's exact call ID.
    history[2]["tool_call_id"] = "unpaired"
    assert agent._latest_todo_response(history) is None
    assert server._todo_state_from_history(history) is None


def test_todo_import_does_not_load_dispatch_modules():
    result = subprocess.run(
        [sys.executable, "-c", "import sys; import tools.todo_tool; "
         "assert 'model_tools' not in sys.modules; "
         "assert 'agent.tool_executor' not in sys.modules"],
        capture_output=True, text=True, timeout=15, cwd=Path(__file__).resolve().parents[2],
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("bad_name", [["todo"], {"name": "todo"}], ids=["list", "dict"])
def test_malformed_tool_name_is_not_todo_and_does_not_raise(bad_name):
    todos = [{"id": "1", "content": "probe item", "status": "in_progress"}]
    history = [
        {"role": "user", "content": "plan the work"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function", "function": {
                "name": bad_name, "arguments": json.dumps({"todos": todos}),
            }},
        ]},
        {"role": "tool", "tool_call_id": "c1", "content": json.dumps({"todos": todos, "revision": 3})},
    ]
    agent = SimpleNamespace(_todo_store=TodoStore(), session_id=None, quiet_mode=True)
    agent._latest_todo_response = MethodType(AIAgent._latest_todo_response, agent)
    agent._tool_response_matches_todo_call = AIAgent._tool_response_matches_todo_call

    AIAgent._hydrate_todo_store(agent, history)

    assert agent._todo_store.snapshot()["todos"] == []
    assert server._todo_state_from_history(history) is None
