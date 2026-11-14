import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export interface DiffEntry {
  path: string;
  status: "A" | "M" | "D" | "T" | "U" | "R" | "C";
  oldPath?: string;
}

export interface DiffChange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface DiffFile extends DiffEntry {
  oldLines: string[];
  newLines: string[];
  changes: DiffChange[];
  binary: boolean;
  oldNoFinalNewline: boolean;
  newNoFinalNewline: boolean;
}

export const MAX_DIFF_LINES = 10_000;
export const MAX_DIFF_BYTES = 4 * 1024 * 1024;

export function isDiffPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4096 &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

export function diffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export function parseDiffPatch(entry: DiffEntry, patch: string): DiffFile {
  const result: DiffFile = {
    ...entry,
    oldLines: [],
    newLines: [],
    changes: [],
    binary: false,
    oldNoFinalNewline: false,
    newNoFinalNewline: false,
  };
  if (patch.includes("\0"))
    throw new Error("The changed file is not supported UTF-8 text.");
  if (Buffer.byteLength(patch, "utf8") > MAX_DIFF_BYTES)
    throw new Error(
      "The changed file is too large to display in the diff viewer.",
    );
  if (/^Binary files .* differ$/m.test(patch)) {
    result.binary = true;
    return result;
  }
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunks = 0;
  let sectionHunks = 0;
  let previous = "";
  let change: DiffChange | undefined;
  const finishChange = (): void => {
    if (change) result.changes.push(change);
    change = undefined;
  };
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("\\ No newline at end of file")) {
      if (previous === "-" || previous === " ") result.oldNoFinalNewline = true;
      if (previous === "+" || previous === " ") result.newNoFinalNewline = true;
      continue;
    }
    if (oldRemaining || newRemaining) {
      const prefix = raw[0];
      const content = raw.slice(1).endsWith("\r")
        ? raw.slice(1, -1)
        : raw.slice(1);
      if (prefix === " ") {
        finishChange();
        result.oldLines.push(content);
        result.newLines.push(content);
        oldRemaining--;
        newRemaining--;
      } else if (prefix === "-" || prefix === "+") {
        change ??= {
          oldStart: result.oldLines.length,
          oldCount: 0,
          newStart: result.newLines.length,
          newCount: 0,
        };
        if (prefix === "-") {
          result.oldLines.push(content);
          change.oldCount++;
          oldRemaining--;
        } else {
          result.newLines.push(content);
          change.newCount++;
          newRemaining--;
        }
      } else {
        throw new Error("Git returned an invalid diff hunk.");
      }
      if (oldRemaining < 0 || newRemaining < 0)
        throw new Error("Git returned an invalid diff hunk.");
      if (
        result.oldLines.length > MAX_DIFF_LINES ||
        result.newLines.length > MAX_DIFF_LINES
      )
        throw new Error(`The changed file exceeds ${MAX_DIFF_LINES} lines.`);
      previous = prefix;
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      finishChange();
      sectionHunks = 0;
    } else if (raw.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!match || ++sectionHunks > 1)
        throw new Error(
          "Git returned an incomplete diff; refresh and try again.",
        );
      const oldStart = Number(match[1]);
      const newStart = Number(match[3]);
      oldRemaining = Number(match[2] ?? "1");
      newRemaining = Number(match[4] ?? "1");
      if ((oldRemaining && oldStart !== 1) || (newRemaining && newStart !== 1))
        throw new Error("The changed file is too large to display in full.");
      hunks++;
    }
  }
  if (oldRemaining || newRemaining)
    throw new Error("Git returned an incomplete diff; refresh and try again.");
  finishChange();
  if (entry.status === "T" && hunks > 1) {
    result.changes = [
      {
        oldStart: 0,
        oldCount: result.oldLines.length,
        newStart: 0,
        newCount: result.newLines.length,
      },
    ];
  }
  return result;
}

const execute = promisify(execFile);

export async function compareDiffText(
  entry: DiffEntry,
  oldText: string,
  newText: string,
  signal: AbortSignal,
): Promise<DiffFile> {
  for (const text of [oldText, newText]) {
    if (text.includes("\0"))
      throw new Error("The changed file is not supported UTF-8 text.");
    if (
      Buffer.byteLength(text, "utf8") > MAX_DIFF_BYTES ||
      diffLines(text).length > MAX_DIFF_LINES
    )
      throw new Error(
        "The changed file is too large to display in the diff viewer.",
      );
  }
  const directory = await mkdtemp(join(tmpdir(), "devdash-pr-diff-"));
  try {
    const oldFile = join(directory, "old");
    const newFile = join(directory, "new");
    await Promise.all([
      writeFile(oldFile, oldText),
      writeFile(newFile, newText),
    ]);
    signal.throwIfAborted();
    let patch: string;
    try {
      ({ stdout: patch } = await execute(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--text",
          "--unified=1000000",
          "--",
          oldFile,
          newFile,
        ],
        {
          cwd: directory,
          signal,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
          env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
        },
      ));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stdout" in error &&
        typeof error.stdout === "string"
      ) {
        patch = error.stdout;
      } else if (
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.trim()
      ) {
        throw new Error(`git: ${error.stderr.trim()}`, { cause: error });
      } else {
        throw error;
      }
    }
    const result = parseDiffPatch(entry, patch);
    if (!patch) {
      result.oldLines = diffLines(oldText);
      result.newLines = diffLines(newText);
      result.oldNoFinalNewline = Boolean(oldText && !oldText.endsWith("\n"));
      result.newNoFinalNewline = Boolean(newText && !newText.endsWith("\n"));
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
