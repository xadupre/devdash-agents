import { randomUUID } from "node:crypto";
import { CopilotRecoveryError, type Conversation } from "./conversation";
import { buildPrompt, MAX_PROMPT_LENGTH, MAX_SELECTION_LENGTH } from "./prompt";
import { discoverRepositories, type Repository } from "./repositories";
import { isExternalUrl } from "./links";
import {
  isImageDataUrl,
  MAX_IMAGES,
  parseImages,
  type ImageAttachment,
} from "./images";
import { describeTool } from "./presentation";
import { ExecutionTiming, type StepTiming } from "./timing";
import {
  isGitHubDiscussionUrl,
  isGitHubCommentBody,
  isGitHubSection,
  type GitHubSection,
} from "./github";
import {
  parsePostMortem,
  postMortemSources,
  type PostMortem,
  type PostMortemProgress,
  type PostMortemSource,
} from "./postmortem";
import {
  findDiscussionReferences,
  type SessionExportSource,
} from "./session-export";
import {
  isLocalProvider,
  type ContextReductionMode,
  type LocalProvider,
} from "./local-worker";
import type { LocalPlacement } from "./local-model-host";
import {
  isCopilotModelId,
  parseHarnessSettingsPatch,
  type HarnessSettings,
} from "./settings";
import {
  isFoundryDevice,
  isFoundryModelId,
  type FoundryDevice,
} from "./foundry";
import {
  parseSessionAnnotation,
  type SessionAnnotation,
  type SavedApplication,
  type SavedConversation,
  type SavedRepositorySession,
} from "./storage";
import type { UserInputRequest, UserInputResponse } from "./copilot";
import type { SessionEvent } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};
import { basename } from "node:path";
import { parseRemoteMachines, type RemoteMachine } from "./remote";
import {
  parseExecutionConfiguration,
  parseSessionAssignment,
  type ExecutionConfiguration,
  type SessionAssignment,
} from "./execution";

export type SessionStatus =
  "idle" | "saved" | "starting" | "ready" | "busy" | "error" | "stopping";
/** Open Copilot CLI sessions grouped by their saved worker and machine binding. */
export interface CopilotWorkerSnapshot {
  groupId: string;
  workerName: string;
  machineName: string;
  model: string;
  sessions: { repositoryId: string; view: SessionView }[];
  busy: boolean;
  /** Epoch milliseconds when idle sessions will be closed. */
  idleStopAt?: number;
}

export type SessionView =
  "copilot" | "local" | `local:${string}` | `copilot:${string}`;

function isSessionView(value: unknown): value is SessionView {
  return (
    value === "copilot" ||
    value === "local" ||
    (typeof value === "string" && /^(local|copilot):[\w-]{1,100}$/.test(value))
  );
}

