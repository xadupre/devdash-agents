import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { validateLocalModelDirectory } from "./local-model";
import { installEngine, type LocalProvider } from "./local-worker";

export function isTransformersModelId(value: string): boolean {
  return (
    value.length <= 200 &&
    /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(
      value,
    ) &&
    !value.includes("..") &&
    !value.includes("--") &&
    !value.split("/").some((part) => part.endsWith(".") || part.endsWith("-"))
  );
}

/** Export checkpoints once at selection time; native inference still uses GenAI. */
export async function prepareLocalModel(
  source: string,
  storageDirectory: string,
  options: {
    provider: LocalProvider;
    signal?: AbortSignal;
    run?: typeof installEngine;
  },
): Promise<string> {
  options.signal?.throwIfAborted();
  let directory = resolve(source);
  let info = await stat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isFile()) {
    if (!/\.(onnx|json|safetensors|bin)$/i.test(directory))
      throw new Error(
        "Choose an ONNX/GenAI file or a Transformers checkpoint file with its configuration and tokenizer alongside it.",
      );
    directory = dirname(directory);
    info = await stat(directory);
  }
  if (info) {
    if (!info.isDirectory()) return validateLocalModelDirectory(directory);
    const genai = await stat(join(directory, "genai_config.json")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (genai) return validateLocalModelDirectory(directory);
    let config: unknown;
    try {
      config = JSON.parse(
        await readFile(join(directory, "config.json"), "utf8"),
      );
    } catch (error) {
      throw new Error(
        "Choose a GenAI directory with genai_config.json or a Transformers checkpoint directory with config.json, weights and tokenizer files.",
        { cause: error },
      );
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("Checkpoint config.json must contain a JSON object.");
  } else if (!isTransformersModelId(source)) {
    return validateLocalModelDirectory(directory);
  }
  if (options.provider === "npu")
    throw new Error(
      "Checkpoint preparation supports CPU and CUDA. For NPU, choose a prebuilt GenAI model compatible with your device.",
    );
  const provider = options.provider === "cuda" ? "cuda" : "cpu";
  await mkdir(storageDirectory, { recursive: true });
  const output = await mkdtemp(
    join(storageDirectory, `${basename(info ? directory : source)}-`),
  );
  const cache = join(output, ".cache");
  try {
    await (options.run ?? installEngine)(
      process.platform === "win32" ? "python" : "python3",
      [
        "-m",
        "onnxruntime_genai.models.builder",
        info ? "-i" : "-m",
        info ? directory : source,
        "-o",
        output,
        "-p",
        "int4",
        "-e",
        provider,
        "-c",
        cache,
        "--extra_options",
        "hf_remote=false",
      ],
      options.signal,
    );
    options.signal?.throwIfAborted();
    await rm(cache, { recursive: true, force: true });
    return await validateLocalModelDirectory(output);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    options.signal?.throwIfAborted();
    throw new Error(
      `Could not prepare ${source}. Install ONNX Runtime GenAI's model-builder dependencies in ${process.platform === "win32" ? "python" : "python3"} on the extension host, and use a supported, trusted checkpoint. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
