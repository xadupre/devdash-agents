import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { totalmem } from "node:os";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FOUNDRY_MANIFEST, validateLocalModelDirectory } from "./local-model";
import type { LocalProvider } from "./local-worker";

const catalogUrl = "https://api.catalog.azureml.ms/asset-gallery/v1.0/models";
const registryUrl =
  "https://centralus.api.azureml.ms/modelregistry/v1.0/registry/models/nonazureaccount";
const headers = {
  "User-Agent": "AzureAiStudio",
  "Content-Type": "application/json",
  "x-ms-use-full-service-contracts": "true",
};
const MANIFEST = FOUNDRY_MANIFEST;

/** Execution providers the native worker can run, by Foundry provider name. */
const PROVIDERS: Record<string, Exclude<LocalProvider, "auto">> = {
  CPUExecutionProvider: "cpu",
  CUDAExecutionProvider: "cuda",
  QNNExecutionProvider: "npu",
};
/** Catalogue tasks served by text generation in local sessions. */
const TEXT_TASKS = new Set([
  "chat-completion",
  "coding",
  "text-generation",
  "vision-language-chat",
]);

export type FoundryDevice = "cpu" | "gpu" | "npu";

export function isFoundryDevice(value: unknown): value is FoundryDevice {
  return value === "cpu" || value === "gpu" || value === "npu";
}

export interface FoundryModel {
  id: string;
  name: string;
  device: string;
  provider: string;
  localProvider: Exclude<LocalProvider, "auto">;
  task: string;
  license: string;
  size: number;
  memory?: number;
}

export interface FoundryMemory {
  ram: number;
  nvidia?: number;
  warning?: string;
}

export interface FoundryCatalog {
  models: (FoundryModel & { memoryLimit?: number })[];
  memory: FoundryMemory;
  hidden: number;
  unchecked: number;
  unsupported: number;
}

export interface DownloadProgress {
  received: number;
  total: number;
}

export interface FoundryOptions {
  signal?: AbortSignal;
  /** Replaces the global fetch, for example to reach a local test server. */
  fetch?: typeof fetch;
}

export async function inspectFoundryMemory(
  probeNvidia: boolean,
  signal?: AbortSignal,
): Promise<FoundryMemory> {
  signal?.throwIfAborted();
  const constrained = process.constrainedMemory();
  const memory: FoundryMemory = {
    ram: constrained > 0 ? Math.min(totalmem(), constrained) : totalmem(),
  };
  if (!probeNvidia) return memory;
  try {
    const { stdout } = await promisify(execFile)(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { signal, timeout: 5000, maxBuffer: 65536, windowsHide: true },
    );
    const sizes = stdout
      .trim()
      .split(/\r?\n/)
      .map((value) => Number(value.trim()) * 1048576);
    if (
      !sizes.length ||
      sizes.some((size) => !Number.isSafeInteger(size) || size <= 0)
    )
      throw new Error("NVIDIA returned no valid dedicated-memory capacity.");
    // A model must fit on one adapter; adding the capacities would overstate it.
    memory.nvidia = Math.max(...sizes);
  } catch (error) {
    signal?.throwIfAborted();
    memory.warning = `NVIDIA VRAM could not be checked: ${error instanceof Error ? error.message : String(error)}`;
  }
  return memory;
}

export function filterFoundryModels(
  models: FoundryModel[],
  memory: FoundryMemory,
  unsupported = 0,
): FoundryCatalog {
  const visible: FoundryCatalog["models"] = [];
  let hidden = 0;
  let unchecked = 0;
  for (const model of models) {
    const memoryLimit =
      model.localProvider === "cuda" ? memory.nvidia : memory.ram;
    if (
      model.memory !== undefined &&
      memoryLimit !== undefined &&
      model.memory > memoryLimit
    ) {
      hidden++;
      continue;
    }
    if (model.memory === undefined || memoryLimit === undefined) unchecked++;
    visible.push(
      memoryLimit === undefined ? { ...model } : { ...model, memoryLimit },
    );
  }
  return { models: visible, memory, hidden, unchecked, unsupported };
}

