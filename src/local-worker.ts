import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type LocalProvider = "auto" | "cuda" | "npu" | "cpu";

export interface LocalDevice {
  provider: Exclude<LocalProvider, "auto">;
  deviceId: number;
  name: string;
}

export function resolveLocalDevice(
  devices: readonly LocalDevice[],
  provider: LocalProvider,
  deviceId?: number,
): LocalDevice {
  const providers: Exclude<LocalProvider, "auto">[] =
    provider === "auto" ? ["cuda", "npu", "cpu"] : [provider];
  for (const candidate of providers) {
    const device = devices.find(
      (entry) =>
        entry.provider === candidate &&
        (deviceId === undefined || deviceId < 0 || entry.deviceId === deviceId),
    );
    if (device) return device;
  }
  throw new Error("Requested provider/device is not available.");
}

export function isLocalProvider(value: unknown): value is LocalProvider {
  return (
    typeof value === "string" && ["auto", "cuda", "npu", "cpu"].includes(value)
  );
}

export interface LocalChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ContextReductionMode = "sliding" | "compress";

export interface LocalContextReduction {
  messages: LocalChatMessage[];
  cacheTokens: number;
}

/** Token counts reported when a generation completes. */
export interface LocalGeneration {
  /** Prompt tokens served from the session's KV cache. */
  cachedTokens: number;
  /** Tokens produced by this request. */
  generatedTokens: number;
  /** Tokens held by the session's KV cache afterwards. */
  cacheTokens: number;
}

interface Pending {
  terminal: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  onToken?: (text: string) => void;
  cleanup: () => void;
}

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_REDUCED_MESSAGES = 255;
export const DEFAULT_WORKER = "devdash-genai-worker";
const WSL_DRIVER_DIRECTORY = "/usr/lib/wsl/lib";

/**
 * Uses a worker built in the extension's own build tree when no explicit path
 * is configured, so a development checkout works without extra settings.
 */
export function resolveWorkerExecutable(
  configured: string,
  extensionPath: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (configured && configured !== DEFAULT_WORKER) return configured;
  const candidates =
    process.platform === "win32"
      ? [
          join(
            extensionPath,
            "build",
            "native",
            "Release",
            `${DEFAULT_WORKER}.exe`,
          ),
          join(extensionPath, "build", "native", `${DEFAULT_WORKER}.exe`),
        ]
      : [join(extensionPath, "build", "native", DEFAULT_WORKER)];
  candidates.push(
    join(
      extensionPath,
      "runtime",
      "bin",
      process.platform === "win32" ? `${DEFAULT_WORKER}.exe` : DEFAULT_WORKER,
    ),
  );
  return candidates.find(exists) ?? DEFAULT_WORKER;
}

