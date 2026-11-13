import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  findLocalModelHost,
  LocalModelHost,
  type LocalModelWorker,
} from "../src/local-model-host";
import type {
  LocalChatMessage,
  LocalDevice,
  LocalGeneration,
} from "../src/local-worker";
import { resolveLocalDevice } from "../src/local-worker";

const device: LocalDevice = { provider: "cpu", deviceId: 0, name: "CPU" };

class Worker implements LocalModelWorker {
  loads: { path: string; provider: string; deviceId?: number }[] = [];
  generations: string[] = [];
  releases: string[] = [];
  stops = 0;
  nextError?: Error;
  nextGeneration?: () => Promise<void>;
  loadDevice = device;
  loadGate?: Promise<void>;
  loadStarted?: () => void;
  stopGate?: Promise<void>;
  stopStarted?: () => void;

  async load(
    path: string,
    provider?: "auto" | "cuda" | "npu" | "cpu",
    deviceId?: number,
    signal?: AbortSignal,
  ): Promise<LocalDevice> {
    this.loads.push({ path, provider: provider ?? "auto", deviceId });
    if (this.loadGate) {
      this.loadStarted?.();
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        this.loadGate!.then(
          () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          },
          (error: unknown) => {
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });
    }
    signal?.throwIfAborted();
    return this.loadDevice;
  }

  async generateChat(
    _messages: LocalChatMessage[],
    _onToken: (text: string) => void,
    signal?: AbortSignal,
    _maxLength?: number,
    session?: string,
  ): Promise<LocalGeneration> {
    if (this.nextGeneration) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void =>
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        this.nextGeneration!().then(
          () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          },
          (error: unknown) => {
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });
    }
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      throw error;
    }
    this.generations.push(session ?? "");
    return {
      cachedTokens: 2,
      generatedTokens: 3,
      cacheTokens: 5,
    };
  }

  async release(session: string): Promise<void> {
    this.releases.push(session);
  }

  async stop(): Promise<void> {
    this.stops++;
    this.stopStarted?.();
    if (this.stopGate) await this.stopGate;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("reuses hosts by effective automatic placements and prefers loaded hosts", async () => {
  const automaticWorker = new Worker();
  automaticWorker.loadDevice = {
    provider: "cuda",
    deviceId: 0,
    name: "CUDA 0",
  };
  const automaticHost = new LocalModelHost(
    "/model",
    { provider: "auto", deviceId: -1 },
    () => automaticWorker,
  );
  const automaticSession = automaticHost.attach("repo", "automatic");
  await automaticSession.load("/model", "auto");
  assert.equal(
    findLocalModelHost(
      [automaticHost],
      "/model",
      resolveLocalDevice([automaticWorker.loadDevice], "cuda", 0),
      () => undefined,
    ),
    automaticHost,
  );

  const explicitHost = new LocalModelHost(
    "/model",
    { provider: "cuda", deviceId: 0 },
    () => new Worker(),
  );
  assert.equal(
    findLocalModelHost(
      [explicitHost],
      "/model",
      resolveLocalDevice(
        [
          { provider: "cuda", deviceId: 0, name: "CUDA 0" },
          { provider: "cpu", deviceId: 0, name: "CPU" },
        ],
        "auto",
      ),
      () => undefined,
    ),
    explicitHost,
  );

  const offloadedHost = new LocalModelHost(
    "/model",
    { provider: "cuda", deviceId: 0 },
    () => new Worker(),
  );
  const offloadedSession = offloadedHost.attach("repo", "offloaded");
  await offloadedHost.place({ provider: "disk" });
  const currentHost = new LocalModelHost(
    "/model",
    { provider: "cuda", deviceId: 0 },
    () => new Worker(),
  );
  assert.equal(
    findLocalModelHost(
      [offloadedHost, currentHost],
      "/model",
      { provider: "cuda", deviceId: 0 },
      (host) =>
        host === offloadedHost ? { provider: "cuda", deviceId: 0 } : undefined,
    ),
    currentHost,
  );

  await Promise.all([automaticSession.stop(), offloadedSession.stop()]);
});

test("placement rejects an occupied model device without reloading either worker", async () => {
  const firstWorker = new Worker();
  const secondWorker = new Worker();
  const first = new LocalModelHost(
    "/model",
    { provider: "cuda", deviceId: 0 },
    () => firstWorker,
  );
  const second = new LocalModelHost(
    "/model",
    { provider: "cuda", deviceId: 1 },
    () => secondWorker,
  );
  const firstSession = first.attach("repo", "first");
  const secondSession = second.attach("repo", "second");
  await firstSession.load("/model", "cuda", 0);
  await secondSession.load("/model", "cuda", 1);
  await assert.rejects(
    second.place({ provider: "cuda", deviceId: 0 }, [first, second]),
    /already has an instance on CUDA 0/,
  );
  assert.equal(firstWorker.loads.length, 1);
  assert.equal(secondWorker.loads.length, 1);
  assert.equal(firstWorker.stops, 0);
  assert.equal(secondWorker.stops, 0);
  assert.deepEqual(second.snapshot().placement, {
    provider: "cuda",
    deviceId: 1,
  });
  await second.place({ provider: "cuda", deviceId: 2 }, [first, second]);
  assert.equal(secondWorker.loads.length, 2);
  await first.place({ provider: "disk" }, [first, second]);
  await second.place({ provider: "disk" }, [first, second]);
  await firstSession.stop();
  await secondSession.stop();
});

test("local model additions are blocked during a pending placement move", async () => {
  const workers: Worker[] = [];
  const host = new LocalModelHost(
    "/model",
    { provider: "cuda", deviceId: 1 },
    () => {
      const worker = new Worker();
      worker.loadDevice = {
        provider: "cuda",
        deviceId: workers.length === 0 ? 1 : 0,
        name: `CUDA ${workers.length === 0 ? 1 : 0}`,
      };
      workers.push(worker);
      return worker;
    },
  );
  const session = host.attach("repo", "existing");
  await session.load("/model", "cuda", 1);
  const gate = deferred();
  const entered = deferred();
  workers[0]!.stopGate = gate.promise;
  workers[0]!.stopStarted = entered.resolve;
  const moving = host.place({ provider: "cuda", deviceId: 0 });
  await entered.promise;

  assert.throws(
    () =>
      findLocalModelHost(
        [host],
        "/model",
        { provider: "cuda", deviceId: 0 },
        () => undefined,
      ),
    /changing placement/,
  );
  assert.throws(
    () =>
      findLocalModelHost(
        [host],
        "/model",
        { provider: "cuda", deviceId: 1 },
        () => undefined,
      ),
    /changing placement/,
  );
  assert.throws(() => host.attach("repo", "new"), /changing placement/);
  assert.equal(workers.length, 1);

  gate.resolve();
  await moving;
  assert.equal(
    findLocalModelHost(
      [host],
      "/model",
      { provider: "cuda", deviceId: 0 },
      () => undefined,
    ),
    host,
  );
  assert.equal(
    findLocalModelHost(
      [host],
      "/model",
      { provider: "cuda", deviceId: 1 },
      () => undefined,
    ),
    undefined,
  );
  await session.stop();
});

test("concurrent placement requests cannot load duplicate weights on an unoccupied GPU", async () => {
  const workers = [new Worker(), new Worker()];
  const hosts = workers.map(
    (worker, deviceId) =>
      new LocalModelHost(
        "/model",
        { provider: "cuda", deviceId },
        () => worker,
      ),
  );
  const sessions = hosts.map((host, index) => host.attach("repo", `${index}`));
  const results = await Promise.allSettled(
    hosts.map((host) => host.place({ provider: "cuda", deviceId: 2 }, hosts)),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(workers.flatMap((worker) => worker.loads).length, 1);
  await Promise.all(sessions.map((session) => session.stop()));
});

test("two local sessions of the same repository keep distinct worker caches and identities", async () => {
  const worker = new Worker();
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
  );
  const first = host.attach("repo", "first");
  const second = host.attach("repo", "second");
  await first.generateChat([{ role: "user", content: "first" }], () => {});
  await second.generateChat([{ role: "user", content: "second" }], () => {});
  assert.notEqual(worker.generations[0], worker.generations[1]);
  assert.deepEqual(
    host.snapshot().sessions.map((session) => session.localSessionId),
    ["first", "second"],
  );
  await first.stop();
  assert.deepEqual(
    host.snapshot().sessions.map((session) => session.localSessionId),
    ["second"],
  );
  await second.generateChat([{ role: "user", content: "again" }], () => {});
  assert.equal(worker.generations[1], worker.generations[2]);
  await second.stop();
});

test("serializes context reduction with generation and isolates session cache accounting", async () => {
  const worker: LocalModelWorker = new Worker();
  const gate = deferred();
  const entered = deferred();
  const calls: string[] = [];
  worker.reduceContext = async (messages, mode, signal, maxLength, session) => {
    calls.push(session!);
    assert.equal(mode, "compress");
    assert.equal(maxLength, 128);
    assert.equal(signal, undefined);
    entered.resolve();
    await gate.promise;
    return { messages: messages.slice(-1), cacheTokens: 11 };
  };
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
  );
  const first = host.attach("repo-a");
  const second = host.attach("repo-b");
  const history: LocalChatMessage[] = [
    { role: "user", content: "old" },
    { role: "user", content: "replacement" },
  ];
  const reduction = first.reduceContext(history, "compress", undefined, 128);
  await entered.promise;
  const generation = second.generateChat(history, () => {}, undefined, 256);
  assert.equal((worker as Worker).generations.length, 0);
  gate.resolve();
  assert.deepEqual(await reduction, {
    messages: history.slice(-1),
    cacheTokens: 11,
  });
  await generation;
  assert.notEqual(calls[0], (worker as Worker).generations[0]);
  assert.deepEqual(host.snapshot().sessions, [
    { repositoryId: "repo-a", cacheTokens: 11, cacheCapacity: 128 },
    { repositoryId: "repo-b", cacheTokens: 5, cacheCapacity: 256 },
  ]);
  await Promise.all([first.stop(), second.stop()]);
});

