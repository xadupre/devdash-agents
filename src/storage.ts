import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "./application";
import { parsePostMortem, type PostMortem } from "./postmortem";
import { parseImages } from "./images";
import { MAX_SELECTION_LENGTH } from "./prompt";
import type { StepTiming } from "./timing";
import { parseSessionAssignment, type SessionAssignment } from "./execution";

export interface SessionAnnotation {
  mark: "success" | "failure" | "abandon";
  reason?: string;
  comments?: string;
}

export function parseSessionAnnotation(value: unknown): SessionAnnotation {
  if (
    !isRecord(value) ||
    (value.mark !== "success" &&
      value.mark !== "failure" &&
      value.mark !== "abandon") ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" || value.reason.length > 20_000)) ||
    (value.comments !== undefined &&
      (typeof value.comments !== "string" || value.comments.length > 20_000)) ||
    (value.mark !== "success" &&
      (typeof value.reason !== "string" || !value.reason.trim()))
  ) {
    throw new Error(
      "Choose a mark and provide a reason for failure or abandonment.",
    );
  }
  return {
    mark: value.mark,
    ...(typeof value.reason === "string" && value.reason.trim()
      ? { reason: value.reason.trim() }
      : {}),
    ...(typeof value.comments === "string" && value.comments.trim()
      ? { comments: value.comments.trim() }
      : {}),
  };
}

export interface SavedConversation {
  assignment?: SessionAssignment;
  backend?: "local" | "copilot";
  recordId?: string;
  recordMessageStart?: number;
  sessionId?: string;
  models?: string[];
  annotation?: SessionAnnotation;
  context?: string;
  generatedTokens?: number;
  finalDiffSize?: number;
  draft: string;
  messages: ChatMessage[];
  postMortem?: PostMortem;
}

export interface SavedSessionSlot extends SavedConversation {
  id: string;
  history?: SavedConversation[];
}

export interface SavedRepositorySession extends SavedConversation {
  id: string;
  history?: SavedConversation[];
  localSessions?: SavedSessionSlot[];
  copilotSessions?: SavedSessionSlot[];
  selectedLocalSessionId?: string;
  selectedCopilotSessionId?: string;
  view?: "copilot" | "local";
}

export interface SavedApplication {
  version: 1;
  root: string;
  activeId?: string;
  sessions: SavedRepositorySession[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    ["user", "assistant", "system", "reasoning", "tool", "output"].includes(
      value.role,
    ) &&
    typeof value.content === "string" &&
    (value.timings === undefined ||
      (Array.isArray(value.timings) && value.timings.every(isStepTiming))) &&
    (value.error === undefined || typeof value.error === "boolean") &&
    ["title", "timestamp", "agentId", "toolCallId", "details"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  );
}

function isStepTiming(value: unknown): value is StepTiming {
  return (
    isRecord(value) &&
    (value.kind === "generation" || value.kind === "tool") &&
    typeof value.name === "string" &&
    typeof value.start === "number" &&
    Number.isFinite(value.start) &&
    value.start >= 0 &&
    (value.end === undefined ||
      (typeof value.end === "number" &&
        Number.isFinite(value.end) &&
        value.end >= value.start)) &&
    (value.agentId === undefined || typeof value.agentId === "string") &&
    (value.outputTokens === undefined ||
      (typeof value.outputTokens === "number" &&
        Number.isSafeInteger(value.outputTokens) &&
        value.outputTokens >= 0))
  );
}

function parseConversation(value: unknown): SavedConversation {
  if (
    !isRecord(value) ||
    typeof value.draft !== "string" ||
    (value.backend !== undefined &&
      value.backend !== "local" &&
      value.backend !== "copilot") ||
    (value.recordId !== undefined &&
      (typeof value.recordId !== "string" ||
        !value.recordId ||
        value.recordId.length > 100)) ||
    (value.recordMessageStart !== undefined &&
      (typeof value.recordMessageStart !== "number" ||
        !Number.isSafeInteger(value.recordMessageStart) ||
        value.recordMessageStart < 0 ||
        !Array.isArray(value.messages) ||
        value.recordMessageStart > value.messages.length)) ||
    (value.models !== undefined &&
      (!Array.isArray(value.models) ||
        value.models.some(
          (model: unknown) =>
            typeof model !== "string" || !model || model.length > 4096,
        ))) ||
    (value.context !== undefined &&
      (typeof value.context !== "string" ||
        value.context.length > MAX_SELECTION_LENGTH)) ||
    (value.sessionId !== undefined &&
      (typeof value.sessionId !== "string" || !value.sessionId)) ||
    (value.generatedTokens !== undefined &&
      (typeof value.generatedTokens !== "number" ||
        !Number.isSafeInteger(value.generatedTokens) ||
        value.generatedTokens < 0)) ||
    (value.finalDiffSize !== undefined &&
      (typeof value.finalDiffSize !== "number" ||
        !Number.isSafeInteger(value.finalDiffSize) ||
        value.finalDiffSize < 0)) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage)
  ) {
    throw new Error("Invalid conversation in saved DevDash Agents history.");
  }
  const postMortem =
    value.postMortem === undefined
      ? undefined
      : parsePostMortem(value.postMortem);
  if (postMortem && postMortem.sourceCount > value.messages.length) {
    throw new Error(
      "Saved PostMortem references missing conversation records.",
    );
  }
  const assignment =
    value.assignment === undefined
      ? undefined
      : parseSessionAssignment(value.assignment);
  if (assignment && assignment.worker.backend !== (value.backend ?? "copilot"))
    throw new Error("Saved session and worker backends must match.");
  return {
    ...(assignment ? { assignment } : {}),
    ...(value.backend !== undefined ? { backend: value.backend } : {}),
    ...(value.recordId !== undefined ? { recordId: value.recordId } : {}),
    ...(value.recordMessageStart !== undefined
      ? { recordMessageStart: value.recordMessageStart as number }
      : {}),
    sessionId: value.sessionId,
    ...(value.models !== undefined ? { models: [...value.models] } : {}),
    ...(value.context !== undefined ? { context: value.context } : {}),
    ...(value.annotation !== undefined
      ? { annotation: parseSessionAnnotation(value.annotation) }
      : {}),
    ...(value.generatedTokens !== undefined
      ? { generatedTokens: value.generatedTokens }
      : {}),
    ...(value.finalDiffSize !== undefined
      ? { finalDiffSize: value.finalDiffSize }
      : {}),
    draft: value.draft,
    messages: value.messages.map((message) => ({
      role: message.role,
      content: message.content,
      title: message.title,
      timestamp: message.timestamp,
      agentId: message.agentId,
      ...(message.toolCallId !== undefined
        ? { toolCallId: message.toolCallId }
        : {}),
      details: message.details,
      error: message.error,
      ...(message.timings
        ? {
            timings: message.timings.map((step) => ({
              kind: step.kind,
              name: step.name,
              start: step.start,
              end: step.end ?? step.start,
              ...(step.agentId ? { agentId: step.agentId } : {}),
              ...(step.outputTokens !== undefined
                ? { outputTokens: step.outputTokens }
                : {}),
            })),
          }
        : {}),
      ...(message.images !== undefined
        ? { images: parseImages(message.images) }
        : {}),
    })),
    ...(postMortem ? { postMortem } : {}),
  };
}

