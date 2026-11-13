import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CopilotConversation } from "../src/conversation";
import type { CopilotOptions } from "../src/copilot";
import { buildPrompt } from "../src/prompt";
import { renderResult } from "../src/render";

async function main(): Promise<void> {
  const workingDirectory = await mkdtemp(
    join(tmpdir(), "arranged-agents-smoke-"),
  );
  const options: CopilotOptions = {
    cliPath: process.env.ARRANGED_AGENTS_CLI_PATH ?? "copilot",
    workingDirectory,
    onPermissionRequest: (request) =>
      request.kind === "read"
        ? { kind: "approve-once" }
        : {
            kind: "reject",
            feedback: "This smoke test only permits file reads.",
          },
  };
  const conversation = new CopilotConversation(options);
  let resumed: CopilotConversation | undefined;
  const signal = new AbortController().signal;
  try {
    await promisify(execFile)("git", ["init", "--quiet", workingDirectory]);
    const marker = `ARRANGED_AGENTS_${randomUUID()}`;
    await writeFile(join(workingDirectory, "smoke-marker.txt"), marker);
    const eventTypes = new Set<string>();
    await conversation.start(signal, (event) => eventTypes.add(event.type));
    const answer = await conversation.send(
      buildPrompt("Reply with ARRANGED_AGENTS_OK and nothing else."),
      signal,
    );
    assert.match(answer, /ARRANGED_AGENTS_OK/);
    assert.match(renderResult("Smoke test", answer), /ARRANGED_AGENTS_OK/);
    const fileAnswer = await conversation.send(
      "Use the file reading tool to read smoke-marker.txt in the current repository. " +
        "Reply with its exact contents and nothing else. Do not execute shell commands.",
      signal,
    );
    assert.ok(
      fileAnswer.includes(marker),
      "Copilot could not read the repository marker.",
    );
    assert.ok(
      eventTypes.has("tool.execution_start"),
      "No tool execution event was received.",
    );
    assert.ok(
      eventTypes.has("tool.execution_complete"),
      "No tool result event was received.",
    );
    const sessionId = conversation.sessionId;
    assert.ok(sessionId);
    await conversation.dispose();
    await writeFile(
      join(workingDirectory, "smoke-marker.txt"),
      "The marker has changed.",
    );
    resumed = new CopilotConversation({
      ...options,
      onPermissionRequest: () => ({
        kind: "reject",
        feedback: "Recall the previous session without tools.",
      }),
    });
    await resumed.start(signal, undefined, sessionId);
    assert.equal(resumed.sessionId, sessionId);
    const remembered = await resumed.send(
      "What exact marker did you read from smoke-marker.txt earlier in this conversation? " +
        "Do not use tools or read files again. Reply with that original marker only.",
      signal,
    );
    assert.ok(
      remembered.includes(marker),
      "The resumed session lost its earlier context.",
    );
    await resumed.dispose();
    resumed = new CopilotConversation(options);
    await resumed.deleteSession(sessionId, signal);
    console.log(
      "Local Copilot CLI, file access, live tool events, stop/resume context, SDK session deletion and rendering: OK",
    );
  } finally {
    try {
      await Promise.all([conversation.dispose(), resumed?.dispose()]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