/** Lists the variants a local session can run and hides those exceeding local memory. */
export async function localFoundryModels(
  device: FoundryDevice,
  options: FoundryOptions = {},
): Promise<FoundryCatalog> {
  const { models, unsupported } = await listFoundryModels(device, options);
  const memory = await inspectFoundryMemory(
    models.some((model) => model.localProvider === "cuda"),
    options.signal,
  );
  return filterFoundryModels(models, memory, unsupported);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFoundryModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 300 &&
    /^azureml:\/\/registries\/[\w.-]+\/models\/[\w.-]+\/versions\/\d+$/.test(
      value,
    )
  );
}

async function request(
  url: string | URL,
  init: RequestInit,
  options: FoundryOptions,
): Promise<Response> {
  const response = await (options.fetch ?? fetch)(url, {
    ...init,
    signal: options.signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Signed blob URLs are credentials and must never appear in error messages.
    throw new Error(`Foundry Local request failed: HTTP ${response.status}.`);
  }
  return response;
}

export async function listFoundryModels(
  device: FoundryDevice,
  options: FoundryOptions = {},
): Promise<{ models: FoundryModel[]; unsupported: number }> {
  if (!isFoundryDevice(device))
    throw new Error("Choose a supported Foundry Local device.");
  const filters = [
    { field: "type", operator: "eq", values: ["models"] },
    { field: "kind", operator: "eq", values: ["Versioned"] },
    { field: "labels", operator: "eq", values: ["latest"] },
    {
      field: "annotations/systemCatalogData/deploymentOptions",
      operator: "eq",
      values: ["Foundry Local on Devices"],
    },
    { field: "annotations/archived", operator: "NotEquals", values: ["true"] },
    {
      field: "properties/variantInfo/variantMetadata/device",
      operator: "eq",
      values: [device],
    },
  ];
  const models = new Map<string, FoundryModel>();
  const seen = new Set<string>();
  let unsupported = 0;
  let continuationToken: string | undefined;
  do {
    const response = await request(
      catalogUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ filters, pageSize: 50, continuationToken }),
      },
      options,
    );
    const data: unknown = await response.json();
    if (!object(data) || !Array.isArray(data.value))
      throw new Error("Invalid Foundry Local catalog response.");
    for (const entry of data.value) {
      if (!object(entry) || !object(entry.properties)) continue;
      const properties = entry.properties;
      const variant =
        object(properties.variantInfo) &&
        properties.variantInfo.variantMetadata;
      if (!object(variant) || variant.modelType !== "ONNX") continue;
      const annotations = object(entry.annotations) ? entry.annotations : {};
      const tags = object(annotations.tags) ? annotations.tags : {};
      if (tags.foundryLocal === "hide" || tags.foundryLocal === "test")
        continue;
      const system = object(annotations.systemCatalogData)
        ? annotations.systemCatalogData
        : {};
      if (
        typeof properties.name !== "string" ||
        typeof variant.device !== "string" ||
        typeof variant.executionProvider !== "string" ||
        typeof variant.fileSizeBytes !== "number" ||
        !Number.isSafeInteger(variant.fileSizeBytes) ||
        variant.fileSizeBytes < 0 ||
        (variant.vRamFootprintBytes !== undefined &&
          variant.vRamFootprintBytes !== null &&
          (typeof variant.vRamFootprintBytes !== "number" ||
            !Number.isSafeInteger(variant.vRamFootprintBytes) ||
            variant.vRamFootprintBytes < 0))
      )
        throw new Error("Invalid Foundry Local model metadata.");
      if (!isFoundryModelId(entry.assetId))
        throw new Error("Invalid Foundry Local model ID.");
      const localProvider = PROVIDERS[variant.executionProvider];
      const task = typeof tags.task === "string" ? tags.task : "";
      if (!localProvider || !TEXT_TASKS.has(task)) {
        unsupported++;
        continue;
      }
      models.set(entry.assetId, {
        id: entry.assetId,
        name: `${properties.name}:${String(properties.version)}`,
        device: variant.device,
        provider: variant.executionProvider,
        localProvider,
        task,
        license:
          typeof system.license === "string"
            ? system.license
            : "See model license",
        size: variant.fileSizeBytes,
        ...(typeof variant.vRamFootprintBytes === "number" &&
        variant.vRamFootprintBytes > 0
          ? { memory: variant.vRamFootprintBytes }
          : {}),
      });
    }
    if (data.continuationToken) {
      if (
        typeof data.continuationToken !== "string" ||
        seen.has(data.continuationToken)
      )
        throw new Error("Invalid Foundry Local catalog continuation token.");
      seen.add(data.continuationToken);
      continuationToken = data.continuationToken;
    } else continuationToken = undefined;
  } while (continuationToken);
  return {
    models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unsupported,
  };
}

