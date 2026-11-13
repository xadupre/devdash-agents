"""Verify that platform packages reject build artifacts and unsafe runtime contents."""
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
import zipfile


module = runpy.run_path(str(Path(__file__).parents[1] / "verify-package.py"))
verify = module["verify"]
verify_entries = module["verify_entries"]


class PackageTests(unittest.TestCase):
    def package(self, directory, extra):
        target = ("win32" if os.name == "nt" else sys.platform) + "-x64"
        executable = "devdash-genai-worker.exe" if os.name == "nt" else "devdash-genai-worker"
        path = Path(directory) / "test.vsix"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("extension/runtime/manifest.json", json.dumps({
                "target": target, "variant": "cpu",
            }))
            archive.writestr("extension/runtime/bin/" + executable, "")
            archive.writestr("extension/runtime/licenses/genai-LICENSE", "test fixture")
            archive.writestr("extension/runtime/licenses/onnxruntime-LICENSE", "test fixture")
            archive.writestr("extension.vsixmanifest", (
                '<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
                f'<Metadata><Identity TargetPlatform="{target}"/></Metadata></PackageManifest>'
            ))
            for name, contents in extra.items():
                archive.writestr(name, contents)
        return path

    def test_build_files_and_models_are_rejected(self):
        for name in (
            "extension/build/native/devdash-genai-worker",
            "extension/native/src/worker.o",
            "extension/native/src/onnxruntime_c_api.h",
            "extension/native/build/libonnxruntime.so",
            "extension/models/model.onnx",
            "extension/models/genai_config.json",
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                path = self.package(directory, {name: ""})
                with self.assertRaisesRegex(ValueError, "leaked"):
                    verify(path)

    def test_remote_build_sources_are_allowed(self):
        native = Path(__file__).parents[1]
        sources = [native / "CMakeLists.txt", native / "setup-worker.sh"]
        sources += list((native / "src").glob("*.cpp"))
        sources += list((native / "src").glob("*.h"))
        names = ["extension/native/" + path.relative_to(native).as_posix() for path in sources]
        self.assertEqual(verify_entries(names, ()), [])

    def test_unexpected_runtime_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.package(directory, {"extension/runtime/include/ort_genai_c.h": ""})
            with self.assertRaisesRegex(ValueError, "Unexpected native bundle"):
                verify(path)

    def test_unsafe_archive_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.package(directory, {"extension/runtime/../../outside": ""})
            with self.assertRaisesRegex(ValueError, "Unsafe VSIX entry"):
                verify(path)

    def test_mismatched_vsix_target_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.package(directory, {})
            with zipfile.ZipFile(path) as source:
                entries = {name: source.read(name) for name in source.namelist()}
            entries["extension.vsixmanifest"] = entries["extension.vsixmanifest"].replace(
                b"TargetPlatform=", b"WrongTarget="
            )
            with zipfile.ZipFile(path, "w") as archive:
                for name, contents in entries.items():
                    archive.writestr(name, contents)
            with self.assertRaisesRegex(ValueError, "VSIX target"):
                verify(path)


if __name__ == "__main__":
    unittest.main()
