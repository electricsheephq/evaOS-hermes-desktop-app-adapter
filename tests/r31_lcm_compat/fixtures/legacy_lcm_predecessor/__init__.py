"""A frozen pre-decomposition plugin used only to exercise the real loader gate.

This deliberately imports one of the paths retained by the September 2026
plugin-compat window.  It is not an LCM implementation and must never be used
as a substitute for the pinned hermes-lcm load fixture.
"""


def register(ctx):
    # Keep this import in the predecessor fixture: PluginManager's compatibility
    # scanner sees it before register() executes, and the pre-cutoff load proves
    # that the retained facade still works for an older plugin.
    from agent.context_compressor import tool_result_id_variants

    def _on_session_start(*, session_id):
        return {
            "compat_loaded": bool(tool_result_id_variants("synthetic-r31-call")),
            "session_id": session_id,
        }

    ctx.register_hook("on_session_start", _on_session_start)
