import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { posix } from "node:path";
import { remoteError, remoteInvocation, runRemoteScript } from "./remote";
import type { MachineConfiguration, WorkerConfiguration } from "./execution";

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
mv -T -- "$temporary" "$target"
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
if [ -f "$2/genai_config.json" ]; then exit; fi
mv -T -- "$temporary" "$2"
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