test("reports unsupported reduction and clears only a failed reduction's cache", async () => {
  const worker: LocalModelWorker = new Worker();
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
  );
  const first = host.attach("repo-a");
  const second = host.attach("repo-b");
  await first.generateChat([], () => {}, undefined, 128);
  await second.generateChat([], () => {}, undefined, 128);
  await assert.rejects(first.reduceContext([], "sliding"), /unsupported/);
  assert.equal(host.snapshot().sessions[0]!.cacheTokens, 5);
  worker.reduceContext = async () => {
    throw new Error("prefill failed");
  };
  await assert.rejects(first.reduceContext([], "sliding"), /prefill failed/);
  assert.equal((worker as Worker).releases.length, 1);
  assert.equal(host.snapshot().sessions[0]!.cacheTokens, 0);
  assert.equal(host.snapshot().sessions[1]!.cacheTokens, 5);
  const aborted = new AbortController();
  aborted.abort(new Error("cancelled"));
  await assert.rejects(
    first.reduceContext([], "compress", aborted.signal),
    /cancelled/,
  );
  worker.reduceContext = async (messages) => ({ messages, cacheTokens: 2 });
  await first.reduceContext(
    [{ role: "user", content: "retained context" }],
    "compress",
  );
  assert.equal(host.snapshot().sessions[0]!.cacheTokens, 2);
  assert.equal(host.snapshot().sessions[1]!.cacheTokens, 5);
  await Promise.all([first.stop(), second.stop()]);
  await assert.rejects(first.reduceContext([], "sliding"), /session is closed/);
});

