import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import { remoteError, runRemoteScript, type RemoteMachine } from "./remote";

export interface MemoryAmount {
  free: number;
  total: number;
}

export interface MemoryUpdate {
  type: "memory";
  cpu: MemoryAmount;
  /** One entry per NVIDIA GPU; absent when nvidia-smi is unavailable. */
  cuda?: MemoryAmount[];
  /** Machine sampled, when it is not this computer. */
  machine?: string;
  /** CUDA device used by the displayed session's worker. */
  deviceId?: number;
}

export async function currentMemorySample<T>(
  current: () => T,
  sample: (identity: T) => Promise<MemoryUpdate>,
): Promise<MemoryUpdate | undefined> {
  const identity = current();
  const update = await sample(identity);
  return current() === identity ? update : undefined;
}

const MiB = 1024 ** 2;

/** Parses `nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaMemory(stdout: string): MemoryAmount[] {
  const gpus = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [free, total, ...rest] = line.split(",").map((value) => {
        const trimmed = value.trim();
        return /^\d+$/.test(trimmed) ? Number(trimmed) * MiB : NaN;
      });
      if (
        rest.length ||
        !Number.isSafeInteger(free) ||
        !Number.isSafeInteger(total) ||
        total! <= 0 ||
        free! > total!
      )
        throw new Error("nvidia-smi returned invalid memory values.");
      return { free: free!, total: total! };
    });
  if (!gpus.length) throw new Error("nvidia-smi reported no GPU.");
  return gpus;
}

export function cpuMemory(): MemoryAmount {
  const constrained = process.constrainedMemory();
  const total =
    constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
  // availableMemory also honours cgroup limits, unlike freemem.
  return { free: Math.min(process.availableMemory(), freemem(), total), total };
}

/**
 * Samples CPU and CUDA memory. Once nvidia-smi fails it is not spawned again,
 * so machines without an NVIDIA driver only pay for the CPU sample.
 */
export class MemoryMonitor {
  private nvidia = true;
  private sampling?: Promise<MemoryUpdate>;

  constructor(private readonly command = "nvidia-smi") {}

  sample(): Promise<MemoryUpdate> {
    return (this.sampling ??= this.read().finally(() => {
      this.sampling = undefined;
    }));
  }

  private async read(): Promise<MemoryUpdate> {
    const update: MemoryUpdate = { type: "memory", cpu: cpuMemory() };
    if (!this.nvidia) return update;
    try {
      const { stdout } = await promisify(execFile)(
        this.command,
        [
          "--query-gpu=memory.free,memory.total",
          "--format=csv,noheader,nounits",
        ],
        { timeout: 5000, maxBuffer: 65536, windowsHide: true },
      );
      update.cuda = parseNvidiaMemory(stdout);
    } catch {
      this.nvidia = false;
    }
    return update;
  }
}

const REMOTE_MEMORY = `awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print a*1024 "," t*1024}' /proc/meminfo || exit 2
nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader,nounits 2>/dev/null || true
`;

/** Parses REMOTE_MEMORY: "available,total" bytes, then optional nvidia-smi lines. */
export function parseRemoteMemory(stdout: string): Omit<MemoryUpdate, "type"> {
  const [first = "", ...rest] = stdout.trim().split(/\r?\n/);
  const [free, total] = first.split(",").map(Number);
  if (
    !Number.isSafeInteger(free) ||
    !Number.isSafeInteger(total) ||
    total! <= 0 ||
    free! < 0
  )
    throw new Error("The remote machine returned invalid memory values.");
  const gpus = rest.join("\n").trim();
  return {
    cpu: { free: Math.min(free!, total!), total: total! },
    ...(gpus ? { cuda: parseNvidiaMemory(gpus) } : {}),
  };
}

/** Samples a remote machine's available RAM and NVIDIA memory over its connection command. */
export async function remoteMemory(
  machine: Pick<RemoteMachine, "command" | "name">,
  signal?: AbortSignal,
): Promise<MemoryUpdate> {
  const result = await runRemoteScript(machine, REMOTE_MEMORY, [], {
    signal,
    timeoutMs: 30_000,
    maxOutput: 65536,
  });
  if (!result.completed || result.code !== 0)
    throw remoteError(result, `Cannot read the memory of ${machine.name}`);
  return {
    type: "memory",
    ...parseRemoteMemory(result.stdout.toString("utf8")),
    machine: machine.name,
  };
}