interface ModelFile {
  path: string;
  size: number;
}

function modelPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.split("/").some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        // eslint-disable-next-line no-control-regex
        /[\x00-\x1f<>:"\\|?*]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("Unsafe Foundry Local model file path.");
  return value;
}

function blobUrl(value: unknown): URL {
  if (typeof value !== "string")
    throw new Error("Missing Foundry Local download URL.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new Error("Invalid Foundry Local blob host.");
  return url;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function xmlText(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi,
    (match, hex: string, decimal: string, name: string) => {
      if (hex || decimal) {
        const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
        if (code > 0x10ffff) throw new Error("Invalid XML character.");
        return String.fromCodePoint(code);
      }
      const text = XML_ENTITIES[name];
      if (text === undefined) throw new Error(`Unknown XML entity ${match}.`);
      return text;
    },
  );
}

function xmlElement(xml: string, name: string): string | undefined {
  const matches = [
    ...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g")),
  ];
  if (matches.length > 1) throw new Error(`Repeated XML element ${name}.`);
  const text = matches[0]?.[1];
  return text === undefined ? undefined : xmlText(text);
}

/** Parses Azure Blob "List Blobs" XML, which uses neither attributes nor CDATA for these fields. */
export function parseBlobListing(xml: string): {
  blobs: { name: string; size: number }[];
  nextMarker: string;
} {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml))
    throw new Error("Invalid Foundry Local blob listing.");
  const body =
    /<EnumerationResults(?:\s[^>]*)?>([\s\S]*)<\/EnumerationResults>/.exec(
      xml,
    )?.[1];
  if (body === undefined)
    throw new Error("Invalid Foundry Local blob listing.");
  const blobs = [...body.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)].map(
    ([, blob = ""]) => {
      const name = xmlElement(blob, "Name");
      const size = Number(xmlElement(blob, "Content-Length"));
      if (name === undefined || !Number.isSafeInteger(size) || size < 0)
        throw new Error("Invalid Foundry Local blob entry.");
      return { name, size };
    },
  );
  const withoutBlobs = body.replace(/<Blobs>[\s\S]*<\/Blobs>/, "");
  const marker = /<NextMarker\s*\/>/.test(withoutBlobs)
    ? ""
    : xmlElement(withoutBlobs, "NextMarker");
  return { blobs, nextMarker: marker ?? "" };
}

async function listFiles(
  container: URL,
  options: FoundryOptions,
): Promise<ModelFile[]> {
  const files: ModelFile[] = [];
  const names = new Set<string>();
  const markers = new Set<string>();
  let marker = "";
  do {
    const url = new URL(container);
    url.searchParams.set("restype", "container");
    url.searchParams.set("comp", "list");
    if (marker) url.searchParams.set("marker", marker);
    const response = await request(url, {}, options);
    const listing = parseBlobListing(await response.text());
    for (const blob of listing.blobs) {
      const path = modelPath(blob.name);
      const key = path.toLowerCase();
      if (names.has(key))
        throw new Error("Invalid or duplicate Foundry Local file.");
      names.add(key);
      files.push({ path, size: blob.size });
    }
    if (listing.nextMarker && markers.has(listing.nextMarker))
      throw new Error("Invalid Foundry Local blob continuation marker.");
    marker = listing.nextMarker;
    markers.add(marker);
  } while (marker);
  if (genaiDirectories(files).length !== 1)
    throw new Error(
      "The Foundry Local package must contain exactly one genai_config.json.",
    );
  return files;
}

function genaiDirectories(files: ModelFile[]): string[] {
  return files
    .filter((file) => /(?:^|\/)genai_config\.json$/i.test(file.path))
    .map((file) => dirname(file.path));
}