export interface LocalSessionSetup {
  create: (localSessionId?: string) => Conversation;
  prepare: () => Promise<void>;
  assignment?: SessionAssignment;
}
export type InformationType =
  "messages" | "reasoning" | "tools" | "output" | "system";
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "reasoning" | "tool" | "output";
  content: string;
  title?: string;
  timestamp?: string;
  agentId?: string;
  toolCallId?: string;
  details?: string;
  error?: boolean;
  images?: ImageAttachment[];
  timings?: StepTiming[];
}
export interface DatasetSession {
  repository: Repository;
  recordId: string;
  sessionId?: string;
  backend: "local" | "copilot";
  location: "current" | "archived" | "parallel";
  models: string[];
  references: string[];
  annotation?: SessionAnnotation;
}
export interface ApplicationState {
  root: string;
  logs?: ApplicationLog[];
  repositories: (Repository & {
    status: SessionStatus;
    hasSavedSession?: boolean;
    sessionCount?: number;
    generation?: number;
    parallelCount?: number;
    queuedCount?: number;
    generatedTokens?: number;
    backend?: "local" | "copilot";
    model?: string;
    view?: SessionView;
    copilotGeneration?: number;
    sessions?: {
      view: SessionView;
      backend: "copilot" | "local";
      status: SessionStatus;
      open: boolean;
      model?: string;
      readOnly?: boolean;
      generation: number;
      assignment?: SessionAssignment;
    }[];
    localSession?: {
      id?: string;
      readOnly?: boolean;
      status: SessionStatus;
      reducingContext?: boolean;
      canReduceContext?: boolean;
      generation?: number;
      model?: string;
      generatedTokens: number;
      contextTokens?: number;
      contextLimit?: number;
    };
    localSessions?: {
      id: string;
      status: SessionStatus;
      model?: string;
      readOnly: boolean;
      reducingContext?: boolean;
      canReduceContext?: boolean;
      contextTokens?: number;
      generatedTokens: number;
      generation?: number;
      contextLimit?: number;
    }[];
    contextTokens?: number;
    contextLimit?: number;
    managementBusy?: boolean;
  })[];
  activeId?: string;
  messages: ChatMessage[];
  error?: string;
  draft: string;
  permissions: PendingPermission[];
  questions: PendingQuestion[];
  postMortem?: PostMortem;
  postMortemBusy?: boolean;
  postMortemProgress?: string;
  postMortemError?: string;
}
export interface ApplicationLog {
  id: number;
  timestamp: string;
  repository: string;
  message: string;
  level: "info" | "error";
}
export interface PendingPermission {
  id: string;
  repositoryId: string;
  kind: string;
  summary: string;
  content: string;
  details: string;
  approvalLabel?: string;
  source?: string;
}
export interface PendingQuestion extends UserInputRequest {
  id: string;
  repositoryId: string;
}
interface RepositorySession {
  assignment?: SessionAssignment;
  backend?: "local" | "copilot";
  recordId: string;
  models?: string[];
  annotation?: SessionAnnotation;
  context?: string;
  repository: Repository;
  status: SessionStatus;
  messages: ChatMessage[];
  conversation?: Conversation;
  localFactory?: (localSessionId?: string) => Conversation;
  controller?: AbortController;
  starting?: Promise<void>;
  error?: string;
  sessionId?: string;
  draft: string;
  sending?: Promise<void>;
  managing?: Promise<void>;
  managingSession?: RepositorySession;
  reducingContext?: boolean;
  history: SavedConversation[];
  generation: number;
  generatedTokens: number;
  contextTokens?: number;
  contextLimit?: number;
  view?: SessionView;
  parent?: RepositorySession;
  local?: RepositorySession;
  locals?: RepositorySession[];
  localId?: string;
  localLoaded?: boolean;
  copilots?: RepositorySession[];
  copilotId?: string;
  removed?: boolean;
  eventMessages: Map<string, ChatMessage>;
  timing?: ExecutionTiming;
  imageAssets?: Map<
    string,
    { image?: ImageAttachment; messages: Set<ChatMessage> }
  >;
  postMortem?: PostMortem;
  postMortemError?: string;
  postMortemProgress?: string;
  postMortemOperation?: { controller: AbortController; promise: Promise<void> };
  parallel: Map<string, RepositorySession>;
  queue: {
    question: string;
    prompt: string;
    message: ChatMessage;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[];
}

export type ApplicationMessage =
  | {
      type:
        | "ready"
        | "refresh"
        | "settings"
        | "local-devices"
        | "local-model"
        | "copilot-models"
        | "dataset-sessions"
        | "foundry-cancel";
    }
  | { type: "foundry-models"; device: FoundryDevice }
  | { type: "worker-foundry-models"; requestId: string; device: "cpu" | "gpu" }
  /** Reply to the host's session dialog; no choice means it was cancelled. */
  | {
      type: "assignment-choice";
      requestId: string;
      choice?: {
        workerId: string;
        workerMachineId: string;
        executionMachineId: string;
      };
    }
  | { type: "foundry-download"; id: string }
  | { type: "local-device"; provider: LocalProvider; deviceId: number }
  | { type: "stop-local-worker"; hostId: string }
  | { type: "stop-copilot-worker"; groupId: string }
  | {
      type: "local-placement";
      modelPath: string;
      hostId?: string;
      placement: LocalPlacement;
    }
  | { type: "copilot-model"; model: string }
  | { type: "remote-machines"; machines: RemoteMachine[]; selected: string }
  | {
      type: "execution-configuration";
      requestId: string;
      configuration: ExecutionConfiguration;
    }
  | {
      type: "reduce-context";
      id: string;
      mode: ContextReductionMode;
      view?: SessionView;
    }
  | { type: "new-local-session"; id: string }
  | { type: "add-session"; id: string }
  | { type: "select-session"; id: string; view: SessionView }
  | { type: "select-local-session"; id: string; localSessionId: string }
  | {
      type: "harness-settings";
      requestId: number;
      settings: Partial<HarnessSettings>;
      baseApprovedUrlOrigins?: string[];
    }
  | {
      type: "annotate-session";
      id: string;
      recordId: string;
      annotation: SessionAnnotation | null;
    }
  | { type: "export-dataset-session"; id: string; recordId: string }
  | { type: "github"; id: string; section: GitHubSection; cursor?: string }
  | { type: "github-discussion"; id: string; url: string }
  | {
      type: "github-comment";
      id: string;
      url: string;
      body: string;
      requestId: string;
    }
  | {
      type:
        | "select"
        | "restart"
        | "postmortem"
        | "export-postmortem"
        | "export-session"
        | "close-github-discussion";
      id: string;
    }
  | {
      type:
        | "open-session"
        | "open-local-session"
        | "delete-last-session"
        | "delete-all-sessions";
      id: string;
    }
  | {
      type: "close-session" | "new-session" | "resume-session";
      id: string;
      view?: SessionView;
    }
  | { type: "draft"; id: string; text: string; view?: SessionView }
  | { type: "cancel"; id: string; view?: SessionView }
  | { type: "transfer-session"; id: string; view?: SessionView }
  | { type: "permission"; id: string; approve: boolean }
  | { type: "answer"; id: string; answer: string }
  | { type: "openExternal"; url: string }
  | {
      type: "send";
      id: string;
      question: string;
      parallel?: boolean;
      images?: ImageAttachment[];
      view?: SessionView;
    };

export function parseApplicationMessage(value: unknown): ApplicationMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Invalid application message.");
  }
  if (value.type === "execution-configuration") {
    if (
      !("requestId" in value) ||
      typeof value.requestId !== "string" ||
      !value.requestId ||
      value.requestId.length > 100
    )
      throw new Error("Invalid execution configuration request.");
    return {
      type: "execution-configuration",
      requestId: value.requestId,
      configuration: parseExecutionConfiguration(
        "configuration" in value ? value.configuration : undefined,
      ),
    };
  }
  if (
    value.type === "ready" ||
    value.type === "refresh" ||
    value.type === "settings" ||
    value.type === "local-devices" ||
    value.type === "local-model" ||
    value.type === "copilot-models" ||
    value.type === "dataset-sessions" ||
    value.type === "foundry-cancel"
  ) {
    return { type: value.type };
  }
  if (value.type === "foundry-models") {
    const device = "device" in value ? value.device : undefined;
    if (!isFoundryDevice(device))
      throw new Error("Invalid Foundry Local device.");
    return { type: "foundry-models", device };
  }
  if (value.type === "worker-foundry-models") {
    const device = "device" in value ? value.device : undefined;
    const requestId = "requestId" in value ? value.requestId : undefined;
    if (
      (device !== "cpu" && device !== "gpu") ||
      typeof requestId !== "string" ||
      !/^[\w-]{1,100}$/.test(requestId)
    )
      throw new Error("Invalid Foundry catalogue request.");
    return { type: "worker-foundry-models", requestId, device };
  }
  if (value.type === "assignment-choice") {
    const requestId = "requestId" in value ? value.requestId : undefined;
    const choice = "choice" in value ? value.choice : undefined;
    const ids =
      choice && typeof choice === "object"
        ? (["workerId", "workerMachineId", "executionMachineId"] as const).map(
            (key) => (choice as Record<string, unknown>)[key],
          )
        : [];
    if (
      typeof requestId !== "string" ||
      !/^[\w-]{1,100}$/.test(requestId) ||
      (choice !== undefined &&
        (ids.length !== 3 ||
          ids.some((id) => typeof id !== "string" || !id || id.length > 200)))
    )
      throw new Error("Invalid session assignment choice.");
    if (choice === undefined) return { type: "assignment-choice", requestId };
    const [workerId, workerMachineId, executionMachineId] = ids as [
      string,
      string,
      string,
    ];
    return {
      type: "assignment-choice",
      requestId,
      choice: { workerId, workerMachineId, executionMachineId },
    };
  }
  if (value.type === "harness-settings") {
    if (
      !("requestId" in value) ||
      typeof value.requestId !== "number" ||
      !Number.isSafeInteger(value.requestId) ||
      value.requestId < 1
    )
      throw new Error("Invalid harness settings request ID.");
    const settings = parseHarnessSettingsPatch(
      "settings" in value ? value.settings : undefined,
    );
    if ("approvedUrlOrigins" in settings !== "baseApprovedUrlOrigins" in value)
      throw new Error("Missing base URL approvals for the settings update.");
    const baseApprovedUrlOrigins =
      "baseApprovedUrlOrigins" in value
        ? parseHarnessSettingsPatch({
            approvedUrlOrigins: value.baseApprovedUrlOrigins,
          }).approvedUrlOrigins
        : undefined;
    return {
      type: "harness-settings",
      requestId: value.requestId,
      settings,
      ...(baseApprovedUrlOrigins !== undefined
        ? { baseApprovedUrlOrigins }
        : {}),
    };
  }
  if (value.type === "foundry-download") {
    const id = "id" in value ? value.id : undefined;
    if (!isFoundryModelId(id))
      throw new Error("Invalid Foundry Local model ID.");
    return { type: "foundry-download", id };
  }
  if (value.type === "local-device") {
    const provider = "provider" in value ? value.provider : undefined;
    const deviceId = "deviceId" in value ? value.deviceId : undefined;
    if (
      !isLocalProvider(provider) ||
      typeof deviceId !== "number" ||
      !Number.isSafeInteger(deviceId) ||
      deviceId < -1 ||
      (provider === "auto" && deviceId !== -1)
    ) {
      throw new Error("Invalid local inference device.");
    }
    return { type: "local-device", provider, deviceId };
  }
  if (value.type === "stop-local-worker") {
    const hostId = "hostId" in value ? value.hostId : undefined;
    if (typeof hostId !== "string" || !/^[\w-]{1,100}$/.test(hostId))
      throw new Error("Invalid local model host.");
    return { type: "stop-local-worker", hostId };
  }
  if (value.type === "stop-copilot-worker") {
    const groupId = "groupId" in value ? value.groupId : undefined;
    if (typeof groupId !== "string" || !/^[a-f0-9]{64}$/.test(groupId))
      throw new Error("Invalid Copilot worker.");
    return { type: "stop-copilot-worker", groupId };
  }
  if (value.type === "local-placement") {
    const modelPath = "modelPath" in value ? value.modelPath : undefined;
    if (
      typeof modelPath !== "string" ||
      !modelPath.trim() ||
      modelPath.length > 4096
    )
      throw new Error("Invalid local model path.");
    const hostId = "hostId" in value ? value.hostId : undefined;
    if (
      hostId !== undefined &&
      (typeof hostId !== "string" || !/^[\w-]{1,100}$/.test(hostId))
    )
      throw new Error("Invalid local model host.");
    const requestedPlacement =
      "placement" in value &&
      value.placement &&
      typeof value.placement === "object"
        ? value.placement
        : undefined;
    if (
      requestedPlacement &&
      "provider" in requestedPlacement &&
      requestedPlacement.provider === "disk"
    ) {
      return {
        type: "local-placement",
        modelPath,
        ...(hostId ? { hostId } : {}),
        placement: { provider: "disk" },
      };
    }
    const provider =
      requestedPlacement && "provider" in requestedPlacement
        ? requestedPlacement.provider
        : undefined;
    const deviceId =
      requestedPlacement && "deviceId" in requestedPlacement
        ? requestedPlacement.deviceId
        : undefined;
    if (
      !isLocalProvider(provider) ||
      typeof deviceId !== "number" ||
      !Number.isSafeInteger(deviceId) ||
      deviceId < -1 ||
      (provider === "auto" && deviceId !== -1)
    )
      throw new Error("Invalid local inference placement.");
    return {
      type: "local-placement",
      modelPath,
      ...(hostId ? { hostId } : {}),
      placement: { provider, deviceId },
    };
  }
  if (value.type === "reduce-context") {
    if (
      !("id" in value) ||
      typeof value.id !== "string" ||
      !value.id ||
      !("mode" in value) ||
      (value.mode !== "sliding" && value.mode !== "compress") ||
      ("view" in value &&
        value.view !== undefined &&
        !isSessionView(value.view))
    )
      throw new Error("Invalid context reduction request.");
    return {
      type: "reduce-context",
      id: value.id,
      mode: value.mode,
      ...("view" in value && isSessionView(value.view)
        ? { view: value.view }
        : {}),
    };
  }
  if (value.type === "select-session") {
    if (
      !("id" in value) ||
      typeof value.id !== "string" ||
      !value.id ||
      !("view" in value) ||
      !isSessionView(value.view)
    )
      throw new Error("Invalid session selection.");
    return { type: "select-session", id: value.id, view: value.view };
  }
  if (value.type === "select-local-session") {
    if (
      !("id" in value) ||
      typeof value.id !== "string" ||
      !value.id ||
      !("localSessionId" in value) ||
      typeof value.localSessionId !== "string" ||
      !/^[\w-]{1,100}$/.test(value.localSessionId)
    )
      throw new Error("Invalid local session selection.");
    return {
      type: "select-local-session",
      id: value.id,
      localSessionId: value.localSessionId,
    };
  }
  if (value.type === "remote-machines") {
    const machines = parseRemoteMachines(
      "machines" in value ? value.machines : undefined,
    );
    const selected = "selected" in value ? value.selected : undefined;
    if (
      typeof selected !== "string" ||
      (selected && !machines.some((machine) => machine.name === selected))
    )
      throw new Error("Choose a configured execution machine.");
    return { type: "remote-machines", machines, selected };
  }
  if (value.type === "copilot-model") {
    const model = "model" in value ? value.model : undefined;
    if (!isCopilotModelId(model)) throw new Error("Invalid Copilot model.");
    return { type: "copilot-model", model };
  }
  if (value.type === "openExternal") {
    if (
      !("url" in value) ||
      typeof value.url !== "string" ||
      !isExternalUrl(value.url)
    ) {
      throw new Error("Only HTTP and HTTPS links can be opened.");
    }
    return { type: "openExternal", url: value.url };
  }
  if (!("id" in value) || typeof value.id !== "string") {
    throw new Error("The application message must identify a repository.");
  }
  if (
    (value.type === "annotate-session" ||
      value.type === "export-dataset-session") &&
    "recordId" in value &&
    typeof value.recordId === "string" &&
    value.recordId.length > 0 &&
    value.recordId.length <= 100
  ) {
    if (value.type === "export-dataset-session")
      return { type: value.type, id: value.id, recordId: value.recordId };
    if (!("annotation" in value)) throw new Error("Missing annotation.");
    return {
      type: value.type,
      id: value.id,
      recordId: value.recordId,
      annotation:
        value.annotation === null
          ? null
          : parseSessionAnnotation(value.annotation),
    };
  }
  if (
    value.type === "github-comment" &&
    "url" in value &&
    isGitHubDiscussionUrl(value.url) &&
    "body" in value &&
    isGitHubCommentBody(value.body) &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 100
  ) {
    return {
      type: "github-comment",
      id: value.id,
      url: value.url,
      body: value.body,
      requestId: value.requestId,
    };
  }
  if (
    value.type === "github-discussion" &&
    "url" in value &&
    isGitHubDiscussionUrl(value.url)
  ) {
    return { type: "github-discussion", id: value.id, url: value.url };
  }
  if (
    value.type === "github" &&
    "section" in value &&
    isGitHubSection(value.section) &&
    (!("cursor" in value) ||
      value.cursor === undefined ||
      (typeof value.cursor === "string" && value.cursor.length <= 4096))
  ) {
    return {
      type: "github",
      id: value.id,
      section: value.section,
      cursor:
        "cursor" in value && typeof value.cursor === "string"
          ? value.cursor
          : undefined,
    };
  }
  if (
    value.type === "answer" &&
    "answer" in value &&
    typeof value.answer === "string" &&
    value.answer.trim() &&
    value.answer.length <= MAX_PROMPT_LENGTH
  ) {
    return { type: "answer", id: value.id, answer: value.answer };
  }
  if (
    value.type === "permission" &&
    "approve" in value &&
    typeof value.approve === "boolean"
  ) {
    return { type: "permission", id: value.id, approve: value.approve };
  }
  if (
    value.type === "select" ||
    value.type === "close-github-discussion" ||
    value.type === "restart" ||
    value.type === "postmortem" ||
    value.type === "export-postmortem" ||
    value.type === "export-session" ||
    value.type === "open-session" ||
    value.type === "open-local-session" ||
    value.type === "new-local-session" ||
    value.type === "add-session" ||
    value.type === "delete-last-session" ||
    value.type === "delete-all-sessions"
  ) {
    return { type: value.type, id: value.id };
  }
  if (
    (value.type === "cancel" ||
      value.type === "transfer-session" ||
      value.type === "resume-session" ||
      value.type === "close-session" ||
      value.type === "new-session") &&
    (!("view" in value) ||
      value.view === undefined ||
      isSessionView(value.view))
  ) {
    const rawView = "view" in value ? value.view : undefined;
    const view = isSessionView(rawView) ? rawView : undefined;
    if (value.type !== "transfer-session")
      return { type: value.type, id: value.id, ...(view ? { view } : {}) };
    return {
      type: "transfer-session",
      id: value.id,
      ...(view ? { view } : {}),
    };
  }
  if (
    value.type === "draft" &&
    "text" in value &&
    typeof value.text === "string" &&
    value.text.length <= MAX_PROMPT_LENGTH &&
    (!("view" in value) ||
      value.view === undefined ||
      isSessionView(value.view))
  ) {
    const rawView = "view" in value ? value.view : undefined;
    const view = isSessionView(rawView) ? rawView : undefined;
    return {
      type: "draft",
      id: value.id,
      text: value.text,
      ...(view ? { view } : {}),
    };
  }
  if (
    value.type === "send" &&
    "question" in value &&
    typeof value.question === "string" &&
    (!("view" in value) ||
      value.view === undefined ||
      isSessionView(value.view)) &&
    (!("parallel" in value) ||
      value.parallel === undefined ||
      typeof value.parallel === "boolean")
  ) {
    const rawView = "view" in value ? value.view : undefined;
    const view = isSessionView(rawView) ? rawView : undefined;
    return {
      type: "send",
      id: value.id,
      question: value.question,
      ...(view ? { view } : {}),
      ...("images" in value && value.images !== undefined
        ? { images: parseImages(value.images) }
        : {}),
      ...("parallel" in value && typeof value.parallel === "boolean"
        ? { parallel: value.parallel }
        : {}),
    };
  }
  throw new Error("Unknown application message.");
}

