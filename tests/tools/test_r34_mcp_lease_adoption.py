"""r34 intake: N3 -- a managed lease connection is never adopted across profiles."""

from __future__ import annotations

from tests.tools.test_mcp_multiplex_connection_keys import _server, two_profiles  # noqa: F401
from tests.tools.test_r34_mcp_lease_reexpress import _pcs_config


def test_lease_connection_is_never_adopted_across_profiles(two_profiles):  # noqa: F811
    """N3: two routed profiles with the same server name and app, different accounts: B gets its
    own connection. Identical lease entries are not adopted across profiles either -- the lease
    is minted for the owning profile, like an OAuth grant."""
    from tools import mcp_tool_discovery as disc
    from tools import mcp_tool_registration as reg

    cfg_a = dict(_pcs_config(), account_id="apn_accountA")
    cfg_b = dict(_pcs_config(), account_id="apn_accountB")

    two_profiles("a")
    srv_a = _server("x", cfg_a)
    disc._adopt_server("x", srv_a)
    srv_a._registered_tool_names = reg._register_server_tools("x", srv_a, cfg_a)

    two_profiles("b")
    assert reg._same_server_route(srv_a, cfg_b, cross_profile=True) is False
    assert reg._same_server_route(srv_a, dict(cfg_a), cross_profile=True) is False
    assert reg._same_server_route(srv_a, dict(cfg_a), cross_profile=False) is True
    assert reg.register_connected_into_current_scope({"x": cfg_b}) == 0
    assert reg.register_connected_into_current_scope({"x": dict(cfg_a)}) == 0
