"""Build a relocatable native runtime from checksum-pinned upstream SDKs."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parent.parent
GENAI_VERSION = "0.19.0"
ORT_VERSION = "1.31.1"
SDKS = {
    ("linux-x64", "cpu"): (
        "onnxruntime-genai-0.19.0-linux-x64.tar.gz",
        "cc4efa65d90fa43104519cd6a67e321a85645a238c5cfcabf42a128b274083c0",
        "onnxruntime-linux-x64-1.31.1.tgz",
        "c849e36a1ef3e22d4ff217b9d1ce4a3cf5b9467b975610913ae959ad5b16bdc9",
    ),
    ("linux-x64", "cuda"): (
        "onnxruntime-genai-0.19.0-linux-x64-cuda.tar.gz",
        "752870f0296aa9dc00db7a70dc72eac0089a6832d56385fb7f74eee277f07197",
        "onnxruntime-linux-x64-gpu_cuda13-1.31.1.tgz",
        "b2146862e691f7e338f5aff9c7a9a5567c2ca57cf01442a1adb3a13bf62d9095",
    ),
    ("win32-x64", "cpu"): (
        "onnxruntime-genai-0.19.0-win-x64.zip",
        "af2659792d15fb97e35f71075427fed9f3138b58975c621adb01868dcf7f6861",
        "onnxruntime-win-x64-1.31.1.zip",
        "5869e26bb25314375f2d5ef1877e3ea06b1543d6c710e6e4a1ec2f7177ab4b2c",
    ),
    ("win32-x64", "cuda"): (
        "onnxruntime-genai-0.19.0-win-x64-cuda.zip",
        "631be165371d6e4dcac41b2f774b996de7e4c02624e9bc7af7681b2ad086e659",
        "onnxruntime-win-x64-gpu_cuda13-1.31.1.zip",
        "6c64508de9c04f9d938297287e9d81fa47a2fbbb30cc04e6fac0db88f6cb68c1",
    ),
    ("darwin-arm64", "cpu"): (
        "onnxruntime-genai-0.19.0-osx-arm64.tar.gz",
        "3171d0ae98bcd364d861693f72d531e2b26399299d1003c3cc950830565c519b",
        "onnxruntime-osx-arm64-1.31.1.tgz",
        "2e1344a1926ee50eb25b38153cb6992c3567515aef0e677a1a520a1798896d6f",
    ),
}


def host_target():
    system = {"Linux": "linux", "Windows": "win32", "Darwin": "darwin"}.get(platform.system())
    arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine().lower()
    )
    return f"{system}-{arch}"


def run(*arguments):
    print("+", subprocess.list2cmdline([str(arg) for arg in arguments]), flush=True)
    subprocess.run([str(arg) for arg in arguments], check=True, cwd=ROOT)


@contextmanager
def build_lock():
    directory = ROOT / "build"
    directory.mkdir(exist_ok=True)
    with (directory / ".devdash-worker-setup.lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            lock.write(b"\0")
            lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def download_dependency(repository, version, name, checksum):
    directory = ROOT / "build" / "native-deps" / "packages"
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / name
    if not archive.exists():
        temporary = archive.with_name(archive.name + ".download")
        try:
            print(f"Downloading {name}", flush=True)
            urllib.request.urlretrieve(
                f"https://github.com/{repository}/releases/download/v{version}/{name}",
                temporary,
            )
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != checksum:
        raise ValueError(f"SHA-256 mismatch for {archive}; remove this archive before retrying")
    extracted = directory / checksum[:16]
    extracted.mkdir(exist_ok=True)
    if name.endswith(".zip"):
        with zipfile.ZipFile(archive) as source:
            for entry in source.namelist():
                if Path(entry).is_absolute() or ".." in Path(entry).parts:
                    raise ValueError(f"Unsafe SDK archive entry: {entry}")
            source.extractall(extracted)
    else:
        with tarfile.open(archive) as source:
            source.extractall(extracted, filter="data")
    return extracted


def sdk_root(directory, header):
    headers = list(directory.rglob(header))
    if len(headers) != 1:
        raise ValueError(f"Expected exactly one {header} in {directory}")
    return headers[0].parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=host_target())
    parser.add_argument("--variant", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.target != host_target():
        parser.error("Native packages must be built on the matching OS and architecture")
    if (args.target, args.variant) not in SDKS:
        parser.error("Supported bundles: Linux x64 and Windows x64 CPU/CUDA; macOS arm64 CPU")
    genai_name, genai_sha, ort_name, ort_sha = SDKS[(args.target, args.variant)]
    with build_lock():
        genai = sdk_root(
            download_dependency("microsoft/onnxruntime-genai", GENAI_VERSION, genai_name, genai_sha),
            "ort_genai_c.h",
        )
        ort = sdk_root(
            download_dependency("microsoft/onnxruntime", ORT_VERSION, ort_name, ort_sha),
            "onnxruntime_c_api.h",
        )
        json_root = ROOT / "build" / "native-deps" / "package-json"
        json_source = download_dependency(
            "nlohmann/json", "3.11.3", "json.tar.xz",
            "d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d",
        ) / "json"
        run("cmake", "-S", json_source, "-B", json_source / "build",
            "-DJSON_BuildTests=OFF")
        run("cmake", "--install", json_source / "build", "--prefix", json_root)
        build = ROOT / "build" / "native"
        run("cmake", "-S", ROOT / "native", "-B", build,
            "-U", "GENAI_*", "-U", "ORT_*",
            "-DARRANGED_WITH_GENAI=ON", "-DBUILD_TESTING=ON", "-DCMAKE_BUILD_TYPE=Release",
            f"-DGENAI_ROOT={genai}", f"-DONNXRUNTIME_ROOT={ort}",
            f"-Dnlohmann_json_DIR={json_root / 'share' / 'cmake' / 'nlohmann_json'}")
        processors = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()
        run("cmake", "--build", build, "--config", "Release", "--parallel", processors or 1, "--verbose")
        runtime = ROOT / "runtime"
        if runtime.is_symlink():
            raise ValueError("The runtime output directory must not be a symlink")
        if runtime.exists():
            shutil.rmtree(runtime)
        run("cmake", "--install", build, "--config", "Release", "--prefix", runtime)
        if args.target.startswith("win32-"):
            output = build / "Release" if (build / "Release" / "devdash-genai-worker.exe").exists() else build
            for path in output.glob("onnxruntime*.dll"):
                path.unlink()
            for path in (runtime / "bin").glob("onnxruntime*.dll"):
                shutil.copy2(path, output / path.name)
        for path in runtime.rglob("*"):
            if path.is_symlink():
                contents = path.resolve(strict=True)
                if not contents.is_relative_to(runtime) or not contents.is_file():
                    raise ValueError(f"Invalid staged runtime symlink: {path}")
                path.unlink()
                shutil.copy2(contents, path)
        if args.target.startswith("linux-"):
            # The worker links ORT's SONAME, which GenAI reuses before trying other names.
            (runtime / "lib" / "libonnxruntime.so").unlink()
            (runtime / "lib" / f"libonnxruntime.so.{ORT_VERSION}").unlink()
        if args.target.startswith("darwin-"):
            for path in runtime.rglob("*"):
                if path.is_file() and (path.suffix == ".dylib" or path.name == "devdash-genai-worker"):
                    run("codesign", "--force", "--sign", "-", path)
        licenses = runtime / "licenses"
        licenses.mkdir()
        for name, sdk in (("genai", genai), ("onnxruntime", ort)):
            found = False
            for path in sdk.iterdir():
                if path.is_file() and ("license" in path.name.lower() or "thirdparty" in path.name.lower()):
                    shutil.copy2(path, licenses / f"{name}-{path.name}")
                    if "license" in path.name.lower():
                        found = True
            if not found:
                raise ValueError(f"Missing redistribution license in {sdk}")
        (runtime / "manifest.json").write_text(json.dumps({
            "target": args.target,
            "variant": args.variant,
            "genaiVersion": GENAI_VERSION,
            "onnxruntimeVersion": ORT_VERSION,
            "sdks": [{"name": genai_name, "sha256": genai_sha}, {"name": ort_name, "sha256": ort_sha}],
        }, indent=2) + "\n", encoding="utf-8")
        print(f"Native {args.target}/{args.variant} runtime staged in {runtime}", flush=True)


if __name__ == "__main__":
    main()