export class AgentApplication {
  private readonly sessions = new Map<string, RepositorySession>();
  private readonly logs: ApplicationLog[] = [];
  private logSequence = 0;
  private activeId?: string;
  private closed = false;
  private stopping?: Promise<void>;
  private readonly saved = new Map<string, SavedRepositorySession>();
  private readonly permissions = new Map<
    string,
    {
      request: PendingPermission;
      owner: RepositorySession;
      resolve: (approve: boolean) => void;
    }
  >();
  private readonly questions = new Map<
    string,
    {
      request: PendingQuestion;
      owner: RepositorySession;
      resolve: (response: UserInputResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    readonly root: string,
    private readonly createConversation: (
      repository: Repository,
      requestId?: string,
      view?: SessionView,
      assignment?: SessionAssignment,
    ) => Conversation,
    private readonly onChange: (streaming?: boolean) => void,
    saved?: SavedApplication,
  ) {
    if (saved && saved.root !== root) {
      throw new Error(
        "Saved history belongs to a different repository parent.",
      );
    }
    this.activeId = saved?.activeId;
    for (const session of saved?.sessions ?? []) {
      this.saved.set(session.id, {
        ...session,
        recordId: session.recordId ?? randomUUID(),
        history: session.history?.map((entry) => ({
          ...entry,
          recordId: entry.recordId ?? randomUUID(),
        })),
      });
    }
  }

  async refresh(): Promise<void> {
    this.assertOpen();
    const repositories = await discoverRepositories(this.root);
    this.assertOpen();
    const ids = new Set(repositories.map((repository) => repository.id));
    for (const [id, session] of this.sessions) {
      if (!ids.has(id)) {
        const slots = this.sessionSlots(session);
        for (const slot of slots) {
          slot.removed = true;
          slot.controller?.abort();
          slot.postMortemOperation?.controller.abort();
          for (const child of slot.parallel.values()) child.controller?.abort();
          this.cancelQueue(slot);
        }
        this.clearPendingRequests(id);
        await Promise.all(slots.map((slot) => slot.conversation?.dispose()));
        if (session.managing) {
          await Promise.allSettled([session.managing]);
        }
        for (const slot of slots) await this.stopSession(slot);
        this.saved.set(id, this.saveSession(session));
        this.sessions.delete(id);
        if (this.activeId === id) {
          this.activeId = undefined;
        }
      }
    }
    for (const repository of repositories) {
      if (!this.sessions.has(repository.id)) {
        const saved = this.saved.get(repository.id);
        const history = saved?.history ?? [];
        const localSaved =
          saved?.backend === "local"
            ? saved
            : [...history].reverse().find((entry) => entry.backend === "local");
        const copilotSaved =
          saved?.backend === "local"
            ? [...history].reverse().find((entry) => entry.backend !== "local")
            : saved;
        const copilotHistory = history.filter(
          (entry) => entry !== copilotSaved && entry.backend !== "local",
        );
        const localHistory = history.filter(
          (entry) => entry !== localSaved && entry.backend === "local",
        );
        const main: RepositorySession = {
          repository,
          recordId: copilotSaved?.recordId ?? randomUUID(),
          assignment:
            copilotSaved?.assignment &&
            structuredClone(copilotSaved.assignment),
          models: copilotSaved?.models?.slice(),
          annotation: copilotSaved?.annotation,
          context: copilotSaved?.context,
          status: copilotSaved?.sessionId ? "saved" : "idle",
          backend: copilotSaved?.backend ?? "copilot",
          sessionId: copilotSaved?.sessionId,
          draft: copilotSaved?.draft ?? "",
          messages:
            copilotSaved?.messages.map((message) => ({
              ...message,
              ...(message.title === "Queued - after current work"
                ? { title: "Not sent - previous application ended" }
                : {}),
            })) ?? [],
          history: copilotHistory.map((entry) => this.copyConversation(entry)),
          generation: 0,
          generatedTokens: copilotSaved?.generatedTokens ?? 0,
          eventMessages: new Map(),
          parallel: new Map(),
          queue: [],
          postMortem: copilotSaved?.postMortem,
          view: saved?.backend === "local" ? "local" : "copilot",
        };
        if (localSaved) {
          main.local = {
            localId: randomUUID(),
            repository,
            recordId: localSaved.recordId ?? randomUUID(),
            assignment:
              localSaved.assignment && structuredClone(localSaved.assignment),
            models: localSaved.models?.slice(),
            annotation: localSaved.annotation,
            context: localSaved.context,
            status: "idle",
            backend: "local",
            draft: localSaved.draft,
            messages: localSaved.messages.map((message) => ({ ...message })),
            history: localHistory.map((entry) => this.copyConversation(entry)),
            generation: 0,
            generatedTokens: localSaved.generatedTokens ?? 0,
            eventMessages: new Map(),
            parallel: new Map(),
            queue: [],
          };
        }
        if (saved?.localSessions?.length) {
          main.locals = saved.localSessions.map((savedLocal) => {
            const local = this.createSessionSlot(repository);
            this.restoreConversation(local, savedLocal);
            local.backend = "local";
            local.localId = savedLocal.id;
            local.history =
              savedLocal.history?.map((entry) =>
                this.copyConversation(entry),
              ) ?? [];
            return local;
          });
          main.local =
            main.locals.find(
              (local) => local.localId === saved.selectedLocalSessionId,
            ) ?? main.locals[0];
          main.view =
            saved.view ?? (saved.selectedLocalSessionId ? "local" : "copilot");
        } else if (main.local) main.locals = [main.local];
        main.copilots = saved?.copilotSessions?.map((entry) => {
          const slot = this.createSessionSlot(repository);
          this.restoreConversation(slot, entry);
          slot.backend = "copilot";
          slot.copilotId = entry.id;
          slot.history =
            entry.history?.map((item) => this.copyConversation(item)) ?? [];
          return slot;
        });
        if (saved?.view !== "local" && saved?.selectedCopilotSessionId)
          main.view = `copilot:${saved.selectedCopilotSessionId}`;
        this.sessions.set(repository.id, main);
      }
    }
    if (this.activeId && !this.sessions.has(this.activeId)) {
      this.activeId = undefined;
    }
    this.onChange();
  }

  getState(): ApplicationState {
    const activeMain = this.activeId
      ? this.sessions.get(this.activeId)
      : undefined;
    const active = activeMain ? this.displayed(activeMain) : undefined;
    return {
      root: this.root,
      logs: this.logs.map((entry) => ({ ...entry })),
      repositories: [...this.sessions.values()]
        .map((main) => {
          const session = this.displayed(main);
          const locals = this.localSessions(main);
          const editor = this.editingLocalSession(main);
          return {
            ...session.repository,
            status:
              (main.managing &&
                main.managingSession === session &&
                session.status !== "starting" &&
                !locals.some((local) => local.reducingContext)) ||
              session.postMortemOperation
                ? ("stopping" as const)
                : session.parallel.size &&
                    ["ready", "error"].includes(session.status)
                  ? ("busy" as const)
                  : session.status,
            hasSavedSession: Boolean(session.sessionId),
            sessionCount:
              session.history.length +
              session.parallel.size +
              (this.hasConversation(session) ? 1 : 0),
            generation: session.generation,
            copilotGeneration: main.generation,
            parallelCount: session.parallel.size,
            queuedCount: session.queue.length,
            generatedTokens: session.generatedTokens,
            backend: session.backend ?? "copilot",
            model: session.conversation?.model,
            view: this.sessionView(session),
            sessions: this.sessionSlots(main).map((slot) => ({
              view: this.sessionView(slot),
              backend: slot.backend ?? "copilot",
              status:
                slot.parallel.size && ["ready", "error"].includes(slot.status)
                  ? ("busy" as const)
                  : slot.status,
              open: Boolean(
                slot.conversation ||
                slot.starting ||
                slot.status === "starting",
              ),
              model: slot.conversation?.model,
              readOnly: slot.backend === "local" ? editor !== slot : undefined,
              generation: slot.generation,
              ...(slot.assignment
                ? { assignment: structuredClone(slot.assignment) }
                : {}),
            })),
            localSession: main.local
              ? {
                  id: main.local.localId,
                  readOnly: editor !== main.local,
                  status: main.local.status,
                  reducingContext: main.local.reducingContext,
                  canReduceContext: Boolean(
                    !main.local.sending &&
                    main.local.conversation?.canReduceContext,
                  ),
                  generation: main.local.generation,
                  model: main.local.conversation?.model,
                  generatedTokens: main.local.generatedTokens,
                  contextTokens: main.local.contextTokens,
                  contextLimit: main.local.contextLimit,
                }
              : undefined,
            localSessions: locals.map((local) => ({
              id: local.localId!,
              status: local.status,
              model: local.conversation?.model,
              readOnly: editor !== local,
              reducingContext: local.reducingContext,
              canReduceContext: Boolean(
                !local.sending && local.conversation?.canReduceContext,
              ),
              contextTokens: local.contextTokens,
              generatedTokens: local.generatedTokens,
              generation: local.generation,
              contextLimit: local.contextLimit,
            })),
            contextTokens: session.contextTokens,
            contextLimit: session.contextLimit,
            managementBusy: Boolean(main.managing),
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
      activeId: this.activeId,
      messages:
        active?.messages.map((message) => this.copyMessage(message)) ?? [],
      error: active?.error,
      draft: active?.draft ?? "",
      permissions: [...this.permissions.values()].map(({ request }) => ({
        ...request,
      })),
      questions: [...this.questions.values()].map(({ request }) => ({
        ...request,
        choices: request.choices ? [...request.choices] : undefined,
      })),
      postMortem: active?.postMortem
        ? structuredClone(active.postMortem)
        : undefined,
      postMortemBusy: Boolean(active?.postMortemOperation),
      postMortemProgress: active?.postMortemOperation
        ? active.postMortemProgress
        : undefined,
      postMortemError: active?.postMortemError,
    };
  }

  requestPermission(
    repositoryId: string,
    permission: Omit<PendingPermission, "id" | "repositoryId">,
    requestId?: string,
    local?: boolean | string,
  ): Promise<boolean> {
    const session = this.getRequestSession(repositoryId, requestId, local);
    if (
      this.closed ||
      session.controller?.signal.aborted ||
      !["starting", "busy"].includes(session.status)
    ) {
      return Promise.resolve(false);
    }
    const request = {
      ...permission,
      summary: requestId
        ? `Parallel ${requestId.slice(0, 8)}: ${permission.summary}`
        : permission.summary,
      id: randomUUID(),
      repositoryId,
    };
    return new Promise((resolve) => {
      this.permissions.set(request.id, { request, owner: session, resolve });
      this.onChange();
    });
  }

  respondToPermission(id: string, approve: boolean): void {
    this.assertOpen();
    const pending = this.permissions.get(id);
    if (!pending) {
      throw new Error("This permission request is no longer pending.");
    }
    this.permissions.delete(id);
    pending.resolve(approve);
    this.onChange();
  }

  askQuestion(
    repositoryId: string,
    question: UserInputRequest,
    requestId?: string,
    local?: boolean | string,
  ): Promise<UserInputResponse> {
    this.assertOpen();
    const session = this.getRequestSession(repositoryId, requestId, local);
    if (
      session.controller?.signal.aborted ||
      !["starting", "busy"].includes(session.status)
    ) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }
    const request: PendingQuestion = {
      ...question,
      question: requestId
        ? `Parallel ${requestId.slice(0, 8)}: ${question.question}`
        : question.question,
      choices: question.choices ? [...question.choices] : undefined,
      id: randomUUID(),
      repositoryId,
    };
    const message: ChatMessage = {
      role: "assistant",
      content: question.question,
      ...(requestId ? { title: `Parallel ${requestId.slice(0, 8)}` } : {}),
    };
    session.messages.push(message);
    const transcriptOwner = session.parent ?? session;
    if (transcriptOwner !== session) transcriptOwner.messages.push(message);
    return new Promise((resolve, reject) => {
      this.questions.set(request.id, {
        request,
        owner: session,
        resolve,
        reject,
      });
      this.onChange();
    });
  }

  answerQuestion(id: string, answer: string): void {
    this.assertOpen();
    const pending = this.questions.get(id);
    if (!pending) {
      throw new Error("This question is no longer pending.");
    }
    if (!answer.trim() || answer.length > MAX_PROMPT_LENGTH) {
      throw new Error(
        `The answer must contain between 1 and ${MAX_PROMPT_LENGTH} characters.`,
      );
    }
    const wasFreeform = !pending.request.choices?.includes(answer);
    if (wasFreeform && pending.request.allowFreeform === false) {
      throw new Error("Choose one of the proposed answers.");
    }
    this.questions.delete(id);
    const message: ChatMessage = {
      role: "user",
      content: answer,
    };
    const transcriptOwner = pending.owner.parent ?? pending.owner;
    transcriptOwner.messages.push(message);
    if (pending.owner !== transcriptOwner) pending.owner.messages.push(message);
    pending.resolve({ answer, wasFreeform });
    this.onChange();
  }

  getSnapshot(): SavedApplication {
    const sessions = new Map(this.saved);
    for (const [id, main] of this.sessions) {
      sessions.set(id, this.saveSession(main));
    }
    return {
      version: 1,
      root: this.root,
      activeId: this.activeId,
      sessions: [...sessions.values()],
    };
  }

  createPostMortem(
    id: string,
    generate: (
      source: PostMortemSource,
      signal: AbortSignal,
      onProgress: (progress: PostMortemProgress) => void,
    ) => Promise<PostMortem>,
  ): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
    this.assertAvailable(session);
    if (session.backend === "local") {
      throw new Error(
        "PostMortem uses Copilot and is disabled for local sessions.",
      );
    }
    if (
      id !== this.activeId ||
      ["starting", "busy"].includes(session.status) ||
      session.parallel.size ||
      session.queue.length
    ) {
      throw new Error(
        "Wait for this conversation's work to finish before generating its PostMortem.",
      );
    }
    if (!session.messages.length)
      throw new Error("There is no conversation to analyse.");
    const source: PostMortemSource = {
      repository: { ...session.repository },
      sessionId: session.sessionId,
      messages: session.messages.map((message) => ({ ...message })),
    };
    const controller = new AbortController();
    session.postMortemError = undefined;
    session.postMortemProgress = `Preparing ${source.messages.length} source records...`;
    const promise = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        const report = parsePostMortem(
          await generate(source, controller.signal, (progress) => {
            if (controller.signal.aborted || this.closed) return;
            session.postMortemProgress = `Analysing records ${progress.first}-${progress.last} of ${progress.total} (model request ${progress.request})...`;
            this.onChange();
          }),
        );
        controller.signal.throwIfAborted();
        this.assertOpen();
        if (
          session.removed ||
          report.repository.id !== id ||
          report.sourceCount !== source.messages.length
        ) {
          throw new Error(
            "The PostMortem belongs to a different conversation.",
          );
        }
        postMortemSources(report, session.messages);
        session.postMortem = report;
      })
      .catch((error: unknown) => {
        if (!this.closed)
          session.postMortemError =
            error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        session.postMortemOperation = undefined;
        session.postMortemProgress = undefined;
        this.onChange();
      });
    session.postMortemOperation = { controller, promise };
    this.onChange();
    return promise;
  }

