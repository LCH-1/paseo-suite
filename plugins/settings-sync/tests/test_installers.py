import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


source = Path(__file__).resolve().parent.parent
shell = os.environ.get("SYNC_TEST_POWERSHELL", "powershell.exe")


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="paseo-install-test-"))
        self.home = self.root / "호스트 [active] & user's home"
        self.package = self.root / "릴리즈 [active] & user's plugin"
        self.old = self.root / "기존 [active] & user's plugin"
        self.foreign = self.root / "다른 작업의 plugin"
        self.state_file = self.root / "state.json"
        self.fake_bin = self.root / "bin"
        self.fake_bin.mkdir()
        self.make_package(self.package, "0.3.15", "new-code")
        self.make_package(self.old, "0.3.14", "old-code")
        self.make_package(self.foreign, "9.0.0", "foreign-code")
        shutil.copytree(source / "install", self.package / "install")
        (self.home / "settings-sync").mkdir(parents=True)
        self.checkpoint = self.home / "settings-sync" / "automation.json"
        self.checkpoint.write_text("synthetic encrypted checkpoint", encoding="utf-8")
        self.state = {"home": str(self.home), "current": self.entry(self.old), "global": True, "calls": [], "foreign": str(self.foreign)}
        fake = source / "tests" / "fixtures" / "fake-install-cli.py"
        for tool in ["paseo", "gh", "unzip"]:
            if os.name == "nt":
                content = "@echo off\r\n\"" + sys.executable + "\" -X utf8 \"" + str(fake) + "\" " + tool + " %*\r\nexit /b %errorlevel%\r\n"
                (self.fake_bin / (tool + ".cmd")).write_bytes(content.encode("utf-8"))
            else:
                executable = self.fake_bin / tool
                executable.write_text("#!/usr/bin/env bash\nexec " + shlex.quote(sys.executable) + " -X utf8 " + shlex.quote(str(fake)) + " " + tool + " \"$@\"\n", encoding="utf-8")
                executable.chmod(0o755)
        self.env = {**os.environ, "PATH": str(self.fake_bin) + os.pathsep + os.environ["PATH"], "PASEO_HOME": str(self.home), "PASEO_HOST": "must-not-use.invalid", "SYNC_INSTALL_FIXTURE": str(self.state_file), "PYTHONUTF8": "1", "LOCALAPPDATA": str(self.root / "Local AppData [audit]"), "HOME": str(self.root / "user-home")}
        self.env = {key: value for key, value in self.env.items() if key.casefold() != "psmodulepath"}
        Path(self.env["HOME"]).mkdir()

    def tearDown(self):
        self.assertEqual(self.root.parent.resolve(), Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith("paseo-install-test-"))
        shutil.rmtree(self.root)

    def make_package(self, directory, version, marker):
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
        (directory / "paseo-plugin.json").write_text(json.dumps({"id": "settings-sync"}), encoding="utf-8")
        (directory / "code-marker").write_text(marker, encoding="utf-8")

    def entry(self, directory, enabled=True, kind="directory"):
        return {"id": "settings-sync", "path": str(directory), "enabled": enabled, "status": "running" if enabled else "disabled", "installation": {"identity": {"kind": kind}}}

    def execute(self, wrapper=False):
        self.state_file.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")
        if wrapper:
            command_source = (source / "client" / "install-commands.ts").read_text(encoding="utf-8")
            name = "windowsInstall" if os.name == "nt" else "ubuntuInstall"
            command = command_source.split("export const " + name + " = `", 1)[1].split("`;", 1)[0].replace("\\\\", "\\")
            script = self.root / ("wrapper.ps1" if os.name == "nt" else "wrapper.sh")
            script.write_text(command, encoding="utf-8-sig" if os.name == "nt" else "utf-8")
        else:
            script = self.package / "install" / ("install.ps1" if os.name == "nt" else "install.sh")
        arguments = [shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)] if os.name == "nt" else ["bash", str(script)]
        result = subprocess.run(arguments, env=self.env, capture_output=True, timeout=60, check=False)
        self.state = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(self.checkpoint.read_text(encoding="utf-8"), "synthetic encrypted checkpoint")
        return result

    def mutations(self):
        return [call[:2] for call in self.state["calls"] if call[:2] != ["plugin", "ls"] and call[:3] != ["daemon", "config", "get"]]

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace")[-3500:])
        self.assertTrue(self.state["current"]["enabled"])
        self.assertEqual(self.state["current"]["status"], "running")
        self.assertEqual((Path(self.state["current"]["path"]) / "code-marker").read_text(encoding="utf-8"), "new-code")

    def make_archive(self):
        archive = self.root / "download.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
            for file in self.package.rglob("*"):
                if file.is_file():
                    zipped.write(file, "settings-sync/" + file.relative_to(self.package).as_posix())
        self.state["archive"] = str(archive)

    def test_fresh_install_enables_only_after_validating_release(self):
        self.state["current"] = None
        self.state["global"] = False
        self.assert_success(self.execute())
        self.assertEqual(self.mutations(), [["daemon", "config"], ["plugin", "install"]])

    def test_existing_directory_is_replaced_without_duplicate_id_or_code_loss(self):
        self.assert_success(self.execute())
        self.assertEqual(self.mutations(), [["plugin", "remove"], ["plugin", "install"]])
        self.assertEqual((self.old / "code-marker").read_text(encoding="utf-8"), "old-code")

    def test_multiple_plugins_do_not_get_selected_as_one_sync_entry(self):
        other = {**self.entry(self.foreign), "id": "unrelated-plugin"}
        self.state["other_plugins"] = [other]
        self.assert_success(self.execute())
        self.assertEqual(self.state["other_plugins"], [other])
        self.assertEqual(self.mutations(), [["plugin", "remove"], ["plugin", "install"]])

    def test_other_plugins_do_not_prevent_a_fresh_sync_install(self):
        other = {**self.entry(self.foreign), "id": "unrelated-plugin"}
        self.state["other_plugins"] = [other]
        self.state["current"] = None
        self.make_archive()
        self.assert_success(self.execute(wrapper=True))
        self.assertEqual(self.state["other_plugins"], [other])
        self.assertEqual(self.mutations(), [["plugin", "install"]])

    def test_failed_update_with_other_plugins_recovers_only_sync(self):
        other = {**self.entry(self.foreign), "id": "unrelated-plugin"}
        self.state["other_plugins"] = [other]
        self.state["fail_install"] = "after"
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.state["current"]["path"], str(self.old))
        self.assertEqual(self.state["current"]["status"], "running")
        self.assertEqual(self.state["other_plugins"], [other])

    def test_install_command_explicitly_activates_a_disabled_plugin(self):
        self.state["current"] = self.entry(self.old, enabled=False)
        self.assert_success(self.execute())

    def test_numerical_version_order_accepts_point_ten_after_point_nine(self):
        (self.old / "package.json").write_text("{\"version\":\"0.3.9\"}", encoding="utf-8")
        (self.package / "package.json").write_text("{\"version\":\"0.3.10\"}", encoding="utf-8")
        self.assert_success(self.execute())

    def test_older_release_cannot_mutate_a_newer_installation(self):
        (self.package / "package.json").write_text("{\"version\":\"0.3.7\"}", encoding="utf-8")
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.state["current"]["path"], str(self.old))

    def test_unknown_installed_version_is_not_silently_replaced(self):
        (self.old / "package.json").write_text("{\"version\":\"development\"}", encoding="utf-8")
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_invalid_cli_json_does_not_change_any_configuration(self):
        self.state["bad_json"] = True
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_failed_remove_keeps_the_existing_running_plugin(self):
        self.state["fail_remove"] = True
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.state["current"]["path"], str(self.old))
        self.assertEqual(self.mutations(), [["plugin", "remove"]])

    def test_install_failure_before_registration_restores_previous_code(self):
        self.state["fail_install"] = "before"
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.state["current"]["path"], str(self.old))
        self.assertEqual(self.state["current"]["status"], "running")

    def test_install_failure_after_registration_restores_previous_disabled_state(self):
        self.state["current"] = self.entry(self.old, enabled=False)
        self.state["fail_install"] = "after"
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.state["current"]["path"], str(self.old))
        self.assertFalse(self.state["current"]["enabled"])

    def test_removed_managed_source_recovers_from_a_preserved_copy(self):
        managed = self.home / "plugins" / "settings-sync" / "v1"
        self.make_package(managed, "0.3.14", "old-code")
        self.state["current"] = self.entry(managed, kind="git")
        self.state["fail_install"] = "after"
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertFalse(managed.exists())
        self.assertEqual((Path(self.state["current"]["path"]) / "code-marker").read_text(encoding="utf-8"), "old-code")

    def test_foreign_replacement_is_preserved_when_installation_fails(self):
        self.state["fail_install"] = "foreign"
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertEqual(self.state["current"]["path"], str(self.foreign))
        self.assertEqual(self.mutations(), [["plugin", "remove"], ["plugin", "install"]])

    def test_fresh_failure_restores_the_global_switch_and_removes_only_failed_registration(self):
        self.state["current"] = None
        self.state["global"] = False
        self.state["fail_install"] = "after"
        self.assertNotEqual(self.execute().returncode, 0)
        self.assertIsNone(self.state["current"])
        self.assertFalse(self.state["global"])

    def test_copied_download_command_verifies_and_executes_its_installer(self):
        self.make_archive()
        self.state["current"] = None
        self.assert_success(self.execute(wrapper=True))

    def test_bad_checksum_stops_the_copied_command_before_any_paseo_call(self):
        self.make_archive()
        self.state["bad_checksum"] = True
        self.assertNotEqual(self.execute(wrapper=True).returncode, 0)
        self.assertEqual(self.state["calls"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
