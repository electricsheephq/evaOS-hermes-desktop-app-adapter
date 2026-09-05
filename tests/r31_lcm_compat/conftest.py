"""Portable path options for the r31.1 compatibility fixtures."""


def pytest_addoption(parser):
    group = parser.getgroup("r31_lcm_compat")
    group.addoption(
        "--r31-lcm-source",
        action="store",
        default=None,
        help="clean checkout containing the pinned LCM commit",
    )
    group.addoption(
        "--r31-old-runtime",
        action="store",
        default=None,
        help="r30.7 runtime checkout used by the continuity fixture",
    )
    group.addoption(
        "--r31-target-runtime",
        action="store",
        default=None,
        help="target runtime checkout used by the continuity fixture",
    )
