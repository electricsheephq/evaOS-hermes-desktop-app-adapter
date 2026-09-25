"""evaOS (r34, EVAOS-LEGACY-PROMPT-SHIM; rs35: delete — see docs/r34-managed-delta.md §SHIM).

Desktop builds before es.10 speak the pre-r34 prompt protocol: they listen for ``<kind>.request`` /
``<kind>.expire`` events, answer with ``<kind>.respond`` RPCs, restore a clarify card from
``pending_clarify`` on resume/activate, and never send ``client.capabilities``. The r34 runtime asks
with server→client requests (``srq-…`` frames) that such a client drops silently. This module keeps
those builds working while the fleet desktop moves to es.10:

- twin at the edge: after a real ``srq`` frame for a covered kind is written, and while a WebSocket
  client that never advertised server→client requests is attached to the session (or was, sticky),
  the legacy ``<kind>.request`` event follows it; a ``request.cancel`` for it gets ``<kind>.expire``.
- answer into the same request: ``<kind>.respond`` RPCs (never registered, so they stay out of the
  contract catalog) delegate to the upstream ``request.answer`` / ``clarify.lock`` handlers — one wait,
  first answer wins, a late answer is ``expired``.
- ``pending_clarify`` on the live-session snapshot is derived from the open requests.
- ``connectors.list`` / ``connectors.connect``: es.9 names the session as ``{session_id}``; r34 takes
  ``owner``. The session owner is rebuilt from that id and the runtime then derives the profile and
  checks transport authority exactly as it does for a native client; a client ``owner`` is never
  rewritten.

``HERMES_EVAOS_LEGACY_PROMPT_SHIM=0`` (read per call) turns all of it off: the runtime then behaves as
the raw tag. Pure at import: ``server_requests`` imports it; the rest is rebound onto server.py's
namespace (``bind_module``) and uses its globals bare.
"""

import os

from .method_ctx import bind_module

_LP_ENV = "HERMES_EVAOS_LEGACY_PROMPT_SHIM"
# srq method -> (legacy event prefix, es.9 respond key | None = native RPC, upstream result key, the twin
# carries the srq id as request_id, the kind has a legacy .expire). Approval keeps its queue request_id and
# its native approval.respond / .pending / .received.
_LP_KINDS = {
    "clarify": ("clarify", "answer", "answer", True, True),
    "approval": ("approval", None, None, False, False),
    "sudo": ("sudo", "password", "value", True, True),
    "secret": ("secret", "value", "value", True, True),
    "tour": ("tour", "text", "value", True, True),
    "vault.unlock_prompt": ("vault.unlock", "password", "value", True, True),
    "vault.save_login": ("vault.save_login", "login", "value", True, True),
    "vault.code": ("vault.code", "code", "value", True, True),
}
_LP_RESPONDS = {f"{kind[0]}.respond": (srq_method, kind) for srq_method, kind in _LP_KINDS.items() if kind[1]}
_LP_CONNECTOR_METHODS = frozenset({"connectors.list", "connectors.connect"})
_LP_USED: set = set()


def legacy_prompt_enabled() -> bool:
    return os.environ.get(_LP_ENV, "1").strip().lower() not in {"0", "false", "no", "off"}


def legacy_prompt_covers(method: str) -> bool:
    """Whether a legacy client can answer *method* through this shim (``server_requests._unanswerable``)."""
    return method in _LP_KINDS and legacy_prompt_enabled()


def _lp_payload(method: str, params: dict, request_id: str) -> dict:
    out = {k: v for k, v in params.items() if k != "session_id"}
    if _LP_KINDS[method][3]:
        out["request_id"] = request_id
    return out


