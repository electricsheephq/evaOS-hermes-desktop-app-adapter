"""r34 R13: every request shape evaOS Desktop es.9 sends passes the merged contract catalog.

The tag's params contracts are ``extra="forbid"`` (an unknown key answers ``4000``). es.9 predates
them, so every key it sends must be declared. ``es9_rpc_shapes.json`` is the audited inventory of
es.9's call sites (method, params incl. the keys its routing wrappers add).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import tui_gateway.server as server
from tui_gateway.contracts import registry as contracts

_SHAPES = json.loads((Path(__file__).with_name("es9_rpc_shapes.json")).read_text(encoding="utf-8"))["shapes"]


def _cases():
    for shape in _SHAPES:
        yield pytest.param(shape, id=f"{shape['method']}@{shape['site']}")


@pytest.mark.parametrize("shape", list(_cases()))
def test_es9_request_shape_is_accepted_by_the_merged_contracts(shape):
    method = shape["method"]
    assert method in server._methods, f"{method} is not registered on the merged backend"
    contract = contracts.METHODS.get(method)
    assert contract is not None, f"{method} has no wire contract"
    params = dict(shape["params"])
    # ---- BEGIN EVAOS-LEGACY-PROMPT-SHIM (rs35: delete; docs/r34-managed-delta.md) ----
    # connectors.list/connect: upstream moved ``{session_id}`` to a required ``owner`` object; the dispatcher's
    # request normalization carries es.9's shape over (tests/tui_gateway/test_legacy_prompt_shim.py, R13).
    _, _, params = server._normalize_request({"id": 1, "method": method, "params": params})
    # ---- END EVAOS-LEGACY-PROMPT-SHIM ----
    _, problem = contracts.validate_params(contract, params)
    assert problem is None, problem


@pytest.mark.parametrize("method", ["session.create", "session.resume", "session.activate"])
def test_desktop_ui_protocol_is_declared_on_every_session_bind(method):
    """es.9 adds ``desktop_ui_protocol: 3`` to every session create/resume/activate."""
    contract = contracts.METHODS[method]
    params = {"desktop_ui_protocol": 3} if method == "session.create" else {"session_id": "x", "desktop_ui_protocol": 3}
    _, problem = contracts.validate_params(contract, params)
    assert problem is None, problem