test("keeps queued reductions cancellable without touching another session's cache", async () => {
  const worker = new Worker() as Worker & LocalModelWorker;
  const gate = deferred();
  const entered = deferred();
  worker.nextGeneration = async () => {
    entered.resolve();
    await gate.promise;
  };
  let reductions = 0;
  worker.reduceContext = async () => {
    reductions++;
    return { messages: [], cacheTokens: 0 };
  };
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
  );
  const first = host.attach("repo-a");
  const second = host.attach("repo-b");
  const generation = first.generateChat([], () => {});
  await entered.promise;
  const controller = new AbortController();
  const reduction = second.reduceContext([], "sliding", controller.signal);
  controller.abort(new Error("queued reduction cancelled"));
  await assert.rejects(reduction, /queued reduction cancelled/);
  gate.resolve();
  await generation;
  await Promise.all([first.stop(), second.stop()]);
  assert.equal(reductions, 0);
  assert.equal(worker.releases.length, 2);
});

test("cancelling the last session aborts model loading but preserves a shared load", async () => {
  const worker = new Worker();
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
  );
  const first = host.attach("repo-a");
  const second = host.attach("repo-b");
  const gate = deferred();
  const entered = deferred();
  worker.loadGate = gate.promise;
  worker.loadStarted = entered.resolve;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const firstLoad = first.load("/model", "cpu", 0, firstController.signal);
  const secondLoad = second.load("/model", "cpu", 0, secondController.signal);
  await entered.promise;
  firstController.abort(new DOMException("cancel first", "AbortError"));
  await assert.rejects(firstLoad, { name: "AbortError" });
  assert.equal(worker.stops, 0);
  gate.resolve();
  await secondLoad;
  assert.equal(host.snapshot().status, "ready");
  await Promise.all([first.stop(), second.stop()]);
});

