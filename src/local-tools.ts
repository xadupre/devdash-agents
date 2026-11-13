import { spawn } from "node:child_process";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { PermissionRequest } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};
import { automaticallyApprove } from "./permissions";
import { describePermission } from "./presentation";
import {
  REMOTE_ERROR_PREFIX,
  remoteError,
  runRemoteScript,
  type RemoteMachine,
} from "./remote";

export const LOCAL_TOOL_MARKERS = [
  ["<tool_call>", "</tool_call>"],
  ["<arranged_tool_call>", "</arranged_tool_call>"],
] as const;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT = 24 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 1000;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export const MAX_LOCAL_TOOL_CALLS = 8;

export type LocalToolCall =
  | { name: "read_file"; arguments: { path: string } }
  | { name: "search_files"; arguments: { query: string } }
  | {
      name: "edit_file";
      arguments: { path: string; oldText: string; newText: string };
    }
  | { name: "run_command"; arguments: { program: string; args: string[] } };

export interface LocalToolHost {
  /** Repository directory, on the remote machine when `remote` is set. */
  repositoryPath: string;
  /** Runs every tool on this machine instead of the extension host. */
  remote?: Pick<RemoteMachine, "name" | "command">;
  canEdit?(): boolean;
  requestPermission(
    permission: ReturnType<typeof describePermission> & {
      source?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean>;
}

function requireEditingSession(host: LocalToolHost): void {
  if (host.canEdit?.() === false)
    throw new Error(
      "This local session is read-only. Only the oldest open local session may edit files or run commands.",
    );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedText(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.length) ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`Local tool request has an invalid ${name}.`);
  }
  return value;
}

export function parseLocalToolCall(text: string): LocalToolCall | undefined {
  let json = text.trim();
  const marker = LOCAL_TOOL_MARKERS.find(
    ([open, close]) => json.startsWith(open) || json.endsWith(close),
  );
  if (marker) {
    const [open, close] = marker;
    // Some local models omit one envelope tag; never repair the JSON itself.
    if (json.startsWith(open)) json = json.slice(open.length).trim();
    if (json.endsWith(close)) json = json.slice(0, -close.length).trim();
  }
  if (marker?.[0] === "<tool_call>" && json.startsWith("<function=")) {
    if (!text.trim().startsWith(marker[0]) || !text.trim().endsWith(marker[1]))
      throw new Error("Malformed local XML tool request.");
    const fn = /^<function=(\w+)>([\s\S]*)<\/function>$/.exec(json);
    if (!fn) throw new Error("Malformed local XML tool request.");
    const args: Record<string, unknown> = Object.create(null);
    let parameters = fn[2]!.trim();
    while (parameters) {
      const parameter = /^<parameter=(\w+)>([\s\S]*?)<\/parameter>/.exec(
        parameters,
      );
      if (!parameter || Object.hasOwn(args, parameter[1]!))
        throw new Error("Malformed or duplicate local tool parameter.");
      const name = parameter[1]!;
      const value = parameter[2]!.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      // Only run_command.args is non-string in the supported tool schemas.
      args[name] = name === "args" ? JSON.parse(value) : value;
      parameters = parameters.slice(parameter[0].length).trim();
    }
    return validateToolCall({ name: fn[1], arguments: args });
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    if (
      marker ||
      LOCAL_TOOL_MARKERS.some(
        ([open, close]) =>
          text.includes(open.slice(0, -1)) || text.includes(close),
      ) ||
      (json.startsWith("{") &&
        json.includes('"name"') &&
        json.includes('"arguments"'))
    )
      throw new Error(
        "Malformed local tool request: expected exactly one complete JSON object, optionally wrapped in matching tool-call tags.",
        { cause: error },
      );
    return undefined;
  }
  if (
    !marker &&
    (!record(value) || !("name" in value) || !("arguments" in value))
  )
    return undefined;
  return validateToolCall(value);
}

