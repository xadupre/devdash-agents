import { randomUUID } from "node:crypto";
import type {
  ContextReductionMode,
  LocalChatMessage,
  LocalContextReduction,
  LocalDevice,
  LocalGeneration,
  LocalProvider,
  LocalWorker,
} from "./local-worker";
import type { LocalModelInfo } from "./local-model";

export type LocalPlacement =
  | { provider: LocalProvider; deviceId: number }
  | { provider: "disk"; deviceId?: never };

export type LocalModelStatus =
  "unloaded" | "loading" | "ready" | "disk" | "error";

export interface LocalModelSession {
  repositoryId: string;
  localSessionId?: string;
  cacheTokens: number;
  cacheCapacity?: number;
}

export interface LocalModelSnapshot {
  id?: string;
  modelPath: string;
  name?: string;
  contextLength?: number;
  sizeBytes?: number;
  bytesPerToken?: LocalModelInfo["bytesPerToken"];
  sharedBuffer?: boolean;
  status: LocalModelStatus;
  placement: LocalPlacement;
  device?: LocalDevice;
  error?: string;
  busy: boolean;
  /** Set by the extension: configured worker and the machine running it. */
  workerName?: string;
  machineName?: string;
  /** Epoch milliseconds when the idle worker process will be stopped. */
  idleStopAt?: number;
  sessions: LocalModelSession[];
}

export type LocalModelWorker = Pick<
  LocalWorker,
  "load" | "generateChat" | "release" | "stop"
> &
  Partial<Pick<LocalWorker, "reduceContext">>;

type WorkerFactory = (onClose: (error: Error) => void) => LocalModelWorker;

interface SessionState {
  repositoryId: string;
  localSessionId?: string;
  cacheTokens: number;
  cacheCapacity?: number;
}

const DISK_ERROR =
  "The local model is on DISK (unloaded). Choose CUDA or CPU in the Sessions panel to load it.";

/**
 * Serializes access to one model worker while keeping each conversation's KV
 * cache under a distinct native worker session ID.
 */
export class LocalModelHost {
  private worker?: LocalModelWorker;
  private status: LocalModelStatus = "unloaded";
  private device?: LocalDevice;
  private error?: string;
  private tail: Promise<void> = Promise.resolve();
  private active = 0;
  private readonly sessions = new Map<string, SessionState>();
  private readonly loadRequests = new Set<symbol>();
  private loadingController?: AbortController;
  private cancelWhenUnused = false;
  private stoppingWorker?: LocalModelWorker;
  private pendingPlacements = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleStopAt?: number;

  constructor(
    readonly modelPath: string,
    private placement: LocalPlacement,
    private readonly createWorker: WorkerFactory,
    private readonly onChange: () => void = () => {},
    private readonly onEmpty: () => void = () => {},
    private readonly metadata?: Pick<
      LocalModelSnapshot,
      "name" | "contextLength" | "sizeBytes" | "bytesPerToken" | "sharedBuffer"
    >,
    /** Milliseconds without activity before the worker process stops; 0 disables. */
    private readonly idleTimeoutMs: () => number = () => 0,
    private readonly onEvent: (
      message: string,
      level?: "info" | "error",
    ) => void = () => {},
  ) {
    if (placement.provider === "disk") this.status = "disk";
  }

