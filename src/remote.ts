import { spawn } from "node:child_process";
import { basename, posix } from "node:path";
import { modelInfoFromConfig, type LocalModelInfo } from "./local-model";

/**
 * A machine reached through a connection command, such as
 * `az ssh vm --ip 1.2.3.4` or `ssh user@host`, that accepts a remote command
 * after `--` and forwards standard input and output.
 */
export interface RemoteMachine {
  name: string;
  /** Connection command line; split into arguments, never run by a local shell. */
  command: string;
  /** Native worker executable on the remote machine. */
  workerPath: string;
  /** Model directory containing genai_config.json on the remote machine. */
  modelPath: string;
  /** Remote directory containing the repositories, cloned under their local folder name. */
  repositoriesPath: string;
}

const MAX_REMOTE_MACHINES = 32;
const MAX_REMOTE_OUTPUT = 4 * 1024 * 1024;

function plainText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

/** Splits a command line on whitespace, honouring single and double quotes. */
export function splitCommandLine(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | undefined;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) throw new Error("Unterminated quote in the connection command.");
  if (started) words.push(word);
  return words;
}

export function parseRemoteMachine(value: unknown): RemoteMachine {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid remote machine.");
  const { name, command, workerPath, modelPath, repositoriesPath } =
    value as RemoteMachine;
  if (!plainText(name, 100)) throw new Error("Invalid remote machine name.");
  if (!plainText(command, 4096) || !splitCommandLine(command).length)
    throw new Error(`Invalid connection command for ${name}.`);
  for (const [label, path] of [
    ["worker executable", workerPath],
    ["model directory", modelPath],
    ["repositories directory", repositoriesPath],
  ] as const) {
    if (!plainText(path, 4096))
      throw new Error(`Invalid remote ${label} for ${name}.`);
  }
  for (const [label, path] of [
    ["model directory", modelPath],
    ["repositories directory", repositoriesPath],
  ] as const) {
    if (!path.startsWith("/"))
      throw new Error(`The remote ${label} for ${name} must be absolute.`);
  }
  return { name, command, workerPath, modelPath, repositoriesPath };
}

export function parseRemoteMachines(value: unknown): RemoteMachine[] {
  if (!Array.isArray(value) || value.length > MAX_REMOTE_MACHINES)
    throw new Error("Invalid remote machines.");
  const machines = value.map(parseRemoteMachine);
  if (new Set(machines.map((machine) => machine.name)).size !== machines.length)
    throw new Error("Remote machine names must be unique.");
  return machines;
}

/** Selected machine, or undefined for this computer or an unknown name. */
export function selectedRemoteMachine(
  machines: unknown,
  selected: unknown,
): RemoteMachine | undefined {
  if (typeof selected !== "string" || !selected) return undefined;
  let parsed: RemoteMachine[];
  try {
    parsed = parseRemoteMachines(machines);
  } catch {
    return undefined;
  }
  return parsed.find((machine) => machine.name === selected);
}

export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Local process running `argv` on the remote machine through its login shell. */
export function remoteInvocation(
  machine: Pick<RemoteMachine, "command">,
  argv: readonly string[],
): { executable: string; args: string[] } {
  const [executable, ...connection] = splitCommandLine(machine.command);
  if (!executable) throw new Error("The connection command is empty.");
  return {
    executable,
    args: [...connection, "--", argv.map(quoteShellArgument).join(" ")],
  };
}

/** The repository folder name is reused under the remote repositories directory. */
export function remoteRepositoryPath(
  machine: Pick<RemoteMachine, "repositoriesPath">,
  localRepositoryPath: string,
): string {
  const name = basename(localRepositoryPath);
  if (!name || name === "." || name === "..")
    throw new Error("Cannot map this repository to a remote directory.");
  return posix.join(machine.repositoriesPath, name);
}

// Some connection commands, such as `az ssh vm`, do not return the remote exit
// status, so the script reports it as its last stderr line.
const REMOTE_STATUS_WRAPPER =
  'script=$1; shift; sh -c "$script" sh "$@"; printf \'\\ndevdash-exit: %d\\n\' "$?" >&2';
const REMOTE_STATUS = /^devdash-exit: (\d+)\r?$/gm;

