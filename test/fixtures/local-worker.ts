import { createInterface } from "node:readline";

const mode = process.argv[2];
const device = { provider: "cpu", deviceId: 0, name: "CPU" };
let generating: string | undefined;
let generatingSession: string | undefined;
// Stand-in KV caches: every generation reuses its session's whole sequence,
// then appends one prompt token and two generated tokens.
const caches = new Map<string, number>();
const generation = (session = "", cancelled = false) => {
  const cachedTokens = caches.get(session) ?? 0;
  const generatedTokens = cancelled ? 1 : 2;
  const cacheTokens = cachedTokens + 1 + generatedTokens;
  caches.set(session, cacheTokens);
  return { cancelled, cachedTokens, generatedTokens, cacheTokens };
};
const reply = (id: string, type: string, fields = {}): void => {
  process.stdout.write(JSON.stringify({ id, type, ...fields }) + "\n");
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as {
    id: string;
    method: string;
    modelPath?: string;
    deviceId?: number;
    targetId?: string;
    session?: string;
  };
  if (mode === "crash") {
    process.stderr.write("runtime unavailable\n");
    process.exit(1);
  }
  if (mode === "malformed") {
    process.stdout.write("not json\n");
    return;
  }
  if (mode === "hang") return;
  if (mode === "oversized") {
    process.stdout.write("x".repeat(1024 * 1024 + 1));
    return;
  }
  switch (request.method) {
    case "discover":
      reply(request.id, "providers", {
        providers:
          mode === "invalid-device" ? [{ ...device, deviceId: -1 }] : [device],
      });
      break;
    case "load":
      if (request.modelPath === "broken") {
        reply(request.id, "error", {
          code: "load_failed",
          message: "Invalid model",
        });
      } else if (mode === "cuda-device-0") {
        // Like GenAI models with runtime_profiles: only device 0 is accepted.
        if (request.deviceId === 0 && process.env.CUDA_VISIBLE_DEVICES)
          reply(request.id, "loaded", {
            provider: "cuda",
            deviceId: 0,
            name: `GPU ${process.env.CUDA_VISIBLE_DEVICES}`,
          });
        else
          reply(request.id, "error", {
            code: "load_failed",
            message: "runtime_profiles require CUDA device_id 0",
          });
      } else {
        reply(request.id, "loaded", device);
      }
      break;
    case "generate":
      reply(request.id, "token", { text: "Hello " });
      if (mode === "cancel") {
        generating = request.id;
        generatingSession = request.session;
      } else {
        const response =
          JSON.stringify({ id: request.id, type: "token", text: "世界" }) +
          "\n";
        const bytes = Buffer.from(response);
        const split = bytes.indexOf(Buffer.from("世")) + 1;
        process.stdout.write(bytes.subarray(0, split));
        setTimeout(() => {
          process.stdout.write(bytes.subarray(split));
          reply(request.id, "done", generation(request.session));
        }, 5);
      }
      break;
    case "cancel":
      if (generating === request.targetId) {
        reply(generating!, "done", generation(generatingSession, true));
        generating = undefined;
      }
      reply(request.id, "cancelled");
      break;
    case "release":
      caches.delete(request.session ?? "");
      reply(request.id, "released");
      break;
    case "stop":
      reply(request.id, "stopped");
      process.exit(0);
  }
});
