import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

export interface MemoryAmount {
  free: number;
  total: number;
}

export interface MemoryUpdate {
  type: "memory";
  cpu: MemoryAmount;
  /** One entry per NVIDIA GPU; absent when nvidia-smi is unavailable. */
  cuda?: MemoryAmount[];
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
