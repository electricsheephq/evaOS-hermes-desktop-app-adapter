"""Constructor coverage for Desktop UI callbacks wired by the TUI gateway."""

import agent.agent_init as agent_init_module
from run_agent import AIAgent


def test_aiagent_accepts_and_forwards_annotate_preview_callback(monkeypatch):
    captured = {}
    callback = lambda payload: payload

    def fake_init_agent(agent, **kwargs):
        captured["agent"] = agent
        captured.update(kwargs)

    monkeypatch.setattr(agent_init_module, "init_agent", fake_init_agent)

    instance = AIAgent(annotate_preview_callback=callback)

    assert captured["agent"] is instance
    assert captured["annotate_preview_callback"] is callback
