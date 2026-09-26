"""Portable path options for the r34 compatibility suite (defaults: the CI-prepared siblings)."""


def pytest_addoption(parser):
    group = parser.getgroup("r34_compat")
    group.addoption(
        "--r34-predecessor",
        action="store",
        default=None,
        help="r33.6 runtime checkout (default: ../evaos-r34-r336-baseline)",
    )
    group.addoption(
        "--r34-target-runtime",
        action="store",
        default=None,
        help="runtime tree under test for the cross-process probes (default: this checkout)",
    )
    group.addoption(
        "--r34-lcmx-source",
        action="store",
        default=None,
        help="clean clone containing the pinned LCM-X commit (default: ../evaos-r34-lcmx-source)",
    )
    group.addoption(
        "--r34-lcmx-ref",
        action="store",
        default=None,
        help="commit to materialize instead of the pin (positive controls only)",
    )