  attach(repositoryId: string, localSessionId?: string): LocalModelHostHandle {
    if (this.isPlacementPending)
      throw new Error(
        "A local model instance is changing placement. Try again after the move completes.",
      );
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      repositoryId,
      ...(localSessionId ? { localSessionId } : {}),
      cacheTokens: 0,
    });
    this.onChange();
    return new LocalModelHostHandle(this, sessionId);
  }

  snapshot(): LocalModelSnapshot {
    return {
      modelPath: this.modelPath,
      ...this.metadata,
      status: this.status,
      placement: { ...this.placement },
      device: this.device,
      error: this.error,
      busy: this.active > 0,
      ...(this.idleStopAt === undefined ? {} : { idleStopAt: this.idleStopAt }),
      sessions: [...this.sessions.values()].map((session) => ({ ...session })),
    };
  }

  async place(
    placement: LocalPlacement,
    peers: Iterable<LocalModelHost> = [],
  ): Promise<void> {
    this.pendingPlacements++;
    try {
      await this.enqueue(async () => {
        if (placement.provider !== "disk") {
          for (const host of peers) {
            if (
              host !== this &&
              host.modelPath === this.modelPath &&
              ((host.placement.provider === placement.provider &&
                host.placement.deviceId === placement.deviceId) ||
                (host.device?.provider === placement.provider &&
                  host.device.deviceId === placement.deviceId))
            )
              throw new Error(
                `This model already has an instance on ${placement.provider.toUpperCase()} ${placement.deviceId}. Use its existing sessions or choose another device.`,
              );
          }
        }
        this.placement = { ...placement };
        if (placement.provider === "disk") {
          await this.unload();
          this.status = "disk";
          this.error = undefined;
          this.clearCaches();
          return;
        }
        await this.unload();
        this.clearCaches();
        this.status = "unloaded";
        this.error = undefined;
        await this.ensureLoaded();
      });
    } finally {
      this.pendingPlacements--;
      this.onChange();
    }
  }

  async load(sessionId: string, signal?: AbortSignal): Promise<LocalDevice> {
    const requestId = Symbol();
    this.loadRequests.add(requestId);
    const removeRequest = (): void => {
      if (!this.loadRequests.delete(requestId)) return;
      if (
        !this.loadRequests.size &&
        this.status === "loading" &&
        this.cancelWhenUnused
      )
        this.loadingController?.abort(
          new DOMException("Local model load cancelled.", "AbortError"),
        );
    };
    signal?.addEventListener("abort", removeRequest, { once: true });
    const promise = this.enqueue(async () => {
      signal?.throwIfAborted();
      if (!this.sessions.has(sessionId))
        throw new Error("The local model session is closed.");
      return this.ensureLoaded(true);
    });
    try {
      return await this.waitForSignal(promise, signal);
    } finally {
      signal?.removeEventListener("abort", removeRequest);
      removeRequest();
    }
  }

  async generateChat(
    sessionId: string,
    messages: LocalChatMessage[],
    onToken: (text: string) => void,
    signal?: AbortSignal,
    maxLength?: number,
  ): Promise<LocalGeneration> {
    const promise = this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.ensureLoaded();
      signal?.throwIfAborted();
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error("The local model session is closed.");
      try {
        const result = await this.worker!.generateChat(
          messages,
          onToken,
          signal,
          maxLength,
          sessionId,
        );
        session.cacheTokens = result.cacheTokens;
        session.cacheCapacity = maxLength;
        this.onChange();
        return result;
      } catch (error) {
        try {
          await this.worker?.release(sessionId);
        } catch (releaseError) {
          session.cacheTokens = 0;
          session.cacheCapacity = undefined;
          this.onChange();
          throw new AggregateError(
            [error, releaseError],
            "Local generation failed and its cache could not be released.",
            { cause: releaseError },
          );
        }
        session.cacheTokens = 0;
        session.cacheCapacity = undefined;
        this.onChange();
        throw error;
      }
    });
    return this.waitForSignal(promise, signal);
  }

  async reduceContext(
    sessionId: string,
    messages: LocalChatMessage[],
    mode: ContextReductionMode,
    signal?: AbortSignal,
    maxLength?: number,
  ): Promise<LocalContextReduction> {
    signal?.throwIfAborted();
    const promise = this.enqueue(async () => {
      signal?.throwIfAborted();
      if (!this.sessions.has(sessionId))
        throw new Error("The local model session is closed.");
      await this.ensureLoaded();
      signal?.throwIfAborted();
      const session = this.sessions.get(sessionId)!;
      if (!this.worker?.reduceContext)
        throw new Error(
          "Context reduction is unsupported by this local worker.",
        );
      try {
        const result = await this.worker.reduceContext(
          messages,
          mode,
          signal,
          maxLength,
          sessionId,
        );
        session.cacheTokens = result.cacheTokens;
        session.cacheCapacity = maxLength;
        this.onChange();
        return result;
      } catch (error) {
        try {
          await this.worker?.release(sessionId);
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            "Context reduction failed and its cache could not be released.",
            { cause: releaseError },
          );
        } finally {
          session.cacheTokens = 0;
          session.cacheCapacity = undefined;
          this.onChange();
        }
        throw error;
      }
    });
    return this.waitForSignal(promise, signal);
  }

  /**
   * Stops the worker process and frees its memory. Sessions stay attached and
   * their next request reloads the model; only KV caches are lost.
   */
  async stop(): Promise<void> {
    await this.enqueue(async () => {
      if (this.status === "disk") return;
      const running = !!this.worker;
      await this.unload();
      if (running) this.onEvent("Worker stopped; its memory is freed.");
      this.clearCaches();
      this.status = "unloaded";
      this.error = undefined;
    });
  }

  async release(sessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      if (this.worker && this.status === "ready")
        await this.worker.release(sessionId);
      this.sessions.delete(sessionId);
      if (!this.sessions.size) {
        await this.unload();
        this.status = "unloaded";
        this.error = undefined;
        if (!this.sessions.size) this.onEmpty();
      }
    });
    this.onChange();
  }

  private async ensureLoaded(cancelWhenUnused = false): Promise<LocalDevice> {
    if (this.status === "disk") throw new Error(DISK_ERROR);
    if (this.status === "ready" && this.device) return this.device;
    if (this.status === "loading")
      throw new Error("A local model load is already in progress.");
    if (this.placement.provider === "disk") throw new Error(DISK_ERROR);
    this.status = "loading";
    this.error = undefined;
    this.onChange();
    const started = Date.now();
    const target =
      this.placement.provider === "auto"
        ? "the automatically selected device"
        : `${this.placement.provider.toUpperCase()}${this.placement.deviceId >= 0 ? ` ${this.placement.deviceId}` : ""}`;
    this.onEvent(`Starting the worker and loading the model on ${target}...`);
    try {
      const controller = new AbortController();
      this.loadingController = controller;
      this.cancelWhenUnused = cancelWhenUnused;
      const worker = this.createWorker((error) => {
        if (this.worker !== worker || this.stoppingWorker === worker) return;
        this.cancelIdleStop();
        this.worker = undefined;
        this.device = undefined;
        this.status = "error";
        this.error = `Local model engine stopped: ${error.message}`;
        this.onEvent(this.error, "error");
        this.clearCaches();
        this.onChange();
      });
      this.worker = worker;
      this.device = await worker.load(
        this.modelPath,
        this.placement.provider,
        this.placement.deviceId >= 0 ? this.placement.deviceId : undefined,
        controller.signal,
      );
      this.status = "ready";
      this.error = undefined;
      this.onEvent(
        `Model loaded on ${this.device.provider.toUpperCase()} ${this.device.deviceId} (${this.device.name}) in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
      );
      this.onChange();
      return this.device;
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.onEvent(`Model load failed: ${this.error}`, "error");
      await this.unload();
      throw error;
    } finally {
      this.loadingController = undefined;
      this.cancelWhenUnused = false;
    }
  }

  private async unload(): Promise<void> {
    this.cancelIdleStop();
    const worker = this.worker;
    if (!worker) {
      this.device = undefined;
      return;
    }
    this.worker = undefined;
    this.stoppingWorker = worker;
    try {
      await worker.stop();
    } finally {
      this.stoppingWorker = undefined;
      this.device = undefined;
    }
  }

  private clearCaches(): void {
    for (const session of this.sessions.values()) {
      session.cacheTokens = 0;
      session.cacheCapacity = undefined;
    }
  }

  private cancelIdleStop(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.idleStopAt = undefined;
  }

  private scheduleIdleStop(): void {
    this.cancelIdleStop();
    const timeout = this.idleTimeoutMs();
    if (this.active || this.status !== "ready" || !(timeout > 0)) return;
    this.idleStopAt = Date.now() + timeout;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.active || this.status !== "ready") return;
      this.onEvent(
        `Idle for ${Math.round(timeout / 60_000)} min; stopping the worker to free memory.`,
      );
      void this.stop().catch(() => {});
    }, timeout);
    this.idleTimer.unref?.();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.active++;
    this.cancelIdleStop();
    this.onChange();
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.active--;
      this.scheduleIdleStop();
      this.onChange();
    });
  }

  private async waitForSignal<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  isSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get currentDevice(): LocalDevice | undefined {
    return this.device;
  }

  get currentStatus(): LocalModelStatus {
    return this.status;
  }

  get isPlacementPending(): boolean {
    return this.pendingPlacements > 0;
  }
}

export function findLocalModelHost(
  hosts: Iterable<LocalModelHost>,
  modelPath: string,
  desired: LocalPlacement,
  rememberedPlacement: (host: LocalModelHost) => LocalPlacement | undefined,
): LocalModelHost | undefined {
  const candidates = [...hosts].filter((host) => host.modelPath === modelPath);
  if (candidates.some((host) => host.isPlacementPending))
    throw new Error(
      "A local model instance is changing placement. Try again after the move completes.",
    );
  const matches = (placement: LocalPlacement | LocalDevice): boolean =>
    placement.provider !== "disk" &&
    desired.provider !== "disk" &&
    placement.provider === desired.provider &&
    placement.deviceId === desired.deviceId;
  const currentPlacement = (host: LocalModelHost) => {
    const snapshot = host.snapshot();
    return (
      snapshot.device ??
      (snapshot.placement.provider === "disk" ? undefined : snapshot.placement)
    );
  };
  return (
    candidates.find((host) => {
      const placement = currentPlacement(host);
      return placement !== undefined && matches(placement);
    }) ??
    candidates.find((host) => {
      if (host.snapshot().placement.provider !== "disk") return false;
      const placement = rememberedPlacement(host);
      return placement !== undefined && matches(placement);
    })
  );
}

export class LocalModelHostHandle {
  constructor(
    private readonly host: LocalModelHost,
    private readonly sessionId: string,
  ) {}

  get device(): LocalDevice | undefined {
    return this.host.currentDevice;
  }

  get status(): LocalModelStatus {
    return this.host.currentStatus;
  }

  load(
    _modelPath: string,
    _provider: LocalProvider,
    _deviceId?: number,
    signal?: AbortSignal,
  ): Promise<LocalDevice> {
    return this.host.load(this.sessionId, signal);
  }

  generateChat(
    messages: LocalChatMessage[],
    onToken: (text: string) => void,
    signal?: AbortSignal,
    maxLength?: number,
  ): Promise<LocalGeneration> {
    return this.host.generateChat(
      this.sessionId,
      messages,
      onToken,
      signal,
      maxLength,
    );
  }

  reduceContext(
    messages: LocalChatMessage[],
    mode: ContextReductionMode,
    signal?: AbortSignal,
    maxLength?: number,
  ): Promise<LocalContextReduction> {
    return this.host.reduceContext(
      this.sessionId,
      messages,
      mode,
      signal,
      maxLength,
    );
  }

  stop(): Promise<void> {
    return this.host.release(this.sessionId);
  }
}