function validateToolCall(value: unknown): LocalToolCall {
  if (!record(value) || !exactKeys(value, ["name", "arguments"]))
    throw new Error("Local tool request must contain only name and arguments.");
  const args = value.arguments;
  if (!record(args)) throw new Error("Local tool arguments must be an object.");

  switch (value.name) {
    case "read_file":
      if (!exactKeys(args, ["path"]))
        throw new Error("read_file requires exactly a path.");
      return {
        name: "read_file",
        arguments: { path: boundedText(args.path, "path", 4096) },
      };
    case "search_files":
      if (!exactKeys(args, ["query"]))
        throw new Error("search_files requires exactly a query.");
      return {
        name: "search_files",
        arguments: { query: boundedText(args.query, "query", 256) },
      };
    case "edit_file":
      if (!exactKeys(args, ["path", "oldText", "newText"]))
        throw new Error("edit_file requires path, oldText, and newText.");
      return {
        name: "edit_file",
        arguments: {
          path: boundedText(args.path, "path", 4096),
          oldText: boundedText(args.oldText, "oldText", 32 * 1024),
          newText: boundedText(args.newText, "newText", 32 * 1024, true),
        },
      };
    case "run_command":
      if (!exactKeys(args, ["program", "args"]))
        throw new Error("run_command requires program and args.");
      if (
        !Array.isArray(args.args) ||
        args.args.length > 64 ||
        !args.args.every(
          (argument) =>
            typeof argument === "string" &&
            argument.length <= 4096 &&
            !argument.includes("\0"),
        )
      ) {
        throw new Error("run_command has invalid arguments.");
      }
      if (
        args.args.reduce((length, argument) => length + argument.length, 0) >
        16 * 1024
      ) {
        throw new Error("run_command arguments exceed the size limit.");
      }
      return {
        name: "run_command",
        arguments: {
          program: boundedText(args.program, "program", 4096),
          args: [...args.args],
        },
      };
    default:
      throw new Error("Local tool request names an unsupported tool.");
  }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

async function localPath(
  root: string,
  path: string,
): Promise<{ root: string; path: string; candidate: string }> {
  if (isAbsolute(path))
    throw new Error("Local tools accept repository-relative paths only.");
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, path);
  if (!inside(canonicalRoot, candidate))
    throw new Error("Local tool path must stay inside the repository.");
  const canonicalPath = await realpath(candidate);
  if (!inside(canonicalRoot, canonicalPath))
    throw new Error("Local tool path resolves outside the repository.");
  const info = await stat(canonicalPath);
  if (!info.isFile())
    throw new Error("Local tool path must name a regular file.");
  return { root: canonicalRoot, path: canonicalPath, candidate };
}

async function rejectSymlinkComponents(
  root: string,
  candidate: string,
): Promise<void> {
  let current = root;
  for (const component of relative(root, candidate).split(sep)) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Local tools do not edit symbolic links.");
  }
}

function outputLimit(text: string): string {
  if (Buffer.byteLength(text) <= MAX_TOOL_OUTPUT) return text;
  let result = text;
  while (Buffer.byteLength(result) > MAX_TOOL_OUTPUT - 64)
    result = result.slice(0, Math.floor(result.length * 0.9));
  return `${result}\n[Output truncated at ${MAX_TOOL_OUTPUT} bytes.]`;
}

async function authorize(
  request: PermissionRequest,
  host: LocalToolHost,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (automaticallyApprove(request, undefined, [])) return true;
  const description = describePermission(request);
  const approved = await host.requestPermission(
    { ...description, source: "Local model" },
    signal,
  );
  signal.throwIfAborted();
  return approved;
}

async function readLocalFile(
  host: LocalToolHost,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const file = await localPath(host.repositoryPath, path);
  const request: PermissionRequest = {
    kind: "read",
    path: file.path,
    intention: "Read a repository file for the local model.",
  };
  if (!(await authorize(request, host, signal)))
    return "Denied. No file was read.";
  signal.throwIfAborted();
  const info = await stat(file.path);
  if (info.size > MAX_READ_BYTES)
    throw new Error(
      `Local file exceeds the ${MAX_READ_BYTES}-byte read limit.`,
    );
  const contents = await readFile(file.path);
  if (contents.byteLength > MAX_READ_BYTES)
    throw new Error(
      `Local file exceeds the ${MAX_READ_BYTES}-byte read limit.`,
    );
  if (contents.includes("\0"))
    throw new Error("Binary files cannot be read as text.");
  return outputLimit(contents.toString("utf8"));
}