test("cancelling the only session stops the in-progress worker load", async () => {
  const worker = new Worker();
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
  );
  const session = host.attach("repo");
  const gate = deferred();
  const entered = deferred();
  worker.loadGate = gate.promise;
  worker.loadStarted = entered.resolve;
  const controller = new AbortController();
  const loading = session.load("/model", "cpu", 0, controller.signal);
  await entered.promise;
  controller.abort(new DOMException("cancel load", "AbortError"));
  await assert.rejects(loading, { name: "AbortError" });
  await session.stop();
  assert.equal(worker.stops, 1);
  assert.equal(host.snapshot().status, "unloaded");
});

test("failed generation releases and clears its possibly stale KV cache", async () => {
  const worker = new Worker();
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
  );
  const session = host.attach("repo");
  await session.load("/model", "cpu", 0);
  await session.generateChat([{ role: "user", content: "first" }], () => {});
  worker.nextError = new Error("generation failed");
  await assert.rejects(
    session.generateChat([{ role: "user", content: "second" }], () => {}),
    /generation failed/,
  );
  assert.equal(worker.releases.length, 1);
  assert.equal(host.snapshot().sessions[0]!.cacheTokens, 0);
  assert.equal(host.snapshot().sessions[0]!.cacheCapacity, undefined);
  await session.stop();
});

test("cancelled generation releases and clears its partial KV cache", async () => {
  let observeClear = false;
  const cleared = deferred();
  const worker = new Worker();
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
    () => {
      if (observeClear && host.snapshot().sessions[0]?.cacheTokens === 0) {
        cleared.resolve();
      }
    },
  );
  const session = host.attach("repo");
  await session.load("/model", "cpu", 0);
  await session.generateChat([{ role: "user", content: "first" }], () => {});
  const entered = deferred();
  const gate = deferred();
  worker.nextGeneration = async () => {
    entered.resolve();
    await gate.promise;
  };
  const controller = new AbortController();
  const generating = session.generateChat(
    [{ role: "user", content: "second" }],
    () => {},
    controller.signal,
  );
  await entered.promise;
  observeClear = true;
  controller.abort(new DOMException("cancel generation", "AbortError"));
  await assert.rejects(generating, { name: "AbortError" });
  await cleared.promise;
  assert.equal(worker.releases.length, 1);
  assert.equal(host.snapshot().sessions[0]!.cacheTokens, 0);
  gate.resolve();
  await session.stop();
});

