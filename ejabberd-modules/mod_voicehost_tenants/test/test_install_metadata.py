import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("install_metadata", Path(__file__).resolve().parents[1] / "install_metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class InstallMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.install = self.root / "ejabberd-26.09"
        self.ctl = self.install / "bin" / "ejabberdctl"
        self.ctl.parent.mkdir(parents=True)
        self.ctl.touch()
        self.proc = self.root / "proc"
        self.proc.mkdir()

    def process(self, pid="42", args=None, env=None, install=None):
        binary = (install or self.install) / "lib" / "beam.smp"
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.touch()
        path = self.proc / pid
        path.mkdir()
        (path / "exe").symlink_to(binary)
        args = args or ["beam.smp", "-sname", "ejabberd@localhost", "-home", "/srv/ejabberd"]
        (path / "cmdline").write_bytes(b"\0".join(v.encode() for v in args) + b"\0")
        env = env if env is not None else {"HOME": "/root", "SECRET": "must-not-be-returned"}
        (path / "environ").write_bytes(b"\0".join((k + "=" + v).encode() for k, v in env.items()) + b"\0")
        (path / "status").write_text("Uid:\t0\t123\t123\t123\nGid:\t0\t456\t456\t456\n")
        return path

    def discover(self):
        return metadata.discover(self.ctl, "ejabberd@localhost", self.proc)

    def test_runtime_home_and_effective_owner(self):
        self.process()
        self.assertEqual(self.discover(), ("/srv/ejabberd/.ejabberd-modules", "123", "456"))

    def test_explicit_contrib_path(self):
        self.process(env={"CONTRIB_MODULES_PATH": "/srv/custom modules"})
        self.assertEqual(self.discover()[0], "/srv/custom modules")

    def test_empty_contrib_uses_home(self):
        self.process(env={"CONTRIB_MODULES_PATH": ""})
        self.assertEqual(self.discover()[0], "/srv/ejabberd/.ejabberd-modules")

    def test_environment_home_fallback(self):
        self.process(args=["beam.smp", "-sname", "ejabberd"], env={"HOME": "/srv/node"})
        self.assertEqual(self.discover()[0], "/srv/node/.ejabberd-modules")

    def test_other_installation_ignored(self):
        self.process("41", install=self.root / "ejabberd-25.04")
        self.process()
        self.assertEqual(self.discover()[1], "123")

    def test_other_node_ignored(self):
        self.process("41", args=["beam.smp", "-sname", "other@localhost"])
        self.process()
        self.assertEqual(self.discover()[1], "123")

    def test_ambiguous_node_fails_before_mutation(self):
        self.process("41")
        self.process()
        with self.assertRaises(ValueError):
            self.discover()

    def test_missing_home_fails(self):
        self.process(args=["beam.smp", "-sname", "ejabberd@localhost"], env={})
        with self.assertRaises(ValueError):
            self.discover()

    def test_unsafe_path_fails(self):
        for contrib in ("relative", "/srv/bad\npath", "/srv/bad\tpath"):
            with self.subTest(contrib=contrib):
                path = self.process()
                (path / "environ").write_bytes(b"CONTRIB_MODULES_PATH=" + contrib.encode() + b"\0")
                with self.assertRaises(ValueError):
                    self.discover()
                shutil.rmtree(path)

    def test_no_matching_process_fails(self):
        with self.assertRaises(ValueError):
            self.discover()


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / "package"
        (self.package / "src").mkdir(parents=True)
        for filename in ("README.md", "COPYING", "mod_voicehost_tenants.spec", "src/mod_voicehost_tenants.erl", "src/voicehost_rooms.erl"):
            (self.package / filename).write_text("fixture\n")
        shutil.copyfile(Path(__file__).resolve().parents[1] / "install.sh", self.package / "install.sh")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands"
        self.ctl = self.bin / "ejabberdctl"
        self.ctl.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\ncase "$1" in\nstatus) echo "The node ejabberd@localhost is started with status: started";;\nmodule_install|module_upgrade) echo "installed";;\n*) exit 99;;\nesac\n')
        self.ctl.chmod(0o755)
        self.contrib = self.root / "custom modules"
        python = self.bin / "python3"
        python.write_text('#!/bin/sh\n[ "$METADATA_FAIL" != 1 ] || exit 1\nprintf "%s\\n" "$CONTRIB_TEST_PATH" "$OWNER_TEST_UID" "$OWNER_TEST_GID"\n')
        python.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"], COMMAND_LOG=str(self.log), CONTRIB_TEST_PATH=str(self.contrib), OWNER_TEST_UID=str(os.geteuid()), OWNER_TEST_GID=str(os.getegid()))

    def run_installer(self, *args):
        return subprocess.run(["bash", str(self.package / "install.sh"), str(self.ctl), *args], env=self.env, capture_output=True, text=True)

    def test_supported_commands_and_production_files_only(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().splitlines(), ["status", "module_install mod_voicehost_tenants"])
        installed = self.contrib / "sources" / "mod_voicehost_tenants"
        files = sorted(str(p.relative_to(installed)) for p in installed.rglob("*") if p.is_file())
        self.assertEqual(files, ["COPYING", "README.md", "mod_voicehost_tenants.spec", "src/mod_voicehost_tenants.erl", "src/voicehost_rooms.erl"])

    def test_upgrade_uses_supported_upgrade_command(self):
        result = self.run_installer("--upgrade")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().splitlines(), ["status", "module_upgrade mod_voicehost_tenants"])

    def test_invalid_option_stops_before_mutation(self):
        result = self.run_installer("--unknown")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.contrib.exists())
        self.assertFalse(self.log.exists())

    def test_metadata_failure_stops_before_copy_and_install(self):
        self.env["METADATA_FAIL"] = "1"
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.contrib.exists())
        self.assertEqual(self.log.read_text().splitlines(), ["status"])


if __name__ == "__main__":
    unittest.main()
