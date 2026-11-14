import { machineRepositoryPath, type MachineConfiguration } from "./execution";
import { runCommand, type CommandRunner } from "./github";
import { remoteCommandRunner } from "./remote";
import type { SessionView } from "./application";
import {
  diffLines,
  isDiffPath,
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  parseDiffPatch,
  type DiffEntry,
  type DiffFile,
} from "./diff";

export { isDiffPath } from "./diff";
export type { DiffChange, DiffEntry } from "./diff";
export type LocalDiffFile = DiffFile;

export interface LocalDiffList {
  commit: string;
  files: DiffEntry[];
  machine: string;
  repositoryPath: string;
}

export interface LocalDiffUpdate {
  type: "local-diff";
  id: string;
  view: SessionView;
  requestId: string;
  list?: LocalDiffList;
  file?: LocalDiffFile;
  error?: string;
}

const MAX_FILES = 5_000;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function location(repositoryPath: string, machine?: MachineConfiguration) {
  if (!machine)
    throw new Error(
      "This session has no recorded execution machine. Start or resume it with a machine assignment before reviewing its diff.",
    );
  return {
    cwd: machineRepositoryPath(machine, repositoryPath),
    run: machine.command ? remoteCommandRunner(machine) : runCommand,
    machine: machine.name,
  };
}

function parseEntries(output: string): DiffEntry[] {
  if (!output) return [];
  const fields = output.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0)
    throw new Error("Git returned an invalid changed-file list.");
  const files: DiffEntry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (
      !status ||
      !/^[AMDTU]$/.test(status) ||
      !isDiffPath(path) ||
      path.includes("\ufffd")
    )
      throw new Error(
        "Git returned an unsupported changed-file path or status.",
      );
    files.push({ status: status as DiffEntry["status"], path });
  }
  if (files.length > MAX_FILES)
    throw new Error(`The diff contains more than ${MAX_FILES} changed files.`);
  return files;
}

async function head(
  cwd: string,
  signal: AbortSignal,
  run: CommandRunner,
): Promise<string> {
  const commit = (
    await run("git", ["rev-parse", "--verify", "HEAD^{commit}"], cwd, signal)
  ).trim();
  if (!commitPattern.test(commit))
    throw new Error("Git returned an invalid HEAD.");
  return commit;
}

export async function listLocalDiff(
  repositoryPath: string,
  machine: MachineConfiguration | undefined,
  signal: AbortSignal,
  runner?: CommandRunner,
): Promise<LocalDiffList> {
  const target = location(repositoryPath, machine);
  const run = runner ?? target.run;
  const commit = await head(target.cwd, signal, run);
  const output = await run(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "-z",
      commit,
      "--",
    ],
    target.cwd,
    signal,
  );
  if ((await head(target.cwd, signal, run)) !== commit)
    throw new Error(
      "HEAD changed while loading the diff. Refresh and try again.",
    );
  return {
    commit,
    files: parseEntries(output),
    machine: target.machine,
    repositoryPath: target.cwd,
  };
}

export async function loadLocalDiffFile(
  repositoryPath: string,
  machine: MachineConfiguration | undefined,
  commit: string,
  path: string,
  signal: AbortSignal,
  runner?: CommandRunner,
): Promise<LocalDiffFile> {
  if (!commitPattern.test(commit) || !isDiffPath(path))
    throw new Error("Invalid diff file request.");
  const target = location(repositoryPath, machine);
  const run = runner ?? target.run;
  if ((await head(target.cwd, signal, run)) !== commit)
    throw new Error(
      "HEAD changed since the diff was loaded. Refresh and try again.",
    );
  const prefix = [
    "-c",
    "core.fsmonitor=false",
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
  ];
  const entries = parseEntries(
    await run(
      "git",
      [...prefix, "--name-status", "-z", commit, "--", path],
      target.cwd,
      signal,
    ),
  );
  if (entries.length !== 1 || entries[0]!.path !== path)
    throw new Error(
      "The file is no longer in the diff. Refresh and try again.",
    );
  const entry = entries[0]!;
  if (entry.status === "U")
    throw new Error("Resolve the merge conflict before viewing this file.");
  const patch = await run(
    "git",
    [...prefix, "--no-color", "--unified=1000000", commit, "--", path],
    target.cwd,
    signal,
  );
  if (patch.includes("\ufffd"))
    throw new Error("The changed file is not supported UTF-8 text.");
  if (!patch)
    throw new Error(
      "The file is no longer in the diff. Refresh and try again.",
    );
  const result = parseDiffPatch(entry, patch);
  if (
    !result.binary &&
    !result.oldLines.length &&
    !result.newLines.length &&
    !result.changes.length &&
    entry.status === "M"
  ) {
    const text = await run(
      "git",
      ["show", `${commit}:${path}`],
      target.cwd,
      signal,
    );
    if (text.includes("\0") || text.includes("\ufffd")) result.binary = true;
    else {
      const lines = diffLines(text);
      if (
        lines.length > MAX_DIFF_LINES ||
        Buffer.byteLength(text, "utf8") > MAX_DIFF_BYTES
      )
        throw new Error(
          "The changed file is too large to display in the diff viewer.",
        );
      result.oldLines = lines;
      result.newLines = [...lines];
      result.oldNoFinalNewline = result.newNoFinalNewline = Boolean(
        text && !text.endsWith("\n"),
      );
    }
  }
  if ((await head(target.cwd, signal, run)) !== commit)
    throw new Error(
      "HEAD changed while loading the file. Refresh and try again.",
    );
  return result;
}