async function searchLocalFiles(
  host: LocalToolHost,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const canonicalRoot = await realpath(host.repositoryPath);
  const request: PermissionRequest = {
    kind: "read",
    path: canonicalRoot,
    intention: "Search repository text files for a literal string.",
  };
  if (!(await authorize(request, host, signal)))
    return "Denied. No files were searched.";

  const ignored = new Set([".git", "node_modules", "build", "dist", ".venv"]);
  const matches: string[] = [];
  let files = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 20) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      signal.throwIfAborted();
      if (matches.length >= MAX_SEARCH_RESULTS) return;
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++files > MAX_SEARCH_FILES)
        throw new Error(
          `Repository search exceeded ${MAX_SEARCH_FILES} files.`,
        );
      const info = await stat(path);
      if (info.size > MAX_FILE_BYTES) continue;
      const contents = await readFile(path);
      if (contents.byteLength > MAX_FILE_BYTES) continue;
      if (contents.includes(0)) continue;
      const text = contents.toString("utf8");
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.includes(query)) continue;
        const relativePath = relative(canonicalRoot, path).split(sep).join("/");
        matches.push(`${relativePath}:${index + 1}: ${line.slice(0, 500)}`);
        if (matches.length >= MAX_SEARCH_RESULTS) return;
      }
      if (matches.length >= MAX_SEARCH_RESULTS) return;
    }
  };
  await visit(canonicalRoot, 0);
  return matches.length
    ? outputLimit(matches.join("\n"))
    : `No matches for ${JSON.stringify(query)}.`;
}

function editedText(
  previousBytes: Buffer,
  oldText: string,
  newText: string,
): string {
  if (previousBytes.includes(0))
    throw new Error("Binary files cannot be edited.");
  let previous: string;
  try {
    previous = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(previousBytes);
  } catch (error) {
    throw new Error("Local file is not valid UTF-8.", { cause: error });
  }
  const first = previous.indexOf(oldText);
  if (first === -1 || previous.indexOf(oldText, first + oldText.length) !== -1)
    throw new Error("edit_file requires oldText to match exactly once.");
  if (oldText === newText)
    throw new Error("edit_file would not change the file.");
  const next =
    previous.slice(0, first) + newText + previous.slice(first + oldText.length);
  if (Buffer.byteLength(next) > MAX_FILE_BYTES)
    throw new Error(`Edited file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  return next;
}

async function editLocalFile(
  host: LocalToolHost,
  path: string,
  oldText: string,
  newText: string,
  signal: AbortSignal,
): Promise<string> {
  const file = await localPath(host.repositoryPath, path);
  await rejectSymlinkComponents(file.root, file.candidate);
  const info = await lstat(file.path);
  if (info.size > MAX_FILE_BYTES)
    throw new Error(
      `Local file exceeds the ${MAX_FILE_BYTES}-byte edit limit.`,
    );
  const previousBytes = await readFile(file.path);
  if (previousBytes.byteLength > MAX_FILE_BYTES)
    throw new Error(
      `Local file exceeds the ${MAX_FILE_BYTES}-byte edit limit.`,
    );
  const next = editedText(previousBytes, oldText, newText);
  const request: PermissionRequest = {
    kind: "write",
    fileName: file.path,
    intention: "Apply this exact edit to a repository file.",
    canOfferSessionApproval: false,
    diff: `--- ${file.path}\n+++ ${file.path}\n-${oldText}\n+${newText}`,
  };
  if (!(await authorize(request, host, signal)))
    throw new Error("Permission denied. No file was changed.");
  requireEditingSession(host);
  signal.throwIfAborted();
  await rejectSymlinkComponents(file.root, file.candidate);
  const currentInfo = await lstat(file.candidate);
  if (
    !currentInfo.isFile() ||
    currentInfo.dev !== info.dev ||
    currentInfo.ino !== info.ino
  )
    throw new Error(
      "File changed while awaiting approval; no edit was applied.",
    );
  const handle = await open(file.path, "r+");
  try {
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== info.dev ||
      openedInfo.ino !== info.ino ||
      openedInfo.size > MAX_FILE_BYTES ||
      !(await handle.readFile()).equals(previousBytes)
    )
      throw new Error(
        "File changed while awaiting approval; no edit was applied.",
      );
    signal.throwIfAborted();
    requireEditingSession(host);
    const bytes = Buffer.from(next, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesWritten === 0)
        throw new Error("Could not write the edited file.");
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
  } finally {
    await handle.close();
  }
  return `Updated ${file.path}.`;
}

function commandText(program: string, args: string[]): string {
  return [program, ...args]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
}

function runLocalCommand(
  program: string,
  args: string[],
  root: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    signal.throwIfAborted();
    const child = spawn(program, args, {
      cwd: root,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
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
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Command cancelled.", "AbortError"),
      );
    const collect = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT) {
        stop(new Error(`Command output exceeded ${MAX_COMMAND_OUTPUT} bytes.`));
        return;
      }
      output += chunk.toString("utf8");
    };
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (error) rejectResult(error);
      else resolveResult(value ?? "");
    };
    const timeout = setTimeout(
      () => stop(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms.`)),
      COMMAND_TIMEOUT_MS,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => finish(error));
    child.once("close", (code, termination) => {
      if (signal.aborted) {
        finish(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Command cancelled.", "AbortError"),
        );
      } else if (failure) {
        finish(failure);
      } else if (code !== 0) {
        finish(
          new Error(
            `Command failed (${termination ?? code}): ${output.slice(-8192)}`,
          ),
        );
      } else {
        finish(
          undefined,
          outputLimit(output || "Command completed with no output."),
        );
      }
    });
    if (signal.aborted) abort();
  });
}