function parseSavedSlots(value: unknown): SavedSessionSlot[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error("Invalid sessions in saved DevDash Agents history.");
  const ids = new Set<string>();
  return value.map((slot: unknown) => {
    if (
      !isRecord(slot) ||
      typeof slot.id !== "string" ||
      !/^[\w-]{1,100}$/.test(slot.id) ||
      ids.has(slot.id) ||
      (slot.history !== undefined && !Array.isArray(slot.history))
    )
      throw new Error("Invalid session in saved DevDash Agents history.");
    ids.add(slot.id);
    return {
      id: slot.id,
      ...parseConversation(slot),
      ...(slot.history !== undefined
        ? { history: slot.history.map(parseConversation) }
        : {}),
    };
  });
}

function parseSavedApplication(value: unknown, root: string): SavedApplication {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.root !== root ||
    (value.activeId !== undefined && typeof value.activeId !== "string") ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error("Invalid saved DevDash Agents history.");
  }
  const ids = new Set<string>();
  const sessions = value.sessions.map(
    (session: unknown): SavedRepositorySession => {
      if (
        !isRecord(session) ||
        typeof session.id !== "string" ||
        ids.has(session.id) ||
        (session.view !== undefined &&
          session.view !== "copilot" &&
          session.view !== "local") ||
        (session.history !== undefined && !Array.isArray(session.history))
      ) {
        throw new Error("Invalid repository in saved DevDash Agents history.");
      }
      ids.add(session.id);
      const localSessions = parseSavedSlots(session.localSessions);
      const copilotSessions = parseSavedSlots(session.copilotSessions);
      if (
        session.selectedLocalSessionId !== undefined &&
        (typeof session.selectedLocalSessionId !== "string" ||
          !localSessions?.some(
            (local) => local.id === session.selectedLocalSessionId,
          ))
      ) {
        throw new Error(
          "Invalid selected local session in saved DevDash Agents history.",
        );
      }
      if (
        session.selectedCopilotSessionId !== undefined &&
        (typeof session.selectedCopilotSessionId !== "string" ||
          !copilotSessions?.some(
            (slot) => slot.id === session.selectedCopilotSessionId,
          ))
      )
        throw new Error(
          "Invalid selected Copilot session in saved DevDash Agents history.",
        );
      return {
        id: session.id,
        ...parseConversation(session),
        history: session.history?.map(parseConversation),
        ...(localSessions !== undefined ? { localSessions } : {}),
        ...(copilotSessions !== undefined ? { copilotSessions } : {}),
        ...(session.selectedCopilotSessionId !== undefined
          ? { selectedCopilotSessionId: session.selectedCopilotSessionId }
          : {}),
        ...(session.selectedLocalSessionId !== undefined
          ? { selectedLocalSessionId: session.selectedLocalSessionId }
          : {}),
        ...(session.view !== undefined ? { view: session.view } : {}),
      };
    },
  );
  return { version: 1, root, activeId: value.activeId, sessions };
}

export class ApplicationStorage {
  readonly filename: string;
  private readonly directory: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    homeDirectory: string,
    private readonly root: string,
  ) {
    this.directory = join(
      homeDirectory,
      ".cache",
      "devdash-agents",
      "conversations",
    );
    this.filename = join(
      this.directory,
      `${createHash("sha256").update(root).digest("hex")}.json`,
    );
  }

  async load(): Promise<SavedApplication | undefined> {
    let content: string;
    try {
      content = await readFile(this.filename, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return parseSavedApplication(JSON.parse(content), this.root);
  }

  save(snapshot: SavedApplication): Promise<void> {
    const content = JSON.stringify(parseSavedApplication(snapshot, this.root));
    const write = async (): Promise<void> => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, this.filename);
      } finally {
        await rm(temporary, { force: true });
      }
    };
    // A failed save is returned to its caller; a later save can retry.
    this.writing = this.writing.then(write, write);
    return this.writing;
  }
}
