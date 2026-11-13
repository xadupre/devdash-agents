import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { posix } from "node:path";
import { remoteError, remoteInvocation, runRemoteScript } from "./remote";
import type { MachineConfiguration, WorkerConfiguration } from "./execution";
import { foundryModelFiles, type DownloadProgress } from "./foundry";

const PREPARE = `set -eu
source=$1; storage=$2; provider=$3; kind=$4; key=$5
if [ "$kind" != model-id ]; then
  if [ -f "$source" ]; then
    case "$source" in *.onnx|*.json|*.safetensors|*.bin) source=$(dirname -- "$source");; *) echo "Unsupported model file" >&2; exit 2;; esac
  fi
  [ -d "$source" ] || { echo "Model source does not exist: $source" >&2; exit 2; }
  if [ -f "$source/genai_config.json" ]; then realpath -e -- "$source"; exit; fi
  [ -f "$source/config.json" ] || { echo "Missing checkpoint config.json" >&2; exit 2; }
fi
mkdir -p -- "$storage"
target="$storage/export-$key"
if [ -f "$target/genai_config.json" ]; then realpath -e -- "$target"; exit; fi
temporary=$(mktemp -d "$storage/.export-XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
if [ "$kind" = model-id ]; then flag=-m; else flag=-i; fi
python3 -m onnxruntime_genai.models.builder "$flag" "$source" -o "$temporary" -p int4 -e "$provider" -c "$temporary/.cache" --extra_options hf_remote=false >&2
[ -f "$temporary/genai_config.json" ] || { echo "Export is missing genai_config.json" >&2; exit 2; }
rm -rf -- "$temporary/.cache"
if error=$(mv -T -- "$temporary" "$target" 2>&1); then :; else
  [ -f "$target/genai_config.json" ] || { printf 'Could not publish prepared model: %s\\n' "$error" >&2; exit 2; }
fi
realpath -e -- "$target"
`;

export async function prepareRemoteModel(
  machine: MachineConfiguration,
  worker: WorkerConfiguration,
  source: string,
  signal: AbortSignal,
): Promise<string> {
  const key = createHash("sha256")
    .update(JSON.stringify([source, worker.provider]))
    .digest("hex")
    .slice(0, 24);
  const result = await runRemoteScript(
    machine,
    PREPARE,
    [source, machine.modelsPath, worker.provider, worker.model.kind, key],
    { signal, timeoutMs: 3_600_000 },
  );
  if (!result.completed || result.code !== 0)
    throw remoteError(result, "Remote model preparation failed");
  const directory = result.stdout.toString("utf8").trim();
  if (!directory.startsWith("/") || /[\r\n]/.test(directory))
    throw new Error("Invalid prepared remote model path.");
  return directory;
}

/** Stream a complete Foundry package, not its multi-gigabyte contents in memory. */
export async function uploadRemoteModel(
  machine: MachineConfiguration,
  directory: string,
  modelId: string,
  signal: AbortSignal,
): Promise<string> {
  const key = createHash("sha256").update(modelId).digest("hex").slice(0, 24);
  const target = posix.join(machine.modelsPath, `foundry-${key}`);
  const cached = await runRemoteScript(
    machine,
    'if [ -f "$1/genai_config.json" ]; then printf ready; fi',
    [target],
    { signal },
  );
  if (!cached.completed || cached.code !== 0)
    throw remoteError(cached, "Checking the remote model cache failed");
  if (cached.stdout.toString("utf8") === "ready") return target;
  const script = `set -eu
mkdir -p -- "$1"
temporary=$(mktemp -d "$1/.upload-XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
tar -xf - -C "$temporary"
[ -f "$temporary/genai_config.json" ] || { echo "Missing genai_config.json" >&2; exit 2; }
if error=$(mv -T -- "$temporary" "$2" 2>&1); then :; else
  [ -f "$2/genai_config.json" ] || { printf 'Could not publish uploaded model: %s\\n' "$error" >&2; exit 2; }
fi
`;
  const launch = remoteInvocation(machine, [
    "sh",
    "-c",
    script,
    "sh",
    machine.modelsPath,
    target,
  ]);
  signal.throwIfAborted();
  const local = spawn("tar", ["-cf", "-", "-C", directory, "."], {
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  const remote = spawn(launch.executable, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    signal,
  });
  let stderr = "";
  for (const child of [local, remote]) {
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });
  }
  remote.stdout.resume();
  const completion = (child: typeof remote | typeof local): Promise<void> =>
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(new Error(`Model transfer failed (exit ${code}): ${stderr}`));
      });
    });
  try {
    await Promise.all([
      completion(local),
      completion(remote),
      pipeline(local.stdout, remote.stdin, { signal }),
    ]);
  } finally {
    if (local.exitCode === null) local.kill();
    if (remote.exitCode === null) remote.kill();
  }
  // Connection tools may hide the remote exit status.
  const verified = await runRemoteScript(
    machine,
    'test -f "$1/genai_config.json"',
    [target],
    { signal },
  );
  if (!verified.completed || verified.code !== 0)
    throw remoteError(verified, "Uploaded model verification failed");
  return target;
}

