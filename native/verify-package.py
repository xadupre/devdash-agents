"""Inspect a platform VSIX and execute its relocated worker, optionally with a real model."""
import argparse
import fnmatch
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET


NATIVE_SOURCES = {
    "native/CMakeLists.txt",
    "native/setup-worker.sh",
    *(f"native/src/{name}" for name in (
        "cuda_discovery.cpp", "cuda_discovery.h", "genai_backend.cpp",
        "main.cpp", "provider_policy.cpp", "provider_policy.h",
        "unavailable_backend.cpp", "worker.cpp", "worker.h",
    )),
}


def verify_entries(names, allowed):
    runtime = []
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"Unsafe VSIX entry: {name}")
        if name.startswith(("extension/build/", "extension/.venv/")) or (
            name.startswith("extension/native/")
            and name.removeprefix("extension/") not in NATIVE_SOURCES
        ):
            raise ValueError(f"Build or SDK files leaked into the VSIX: {name}")
        if path.name == "genai_config.json" or ".onnx" in path.name:
            raise ValueError(f"Model data leaked into the VSIX: {name}")
        if name.startswith("extension/runtime/") and not name.endswith("/"):
            relative = name.removeprefix("extension/runtime/")
            if not any(fnmatch.fnmatchcase(relative, pattern) for pattern in allowed):
                raise ValueError(f"Unexpected native bundle file: {name}")
            runtime.append(name)
    return runtime


def verify(filename):
    with zipfile.ZipFile(filename) as archive:
        names = archive.namelist()
        manifest = json.loads(archive.read("extension/runtime/manifest.json"))
        target = manifest["target"]
        platform = target.split("-")[0]
        executable = "devdash-genai-worker.exe" if platform == "win32" else "devdash-genai-worker"
        libraries = {
            "win32": ("bin/onnxruntime*.dll",),
            "darwin": ("lib/libonnxruntime*.dylib",),
            "linux": ("lib/libonnxruntime*.so*",),
        }
        if platform not in libraries or manifest["variant"] not in ("cpu", "cuda"):
            raise ValueError("Unsupported native runtime manifest")
        allowed = ("manifest.json", f"bin/{executable}", "licenses/*", *libraries[platform])
        runtime = verify_entries(names, allowed)
        xml = ET.fromstring(archive.read("extension.vsixmanifest"))
        identity = next(element for element in xml.iter() if element.tag.endswith("}Identity"))
        if identity.attrib.get("TargetPlatform") != target:
            raise ValueError("VSIX target does not match the native runtime manifest")
        platform = "win32" if os.name == "nt" else sys.platform
        if target.split("-")[0] != platform:
            raise ValueError(f"Cannot execute a {target} package on {platform}")
        worker_name = f"extension/runtime/bin/{executable}"
        if worker_name not in runtime:
            raise ValueError("The platform VSIX is missing its native worker")
        if not any("/licenses/genai-" in name for name in runtime) or not any(
            "/licenses/onnxruntime-" in name for name in runtime
        ):
            raise ValueError("The native bundle is missing upstream licenses")
        with tempfile.TemporaryDirectory(prefix="devdash-vsix-") as directory:
            for name in runtime:
                archive.extract(name, directory)
            worker = Path(directory) / worker_name
            worker.chmod(0o755)
            environment = dict(os.environ)
            environment.pop("LD_LIBRARY_PATH", None)
            environment.pop("DYLD_LIBRARY_PATH", None)
            environment["ARRANGED_TEST_PROVIDER"] = "cpu"
            subprocess.run(
                [sys.executable, str(Path(__file__).parent / "tests" / "process_test.py"),
                 str(worker), "runtime"],
                cwd=directory, env=environment, check=True,
            )
        print(f"Verified relocated {target}/{manifest['variant']} VSIX runtime: {filename}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vsix", type=Path)
    verify(parser.parse_args().vsix.resolve())