async function executeCommand(
  host: LocalToolHost,
  program: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const root = await realpath(host.repositoryPath);
  const command = commandText(program, args);
  const request: PermissionRequest = {
    kind: "shell",
    fullCommandText: command,
    intention: `Run a local model command in ${root}.`,
    commands: [{ identifier: program, readOnly: false }],
    canOfferSessionApproval: false,
    hasWriteFileRedirection: false,
    possiblePaths: [root],
    possibleUrls: [],
    requestSandboxBypass: true,
    requestSandboxBypassReason:
      "Local model commands run directly in the extension host, not in the Copilot CLI sandbox.",
    warning:
      "This command is not sandboxed and may access files outside this repository.",
  };
  if (!(await authorize(request, host, signal)))
    throw new Error("Permission denied. The command was not run.");
  requireEditingSession(host);
  signal.throwIfAborted();
  return runLocalCommand(program, args, root, signal);
}

type RemoteToolHost = LocalToolHost & {
  remote: NonNullable<LocalToolHost["remote"]>;
};

const REMOTE_CONNECTION_GRACE_MS = 60_000;
const REMOTE_FAIL = `fail() { printf '${REMOTE_ERROR_PREFIX}%s\\n' "$1" >&2; exit 2; }
root=$(realpath -e -- "$1" 2>/dev/null) || fail "The remote repository does not exist: $1"
`;
// $2 is a normalized repository-relative path; symlinks must stay inside.
const REMOTE_FILE = `${REMOTE_FAIL}candidate="$root/$2"
path=$(realpath -e -- "$candidate" 2>/dev/null) || fail "Local tool path does not exist."
case "$path" in "$root"/*) ;; *) fail "Local tool path resolves outside the repository." ;; esac
[ -f "$path" ] || fail "Local tool path must name a regular file."
`;
const REMOTE_NO_SYMLINK = `[ "$path" = "$candidate" ] || fail "Local tools do not edit symbolic links."
`;
const REMOTE_READ = `${REMOTE_FILE}[ -n "$4" ] && { ${REMOTE_NO_SYMLINK}}
[ "$(stat -c %s -- "$path")" -le "$3" ] || fail "Local file exceeds the $3-byte $5 limit."
exec cat -- "$path"
`;
const REMOTE_WRITE = `${REMOTE_FILE}${REMOTE_NO_SYMLINK}[ "$(sha256sum -- "$path" | cut -d ' ' -f 1)" = "$3" ] || fail "File changed while awaiting approval; no edit was applied."
cat > "$path" || fail "Could not write the edited file."
`;
const REMOTE_SEARCH = `${REMOTE_FAIL}cd -- "$root" || fail "The remote repository cannot be opened."
grep -rnIF ${[".git", "node_modules", "build", "dist", ".venv"].map((name) => `--exclude-dir=${name}`).join(" ")} -e "$2" . 2>/dev/null | cut -c 1-600 | head -n ${MAX_SEARCH_RESULTS}
exit 0
`;
const REMOTE_COMMAND = `${REMOTE_FAIL}cd -- "$root" || fail "The remote repository cannot be opened."
shift
if command -v timeout >/dev/null 2>&1; then exec timeout -k 2 ${COMMAND_TIMEOUT_MS / 1000} "$@" 2>&1; fi
exec "$@" 2>&1
`;

