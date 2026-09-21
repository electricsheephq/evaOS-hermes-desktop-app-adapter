"""The blocked-overflow warning must not claim a stall a compaction already cleared.

``CONTEXT_OVERFLOW_BLOCKED_WARNING_TEMPLATE`` measures against the COMPRESSION
THRESHOLD, a fraction of the model's context window.  A successful compaction
arms the anti-thrash breaker, so the very next preflight sees "over threshold +
compression blocked" and told the user *"The model may stop responding"* about a
context that fits the effective input window with room to spare.

Only the still-at-or-past-the-effective-input-window case keeps that warning.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent.status_output import StatusOutputMixin


class _Agent(StatusOutputMixin):
    """Minimal carrier for the two methods under test."""

    def __init__(self, *, context_length: int, awaiting: bool, max_tokens: int | None = None):
        self.context_compressor = SimpleNamespace(
            context_length=context_length,
            max_tokens=max_tokens,
            awaiting_real_usage_after_compression=awaiting,
        )
        self.warnings: list[str] = []
        self._last_ctx_overflow_warn = None
        self.touches: list[str] = []

    def _emit_warning(self, message: str) -> None:
        self.warnings.append(message)

    def _touch_activity(self, reason: str, provenance=None) -> None:
        self.touches.append(reason)


# 96K window; the compression threshold sits far below it, so ~40K tokens is
# "over threshold" while still less than half the window.
_WINDOW = 96_000
_THRESHOLD = 33_600
_FITS_WINDOW = 40_000
_PAST_WINDOW = 99_000


def test_no_stall_warning_when_compaction_result_fits_the_window():
    agent = _Agent(context_length=_WINDOW, awaiting=True)

    agent._warn_context_overflow_blocked("ineffective", _FITS_WINDOW, _THRESHOLD)

    assert agent.warnings == []
    # The dedup key stays unset so a genuinely over-window turn can still warn.
    assert agent._last_ctx_overflow_warn is None
    # Activity is still touched: only the user-facing line changed.
    assert agent.touches == ["compression blocked (ineffective)"]


def test_warning_kept_when_the_result_is_still_at_the_window():
    agent = _Agent(context_length=_WINDOW, awaiting=True)

    agent._warn_context_overflow_blocked("ineffective", _PAST_WINDOW, _THRESHOLD)

    assert len(agent.warnings) == 1
    assert "The model may stop responding" in agent.warnings[0]
    assert agent._last_ctx_overflow_warn == ("ctx_overflow_blocked", "ineffective")


def test_warning_kept_when_result_exceeds_reserved_input_window():
    agent = _Agent(context_length=100_000, max_tokens=20_000, awaiting=True)

    agent._warn_context_overflow_blocked("ineffective", 90_000, _THRESHOLD)

    assert len(agent.warnings) == 1
    assert "The model may stop responding" in agent.warnings[0]


def test_no_warning_when_result_fits_reserved_input_window():
    agent = _Agent(context_length=100_000, max_tokens=20_000, awaiting=True)

    agent._warn_context_overflow_blocked("ineffective", 70_000, _THRESHOLD)

    assert agent.warnings == []
    assert agent._last_ctx_overflow_warn is None


def test_warning_kept_when_no_compaction_ran():
    """A block with no compaction behind it is the original #11529 case: still warn."""
    agent = _Agent(context_length=_WINDOW, awaiting=False)

    agent._warn_context_overflow_blocked("cooldown:30", _FITS_WINDOW, _THRESHOLD)

    assert len(agent.warnings) == 1
    assert "The model may stop responding" in agent.warnings[0]


@pytest.mark.parametrize("context_length", [0, None, "96000"])
def test_warning_kept_when_the_window_is_unknown(context_length):
    """No usable window figure — fail visible rather than silently swallowing."""
    agent = _Agent(context_length=context_length, awaiting=True)

    agent._warn_context_overflow_blocked("ineffective", _FITS_WINDOW, _THRESHOLD)

    assert len(agent.warnings) == 1


def test_suppressed_turn_does_not_consume_the_dedup_slot():
    """After a suppressed turn, the next genuinely over-window turn still warns."""
    agent = _Agent(context_length=_WINDOW, awaiting=True)

    agent._warn_context_overflow_blocked("ineffective", _FITS_WINDOW, _THRESHOLD)
    assert agent.warnings == []

    agent._warn_context_overflow_blocked("ineffective", _PAST_WINDOW, _THRESHOLD)
    assert len(agent.warnings) == 1