export function findWorkerOnPath(
  pathValue = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const extensions =
    platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
    for (const extension of extensions) {
      const candidate = resolve(
        directory || ".",
        `${DEFAULT_WORKER}${extension}`,
      );
      try {
        accessSync(
          candidate,
          platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/**
 * Runs the engine setup script shipped in a source checkout. It downloads
 * prebuilt SDKs and builds only the worker; output is kept for error reports.
 */
export function installEngine(
  command: string,
  args: string[] = [],
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    });
    let output = "";
    let cancellation: unknown;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };
    const killTree = (signalName: NodeJS.Signals) => {
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
    const abort = () => {
      cancellation =
        signal?.reason ?? new DOMException("Aborted", "AbortError");
      killTree("SIGTERM");
      killTree("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4096);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", (error) => {
      cleanup();
      reject(
        cancellation ??
          new Error(`Installing local models failed: ${error.message}`, {
            cause: error,
          }),
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (cancellation) reject(cancellation);
      else if (code === 0) resolve();
      else
        reject(
          new Error(
            `Installing local models failed (${code ?? "stopped"}): ${output.trim()}`,
          ),
        );
    });
  });
}

/** Under WSL, the GPU driver lives in a separate directory that must win over native libcuda. */
export function workerEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  if (platform !== "linux" || !exists(WSL_DRIVER_DIRECTORY)) return environment;
  const current = environment.LD_LIBRARY_PATH;
  const reordered = [
    WSL_DRIVER_DIRECTORY,
    ...(current
      ? current.split(":").filter((entry) => entry !== WSL_DRIVER_DIRECTORY)
      : []),
  ].join(":");
  if (current === reordered) return environment;
  return {
    ...environment,
    LD_LIBRARY_PATH: reordered,
  };
}

function isDevice(value: unknown): value is LocalDevice {
  if (!value || typeof value !== "object") return false;
  const device = value as Record<string, unknown>;
  return (
    typeof device.provider === "string" &&
    ["cpu", "cuda", "npu"].includes(device.provider) &&
    Number.isSafeInteger(device.deviceId) &&
    Number(device.deviceId) >= 0 &&
    typeof device.name === "string"
  );
}

/** JSON-lines transport. The executable is always launched directly, never by a shell. */
export class LocalWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private closed = false;
  private stopping?: Promise<void>;
  private readonly exited: Promise<void>;
  private stderr = "";

  /**
   * @param onClose called once when the worker can no longer serve requests,
   * including after stop().
   */
  private readonly cudaDevice?: number;

  constructor(
    executable: string,
    args: string[] = [],
    private readonly timeoutMs = 120_000,
    private readonly onClose?: (error: Error) => void,
    /** Runs the worker in its own process group, e.g. behind a remote connection command. */
    private readonly processGroup = false,
    options: {
      /** Extra variables for a local worker process. */
      environment?: Record<string, string>;
      /**
       * The only CUDA device the process can see (via CUDA_VISIBLE_DEVICES,
       * set by the caller). It loads as device 0 and is reported as this one.
       */
      cudaDevice?: number;
    } = {},
  ) {
    this.cudaDevice = options.cudaDevice;
    this.child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: workerEnvironment({ ...process.env, ...options.environment }),
      detached: processGroup && process.platform !== "win32",
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
    this.child.on("error", (error: NodeJS.ErrnoException) =>
      this.fail(
        error.code === "ENOENT"
          ? new Error(
              processGroup
                ? `The remote connection command is not installed: ${executable}`
                : `Local models are not installed on this computer (missing: ${executable}). Automatic installation is available on Linux x64 when running from the source checkout.`,
              { cause: error },
            )
          : error,
      ),
    );
    this.child.stdin.on("error", (error) => this.fail(error));
    this.exited = new Promise((resolve) => {
      this.child.on("close", (code, signal) => {
        this.fail(
          new Error(
            `The local model engine stopped unexpectedly (${signal ?? code}): ${this.stderr.trim()}`,
          ),
        );
        resolve();
      });
    });
  }

  async discover(signal?: AbortSignal): Promise<LocalDevice[]> {
    const response = await this.request(
      { method: "discover" },
      "providers",
      signal,
    );
    if (
      !Array.isArray(response.providers) ||
      !response.providers.every(isDevice)
    ) {
      const error = new Error(
        "Invalid local worker provider discovery response.",
      );
      this.fail(error);
      throw error;
    }
    return response.providers;
  }

  async load(
    modelPath: string,
    provider: LocalProvider = "auto",
    deviceId?: number,
    signal?: AbortSignal,
  ): Promise<LocalDevice> {
    const pinned = provider === "cuda" && this.cudaDevice !== undefined;
    const response = await this.request(
      {
        method: "load",
        modelPath,
        provider,
        deviceId: pinned ? 0 : deviceId,
      },
      "loaded",
      signal,
    );
    const device = {
      provider: response.provider,
      deviceId:
        pinned && response.provider === "cuda" && response.deviceId === 0
          ? this.cudaDevice
          : response.deviceId,
      name:
        typeof response.name === "string" ? response.name : response.provider,
    };
    if (!isDevice(device)) {
      const error = new Error("Invalid local worker load response.");
      this.fail(error);
      throw error;
    }
    return device;
  }

  async generate(
    prompt: string,
    onToken: (text: string) => void,
    signal?: AbortSignal,
    maxLength?: number,
  ): Promise<void> {
    await this.request(
      { method: "generate", prompt, maxLength },
      "done",
      signal,
      onToken,
    );
  }

  /** Without a session, the worker's default session cache is used. */
  async generateChat(
    messages: LocalChatMessage[],
    onToken: (text: string) => void,
    signal?: AbortSignal,
    maxLength?: number,
    session?: string,
  ): Promise<LocalGeneration> {
    const response = await this.request(
      { method: "generate", messages, maxLength, session },
      "done",
      signal,
      onToken,
    );
    return {
      cachedTokens: response.cachedTokens as number,
      generatedTokens: response.generatedTokens as number,
      cacheTokens: response.cacheTokens as number,
    };
  }

  /** Returns replacement history after rebuilding the session's KV cache. */
  async reduceContext(
    messages: LocalChatMessage[],
    mode: ContextReductionMode,
    signal?: AbortSignal,
    maxLength?: number,
    session?: string,
  ): Promise<LocalContextReduction> {
    const response = await this.request(
      { method: "reduceContext", messages, mode, maxLength, session },
      "reduced",
      signal,
    );
    return {
      messages: response.messages as LocalChatMessage[],
      cacheTokens: response.cacheTokens as number,
    };
  }

  /** Frees a session's KV cache; releasing an unknown session succeeds. */
  async release(session: string): Promise<void> {
    await this.request({ method: "release", session }, "released");
  }

  stop(): Promise<void> {
    return (this.stopping ??= this.shutdown());
  }

  private async shutdown(): Promise<void> {
    if (!this.closed) {
      try {
        await this.request(
          { method: "stop" },
          "stopped",
          undefined,
          undefined,
          2000,
        );
      } catch {
        // A crashed or unresponsive worker must not block extension disposal.
      } finally {
        this.child.stdin.end();
      }
    }
    const timer = setTimeout(() => this.kill(), 2000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private request(
    fields: Record<string, unknown>,
    terminal: string,
    signal?: AbortSignal,
    onToken?: (text: string) => void,
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.closed || (this.stopping && fields.method !== "stop")) {
      return Promise.reject(new Error("Local worker is stopped."));
    }
    const id = randomUUID();
    const line = JSON.stringify({ ...fields, id }) + "\n";
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      return Promise.reject(new Error("Local worker request exceeds 1 MiB."));
    }
    return new Promise((resolve, reject) => {
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        this.fail(
          new Error(`Local worker ${String(fields.method)} timed out.`),
        );
      }, timeoutMs);
      const abort = (): void => {
        if (fields.method !== "generate" && fields.method !== "reduceContext") {
          const request = this.pending.get(id);
          if (request) {
            this.pending.delete(id);
            request.cleanup();
            request.reject(signal?.reason);
          }
          this.fail(new Error("Local worker operation aborted."));
          return;
        }
        // Wait for the generation's terminal event before permitting another
        // request; otherwise cancellation could accidentally affect its successor.
        void this.request(
          { method: "cancel", targetId: id },
          "cancelled",
          undefined,
          undefined,
          2000,
        ).catch((error: unknown) =>
          this.fail(error instanceof Error ? error : new Error(String(error))),
        );
        abortTimer = setTimeout(() => {
          this.fail(new Error("Local worker cancellation timed out."));
        }, 2000);
      };
      this.pending.set(id, {
        terminal,
        resolve: (response) => {
          if (signal?.aborted) reject(signal.reason);
          else resolve(response);
        },
        reject: (error) => reject(signal?.aborted ? signal.reason : error),
        onToken,
        cleanup: () => {
          clearTimeout(timer);
          clearTimeout(abortTimer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(line, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          throw new Error("Local worker response exceeds 1 MiB.");
        }
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== "object") {
          throw new Error("Invalid local worker event.");
        }
        const response = event as Record<string, unknown>;
        if (
          response.type === "reduced" &&
          (!Number.isSafeInteger(response.cacheTokens) ||
            Number(response.cacheTokens) < 0 ||
            !Array.isArray(response.messages) ||
            response.messages.length > MAX_REDUCED_MESSAGES ||
            !response.messages.every(
              (message: unknown) =>
                message !== null &&
                typeof message === "object" &&
                Object.keys(message).length === 2 &&
                ["system", "user", "assistant"].includes(
                  (message as LocalChatMessage).role,
                ) &&
                typeof (message as LocalChatMessage).content === "string" &&
                !(message as LocalChatMessage).content.includes("\0"),
            ))
        ) {
          throw new Error("Invalid local worker context reduction.");
        }
        if (
          typeof response.id !== "string" ||
          typeof response.type !== "string"
        ) {
          throw new Error("Invalid local worker event envelope.");
        }
        const request = this.pending.get(response.id);
        if (!request) throw new Error("Unknown local worker request ID.");
        if (response.type === "token") {
          if (!request.onToken || typeof response.text !== "string") {
            throw new Error("Invalid local worker token.");
          }
          request.onToken(response.text);
        } else {
          if (response.type !== "error" && response.type !== request.terminal) {
            throw new Error("Unexpected local worker response.");
          }
          if (
            response.type === "done" &&
            (typeof response.cancelled !== "boolean" ||
              ![
                response.cachedTokens,
                response.generatedTokens,
                response.cacheTokens,
              ].every(
                (count) => Number.isSafeInteger(count) && Number(count) >= 0,
              ))
          ) {
            throw new Error("Invalid local worker completion.");
          }
          if (
            response.type === "error" &&
            (typeof response.code !== "string" ||
              typeof response.message !== "string")
          ) {
            throw new Error("Invalid local worker error.");
          }
          this.pending.delete(response.id);
          request.cleanup();
          if (response.type === "error") {
            request.reject(
              new Error(
                `${String(response.code)}: ${String(response.message)}`,
              ),
            );
          } else {
            request.resolve(response);
          }
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
      this.fail(new Error("Local worker response exceeds 1 MiB."));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
    this.kill();
    this.onClose?.(error);
  }

  private kill(): void {
    if (
      this.processGroup &&
      process.platform !== "win32" &&
      this.child.pid !== undefined
    ) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    this.child.kill("SIGKILL");
  }
}