  exportPostMortem(id: string): string {
    this.assertOpen();
    const session = this.getSession(id);
    const report = session.postMortem;
    if (!report) throw new Error("Generate a PostMortem before exporting it.");
    return (
      JSON.stringify(
        {
          ...report,
          sources: postMortemSources(report, session.messages).map(
            (message, index) => ({ index: index + 1, ...message }),
          ),
        },
        null,
        2,
      ) + "\n"
    );
  }

  getSessionExport(id: string): SessionExportSource {
    this.assertOpen();
    const session = this.getSession(id);
    if (!this.hasConversation(session)) {
      throw new Error("There is no session to export.");
    }
    const conversation = this.copyConversation(session);
    for (const message of conversation.messages) {
      if (message.images) {
        message.images = message.images.map((image) => ({ ...image }));
      }
    }
    return { repository: { ...session.repository }, conversation };
  }

  getDatasetSessions(): DatasetSession[] {
    this.assertOpen();
    const rows: DatasetSession[] = [];
    const add = (
      repository: Repository,
      conversation: SavedConversation,
      location: DatasetSession["location"],
    ) => {
      if (!this.hasConversation(conversation) || !conversation.recordId) return;
      rows.push({
        repository: { ...repository },
        recordId: conversation.recordId,
        sessionId: conversation.sessionId,
        backend: conversation.backend ?? "copilot",
        location,
        models: conversation.models?.slice() ?? [],
        references: findDiscussionReferences(conversation),
        ...(conversation.annotation
          ? { annotation: { ...conversation.annotation } }
          : {}),
      });
    };
    for (const main of this.sessions.values()) {
      for (const slot of this.sessionSlots(main)) {
        add(main.repository, slot, "current");
        for (const entry of slot.history)
          add(main.repository, entry, "archived");
        for (const entry of slot.parallel.values())
          add(main.repository, entry, "parallel");
      }
    }
    for (const [id, saved] of this.saved) {
      if (this.sessions.has(id)) continue;
      const repository = { id, path: id, name: basename(id) };
      add(repository, saved, "archived");
      for (const entry of saved.history ?? [])
        add(repository, entry, "archived");
      for (const local of [
        ...(saved.localSessions ?? []),
        ...(saved.copilotSessions ?? []),
      ]) {
        add(repository, local, "archived");
        for (const entry of local.history ?? [])
          add(repository, entry, "archived");
      }
    }
    return rows;
  }

  private datasetConversation(
    id: string,
    recordId: string,
  ): SessionExportSource {
    this.assertOpen();
    const main = this.sessions.get(id);
    let conversation: SavedConversation | undefined;
    let repository: Repository;
    if (main) {
      repository = main.repository;
      for (const slot of this.sessionSlots(main)) {
        conversation = [slot, ...slot.history, ...slot.parallel.values()].find(
          (entry) => entry.recordId === recordId && this.hasConversation(entry),
        );
        if (conversation) break;
      }
    } else {
      const saved = this.saved.get(id);
      repository = { id, path: id, name: basename(id) };
      conversation = saved
        ? [
            saved,
            ...(saved.history ?? []),
            ...[
              ...(saved.localSessions ?? []),
              ...(saved.copilotSessions ?? []),
            ].flatMap((local) => [local, ...(local.history ?? [])]),
          ].find(
            (entry) =>
              entry.recordId === recordId && this.hasConversation(entry),
          )
        : undefined;
    }
    if (!conversation) throw new Error("This session is no longer available.");
    return { repository, conversation };
  }

  annotateSession(
    id: string,
    recordId: string,
    annotation: SessionAnnotation | null,
  ): void {
    this.datasetConversation(id, recordId).conversation.annotation =
      annotation === null ? undefined : parseSessionAnnotation(annotation);
    this.onChange();
  }

  getDatasetSessionExport(id: string, recordId: string): SessionExportSource {
    const source = this.datasetConversation(id, recordId);
    const conversation = this.copyConversation(source.conversation);
    for (const message of conversation.messages) {
      if (message.images)
        message.images = message.images.map((image) => ({ ...image }));
    }
    return { repository: { ...source.repository }, conversation };
  }

  setDraft(id: string, text: string, view?: SessionView): void {
    this.assertOpen();
    if (text.length > MAX_PROMPT_LENGTH) {
      throw new Error(
        `The draft must not exceed ${MAX_PROMPT_LENGTH} characters.`,
      );
    }
    const session = this.getSession(id, view);
    this.assertAvailable(session);
    session.draft = text;
    this.onChange();
  }

  async restart(id: string, assignment?: SessionAssignment): Promise<void> {
    this.assertOpen();
    const current = this.getSession(id);
    this.assertAvailable(current);
    if (current.backend === "local" && !current.localFactory) {
      throw new Error("Open a local session to choose its model again.");
    }
    if (
      current.status === "starting" ||
      current.status === "busy" ||
      current.parallel.size
    ) {
      throw new Error(
        "Cancel the running operation before starting a new session.",
      );
    }
    return this.manageSession(id, async (session) => {
      await this.stopSession(session);
      if (this.hasConversation(session)) {
        session.history.push(this.copyConversation(session));
      }
      const messages = session.messages;
      const localFactory = session.localFactory;
      const backend = session.backend;
      this.restoreConversation(session);
      session.localFactory = localFactory;
      session.backend = backend;
      if (assignment) this.setAssignment(session, assignment);
      session.messages = messages;
      session.messages.push({
        role: "system",
        content: `Starting a new ${localFactory ? "local chat" : "Copilot"} session. Earlier messages are kept for reference, not replayed as context.`,
      });
      this.activeId = id;
      await this.startSession(session);
    });
  }

  reduceContext(
    id: string,
    mode: ContextReductionMode,
    view: SessionView = "local",
  ): Promise<void> {
    this.assertOpen();
    const main = this.getMainSession(id);
    this.assertAvailable(main);
    const session = view === "local" ? main.local : this.getSession(id, view);
    if (
      !session ||
      session.backend !== "local" ||
      (session.status !== "ready" &&
        !(
          session.status === "error" && session.conversation?.canReduceContext
        )) ||
      session.sending ||
      session.parallel.size ||
      !session.conversation?.reduceContext
    )
      throw new Error(
        "Select an idle, open local session to reduce its context.",
      );
    const conversation = session.conversation;
    const controller = new AbortController();
    session.controller = controller;
    session.status = "busy";
    session.reducingContext = true;
    session.error = undefined;
    this.log(
      session,
      mode === "sliding"
        ? "Discarding the oldest half of the local context and rebuilding its cache..."
        : "Compressing the local context by half and prefilling a new cache...",
    );
    const operation = Promise.resolve()
      .then(() => conversation.reduceContext!(mode, controller.signal))
      .then(() => {
        session.messages.push({
          role: "system",
          content:
            mode === "sliding"
              ? "The oldest half of the local context was discarded and its cache rebuilt. The displayed transcript is unchanged."
              : "The local context was summarized to half its size and a new cache prefilled. The displayed transcript is unchanged.",
        });
        this.log(session, "Local context reduced; cache ready.");
      })
      .catch((error: unknown) => {
        session.error = error instanceof Error ? error.message : String(error);
        this.log(
          session,
          `Context reduction failed: ${session.error}`,
          "error",
        );
        throw error;
      })
      .finally(() => {
        if (session.controller === controller) {
          session.controller = undefined;
          session.status = "ready";
        }
        main.managing = undefined;
        main.managingSession = undefined;
        session.reducingContext = false;
        this.drainQueue(main);
        this.onChange();
      });
    main.managing = operation;
    main.managingSession = session;
    this.onChange();
    return operation;
  }

