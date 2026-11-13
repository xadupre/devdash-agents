import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cpuMemory,
  MemoryMonitor,
  parseNvidiaMemory,
} from "../src/system-memory";

const MiB = 1024 ** 2;

test("nvidia-smi memory output is parsed per GPU and invalid values are rejected", () => {
  assert.deepEqual(parseNvidiaMemory("7959, 8188\r\n100, 24576\n"), [
    { free: 7959 * MiB, total: 8188 * MiB },
    { free: 100 * MiB, total: 24576 * MiB },
  ]);
  for (const output of [
    "",
    "[N/A], 8188",
    "9000, 8188",
    "1, 0",
    "1, 2, 3",
    "-1, 2",
  ])
    assert.throws(() => parseNvidiaMemory(output), /nvidia-smi/);
});

test("CPU memory reports available bytes within the total", () => {
  const { free, total } = cpuMemory();
  assert.ok(total > 0 && free > 0 && free <= total);
});

test("a missing nvidia-smi reports CPU memory only and is not spawned again", async () => {
  const monitor = new MemoryMonitor("/__devdash_missing_nvidia_smi__");
  const [first, concurrent] = await Promise.all([
    monitor.sample(),
    monitor.sample(),
  ]);
  assert.equal(first, concurrent);
  assert.equal(first.type, "memory");
  assert.equal(first.cuda, undefined);
  assert.equal((await monitor.sample()).cuda, undefined);
});
