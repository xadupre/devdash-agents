#!/usr/bin/env bash
# Builds the local model engine (build/native/devdash-genai-worker) against
# pinned, checksum-verified prebuilt ONNX Runtime GenAI SDKs. ONNX Runtime
# itself is never compiled. Uses the CUDA SDKs when an NVIDIA GPU responds.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$ROOT/build/native-deps"
BUILD="$ROOT/build/native"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
    printf 'Local models: automatic setup supports Linux x64 only.\n' >&2
    exit 1
fi
for tool in cmake c++ curl sha256sum tar flock; do
    if ! command -v "$tool" > /dev/null 2>&1; then
        printf 'Local models: required command not found: %s\n' "$tool" >&2
        exit 1
    fi
done

VARIANT="${ARRANGED_WORKER_VARIANT:-}"
if [[ -z "$VARIANT" ]]; then
    if command -v nvidia-smi > /dev/null 2>&1 && nvidia-smi -L > /dev/null 2>&1; then
        VARIANT=gpu
    else
        VARIANT=cpu
    fi
fi
case "$VARIANT" in
    cpu)
        GENAI=onnxruntime-genai-0.19.0-linux-x64
        GENAI_SHA256=cc4efa65d90fa43104519cd6a67e321a85645a238c5cfcabf42a128b274083c0
        ORT=onnxruntime-linux-x64-1.31.1
        ORT_SHA256=c849e36a1ef3e22d4ff217b9d1ce4a3cf5b9467b975610913ae959ad5b16bdc9
        ;;
    gpu)
        GENAI=onnxruntime-genai-0.19.0-linux-x64-cuda
        GENAI_SHA256=752870f0296aa9dc00db7a70dc72eac0089a6832d56385fb7f74eee277f07197
        ORT=onnxruntime-linux-x64-gpu_cuda13-1.31.1
        ORT_SHA256=b2146862e691f7e338f5aff9c7a9a5567c2ca57cf01442a1adb3a13bf62d9095
        ;;
    *)
        printf 'ARRANGED_WORKER_VARIANT must be cpu or gpu, not %s\n' "$VARIANT" >&2
        exit 1
        ;;
esac
NLOHMANN_SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d

# Serialize setup per checkout: downloads, extracted SDKs and the CMake tree are shared.
mkdir -p "$ROOT/build"
exec 9>"$ROOT/build/.devdash-worker-setup.lock"
flock 9
if [[ -x "$BUILD/devdash-genai-worker" ]]; then
    printf 'Local models: ready (existing worker).\n'
    exit 0
fi

sdk_complete() {
    case "$1" in
        */onnxruntime-genai-*)
            [[ -f "$1/include/ort_genai_c.h" && -e "$1/lib/libonnxruntime-genai.so" ]]
            ;;
        */onnxruntime-linux-x64-*)
            [[ -f "$1/include/onnxruntime_c_api.h" && -e "$1/lib/libonnxruntime.so" ]]
            ;;
        */json)
            [[ -f "$1/CMakeLists.txt" ]]
            ;;
        *)
            return 1
            ;;
    esac
}

# fetch NAME URL SHA256: atomically extracts a verified archive into $DEPS.
fetch() {
    local name="$1" url="$2" sha="$3" archive staging
    sdk_complete "$DEPS/$name" && return
    if [[ -e "$DEPS/$name" ]]; then
        rm -rf -- "$DEPS/$name"
    fi
    staging="$DEPS/.${name}.tmp"
    rm -rf -- "$staging"
    mkdir -p "$staging"
    archive="$staging/$name.download"
    printf 'Local models: downloading %s...\n' "$name"
    curl -fsSL --retry 3 "$url" -o "$archive"
    printf '%s  %s\n' "$sha" "$archive" | sha256sum -c --quiet -
    tar -xf "$archive" -C "$staging"
    if ! sdk_complete "$staging/$name"; then
        printf 'Local models: archive %s did not contain its expected directory.\n' "$name" >&2
        exit 1
    fi
    mv "$staging/$name" "$DEPS/$name"
    rm -rf -- "$staging"
}

mkdir -p "$DEPS"
fetch "$GENAI" "https://github.com/microsoft/onnxruntime-genai/releases/download/v0.19.0/$GENAI.tar.gz" "$GENAI_SHA256"
fetch "$ORT" "https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/$ORT.tgz" "$ORT_SHA256"
fetch json "https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz" "$NLOHMANN_SHA256"
NLOHMANN="$DEPS/nlohmann-json-3.11.3"
if [[ ! -f "$NLOHMANN/share/cmake/nlohmann_json/nlohmann_jsonConfig.cmake" ]]; then
    # Header-only: this only installs headers and the CMake package files.
    NLOHMANN_STAGING="$DEPS/.nlohmann-json-3.11.3.tmp"
    rm -rf -- "$NLOHMANN_STAGING"
    if [[ -e "$NLOHMANN" ]]; then
        rm -rf -- "$NLOHMANN"
    fi
    cmake -S "$DEPS/json" -B "$DEPS/json-build" -DJSON_BuildTests=OFF > /dev/null
    cmake --install "$DEPS/json-build" --prefix "$NLOHMANN_STAGING" > /dev/null
    rm -rf "$DEPS/json-build"
    if [[ ! -f "$NLOHMANN_STAGING/share/cmake/nlohmann_json/nlohmann_jsonConfig.cmake" ]]; then
        printf 'Local models: nlohmann/json installation did not produce its CMake package.\n' >&2
        exit 1
    fi
    mv "$NLOHMANN_STAGING" "$NLOHMANN"
fi

printf 'Local models: building the %s engine...\n' "$VARIANT"
cmake -S "$ROOT/native" -B "$BUILD" -U 'GENAI_*' -U 'ORT_*' \
    -DARRANGED_WITH_GENAI=ON \
    -DBUILD_TESTING=OFF \
    -DGENAI_ROOT="$DEPS/$GENAI" -DONNXRUNTIME_ROOT="$DEPS/$ORT" \
    -Dnlohmann_json_DIR="$NLOHMANN/share/cmake/nlohmann_json" > /dev/null
cmake --build "$BUILD" --target devdash-genai-worker --parallel "$(nproc)" --verbose
printf 'Local models: ready (%s).\n' "$VARIANT"