function remoteRelativePath(path: string): string {
  if (path.startsWith("/") || isAbsolute(path))
    throw new Error("Local tools accept repository-relative paths only.");
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../"))
    throw new Error("Local tool path must stay inside the repository.");
  return normalized;
}

function remoteLabel(host: LocalToolHost, path?: string): string {
  return posix.join(host.repositoryPath, path ?? "");
}

async function readRemoteBytes(
  host: RemoteToolHost,
  path: string,
  limit: number,
  purpose: "read" | "edit",
  signal: AbortSignal,
): Promise<Buffer> {
  const result = await runRemoteScript(
    host.remote,
    REMOTE_READ,
    [
      host.repositoryPath,
      path,
      String(limit),
      purpose === "edit" ? "1" : "",
      purpose,
    ],
    { signal, maxOutput: limit + 1 },
  );
  if (result.code !== 0) throw remoteError(result, "Remote read failed");
  return result.stdout;
}

async function readRemoteFile(
  host: RemoteToolHost,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const relativePath = remoteRelativePath(path);
  const request: PermissionRequest = {
    kind: "read",
    path: remoteLabel(host, relativePath),
    intention: `Read a repository file on ${host.remote.name} for the local model.`,
  };
  if (!(await authorize(request, host, signal)))
    return "Denied. No file was read.";
  const contents = await readRemoteBytes(
    host,
    relativePath,
    MAX_READ_BYTES,
    "read",
    signal,
  );
  if (contents.includes(0))
    throw new Error("Binary files cannot be read as text.");
  return outputLimit(contents.toString("utf8"));
}

async function searchRemoteFiles(
  host: RemoteToolHost,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const request: PermissionRequest = {
    kind: "read",
    path: host.repositoryPath,
    intention: `Search repository text files on ${host.remote.name} for a literal string.`,
  };
  if (!(await authorize(request, host, signal)))
    return "Denied. No files were searched.";
  const result = await runRemoteScript(
    host.remote,
    REMOTE_SEARCH,
    [host.repositoryPath, query],
    { signal },
  );
  if (result.code !== 0) throw remoteError(result, "Remote search failed");
  const matches = result.stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^\.\/(.*?):(\d+):(.*)$/s.exec(line);
      return match
        ? `${match[1]}:${match[2]}: ${match[3]!.slice(0, 500)}`
        : line;
    });
  return matches.length
    ? outputLimit(matches.join("\n"))
    : `No matches for ${JSON.stringify(query)}.`;
}

