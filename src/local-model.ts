import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";
import type { LocalProvider } from "./local-worker";

/** Written by Foundry Local downloads at the root of each cached model. */
export const FOUNDRY_MANIFEST = ".devdash-download.json";

export interface LocalModelInfo {
  name: string;
  sizeBytes: number;
  contextLength: number;
  bytesPerToken?: Partial<Record<Exclude<LocalProvider, "auto">, number>>;
  sharedBuffer?: boolean;
  cachePolicy?: "shared-prefix" | "per-session";
}

export async function inspectLocalModel(
  directory: string,
): Promise<LocalModelInfo> {
  const config: unknown = JSON.parse(
    await readFile(join(directory, "genai_config.json"), "utf8"),
  );
  return modelInfoFromConfig(
    config,
    await localModelName(directory),
    await localModelSize(directory),
  );
}

/** Interprets a parsed genai_config.json, wherever the model directory is. */
export function modelInfoFromConfig(
  config: unknown,
  name: string,
  sizeBytes: number,
): LocalModelInfo {
  const model =
    config && typeof config === "object" && "model" in config
      ? config.model
      : undefined;
  const contextLength =
    model && typeof model === "object" && "context_length" in model
      ? model.context_length
      : undefined;
  const decoder =
    model && typeof model === "object" && "decoder" in model
      ? model.decoder
      : undefined;
  const dimensions =
    decoder && typeof decoder === "object"
      ? ["num_hidden_layers", "num_key_value_heads", "head_size"].map((key) =>
          key in decoder ? decoder[key as keyof typeof decoder] : undefined,
        )
      : [];
  const [layers, keyValueHeads, headSize] = dimensions;
  const kvElementsPerToken =
    dimensions.length === 3 &&
    dimensions.every(
      (value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    )
      ? 2 * Number(layers) * Number(keyValueHeads) * Number(headSize)
      : undefined;
  const providerOptions =
    decoder &&
    typeof decoder === "object" &&
    "provider_options" in decoder &&
    decoder.provider_options &&
    typeof decoder.provider_options === "object"
      ? decoder.provider_options
      : undefined;
  const hasHalfPrecisionProvider =
    providerOptions !== undefined &&
    ("cuda" in providerOptions || "dml" in providerOptions);
  const bytesPerToken =
    kvElementsPerToken === undefined
      ? undefined
      : {
          cpu: kvElementsPerToken * 4,
          npu: kvElementsPerToken * 2,
          ...(hasHalfPrecisionProvider
            ? {
                cuda: kvElementsPerToken * 2,
              }
            : {}),
        };
  const search =
    config && typeof config === "object" && "search" in config
      ? config.search
      : undefined;
  const sharedBuffer =
    search &&
    typeof search === "object" &&
    "past_present_share_buffer" in search
      ? search.past_present_share_buffer === true
      : undefined;
  const engine =
    config && typeof config === "object" && "engine" in config
      ? config.engine
      : undefined;
  if (
    typeof contextLength !== "number" ||
    !Number.isSafeInteger(contextLength) ||
    contextLength < 1
  )
    throw new Error(
      "Local model configuration must specify a positive integer model.context_length.",
    );
  return {
    name,
    sizeBytes,
    contextLength,
    cachePolicy:
      engine && typeof engine === "object" && "dynamic_batching" in engine
        ? "shared-prefix"
        : "per-session",
    ...(bytesPerToken ? { bytesPerToken } : {}),
    ...(sharedBuffer !== undefined ? { sharedBuffer } : {}),
  };
}

/**
 * Foundry Local caches are stored under hashed directories, so their name
 * comes from the download manifest; other models use their directory name.
 */
export async function localModelName(directory: string): Promise<string> {
  const resolved = resolve(directory);
  for (
    let current = resolved, level = 0;
    level < 4 && dirname(current) !== current;
    current = dirname(current), level++
  ) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        await readFile(join(current, FOUNDRY_MANIFEST), "utf8"),
      );
    } catch {
      continue;
    }
    const id =
      manifest && typeof manifest === "object" && "id" in manifest
        ? manifest.id
        : undefined;
    const name =
      typeof id === "string"
        ? /\/models\/([^/]+)\/versions\//.exec(id)?.[1]
        : undefined;
    if (name) return name;
    break;
  }
  return basename(resolved);
}

/** Logical bytes in the model directory, without reading weights or following directory symlinks. */
export async function localModelSize(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await localModelSize(path);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const info = await stat(path);
      if (info.isFile()) bytes += info.size;
    }
  }
  return bytes;
}

export async function validateLocalModelDirectory(
  modelDirectory: string,
): Promise<string> {
  const directory = resolve(modelDirectory);
  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Local model directory does not exist: ${directory}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`Local model path is not a directory: ${directory}`);
  }
  const configPath = join(directory, "genai_config.json");
  let config: unknown;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}.`, { cause: error });
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Local model is missing ${configPath}.`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${configPath} must contain a JSON object.`);
  }
  return directory;
}