  async select(id: string): Promise<void> {
    this.assertOpen();
    const session = this.getSession(id);
    this.assertAvailable(session, session.status === "starting");
    this.activeId = id;
    this.onChange();
  }

  async openSession(id: string, assignment?: SessionAssignment): Promise<void> {
    this.assertOpen();
    const main = this.getMainSession(id);
    this.assertAvailable(main);
    if (assignment) this.setAssignment(main, assignment);
    main.view = "copilot";
    this.activeId = id;
    this.onChange();
    await this.startSession(main);
  }

  getAssignment(id: string, view?: SessionView): SessionAssignment | undefined {
    const assignment = this.getSession(id, view).assignment;
    return assignment && structuredClone(assignment);
  }

  private setAssignment(
    session: RepositorySession,
    value: SessionAssignment,
  ): void {
    const assignment = parseSessionAssignment(value);
    if ((session.backend ?? "copilot") !== assignment.worker.backend)
      throw new Error("The session and worker backends must match.");
    if (
      session.assignment &&
      JSON.stringify(session.assignment) === JSON.stringify(assignment)
    )
      return;
    if (session.conversation || session.starting)
      throw new Error(
        "Close the session before changing its worker assignment.",
      );
    if (
      session.assignment &&
      JSON.stringify(session.assignment) !== JSON.stringify(assignment)
    )
      throw new Error("Create a new session to use another worker or machine.");
    session.assignment = assignment;
  }

  addCopilotSession(id: string, assignment?: SessionAssignment): Promise<void> {
    this.assertOpen();
    const main = this.getMainSession(id);
    this.assertAvailable(main);
    let slot = main;
    if (
      main.conversation ||
      main.starting ||
      (assignment &&
        main.assignment &&
        JSON.stringify(main.assignment) !== JSON.stringify(assignment))
    ) {
      slot = this.createSessionSlot(main.repository);
      slot.copilotId = randomUUID();
      slot.backend = "copilot";
      (main.copilots ??= []).push(slot);
    }
    main.view = this.sessionView(slot);
    if (assignment) this.setAssignment(slot, assignment);
    this.activeId = id;
    return this.newSession(id);
  }

  /** Assignment of the session displayed in the active repository. */
  activeAssignment(): SessionAssignment | undefined {
    const main = this.activeId ? this.sessions.get(this.activeId) : undefined;
    return main ? this.displayed(main).assignment : undefined;
  }

  selectSession(id: string, view: SessionView): void {
    this.assertOpen();
    const main = this.getMainSession(id);
    const slot = this.getSession(id, view);
    if (slot.localId) {
      main.local = slot;
      main.view = "local";
    } else main.view = this.sessionView(slot);
    this.activeId = id;
    this.onChange();
  }

  openLocalSession(
    id: string,
    create: (localSessionId?: string) => Conversation,
    prepare?: () => Promise<void>,
    additional = false,
    assignment?: SessionAssignment,
  ): Promise<void> {
    this.assertOpen();
    const main = this.getMainSession(id);
    if (
      !additional &&
      main.local &&
      ["ready", "busy", "starting"].includes(main.local.status)
    ) {
      main.view = "local";
      this.activeId = id;
      this.onChange();
      return Promise.resolve();
    }
    this.assertAvailable(main);
    const local =
      additional || !main.local
        ? this.createSessionSlot(main.repository)
        : main.local;
    local.localId ??= randomUUID();
    const locals = this.localSessions(main).filter((entry) => entry !== local);
    main.locals = [...locals, local];
    main.local = local;
    main.view = "local";
    this.activeId = id;
    local.backend = "local";
    if (assignment) this.setAssignment(local, assignment);
    local.localFactory = create;
    const status = local.status;
    if (prepare) {
      local.status = "starting";
      local.error = undefined;
      this.log(local, "Preparing local model and engine...");
    }
    return this.manageSession(id, async () => {
      if (!local.messages.length)
        local.messages.push({
          role: "system",
          content:
            "Local chat inference: uses the model's tokenizer chat template and successful conversation turns. Repository reads, literal search, exact text edits, and commands are available; edits and unsandboxed commands require approval. Template failures are reported without a raw prompt fallback.",
        });
      if (prepare) {
        try {
          await prepare();
        } finally {
          local.status = status;
        }
        this.assertOpen();
      }
      await this.startSession(local);
    });
  }

  selectLocalSession(id: string, localSessionId: string): void {
    this.selectSession(id, `local:${localSessionId}`);
  }

  canEditLocalSession(id: string, localSessionId: string): boolean {
    const main = this.sessions.get(id);
    return (
      !this.closed &&
      !!main &&
      this.editingLocalSession(main)?.localId === localSessionId
    );
  }

  transferSession(id: string, sourceView?: SessionView): void {
    this.assertOpen();
    const main = this.getMainSession(id);
    this.assertAvailable(main);
    const source = this.getSession(id, sourceView);
    const target = source === main ? main.local : main;
    if (!target)
      throw new Error("Open a local session before transferring a transcript.");
    let remaining = 16_000;
    const excerpts: string[] = [];
    for (
      let index = source.messages.length - 1;
      index >= 0 && remaining > 0;
      index--
    ) {
      const message = source.messages[index]!;
      if (!["user", "assistant", "tool"].includes(message.role)) continue;
      const excerpt =
        `${message.role}: ${message.content.slice(-remaining)}`.slice(
          -remaining,
        );
      excerpts.push(excerpt);
      remaining -= excerpt.length;
    }
    const transcript = excerpts.reverse().join("\n");
    if (transcript.length > MAX_PROMPT_LENGTH)
      throw new Error("The transferred transcript exceeds the prompt limit.");
    target.draft = transcript;
    main.view = target === main ? "copilot" : "local";
    this.activeId = id;
    this.onChange();
  }

