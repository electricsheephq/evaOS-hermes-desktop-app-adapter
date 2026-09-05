"""Cron aggregation must not perform full profile metadata scans."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from hermes_cli import web_server
import hermes_cli.web_server_cron as _web_server_cron


class CronProfileEnumerationTests(unittest.TestCase):
    def test_uses_lightweight_name_path_enumerator(self):
        with tempfile.TemporaryDirectory() as root:
            homes = [
                ("default", Path(root)),
                ("coder-01", Path(root) / "profiles" / "coder-01"),
            ]
            with (
                mock.patch(
                    "hermes_cli.profiles.profiles_to_serve",
                    return_value=homes,
                ) as lightweight,
                mock.patch(
                    "hermes_cli.profiles.list_profiles",
                    side_effect=AssertionError("full profile scan is forbidden"),
                ),
            ):
                result = _web_server_cron._cron_profile_dicts()

        lightweight.assert_called_once_with(multiplex=True)
        self.assertEqual([item["name"] for item in result], ["default", "coder-01"])
        self.assertTrue(result[0]["is_default"])
        self.assertFalse(result[1]["is_default"])

    def test_managed_process_uses_only_its_owner(self):
        """The cron listing must consume the owner-only lightweight seam.

        ``profiles_to_serve`` is the current defining module's routing
        chokepoint; a managed process supplies only its owner even when the
        caller asks for multiplexed enumeration.  A full metadata scan is a
        forbidden fallback for this path.
        """
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / "profiles" / "main"
            with (
                mock.patch(
                    "hermes_cli.managed_profile_scope.managed_profile_name",
                    return_value="main",
                ),
                mock.patch("hermes_constants.get_hermes_home", return_value=home),
                mock.patch(
                    "hermes_cli.profiles.profiles_to_serve",
                    side_effect=AssertionError(
                        "managed process must not enumerate siblings"
                    ),
                ),
                mock.patch(
                    "hermes_cli.profiles.list_profiles",
                    side_effect=AssertionError("full profile scan is forbidden"),
                ),
            ):
                result = _web_server_cron._cron_profile_dicts()

        self.assertEqual(
            [{key: item[key] for key in ("name", "path", "is_default")} for item in result],
            [{"name": "main", "path": str(home), "is_default": False}],
        )


if __name__ == "__main__":
    unittest.main()
