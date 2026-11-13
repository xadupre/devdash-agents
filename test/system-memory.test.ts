import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cpuMemory,
  currentMemorySample,
  MemoryMonitor,
  parseNvidiaMemory,
  parseRemoteMemory,
  remoteMemory,
} from "../src/system-memory";
import { join } from "node:path";

const MiB = 1024 ** 2;

test("memory samples from a previously active worker are discarded", async () => {
  const previous = {};
  const next = {};
  let active = previous;
  let complete!: (update: {
    type: "memory";
    cpu: { free: number; total: number };
  }) => void;
  const sample = currentMemorySample(
    () => active,
    () => new Promise((resolve) => (complete = resolve)),
  );
  active = next;
  complete({ type: "memory", cpu: { free: 1, total: 2 } });
  assert.equal(await sample, undefined);
  const update = { type: "memory" as const, cpu: { free: 3, total: 4 } };
  assert.equal(
    await currentMemorySample(
      () => active,
      async () => update,
    ),
    update,
  );
});

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

test("remote memory reports available RAM and optional GPUs", async () => {
  assert.deepEqual(parseRemoteMemory("1024,4096\n7959, 8188\n"), {
    cpu: { free: 1024, total: 4096 },
    cuda: [{ free: 7959 * MiB, total: 8188 * MiB }],
  });
  assert.deepEqual(parseRemoteMemory("1024,4096\n"), {
    cpu: { free: 1024, total: 4096 },
  });
  assert.throws(() => parseRemoteMemory(",\n"), /invalid memory/);
});

test(
  "remote memory is sampled through the connection command",
  { skip: process.platform !== "linux" },
  async () => {
    const update = await remoteMemory({
      name: "vm",
      command: `"${process.execPath}" "${join(__dirname, "fixtures", "remote-shell.js")}"`,
    });
    assert.equal(update.machine, "vm");
    assert.ok(update.cpu.total > 0 && update.cpu.free <= update.cpu.total);
  },
);