// Reads "path<TAB>size<TAB>curl-escaped-url" lines on stdin so signed URLs
// stay out of process listings, and prints the downloaded byte count.
const DOWNLOAD = `set -eu
storage=$1; target=$2
command -v curl >/dev/null || { echo "devdash-error: curl is required on the remote machine to download Foundry models." >&2; exit 2; }
mkdir -p -- "$storage"
temporary=$(mktemp -d "$storage/.download-XXXXXX")
monitor=
cleanup() { if [ -n "$monitor" ]; then kill "$monitor" 2>/dev/null || :; fi; rm -rf -- "$temporary"; }
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
(while :; do printf 'progress %s\\n' "$(du -sb -- "$temporary" 2>/dev/null | cut -f1)"; sleep 5; done) &
monitor=$!
tab=$(printf '\\t')
while IFS=$tab read -r path size url; do
  mkdir -p -- "$(dirname -- "$temporary/$path")"
  printf 'url = "%s"\\n' "$url" | curl -q -fsL --retry 3 -o "$temporary/$path" --config - || { echo "devdash-error: Downloading $path failed (curl exit $?)." >&2; exit 2; }
  [ "$(stat -c %s -- "$temporary/$path")" = "$size" ] || { echo "devdash-error: Incomplete download of $path." >&2; exit 2; }
done
[ -f "$temporary/genai_config.json" ] || { echo "devdash-error: The package has no genai_config.json." >&2; exit 2; }
if error=$(mv -T -- "$temporary" "$target" 2>&1); then :; else
  [ -f "$target/genai_config.json" ] || { printf 'devdash-error: Could not publish downloaded model: %s\\n' "$error" >&2; exit 2; }
fi
`;

/** Downloads a Foundry catalogue model directly on the remote machine. */
export async function downloadRemoteFoundryModel(
  machine: MachineConfiguration,
  modelId: string,
  signal: AbortSignal,
  onProgress?: (progress: DownloadProgress) => void,
  fetchOverride?: typeof fetch,
): Promise<string> {
  const key = createHash("sha256").update(modelId).digest("hex").slice(0, 24);
  const target = posix.join(machine.modelsPath, `foundry-${key}`);
  const cached = await runRemoteScript(
    machine,
    'if [ -f "$1/genai_config.json" ]; then printf ready; fi',
    [target],
    { signal },
  );
  if (!cached.completed || cached.code !== 0)
    throw remoteError(cached, "Checking the remote model cache failed");
  if (cached.stdout.toString("utf8") === "ready") return target;
  const files = await foundryModelFiles(modelId, {
    signal,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let pending = "";
  const result = await runRemoteScript(
    machine,
    DOWNLOAD,
    [machine.modelsPath, target],
    {
      input: Buffer.from(
        files
          .map(
            (file) =>
              `${file.path}\t${file.size}\t${file.url.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\n`,
          )
          .join(""),
      ),
      signal,
      timeoutMs: 6 * 3_600_000,
      onStdout: (chunk) => {
        const lines = (pending + chunk.toString("utf8")).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const received = Number(/^progress (\d+)\s*$/.exec(line)?.[1]);
          if (Number.isSafeInteger(received))
            onProgress?.({ received: Math.min(received, total), total });
        }
      },
    },
  );
  if (!result.completed || result.code !== 0)
    throw remoteError(result, "Remote Foundry model download failed");
  onProgress?.({ received: total, total });
  return target;
}