  private async startSession(session: RepositorySession): Promise<void> {
    const id = session.repository.id;
    this.assertOpen();
    if (session.removed) {
      throw new Error("The repository is no longer available.");
    }
    if (session.backend === "local" && !session.localFactory) {
      throw new Error("Open a local session to choose its model again.");
    }
    if (session.status === "starting") {
      return session.starting;
    }
    if (session.status === "ready" || session.status === "busy") {
      return;
    }
    if (session.backend === "local") {
      const main = this.getMainSession(id);
      main.locals = [
        ...this.localSessions(main).filter((local) => local !== session),
        session,
      ];
    }
    const previous = session.conversation;
    if (
      previous?.sessionId &&
      !session.sessionId &&
      !session.history.some((entry) => entry.sessionId === previous.sessionId)
    ) {
      session.history.push({
        ...this.copyConversation(session),
        sessionId: previous.sessionId,
      });
      session.recordId = randomUUID();
      session.models = undefined;
      session.annotation = undefined;
      session.context = undefined;
    }
    if ((previous || session.messages.length > 0) && !session.sessionId) {
      session.messages.push({
        role: "system",
        content: `The previous session ended. Starting a new ${session.localFactory ? "local chat" : "Copilot"} session; earlier messages are shown for reference only.`,
      });
    }
    if (!session.sessionId) session.generatedTokens = 0;
    const controller = new AbortController();
    session.controller = controller;
    session.status = "starting";
    session.error = undefined;
    this.log(
      session,
      session.backend === "local"
        ? "Preparing local session..."
        : "Starting Copilot session...",
    );
    this.onChange();
    const start = async (): Promise<void> => {
      try {
        await previous?.dispose();
        this.assertOpen();
        if (session.removed) {
          throw new Error("The repository is no longer available.");
        }
        const conversation =
          session.localFactory?.(session.localId) ??
          this.createConversation(
            session.repository,
            undefined,
            this.sessionView(session),
            session.assignment,
          );
        session.conversation = conversation;
        session.localLoaded = false;
        session.eventMessages.clear();
        session.imageAssets?.clear();
        await conversation.start(
          controller.signal,
          (event) => {
            if (
              !this.closed &&
              session.conversation === conversation &&
              (this.sessions.get(id) === session ||
                this.sessions.get(id)?.copilots?.includes(session) ||
                this.localSessions(this.sessions.get(id)).includes(session))
            ) {
              this.recordEvent(session, event);
            }
          },
          session.sessionId,
        );
        session.sessionId = conversation.sessionId;
        this.recordModel(session, conversation.model);
        session.status = "ready";
        session.localLoaded = session.backend === "local";
        this.log(
          session,
          session.backend === "local"
            ? "Local session ready; shared model available."
            : "Copilot session ready.",
        );
      } catch (error) {
        if (session.backend === "local")
          this.log(session, "Local session could not be started.");
        this.log(
          session,
          `Session start failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        this.fail(
          session,
          session.sessionId && !this.closed
            ? new Error(
                `Could not resume the saved Copilot session: ${error instanceof Error ? error.message : String(error)}. Retry, or choose New session to keep the displayed history but start fresh.`,
                { cause: error },
              )
            : error,
        );
        throw error;
      } finally {
        session.starting = undefined;
        this.clearPendingRequests(id, session);
        this.onChange();
      }
    };
    session.starting = start();
    return session.starting;
  }

  async send(
    id: string,
    question: string,
    parallel = true,
    images?: ImageAttachment[],
    view?: SessionView,
  ): Promise<void> {
    images = images === undefined ? undefined : parseImages(images);
    if (!question.trim() && images?.length)
      question = "Describe the attached images.";
    this.assertOpen();
    const session = this.getSession(id, view);
    this.assertAvailable(session);
    if (
      id !== this.activeId ||
      (!["ready", "busy"].includes(session.status) &&
        !(session.status === "error" && session.parallel.size && parallel)) ||
      !session.conversation
    ) {
      throw new Error(
        "Select a ready repository session before sending a message.",
      );
    }
    if (session.localFactory && images?.length) {
      throw new Error("Local chat inference does not support images.");
    }
    if (
      session.localFactory &&
      (!question.trim() || question.length > MAX_PROMPT_LENGTH)
    ) {
      throw new Error("Enter a local message within the prompt size limit.");
    }
    const prompt = session.localFactory ? question : buildPrompt(question);
    if (session.status === "busy" || session.parallel.size) {
      if (parallel && !session.localFactory)
        return this.sendParallel(session, question, images);
      return new Promise<void>((resolve, reject) => {
        const message: ChatMessage = {
          role: "user",
          content: question.trim(),
          title: "Queued - after current work",
          ...(images?.length ? { images } : {}),
        };
        session.queue.push({ question, prompt, message, resolve, reject });
        session.messages.push(message);
        session.draft = "";
        this.onChange();
      });
    }
    return this.sendMain(session, question, prompt, undefined, images);
  }

  private async sendMain(
    session: RepositorySession,
    question: string,
    prompt: string,
    queuedMessage?: ChatMessage,
    images = queuedMessage?.images,
  ): Promise<void> {
    const conversation = session.conversation;
    if (!conversation) throw new Error("The repository session is not open.");
    this.recordModel(session, conversation.model);
    const id = session.repository.id;
    if (queuedMessage) queuedMessage.title = "Sent after current work";
    else
      session.messages.push({
        role: "user",
        content: question.trim(),
        ...(images?.length ? { images } : {}),
      });
    const user = queuedMessage ?? session.messages.at(-1)!;
    user.timings = [];
    session.timing = new ExecutionTiming(user.timings);
    session.draft = "";
    session.status = "busy";
    session.error = undefined;
    const controller = new AbortController();
    session.controller = controller;
    this.onChange();
    const requestStart = session.messages.length;
    const run = async (): Promise<void> => {
      try {
        const answer = await conversation.send(
          prompt,
          controller.signal,
          images,
        );
        if (
          !session.messages
            .slice(requestStart)
            .some(
              (message) =>
                message.role === "assistant" &&
                !message.title &&
                !message.agentId &&
                message.content === answer,
            )
        ) {
          session.messages.push({ role: "assistant", content: answer });
        }
      } catch (error) {
        if (!this.closed) {
          if (!(error instanceof CopilotRecoveryError))
            session.sessionId = undefined;
          session.draft = question;
        }
        this.fail(session, error);
        this.cancelQueue(session);
        throw error;
      } finally {
        session.timing?.finish();
        session.timing = undefined;
        this.clearPendingRequests(id, session);
        this.onChange();
      }
    };
    const sending = run();
    session.sending = sending;
    try {
      await sending;
    } finally {
      session.sending = undefined;
      if (session.status === "busy") session.status = "ready";
      this.drainQueue(session);
      this.onChange();
    }
  }

  private async sendParallel(
    parent: RepositorySession,
    question: string,
    images?: ImageAttachment[],
  ): Promise<void> {
    const requestId = randomUUID();
    const parentConversation = parent.conversation;
    const label = `Parallel ${requestId.slice(0, 8)}`;
    let remaining = MAX_SELECTION_LENGTH;
    const context: string[] = [];
    for (
      let index = parent.messages.length - 1;
      index >= 0 && remaining > 0;
      index--
    ) {
      const message = parent.messages[index]!;
      if (!["user", "assistant", "tool"].includes(message.role)) continue;
      const excerpt =
        `${message.role}: ${message.content.slice(-remaining)}`.slice(
          -remaining,
        );
      context.push(excerpt);
      remaining -= excerpt.length;
    }
    const selection = context.reverse().join("\n").slice(-MAX_SELECTION_LENGTH);
    const prompt = buildPrompt(question, selection);
    const user: ChatMessage = {
      role: "user",
      title: label,
      content: question.trim(),
      ...(images?.length ? { images } : {}),
    };
    const controller = new AbortController();
    const child: RepositorySession = {
      repository: parent.repository,
      recordId: randomUUID(),
      parent,
      assignment: parent.assignment && structuredClone(parent.assignment),
      context: selection,
      status: "starting",
      messages: [user],
      draft: "",
      history: [],
      generation: 0,
      generatedTokens: 0,
      eventMessages: new Map(),
      parallel: new Map(),
      queue: [],
      controller,
    };
    parent.parallel.set(requestId, child);
    parent.messages.push(user);
    parent.draft = "";
    this.onChange();
    const run = async (): Promise<void> => {
      try {
        const conversation = this.createConversation(
          parent.repository,
          requestId,
          this.sessionView(parent),
          parent.assignment,
        );
        child.conversation = conversation;
        await conversation.start(controller.signal, (event) => {
          if (!this.closed && parent.parallel.get(requestId) === child) {
            const tokenOwner =
              parent.conversation === parentConversation ||
              (parent.sessionId !== undefined &&
                parent.sessionId === parentConversation?.sessionId)
                ? parent
                : (parent.history.find(
                    (entry) =>
                      entry.sessionId === parentConversation?.sessionId,
                  ) ?? child);
            this.recordEvent(child, event, parent.messages, label, tokenOwner);
          }
        });
        child.sessionId = conversation.sessionId;
        this.recordModel(child, conversation.model);
        child.status = "busy";
        user.timings = [];
        child.timing = new ExecutionTiming(user.timings);
        this.onChange();
        const answer = await conversation.send(
          prompt,
          controller.signal,
          images,
        );
        if (
          !child.messages.some(
            (message) =>
              message.role === "assistant" &&
              !message.agentId &&
              message.content === answer,
          )
        ) {
          const message: ChatMessage = {
            role: "assistant",
            title: label,
            content: answer,
          };
          child.messages.push(message);
          parent.messages.push(message);
        }
      } catch (error) {
        if (error instanceof CopilotRecoveryError) this.interruptWork(child);
        const message: ChatMessage = {
          role: "assistant",
          title: `${label} - failed`,
          error: true,
          content: error instanceof Error ? error.message : String(error),
        };
        child.messages.push(message);
        parent.messages.push(message);
        throw error;
      } finally {
        child.timing?.finish();
        child.timing = undefined;
        this.clearPendingRequests(parent.repository.id, child);
        try {
          await child.conversation?.dispose();
        } finally {
          child.sessionId ??= child.conversation?.sessionId;
          parent.history.push(this.copyConversation(child));
          parent.parallel.delete(requestId);
          this.onChange();
          this.drainQueue(parent);
        }
      }
    };
    child.sending = run();
    return child.sending;
  }

  private drainQueue(session: RepositorySession): void {
    if (
      this.closed ||
      session.removed ||
      session.managing ||
      session.sending ||
      session.status !== "ready" ||
      session.parallel.size
    )
      return;
    const next = session.queue.shift();
    if (!next) return;
    void this.sendMain(session, next.question, next.prompt, next.message).then(
      next.resolve,
      next.reject,
    );
  }

  private cancelQueue(session: RepositorySession): void {
    for (const queued of session.queue.splice(0)) {
      queued.message.title = "Not sent - queue cancelled";
      queued.reject(
        new DOMException("The queued message was cancelled.", "AbortError"),
      );
    }
  }

  cancel(id: string, view?: SessionView): void {
    this.assertOpen();
    const session = this.getSession(id, view);
    if (session.postMortemOperation) {
      session.postMortemOperation.controller.abort();
      this.onChange();
      return;
    }
    session.controller?.abort();
    for (const child of session.parallel.values()) child.controller?.abort();
    this.cancelQueue(session);
    this.clearPendingRequests(id, session);
    this.onChange();
  }

  async changeModel(id: string, model: string): Promise<boolean> {
    this.assertOpen();
    const session = this.getSession(id);
    this.assertAvailable(session);
    if (session.assignment)
      throw new Error(
        "This session is bound to one worker model. Create a session with another worker to change models.",
      );
    if (session.backend === "local") {
      throw new Error(
        "Open a new local session to change its model or device.",
      );
    }
    if (session.status === "starting") {
      throw new Error(
        "Wait for the Copilot session to start before changing its model.",
      );
    }
    if (!["ready", "busy"].includes(session.status) || !session.conversation) {
      return false;
    }
    await session.conversation.setModel(model);
    this.log(session, `Copilot model changed to ${model}.`);
    session.messages.push({
      role: "system",
      content: `Model changed to ${model}; it applies from the next message.`,
    });
    this.onChange();
    return true;
  }

  closeSession(id: string, view?: SessionView): Promise<void> {
    return this.manageSession(
      id,
      async (session) => {
        await this.stopSession(session);
        session.generation++;
      },
      view,
    );
  }

  newSession(
    id: string,
    localSetup?: LocalSessionSetup,
    assignment?: SessionAssignment,
  ): Promise<void> {
    if (localSetup) {
      const main = this.getMainSession(id);
      this.assertAvailable(main);
      main.local ??= this.createSessionSlot(main.repository);
      main.local.localId ??= randomUUID();
      main.locals ??= [main.local];
      main.view = "local";
      this.activeId = id;
      main.local.backend = "local";
      main.local.localFactory = localSetup.create;
    }
    return this.freshSession(id, true, localSetup, assignment);
  }

  private freshSession(
    id: string,
    preserveLocal: boolean,
    localSetup?: LocalSessionSetup,
    assignment?: SessionAssignment,
  ): Promise<void> {
    return this.manageSession(id, async (session) => {
      if (
        preserveLocal &&
        session.backend === "local" &&
        !session.localFactory
      ) {
        throw new Error("Open a local session to choose its model again.");
      }
      const backend = preserveLocal ? session.backend : undefined;
      const localFactory =
        localSetup?.create ??
        (preserveLocal ? session.localFactory : undefined);
      if (!preserveLocal && session.backend === "local")
        this.log(session, "Switching from local model to Copilot...");
      await this.stopSession(session);
      if (this.hasConversation(session)) {
        session.history.push(this.copyConversation(session));
      }
      this.restoreConversation(session);
      session.localFactory = localFactory;
      session.backend = backend;
      const desired = assignment ?? localSetup?.assignment;
      if (desired) this.setAssignment(session, desired);
      if (localSetup) {
        session.status = "starting";
        session.error = undefined;
        this.log(session, "Preparing local model and engine...");
        this.onChange();
        await localSetup.prepare();
        session.status = "idle";
      }
      this.activeId = id;
      await this.startSession(session);
    });
  }

  /**
   * Resumes an existing Copilot session in the repository. A conversation
   * archived by DevDash Agents is restored with its transcript; a session
   * created elsewhere (for example by the CLI) starts with an empty transcript.
   */
  resumeSession(
    id: string,
    sessionId: string,
    assignment?: SessionAssignment,
  ): Promise<void> {
    if (assignment) {
      assignment = parseSessionAssignment(assignment);
      if (assignment.worker.backend !== "copilot")
        throw new Error("Choose a Copilot worker to resume a Copilot session.");
    }
    const main = this.getMainSession(id);
    this.assertAvailable(main);
    const existing = [main, ...(main.copilots ?? [])].find(
      (slot) => slot.sessionId === sessionId,
    );
    if (existing) this.selectSession(id, this.sessionView(existing));
    else if (this.displayed(main).backend === "local") {
      let slot = main;
      if (main.conversation || main.starting) {
        slot = this.createSessionSlot(main.repository);
        slot.copilotId = randomUUID();
        slot.backend = "copilot";
        (main.copilots ??= []).push(slot);
      }
      this.selectSession(id, this.sessionView(slot));
    }
    return this.manageSession(id, async (session) => {
      if (session.sessionId === sessionId) {
        if (
          assignment &&
          !session.assignment &&
          !session.conversation &&
          !session.starting
        )
          this.setAssignment(session, assignment);
        this.activeId = id;
        await this.startSession(session);
        return;
      }
      await this.stopSession(session);
      if (this.hasConversation(session)) {
        session.history.push(this.copyConversation(session));
      }
      const owner = [main, ...(main.copilots ?? [])].find((slot) =>
        slot.history.some((entry) => entry.sessionId === sessionId),
      );
      const index = owner?.history.findIndex(
        (entry) => entry.sessionId === sessionId,
      );
      const archived =
        owner && index !== undefined && index !== -1
          ? owner.history.splice(index, 1)[0]
          : undefined;
      this.restoreConversation(
        session,
        archived ?? {
          sessionId,
          draft: "",
          messages: [],
          backend: "copilot",
          assignment: assignment ?? session.assignment,
        },
      );
      if (archived && assignment && !session.assignment)
        this.setAssignment(session, assignment);
      if (!archived) {
        session.messages.push({
          role: "system",
          content: `Resumed existing Copilot session ${sessionId}. Earlier messages from outside DevDash Agents are not shown, but the model keeps their context.`,
        });
      }
      this.activeId = id;
      await this.startSession(session);
    });
  }

  deleteSessions(id: string, all: boolean): Promise<void> {
    return this.manageSession(id, async (selected) => {
      if (selected.backend === "local")
        throw new Error(
          "Local chat sessions have no remote history to delete.",
        );
      const main = this.getMainSession(id);
      const slots = all
        ? [
            selected,
            ...[main, ...(main.copilots ?? [])].filter(
              (slot) => slot !== selected,
            ),
          ]
        : [selected];
      for (const slot of slots) await this.stopSession(slot);
      const controller = new AbortController();
      selected.controller = controller;
      try {
        for (const session of slots) {
          this.assertOpen();
          if (session.removed)
            throw new Error("The repository is no longer available.");
          controller.signal.throwIfAborted();
          const cleaners = new Map<string, Conversation>();
          try {
            do {
              if (!this.hasConversation(session)) {
                const previous = session.history.pop();
                if (!previous) break;
                this.restoreConversation(session, previous);
              }
              const key = JSON.stringify(session.assignment ?? null);
              let cleaner = cleaners.get(key);
              if (!cleaner) {
                cleaner = this.createConversation(
                  session.repository,
                  undefined,
                  this.sessionView(session),
                  session.assignment,
                );
                cleaners.set(key, cleaner);
              }
              session.conversation = cleaner;
              if (session.sessionId)
                await cleaner.deleteSession(
                  session.sessionId,
                  controller.signal,
                );
              this.restoreConversation(session, session.history.pop());
              this.onChange();
            } while (all && this.hasConversation(session));
          } finally {
            session.conversation = undefined;
            await Promise.all(
              [...cleaners.values()].map((cleaner) => cleaner.dispose()),
            );
          }
        }
      } finally {
        selected.controller = undefined;
      }
    });
  }

  private manageSession(
    id: string,
    action: (session: RepositorySession) => Promise<void>,
    view?: SessionView,
  ): Promise<void> {
    this.assertOpen();
    const main = this.getMainSession(id);
    const session = this.getSession(id, view);
    this.assertAvailable(main);
    const operation = Promise.resolve()
      .then(() => {
        this.assertOpen();
        return action(session);
      })
      .catch((error: unknown) => {
        this.fail(session, error);
        throw error;
      })
      .finally(() => {
        main.managing = undefined;
        main.managingSession = undefined;
        for (const slot of this.sessionSlots(main)) this.drainQueue(slot);
        this.onChange();
      });
    main.managing = operation;
    main.managingSession = session;
    this.onChange();
    return operation;
  }

  private async stopSession(session: RepositorySession): Promise<void> {
    const conversation = session.conversation;
    const sessionId = session.sessionId;
    if (session.status === "busy" || session.status === "starting") {
      session.messages.push({
        role: "system",
        content:
          "The operation was interrupted when this session was closed. It will not be resumed automatically.",
      });
    }
    session.controller?.abort();
    const postMortem = session.postMortemOperation;
    postMortem?.controller.abort();
    this.cancelQueue(session);
    const children = [...session.parallel.values()];
    for (const child of children) child.controller?.abort();
    this.clearPendingRequests(session.repository.id, session);
    if (conversation && session.backend === "local")
      this.log(session, "Releasing local session cache...");
    try {
      await conversation?.dispose();
    } catch (error) {
      this.log(
        session,
        `Session stop failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      throw error;
    }
    if (conversation)
      this.log(
        session,
        session.backend === "local"
          ? "Local session cache released."
          : "Copilot session closed.",
      );
    await Promise.allSettled([
      ...(session.starting ? [session.starting] : []),
      ...(session.sending ? [session.sending] : []),
      ...children.flatMap((child) => (child.sending ? [child.sending] : [])),
      ...(postMortem ? [postMortem.promise] : []),
    ]);
    session.sessionId = sessionId ?? conversation?.sessionId;
    session.conversation = undefined;
    session.localLoaded = false;
    session.controller = undefined;
    session.error = undefined;
    session.status = session.sessionId ? "saved" : "idle";
    session.eventMessages.clear();
    session.timing = undefined;
    session.imageAssets?.clear();
  }

  private restoreConversation(
    session: RepositorySession,
    saved?: SavedConversation,
  ): void {
    session.localFactory = undefined;
    if (saved)
      session.assignment =
        saved.assignment && structuredClone(saved.assignment);
    session.recordId = saved?.recordId ?? randomUUID();
    session.models = saved?.models?.slice();
    session.annotation = saved?.annotation
      ? { ...saved.annotation }
      : undefined;
    session.context = saved?.context;
    session.backend = saved?.backend;
    session.sessionId = saved?.sessionId;
    session.generatedTokens = saved?.generatedTokens ?? 0;
    session.contextTokens = undefined;
    session.contextLimit = undefined;
    session.messages =
      saved?.messages.map((message) => this.copyMessage(message)) ?? [];
    session.draft = saved?.draft ?? "";
    session.status = saved?.sessionId ? "saved" : "idle";
    session.error = undefined;
    session.generation++;
    session.eventMessages.clear();
    session.timing = undefined;
    session.imageAssets?.clear();
    session.postMortem = saved?.postMortem
      ? structuredClone(saved.postMortem)
      : undefined;
    session.postMortemError = undefined;
  }

  private assertAvailable(
    session: RepositorySession,
    allowManagedStartup = false,
  ): void {
    if (session.removed) {
      throw new Error("The repository is no longer available.");
    }
    if (session.postMortemOperation) {
      throw new Error(
        "A PostMortem is already being generated for this repository.",
      );
    }
    if (
      (session.managing ||
        this.sessions.get(session.repository.id)?.managing) &&
      !allowManagedStartup
    ) {
      throw new Error(
        "A session management operation is already running for this repository.",
      );
    }
  }
  private hasConversation(session: SavedConversation): boolean {
    return Boolean(
      session.sessionId || session.draft || session.messages.length,
    );
  }

  private recordModel(session: RepositorySession, model?: string): void {
    if (!model || model === "Copilot default model") return;
    const models = (session.models ??= []);
    if (!models.includes(model)) models.push(model);
  }

  private copyMessage(message: ChatMessage): ChatMessage {
    return {
      ...message,
      ...(message.timings
        ? { timings: message.timings.map((step) => ({ ...step })) }
        : {}),
    };
  }

  private copyConversation(session: SavedConversation): SavedConversation {
    return {
      ...(session.assignment
        ? { assignment: structuredClone(session.assignment) }
        : {}),
      ...(session.backend !== undefined ? { backend: session.backend } : {}),
      ...(session.recordId !== undefined ? { recordId: session.recordId } : {}),
      sessionId: session.sessionId,
      ...(session.models?.length ? { models: [...session.models] } : {}),
      ...(session.context !== undefined ? { context: session.context } : {}),
      ...(session.annotation ? { annotation: { ...session.annotation } } : {}),
      generatedTokens: session.generatedTokens,
      draft: session.draft,
      messages: session.messages.map((message) => this.copyMessage(message)),
      ...(session.postMortem
        ? { postMortem: structuredClone(session.postMortem) }
        : {}),
    };
  }

  dispose(): Promise<void> {
    return (this.stopping ??= this.stop());
  }

  private async stop(): Promise<void> {
    this.closed = true;
    this.clearPendingRequests();
    const slots = [...this.sessions.values()].flatMap((main) =>
      this.sessionSlots(main),
    );
    for (const session of slots) {
      if (session.status === "busy" || session.status === "starting") {
        session.messages.push({
          role: "system",
          content:
            "The operation was interrupted when the application closed. Pending work will not be resumed or sent again automatically.",
        });
      }
      session.controller?.abort();
      session.postMortemOperation?.controller.abort();
      this.cancelQueue(session);
      for (const child of session.parallel.values()) child.controller?.abort();
    }
    await Promise.all(slots.map((session) => session.conversation?.dispose()));
    await Promise.allSettled(
      slots.flatMap((session) => [
        ...(session.starting ? [session.starting] : []),
        ...(session.sending ? [session.sending] : []),
        ...(session.managing ? [session.managing] : []),
        ...(session.postMortemOperation
          ? [session.postMortemOperation.promise]
          : []),
        ...[...session.parallel.values()].flatMap((child) =>
          child.sending ? [child.sending] : [],
        ),
      ]),
    );
  }

  private saveSession(main: RepositorySession): SavedRepositorySession {
    const locals = this.localSessions(main);
    if (locals.length > 1 || main.copilots?.length) {
      return {
        id: main.repository.id,
        ...this.copyConversation(main),
        history: [...main.history, ...main.parallel.values()].map((entry) =>
          this.copyConversation(entry),
        ),
        localSessions: locals.map((local) => ({
          id: local.localId!,
          ...this.copyConversation(local),
          history: local.history.map((entry) => this.copyConversation(entry)),
        })),
        selectedLocalSessionId: main.local?.localId,
        ...(main.copilots?.length
          ? {
              copilotSessions: main.copilots.map((slot) => ({
                id: slot.copilotId!,
                ...this.copyConversation(slot),
                history: [...slot.history, ...slot.parallel.values()].map(
                  (entry) => this.copyConversation(entry),
                ),
              })),
            }
          : {}),
        ...(main.view?.startsWith("copilot:")
          ? { selectedCopilotSessionId: main.view.slice(8) }
          : {}),
        view: main.view === "local" ? "local" : "copilot",
      };
    }
    const session = this.displayed(main);
    const slots = this.sessionSlots(main);
    const history = [
      ...slots.flatMap((slot) => [
        ...slot.history,
        ...slot.parallel.values(),
        ...(slot !== session && this.hasConversation(slot)
          ? [this.copyConversation(slot)]
          : []),
      ]),
    ];
    return {
      id: session.repository.id,
      ...this.copyConversation(session),
      history: history.length
        ? history.map((entry) => this.copyConversation(entry))
        : undefined,
    };
  }

  private clearPendingRequests(
    repositoryId?: string,
    owner?: RepositorySession,
  ): void {
    for (const [id, pending] of this.permissions) {
      if (
        (!repositoryId || pending.request.repositoryId === repositoryId) &&
        (!owner || pending.owner === owner)
      ) {
        this.permissions.delete(id);
        pending.resolve(false);
      }
    }
    for (const [id, pending] of this.questions) {
      if (
        (!repositoryId || pending.request.repositoryId === repositoryId) &&
        (!owner || pending.owner === owner)
      ) {
        this.questions.delete(id);
        pending.reject(
          new DOMException("The question was cancelled.", "AbortError"),
        );
      }
    }
  }

  private getMainSession(id: string): RepositorySession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(
        "Unknown repository. Choose a directory from the repository list.",
      );
    }
    return session;
  }