test("a session attached during last-worker shutdown keeps the host registered", async () => {
  const workers: Worker[] = [];
  let empty = 0;
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    },
    () => {},
    () => empty++,
  );
  const first = host.attach("repo-a");
  await first.load("/model", "cpu", 0);
  const gate = deferred();
  const entered = deferred();
  workers[0]!.stopGate = gate.promise;
  workers[0]!.stopStarted = entered.resolve;
  const closing = first.stop();
  await entered.promise;
  const second = host.attach("repo-b");
  gate.resolve();
  await closing;
  assert.equal(empty, 0);
  assert.deepEqual(
    host.snapshot().sessions.map((session) => session.repositoryId),
    ["repo-b"],
  );
  await second.load("/model", "cpu", 0);
  assert.equal(workers.length, 2);
  await second.stop();
});

test("shares one loaded worker while isolating and releasing session caches", async () => {
  const workers: Worker[] = [];
  const host = new LocalModelHost(
    "/model",
    {
      provider: "cpu",
      deviceId: 0,
    },
    () => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    },
  );
  const first = host.attach("repo-a");
  const second = host.attach("repo-b");
  await Promise.all([
    first.load("/model", "cpu", 0),
    second.load("/model", "cpu", 0),
  ]);
  assert.equal(workers.length, 1);
  const result = await first.generateChat(
    [{ role: "user", content: "hello" }],
    () => {},
    undefined,
    8192,
  );
  assert.equal(result.cacheTokens, 5);
  assert.deepEqual(
    host
      .snapshot()
      .sessions.map(({ repositoryId, cacheTokens }) => [
        repositoryId,
        cacheTokens,
      ]),
    [
      ["repo-a", 5],
      ["repo-b", 0],
    ],
  );
  await first.stop();
  assert.equal(workers[0]!.releases.length, 1);
  assert.equal(workers[0]!.stops, 0);
  await second.stop();
  assert.equal(workers[0]!.stops, 1);
});

test("keeps a queued generation cancellable and offloads without saving the model", async () => {
  const workers: Worker[] = [];
  const host = new LocalModelHost(
    "/model",
    {
      provider: "cpu",
      deviceId: 0,
    },
    () => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    },
  );
  const first = host.attach("repo-a");
  const second = host.attach("repo-b");
  await first.load("/model", "cpu", 0);
  const gate = deferred();
  workers[0]!.nextGeneration = () => gate.promise;
  const firstRun = first.generateChat(
    [{ role: "user", content: "first" }],
    () => {},
  );
  const controller = new AbortController();
  const queuedRun = second.generateChat(
    [{ role: "user", content: "second" }],
    () => {},
    controller.signal,
  );
  controller.abort(new Error("cancel queued"));
  await assert.rejects(queuedRun, /cancel queued/);
  gate.resolve();
  await firstRun;
  assert.equal(workers[0]!.generations.length, 1);
  await host.place({ provider: "disk" });
  assert.equal(host.snapshot().status, "disk");
  assert.equal(workers[0]!.stops, 1);
  assert.equal(host.snapshot().sessions[0]!.cacheTokens, 0);
  await assert.rejects(
    first.generateChat([{ role: "user", content: "blocked" }], () => {}),
    /on DISK/,
  );
  await host.place({ provider: "cuda", deviceId: 0 });
  assert.equal(workers.length, 2);
  assert.equal(host.snapshot().device?.provider, "cpu");
  await Promise.all([first.stop(), second.stop()]);
});

test("switching devices unloads then loads a new worker", async () => {
  const workers: Worker[] = [];
  const host = new LocalModelHost(
    "/model",
    {
      provider: "cpu",
      deviceId: 0,
    },
    () => {
      const worker = new Worker();
      workers.push(worker);
      return worker;
    },
  );
  const session = host.attach("repo");
  await session.load("/model", "cpu", 0);
  await host.place({ provider: "cuda", deviceId: 1 });
  assert.equal(workers.length, 2);
  assert.equal(workers[0]!.stops, 1);
  assert.deepEqual(workers[1]!.loads, [
    { path: "/model", provider: "cuda", deviceId: 1 },
  ]);
  await session.stop();
});

test("automatic device selection omits deviceId when loading", async () => {
  const worker = new Worker();
  const host = new LocalModelHost(
    "/model",
    { provider: "auto", deviceId: -1 },
    () => worker,
  );
  await host.attach("repo-a").load("/model", "auto");
  assert.deepEqual(worker.loads, [
    { path: "/model", provider: "auto", deviceId: undefined },
  ]);
});