async function editRemoteFile(
  host: RemoteToolHost,
  path: string,
  oldText: string,
  newText: string,
  signal: AbortSignal,
): Promise<string> {
  const relativePath = remoteRelativePath(path);
  const previousBytes = await readRemoteBytes(
    host,
    relativePath,
    MAX_FILE_BYTES,
    "edit",
    signal,
  );
  const label = remoteLabel(host, relativePath);
  const next = editedText(previousBytes, oldText, newText);
  const request: PermissionRequest = {
    kind: "write",
    fileName: label,
    intention: `Apply this exact edit to a repository file on ${host.remote.name}.`,
    canOfferSessionApproval: false,
    diff: `--- ${label}\n+++ ${label}\n-${oldText}\n+${newText}`,
  };
  if (!(await authorize(request, host, signal)))
    throw new Error("Permission denied. No file was changed.");
  requireEditingSession(host);
  signal.throwIfAborted();
  const result = await runRemoteScript(
    host.remote,
    REMOTE_WRITE,
    [
      host.repositoryPath,
      relativePath,
      createHash("sha256").update(previousBytes).digest("hex"),
    ],
    { input: Buffer.from(next, "utf8"), signal },
  );
  if (result.code !== 0) throw remoteError(result, "Remote edit failed");
  return `Updated ${label} on ${host.remote.name}.`;
}

async function executeRemoteCommand(
  host: RemoteToolHost,
  program: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const command = commandText(program, args);
  const request: PermissionRequest = {
    kind: "shell",
    fullCommandText: command,
    intention: `Run a local model command on ${host.remote.name} in ${host.repositoryPath}.`,
    commands: [{ identifier: program, readOnly: false }],
    canOfferSessionApproval: false,
    hasWriteFileRedirection: false,
    possiblePaths: [host.repositoryPath],
    possibleUrls: [],
    requestSandboxBypass: true,
    requestSandboxBypassReason: `Local model commands run directly on the remote machine ${host.remote.name}, not in the Copilot CLI sandbox.`,
    warning: `This command runs on ${host.remote.name}, is not sandboxed and may access files outside this repository.`,
  };
  if (!(await authorize(request, host, signal)))
    throw new Error("Permission denied. The command was not run.");
  requireEditingSession(host);
  signal.throwIfAborted();
  const result = await runRemoteScript(
    host.remote,
    REMOTE_COMMAND,
    [host.repositoryPath, program, ...args],
    {
      signal,
      timeoutMs: COMMAND_TIMEOUT_MS + REMOTE_CONNECTION_GRACE_MS,
      maxOutput: MAX_COMMAND_OUTPUT,
    },
  );
  const output = result.stdout.toString("utf8");
  if (result.code !== 0) {
    if (result.stderr.includes(REMOTE_ERROR_PREFIX))
      throw remoteError(result, "Remote command failed");
    throw new Error(
      result.completed
        ? `Command failed (${result.code ?? "signal"}): ${output.slice(-8192) || "no output"}`
        : `Could not reach ${host.remote.name}: ${result.stderr.trim().slice(-8192)}`,
    );
  }
  return outputLimit(output || "Command completed with no output.");
}

export async function executeLocalTool(
  call: LocalToolCall,
  host: LocalToolHost,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (host.remote) {
    const remoteHost = host as RemoteToolHost;
    switch (call.name) {
      case "read_file":
        return readRemoteFile(remoteHost, call.arguments.path, signal);
      case "search_files":
        return searchRemoteFiles(remoteHost, call.arguments.query, signal);
      case "edit_file":
        requireEditingSession(host);
        return editRemoteFile(
          remoteHost,
          call.arguments.path,
          call.arguments.oldText,
          call.arguments.newText,
          signal,
        );
      case "run_command":
        requireEditingSession(host);
        return executeRemoteCommand(
          remoteHost,
          call.arguments.program,
          call.arguments.args,
          signal,
        );
    }
  }
  switch (call.name) {
    case "read_file":
      return readLocalFile(host, call.arguments.path, signal);
    case "search_files":
      return searchLocalFiles(host, call.arguments.query, signal);
    case "edit_file":
      requireEditingSession(host);
      return editLocalFile(
        host,
        call.arguments.path,
        call.arguments.oldText,
        call.arguments.newText,
        signal,
      );
    case "run_command":
      requireEditingSession(host);
      return executeCommand(
        host,
        call.arguments.program,
        call.arguments.args,
        signal,
      );
  }
}