  private getSession(id: string, view?: SessionView): RepositorySession {
    const main = this.getMainSession(id);
    if (view?.startsWith("copilot:")) {
      const slot = main.copilots?.find(
        (entry) => entry.copilotId === view.slice(8),
      );
      if (!slot)
        throw new Error("This Copilot session is no longer available.");
      return slot;
    }
    if (view?.startsWith("local:")) {
      const local = this.localSessions(main).find(
        (slot) => slot.localId === view.slice(6),
      );
      if (!local) throw new Error("This local session is no longer available.");
      return local;
    }
    if (view === "local") {
      if (!main.local) throw new Error("The local session is not open.");
      return main.local;
    }
    if (view === "copilot") return main;
    return this.displayed(main);
  }

  private displayed(main: RepositorySession): RepositorySession {
    if (main.view?.startsWith("copilot:"))
      return this.getSession(main.repository.id, main.view);
    return main.view === "local" && main.local ? main.local : main;
  }

  private sessionView(slot: RepositorySession): SessionView {
    return slot.localId
      ? `local:${slot.localId}`
      : slot.copilotId
        ? `copilot:${slot.copilotId}`
        : "copilot";
  }

  private sessionSlots(main?: RepositorySession): RepositorySession[] {
    return main
      ? [main, ...(main.copilots ?? []), ...this.localSessions(main)]
      : [];
  }