def _lp_twin_wanted(sid: str) -> bool:
    session = _sessions.get(sid)
    if session is None:
        return False
    from tui_gateway import server_requests
    from tui_gateway.ws import WSTransport
    peers = [p for p in _session_live_transports(session) if isinstance(p, WSTransport)]
    if any(not server_requests.answers_requests(p) for p in peers):
        session["_lp_seen"] = True  # sticky: a legacy client served this session
        return True
    return bool(session.get("_lp_seen")) and not peers  # detached legacy session: keep the replay ring fed


def _lp_after_write(obj) -> None:
    """``write_json`` hook, AFTER the real frame (in-process or relayed from a compute-host child)."""
    if not isinstance(obj, dict):
        return
    params = obj.get("params") if isinstance(obj.get("params"), dict) else {}
    method = obj.get("method")
    try:
        if isinstance(obj.get("id"), str) and method in _LP_KINDS:
            sid = str(params.get("session_id") or "")
            if legacy_prompt_enabled() and _lp_twin_wanted(sid):
                _emit(f"{_LP_KINDS[method][0]}.request", sid, _lp_payload(method, params, obj["id"]))
        elif method == "event" and params.get("type") == "request.cancel":
            payload = params.get("payload") if isinstance(params.get("payload"), dict) else {}
            kind = _LP_KINDS.get(payload.get("method"))
            sid = str(params.get("session_id") or "")
            if kind and kind[4] and legacy_prompt_enabled() and _lp_twin_wanted(sid):
                _emit(f"{kind[0]}.expire", sid, {"request_id": payload.get("id")})
    except Exception:
        logger.debug("legacy prompt twin failed", exc_info=True)  # a twin must never break the real frame


def _legacy_prompt_respond(rid, method: str, params: dict) -> dict | None:
    """``rpc_dispatch`` hook: a legacy ``<kind>.respond``, or None to continue normal dispatch."""
    entry = _LP_RESPONDS.get(method)
    if entry is None or method in _methods or not legacy_prompt_enabled():  # never shadow a real handler
        return None
    srq_method, kind = entry
    request_id = str(params.get("request_id") or "")
    if not request_id:
        return _err(rid, 4009, f"no pending {kind[1]} request")  # es.9 matches this text
    raw = params.get(kind[1], "")
    answer = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
    if method not in _LP_USED:
        _LP_USED.add(method)
        logger.info("legacy prompt shim served %s (pre-es.10 client)", method)
    if srq_method == "clarify" and (question_id := str(params.get("question_id") or "")):
        return _methods["clarify.lock"](rid, {"request_id": request_id, "question_id": question_id, "answer": answer})
    # A batch clarify answered with no question_id is es.9's cancel-all: no "answers" key → the tool gets "".
    return _methods["request.answer"](rid, {"id": request_id, "result": {kind[2]: answer}})


def _legacy_prompt_snapshot(sid: str, session: dict) -> dict | None:
    """``_live_session_payload`` hook: the open clarify as es.9's ``pending_clarify`` (locked answers included)."""
    if not legacy_prompt_enabled():
        return None
    from tui_gateway import server_requests
    from tui_gateway.ws import WSTransport
    transport = current_transport()
    if isinstance(transport, WSTransport) and not server_requests.answers_requests(transport):
        session["_lp_seen"] = True
    for entry in _open_requests(sid):  # includes the compute-host mirror
        if entry.get("method") == "clarify" and isinstance(entry.get("params"), dict):
            return _lp_payload("clarify", entry["params"], str(entry["id"]))
    return None


def _legacy_connector_params(method: str, params: dict) -> dict:
    """``_normalize_request`` hook: es.9's ``{session_id}`` connector shape → the r34 session ``owner``."""
    if method not in _LP_CONNECTOR_METHODS or "owner" in params or not legacy_prompt_enabled():
        return params
    sid = params.get("session_id")
    if not isinstance(sid, str) or not sid:
        return params
    out = {k: v for k, v in params.items() if k != "session_id"}
    out["owner"] = {"type": "session", "session_id": sid}
    return out


def register(server):
    bind_module(globals(), server)