async function cacheExists(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid Foundry Local cache directory.");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function validateCache(directory: string, id: string): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(join(directory, MANIFEST), "utf8"),
  );
  if (!object(manifest) || manifest.id !== id || !Array.isArray(manifest.files))
    throw new Error("Invalid Foundry Local cache manifest.");
  const files: ModelFile[] = [];
  for (const file of manifest.files) {
    if (!object(file) || typeof file.size !== "number")
      throw new Error("Invalid Foundry Local cached file.");
    const path = modelPath(file.path);
    const info = await lstat(join(directory, path));
    if (!info.isFile() || info.size !== file.size)
      throw new Error(
        `Incomplete Foundry Local cache. Remove ${directory} and retry.`,
      );
    files.push({ path, size: file.size });
  }
  const [model] = genaiDirectories(files);
  if (genaiDirectories(files).length !== 1 || model === undefined)
    throw new Error("Invalid Foundry Local cache manifest.");
  return validateLocalModelDirectory(join(directory, model));
}

function cacheDirectory(id: string, cacheRoot: string): string {
  return join(
    cacheRoot,
    "foundry",
    createHash("sha256").update(id).digest("hex"),
  );
}

/**
 * Lists the files of the package's GenAI model directory with signed download
 * URLs, so another machine can fetch them. The URLs are credentials.
 */
export async function foundryModelFiles(
  id: string,
  options: FoundryOptions = {},
): Promise<{ path: string; size: number; url: string }[]> {
  if (!isFoundryModelId(id)) throw new Error("Invalid Foundry Local model ID.");
  const registry = new URL(registryUrl);
  registry.searchParams.set("assetId", id);
  const response = await request(registry, { headers }, options);
  const data: unknown = await response.json();
  if (!object(data))
    throw new Error("Invalid Foundry Local registry response.");
  const container = blobUrl(data.blobSasUri);
  const files = await listFiles(container, options);
  const [model = "."] = genaiDirectories(files);
  const prefix = model === "." ? "" : `${model}/`;
  return files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => {
      const url = new URL(container);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
      return {
        path: file.path.slice(prefix.length),
        size: file.size,
        url: url.href,
      };
    });
}

/**
 * Downloads the complete package into an atomic cache and returns the
 * directory containing genai_config.json.
 */
export async function downloadFoundryModel(
  id: string,
  cacheRoot: string,
  options: FoundryOptions = {},
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  if (!isFoundryModelId(id)) throw new Error("Invalid Foundry Local model ID.");
  const { signal } = options;
  signal?.throwIfAborted();
  const directory = cacheDirectory(id, cacheRoot);
  const root = dirname(directory);
  if (await cacheExists(directory)) {
    const model = await validateCache(directory, id);
    signal?.throwIfAborted();
    return model;
  }
  const registry = new URL(registryUrl);
  registry.searchParams.set("assetId", id);
  const response = await request(registry, { headers }, options);
  const data: unknown = await response.json();
  if (!object(data))
    throw new Error("Invalid Foundry Local registry response.");
  const container = blobUrl(data.blobSasUri);
  const files = await listFiles(container, options);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(total))
    throw new Error("Foundry Local package is too large.");
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, ".download-"));
  let received = 0;
  let reportedAt = 0;
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const url = new URL(container);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
      const response = await request(url, {}, options);
      if (!response.body)
        throw new Error("Foundry Local returned no file data.");
      const destination = join(temporary, file.path);
      await mkdir(dirname(destination), { recursive: true });
      let bytes = 0;
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          received += chunk.length;
          const now = Date.now();
          if (now - reportedAt >= 100) {
            onProgress?.({ received, total });
            reportedAt = now;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        ),
        progress,
        createWriteStream(destination, { flags: "wx" }),
        { signal },
      );
      if (bytes !== file.size)
        throw new Error("Incomplete Foundry Local file download.");
    }
    await writeFile(join(temporary, MANIFEST), JSON.stringify({ id, files }), {
      flag: "wx",
    });
    await validateCache(temporary, id);
    signal?.throwIfAborted();
    try {
      await rename(temporary, directory);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "EEXIST" ||
            error.code === "ENOTEMPTY" ||
            (process.platform === "win32" &&
              (error.code === "EPERM" || error.code === "EACCES")))
        ) ||
        !(await cacheExists(directory))
      )
        throw error;
    }
    const model = await validateCache(directory, id);
    signal?.throwIfAborted();
    onProgress?.({ received, total });
    return model;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
