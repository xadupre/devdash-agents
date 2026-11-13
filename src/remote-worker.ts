import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import {
  REMOTE_ERROR_PREFIX,
  remoteError,
  runRemoteScript,
  type RemoteMachine,
} from "./remote";
import { DEFAULT_WORKER } from "./local-worker";

/** Sources needed by native/setup-worker.sh; shipped in the VSIX for remote builds. */
const SOURCES = ["CMakeLists.txt", "setup-worker.sh", "src"];

const FAIL = `fail() { printf '${REMOTE_ERROR_PREFIX}%s\\n' "$1" >&2; exit 2; }`;

/** Exit 3: the default worker is missing and can be built from the sources. */
const FIND = `${FAIL}
worker=$1
root=$HOME/.cache/devdash-agents/engine/$2
if [ "$worker" != "${DEFAULT_WORKER}" ]; then
  command -v -- "$worker" || fail "Worker executable not found on this machine: $worker. Install it, or set the machine's native worker executable to ${DEFAULT_WORKER} to build it automatically."
  exit 0
fi
command -v -- "$worker" && exit 0
[ -x "$root/build/native/${DEFAULT_WORKER}" ] && { printf '%s\\n' "$root/build/native/${DEFAULT_WORKER}"; exit 0; }
exit 3
`;

const INSTALL = `${FAIL}
root=$HOME/.cache/devdash-agents/engine/$1
mkdir -p -- "$root" || fail "Cannot create $root."
for tool in bash tar flock; do
  command -v "$tool" >/dev/null 2>&1 || fail "Building the worker on this machine requires $tool."
done
exec 9>"$root/.install.lock" || fail "Cannot lock $root."
flock 9
worker=$root/build/native/${DEFAULT_WORKER}
if [ ! -x "$worker" ]; then
  rm -rf -- "$root/native"
  mkdir -p -- "$root/native" && tar -xzf - -C "$root/native" || fail "Cannot unpack the worker sources into $root."
  log=$root/setup.log
  bash "$root/native/setup-worker.sh" >"$log" 2>&1 ||
    fail "Building the worker failed (log: $log): $(tail -n 3 "$log" | tr '\\n' ' ')"
fi
[ -x "$worker" ] || fail "The worker build did not produce $worker."
printf '%s\\n' "$worker"
`;

async function files(directory: string, prefix: string): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), {
    withFileTypes: true,
  });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = posix.join(prefix, entry.name);
      return entry.isDirectory() ? files(directory, path) : [path];
    }),
  );
  return nested.flat().sort();
}

/** Content hash of the worker sources; each version builds in its own directory. */
export async function workerSourceVersion(nativeDirectory: string): Promise<{
  version: string;
  paths: string[];
}> {
  const paths = (
    await Promise.all(
      SOURCES.map((entry) =>
        entry.includes(".") ? [entry] : files(nativeDirectory, entry),
      ),
    )
  ).flat();
  const hash = createHash("sha256");
  for (const path of paths)
    hash
      .update(path)
      .update("\0")
      .update(await readFile(join(nativeDirectory, path)))
      .update("\0");
  return { version: hash.digest("hex").slice(0, 16), paths };
}

export interface RemoteWorkerOptions {
  /** Directory containing CMakeLists.txt, setup-worker.sh and src/. */
  nativeDirectory: string;
  signal?: AbortSignal;
  /** Called before a build, which can take several minutes. */
  onInstall?: () => void;
}

/**
 * Returns the worker executable to run on a remote machine. When the default
 * worker is not on its PATH, builds it once from the shipped sources under
 * ~/.cache/devdash-agents/engine/<version>.
 */
export async function ensureRemoteWorker(
  machine: Pick<RemoteMachine, "command" | "workerPath" | "name">,
  options: RemoteWorkerOptions,
): Promise<string> {
  const { version, paths } = await workerSourceVersion(options.nativeDirectory);
  const found = await runRemoteScript(
    machine,
    FIND,
    [machine.workerPath, version],
    { signal: options.signal, timeoutMs: 120_000 },
  );
  if (found.completed && found.code === 0)
    return found.stdout.toString("utf8").trim().split("\n").at(-1)!;
  if (!found.completed || found.code !== 3)
    throw remoteError(found, `Cannot look for the worker on ${machine.name}`);
  options.onInstall?.();
  const { stdout: archive } = await promisify(execFile)(
    "tar",
    ["-czf", "-", ...paths],
    {
      cwd: options.nativeDirectory,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      signal: options.signal,
      windowsHide: true,
    },
  );
  const installed = await runRemoteScript(machine, INSTALL, [version], {
    input: archive,
    signal: options.signal,
    timeoutMs: 45 * 60_000,
  });
  if (!installed.completed || installed.code !== 0)
    throw remoteError(
      installed,
      `Cannot install the worker on ${machine.name}`,
    );
  return installed.stdout.toString("utf8").trim().split("\n").at(-1)!;
}
