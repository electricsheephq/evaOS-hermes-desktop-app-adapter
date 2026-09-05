"""Managed --all restarts retain the predecessor's exact supervisor boundary."""

from types import SimpleNamespace

from hermes_cli import gateway


def test_managed_restart_all_uses_only_the_existing_supervisor(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "_refuse_from_inside_gateway", lambda *_: None)
    monkeypatch.setattr(
        gateway,
        "_restart_managed_external_gateway_if_applicable",
        lambda: calls.append("managed-supervisor") or True,
    )
    monkeypatch.setattr(
        gateway,
        "_dispatch_all_via_service_manager_if_s6",
        lambda *_: calls.append("generic-dispatch") or False,
    )
    monkeypatch.setattr(gateway, "_restart_all", lambda *_: calls.append("generic-restart"))

    gateway._cmd_restart(SimpleNamespace(all=True, system=False))

    assert calls == ["managed-supervisor"]


def test_unmanaged_restart_all_retains_upstream_dispatch(monkeypatch):
    calls = []
    monkeypatch.setattr(gateway, "_refuse_from_inside_gateway", lambda *_: None)
    monkeypatch.setattr(gateway, "_restart_managed_external_gateway_if_applicable", lambda: False)
    monkeypatch.setattr(
        gateway,
        "_dispatch_all_via_service_manager_if_s6",
        lambda action: calls.append(("dispatch", action)) or False,
    )
    monkeypatch.setattr(gateway, "_restart_all", lambda system: calls.append(("restart", system)))

    gateway._cmd_restart(SimpleNamespace(all=True, system=True))

    assert calls == [("dispatch", "restart"), ("restart", True)]