test("idle workers stop after the timeout, busy ones never, and Stop frees memory on demand", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const workers: Worker[] = [];
  let timeout = 1000;
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => {
      workers.push(new Worker());
      return workers.at(-1)!;
    },
    () => {},
    () => {},
    undefined,
    () => timeout,
  );
  const session = host.attach("repo", "s");
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  };
  await session.generateChat([], () => {}, undefined, 64);
  assert.equal(host.snapshot().idleStopAt, Date.now() + 1000);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(host.currentStatus, "ready");

  const gate = deferred();
  workers[0]!.nextGeneration = () => gate.promise;
  const running = session.generateChat([], () => {}, undefined, 64);
  await flush();
  assert.equal(host.snapshot().idleStopAt, undefined);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(host.currentStatus, "ready", "never stops during a request");
  workers[0]!.nextGeneration = undefined;
  gate.resolve();
  await running;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(host.currentStatus, "unloaded");
  assert.equal(workers[0]!.stops, 1);
  assert.equal(host.snapshot().sessions[0]!.cacheTokens, 0);
  assert.equal(host.snapshot().idleStopAt, undefined);

  await session.generateChat([], () => {}, undefined, 64);
  assert.equal(workers.length, 2, "the next request reloads the model");
  await host.stop();
  assert.equal(host.currentStatus, "unloaded");
  assert.equal(workers[1]!.stops, 1);

  timeout = 0;
  await session.generateChat([], () => {}, undefined, 64);
  assert.equal(host.snapshot().idleStopAt, undefined, "0 disables the timeout");
  await session.stop();
});

test("changing the idle timeout cancels and rearms an already idle worker", async (t) => {
  const worker = new Worker();
  let timeout = 100;
  const host = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () => worker,
    () => {},
    () => {},
    undefined,
    () => timeout,
  );
  const session = host.attach("repo");
  t.after(() => session.stop());
  await session.generateChat([], () => {});
  const firstDeadline = host.snapshot().idleStopAt!;
  timeout = 500;
  host.refreshIdleTimeout();
  assert.equal(host.snapshot().idleStopAt, firstDeadline + 400);
  timeout = 0;
  host.refreshIdleTimeout();
  assert.equal(host.snapshot().idleStopAt, undefined);
  await delay(150);
  assert.equal(worker.stops, 0);
  const stopped = deferred();
  worker.stopStarted = stopped.resolve;
  timeout = 1;
  host.refreshIdleTimeout();
  await Promise.race([
    stopped.promise,
    delay(3000).then(() => {
      throw new Error("Idle worker was not stopped");
    }),
  ]);
  assert.equal(worker.stops, 1);
});

test("reports worker load, idle stop and failure events", async () => {
  const events: string[] = [];
  const host = new LocalModelHost(
    "/model",
    { provider: "cuda", deviceId: 1 },
    () => new Worker(),
    undefined,
    undefined,
    undefined,
    () => 1,
    (message, level = "info") => events.push(`${level}: ${message}`),
  );
  const session = host.attach("repo");
  await session.load("/model", "cuda", 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.currentStatus, "unloaded");
  assert.match(events[0]!, /^info: Starting the worker .* on CUDA 1/);
  assert.match(events[1]!, /^info: Model loaded on .* in \d+\.\d s\.$/);
  assert.match(events[2]!, /^info: Idle for 0 min; stopping the worker/);
  assert.equal(events[3], "info: Worker stopped; its memory is freed.");

  const failing = new LocalModelHost(
    "/model",
    { provider: "cpu", deviceId: 0 },
    () =>
      Object.assign(new Worker(), {
        loadGate: Promise.reject(new Error("boom")),
      }),
    undefined,
    undefined,
    undefined,
    undefined,
    (message, level = "info") => events.push(`${level}: ${message}`),
  );
  await assert.rejects(failing.attach("repo").load("/model", "cpu", 0));
  assert.equal(events.at(-1), "error: Model load failed: boom");
  await session.stop();
});
