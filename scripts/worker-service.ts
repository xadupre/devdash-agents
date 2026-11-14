import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_WORKER,
  isLocalProvider,
  LocalWorker,
  resolveWorkerExecutable,
} from "../src/local-worker";
import { startWorkerService } from "../src/worker-service";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      "model-id": { type: "string", default: "devdash-local" },
      worker: { type: "string", default: DEFAULT_WORKER },
      provider: { type: "string", default: "auto" },
      "device-id": { type: "string" },
      port: { type: "string", default: "8000" },
      "max-length": { type: "string", default: "8192" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run worker:serve -- --model /absolute/genai/model [--model-id devdash-local] " +
        "[--worker /path/to/worker] [--provider auto|cpu|cuda|npu] [--device-id 0] " +
        "[--port 8000] [--max-length 8192]\n" +
        "Set DEVDASH_WORKER_API_KEY for bearer authentication. Listens only on 127.0.0.1.",
    );
    return;
  }
  const apiKey = process.env.DEVDASH_WORKER_API_KEY ?? "";
  if (!apiKey.trim()) throw new Error("Set DEVDASH_WORKER_API_KEY.");
  if (!values.model)
    throw new Error("--model must name a prepared GenAI model directory.");
  if (!isLocalProvider(values.provider)) throw new Error("Invalid --provider.");
  const port = Number(values.port);
  const deviceId =
    values["device-id"] === undefined ? undefined : Number(values["device-id"]);
  const maxLength = Number(values["max-length"]);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("--port must be between 0 and 65535.");
  if (
    deviceId !== undefined &&
    (!Number.isSafeInteger(deviceId) || deviceId < 0)
  )
    throw new Error("--device-id must be a nonnegative integer.");
  if (!Number.isInteger(maxLength) || maxLength < 2 || maxLength > 131072)
    throw new Error("--max-length must be between 2 and 131072.");
  const lifetime = new AbortController();
  let service: Awaited<ReturnType<typeof startWorkerService>> | undefined;
  const worker = new LocalWorker(
    resolveWorkerExecutable(values.worker, resolve(__dirname, "../..")),
    [],
    120_000,
    (error) => {
      if (!lifetime.signal.aborted) {
        console.error(error.message);
        process.exitCode = 1;
        stop();
      }
    },
  );
  const stop = () => {
    lifetime.abort();
    void (async () => {
      await service?.close();
      await worker.stop();
    })().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await worker.load(
      resolve(values.model),
      values.provider,
      deviceId,
      lifetime.signal,
    );
    lifetime.signal.throwIfAborted();
    service = await startWorkerService({
      worker,
      model: values["model-id"],
      apiKey,
      port,
      maxLength,
    });
    if (lifetime.signal.aborted) {
      await service.close();
      return;
    }
    console.log(
      `Local model service: ${service.baseUrl} (model: ${values["model-id"]})`,
    );
  } catch (error) {
    await worker.stop();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