export interface RemoteResult {
  /** False when the remote script never reported its status, e.g. a connection failure. */
  completed: boolean;
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * Runs a POSIX shell script remotely with positional arguments. The local
 * connection process runs in its own process group so cancellation stops it.
 */
export function runRemoteScript(
  machine: Pick<RemoteMachine, "command">,
  script: string,
  args: readonly string[],
  options: {
    input?: Buffer;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutput?: number;
  } = {},
): Promise<RemoteResult> {
  const { executable, args: connection } = remoteInvocation(machine, [
    "sh",
    "-c",
    REMOTE_STATUS_WRAPPER,
    "sh",
    script,
    ...args,
  ]);
  const maxOutput = options.maxOutput ?? MAX_REMOTE_OUTPUT;
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child = spawn(executable, connection, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let failure: Error | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signalName: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(
          process.platform === "win32" ? child.pid : -child.pid,
          signalName,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          child.kill(signalName);
      }
    };
    const stop = (error: Error): void => {
      failure ??= error;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 500);
    };
    const abort = (): void =>
      stop(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new DOMException("Remote operation cancelled.", "AbortError"),
      );
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () =>
              stop(
                new Error(
                  `Remote operation timed out after ${options.timeoutMs}ms.`,
                ),
              ),
            options.timeoutMs,
          );
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutput) {
        stop(new Error(`Remote output exceeded ${maxOutput} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ENOENT"
          ? new Error(
              `The remote connection command is not installed: ${executable}`,
              { cause: error },
            )
          : error,
      ),
    );
    child.once("close", (code) => {
      if (failure) finish(failure);
      else {
        finish();
        const status = [...stderr.matchAll(REMOTE_STATUS)].at(-1);
        resolve({
          completed: status !== undefined,
          code: status ? Number(status[1]) : code || 255,
          stdout: Buffer.concat(stdout),
          stderr: stderr.replace(REMOTE_STATUS, ""),
        });
      }
    });
    child.stdin.end(options.input);
  });
}

export const REMOTE_ERROR_PREFIX = "devdash-error: ";

/**
 * Prefers the message a remote script reported with REMOTE_ERROR_PREFIX over
 * connection noise, then the last stderr line.
 */
export function remoteError(result: RemoteResult, fallback: string): Error {
  const lines = result.stderr
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const reported = lines
    .filter((line) => line.startsWith(REMOTE_ERROR_PREFIX))
    .at(-1);
  return new Error(
    reported?.slice(REMOTE_ERROR_PREFIX.length) ??
      lines.at(-1) ??
      `${fallback} (exit ${result.code ?? "signal"}).`,
  );
}

const REMOTE_MODEL = `fail() { printf '${REMOTE_ERROR_PREFIX}%s\\n' "$1" >&2; exit 2; }
directory=$(realpath -e -- "$1" 2>/dev/null) || fail "Remote model directory does not exist: $1"
[ -d "$directory" ] || fail "Remote model path is not a directory: $directory"
[ -f "$directory/genai_config.json" ] || fail "Remote model is missing $directory/genai_config.json."
printf '%s\\n' "$directory"
du -sb -- "$directory" | cut -f 1
exec cat -- "$directory/genai_config.json"
`;

/** Reads the remote model's canonical directory, size and configuration. */
export async function inspectRemoteModel(
  machine: Pick<RemoteMachine, "command" | "modelPath">,
  signal?: AbortSignal,
): Promise<{ directory: string; info: LocalModelInfo }> {
  const result = await runRemoteScript(
    machine,
    REMOTE_MODEL,
    [machine.modelPath],
    { signal, maxOutput: 1024 * 1024 },
  );
  if (result.code !== 0)
    throw remoteError(result, "Inspecting the remote model failed");
  const text = result.stdout.toString("utf8");
  const [directory, size] = text.split("\n", 2);
  const sizeBytes = Number(size);
  if (!directory?.startsWith("/") || !Number.isSafeInteger(sizeBytes))
    throw new Error("Invalid remote model inspection output.");
  let config: unknown;
  try {
    config = JSON.parse(
      text.slice(directory.length + 1 + (size?.length ?? 0) + 1),
    );
  } catch (error) {
    throw new Error(`Invalid JSON in ${directory}/genai_config.json.`, {
      cause: error,
    });
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error(
      `${directory}/genai_config.json must contain a JSON object.`,
    );
  return {
    directory,
    info: modelInfoFromConfig(config, posix.basename(directory), sizeBytes),
  };
}