  private localSessions(main?: RepositorySession): RepositorySession[] {
    return main?.locals ?? (main?.local ? [main.local] : []);
  }

  private editingLocalSession(
    main: RepositorySession,
  ): RepositorySession | undefined {
    return this.localSessions(main).find(
      (local) =>
        local.status === "starting" ||
        (local.localLoaded && !!local.conversation),
    );
  }

  private createSessionSlot(repository: Repository): RepositorySession {
    return {
      repository,
      recordId: randomUUID(),
      status: "idle",
      messages: [],
      draft: "",
      history: [],
      generation: 0,
      generatedTokens: 0,
      eventMessages: new Map(),
      parallel: new Map(),
      queue: [],
    };
  }

  private getRequestSession(
    id: string,
    requestId?: string,
    local?: boolean | string,
  ): RepositorySession {
    const main = this.getMainSession(id);
    const parent =
      typeof local === "string"
        ? this.getSession(id, isSessionView(local) ? local : `local:${local}`)
        : local === true
          ? main.local
          : local === false
            ? main
            : this.displayed(main);
    if (!parent) throw new Error("The local session is not open.");
    if (!requestId) return parent;
    const child = parent.parallel.get(requestId);
    if (!child) throw new Error("This parallel request has ended.");
    return child;
  }

  private recordEvent(
    session: RepositorySession,
    event: SessionEvent,
    destination?: ChatMessage[],
    label?: string,
    tokenOwner: Pick<SavedConversation, "generatedTokens"> = session,
  ): void {
    session.timing?.record(event);
    if (event.type === "session.info" && event.data.infoType === "local")
      this.log(session, event.data.message);
    if (event.type === "assistant.usage") {
      this.recordModel(session, event.data.model);
      const tokens = event.data.outputTokens;
      const ownerTokens = tokenOwner.generatedTokens ?? 0;
      if (
        typeof tokens === "number" &&
        Number.isSafeInteger(tokens) &&
        tokens >= 0 &&
        Number.isSafeInteger(session.generatedTokens + tokens) &&
        Number.isSafeInteger(ownerTokens + tokens)
      ) {
        session.generatedTokens += tokens;
        if (tokenOwner !== session)
          tokenOwner.generatedTokens = ownerTokens + tokens;
      }
      this.onChange(true);
      return;
    }
    if (event.type === "session.usage_info") {
      session.contextTokens = event.data.currentTokens;
      session.contextLimit = event.data.tokenLimit;
      this.onChange(true);
      return;
    }
    const addImage = (message: ChatMessage, image: ImageAttachment): void => {
      const images = (message.images ??= []);
      if (
        images.length < MAX_IMAGES &&
        !images.some((other) => other.dataUrl === image.dataUrl)
      ) {
        images.push(image);
      }
    };
    const imageAsset = (id: string) => {
      const assets = (session.imageAssets ??= new Map());
      let asset = assets.get(id);
      if (!asset) {
        asset = { messages: new Set() };
        assets.set(id, asset);
      }
      return asset;
    };
    const push = (message: ChatMessage): void => {
      if (label)
        message.title = message.title ? `${label}: ${message.title}` : label;
      session.messages.push(message);
      destination?.push(message);
    };
    const upsert = (
      key: string,
      role: ChatMessage["role"],
      content: string,
      append: boolean,
      title?: string,
      toolCallId?: string,
    ): void => {
      const id = `${event.agentId ?? ""}:${key}`;
      const previous = session.eventMessages.get(id);
      if (previous) {
        previous.content = append ? previous.content + content : content;
      } else {
        const message: ChatMessage = {
          role,
          content,
          title,
          timestamp: event.timestamp,
          agentId: event.agentId,
          ...(toolCallId ? { toolCallId } : {}),
        };
        session.eventMessages.set(id, message);
        push(message);
      }
    };
    switch (event.type) {
      case "session.binary_asset": {
        if (event.data.type !== "image") return;
        const dataUrl = `data:${event.data.mimeType};base64,${event.data.data}`;
        if (!isImageDataUrl(dataUrl)) return;
        const asset = imageAsset(event.data.assetId);
        asset.image = { name: "Tool image", dataUrl };
        for (const message of asset.messages) addImage(message, asset.image);
        asset.messages.clear();
        this.onChange(true);
        return;
      }
      case "user.message":
        return;
      case "assistant.message_start":
        upsert(`message:${event.data.messageId}`, "assistant", "", false);
        break;
      case "assistant.message_delta":
        upsert(
          `message:${event.data.messageId}`,
          "assistant",
          event.data.deltaContent,
          true,
        );
        break;
      case "assistant.message":
        upsert(
          `message:${event.data.messageId}`,
          "assistant",
          event.data.content,
          false,
        );
        if (event.data.reasoningText) {
          upsert(
            `reasoning:${event.data.messageId}`,
            "reasoning",
            event.data.reasoningText,
            false,
          );
        }
        break;
      case "assistant.reasoning_delta":
        upsert(
          `reasoning:${event.data.reasoningId}`,
          "reasoning",
          event.data.deltaContent,
          true,
        );
        break;
      case "assistant.reasoning":
        upsert(
          `reasoning:${event.data.reasoningId}`,
          "reasoning",
          event.data.content,
          false,
        );
        break;
      case "tool.shell_output":
        upsert(
          `output:${event.data.toolCallId}:${event.data.stream ?? "stdout"}`,
          "output",
          event.data.text,
          true,
          `${event.data.toolCallId} (${event.data.stream ?? "stdout"})`,
          event.data.toolCallId,
        );
        break;
      case "assistant.tool_call_delta":
        upsert(
          `tool-input:${event.data.toolCallId}`,
          "system",
          event.data.inputDelta,
          true,
          `Tool input: ${event.data.toolName ?? event.data.toolCallId}`,
        );
        break;
      default: {
        const message: ChatMessage = {
          role: "system",
          title: event.type,
          content: JSON.stringify(event.data, null, 2),
          timestamp: event.timestamp,
          agentId: event.agentId,
        };
        if (
          event.type === "session.warning" &&
          event.data.warningType === "crash_recovery"
        ) {
          this.interruptWork(session);
          message.title = "Copilot recovery";
          message.content = event.data.message;
          message.error = true;
        } else if (event.type === "tool.execution_start") {
          message.role = "tool";
          message.toolCallId = event.data.toolCallId;
          message.title = `${event.data.toolName} - running`;
          message.content = describeTool(
            event.data.toolName,
            event.data.arguments,
          );
          message.details = JSON.stringify(event.data, null, 2);
          session.eventMessages.set(
            `${event.agentId ?? ""}:tool:${event.data.toolCallId}`,
            message,
          );
        } else if (event.type === "tool.execution_complete") {
          const tool = session.eventMessages.get(
            `${event.agentId ?? ""}:tool:${event.data.toolCallId}`,
          );
          if (tool?.title) {
            tool.title =
              tool.title?.replace(/ - running$/, "") +
              (event.data.success ? " - completed" : " - failed");
          }
          message.role = "output";
          message.toolCallId = event.data.toolCallId;
          message.error = !event.data.success;
          message.title = `Tool ${event.data.toolCallId}: ${event.data.success ? "completed" : "failed"}`;
          message.content =
            [event.data.result?.content, event.data.error?.message]
              .filter((part) => part !== undefined)
              .join("\n") ||
            (event.data.success ? "Completed" : "Tool execution failed.");
          message.details = JSON.stringify(event.data, null, 2);
          const result = event.data.result;
          for (const part of [
            ...(result?.contents ?? []),
            ...(result?.binaryResultsForLlm ?? []),
          ]) {
            if (part.type !== "image") continue;
            if ("data" in part) {
              const dataUrl = `data:${part.mimeType};base64,${part.data}`;
              if (isImageDataUrl(dataUrl)) {
                addImage(message, { name: "Tool image", dataUrl });
              }
            } else if ("assetId" in part) {
              const asset = imageAsset(part.assetId);
              if (asset.image) addImage(message, asset.image);
              else asset.messages.add(message);
            }
          }
        } else if (event.type === "tool.execution_partial_result") {
          upsert(
            `partial:${event.data.toolCallId}`,
            "output",
            event.data.partialOutput,
            false,
            undefined,
            event.data.toolCallId,
          );
          this.onChange(true);
          return;
        }
        push(message);
      }
    }
    this.onChange(true);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("The DevDash Agents tab is closed.");
    }
  }

  private interruptWork(session: RepositorySession): void {
    this.clearPendingRequests(session.repository.id, session);
    for (const message of session.eventMessages.values()) {
      if (message.role === "tool" && message.title?.endsWith(" - running")) {
        message.title = message.title.replace(/ - running$/, " - interrupted");
        message.error = true;
      }
    }
    session.eventMessages.clear();
    session.imageAssets?.clear();
  }

  private log(
    session: RepositorySession,
    message: string,
    level: ApplicationLog["level"] = "info",
  ): void {
    this.logEvent(session.repository.name, message, level);
  }

  /** Records an event not tied to one session, e.g. a worker or machine step. */
  logEvent(
    source: string,
    message: string,
    level: ApplicationLog["level"] = "info",
  ): void {
    if (this.closed) return;
    this.logs.push({
      id: ++this.logSequence,
      timestamp: new Date().toISOString(),
      repository: source,
      message,
      level,
    });
    if (this.logs.length > 200) this.logs.shift();
    this.onChange();
  }

  private fail(session: RepositorySession, error: unknown): void {
    if (error instanceof CopilotRecoveryError) this.interruptWork(session);
    session.status = "error";
    session.error =
      error instanceof Error && error.name === "AbortError"
        ? "Request cancelled. Select this repository to start a new session."
        : error instanceof Error
          ? error.message
          : String(error);
  }
}
