import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  downloadFoundryModel,
  filterFoundryModels,
  listFoundryModels,
  localFoundryModels,
  parseBlobListing,
  type FoundryModel,
} from "../src/foundry";

const asset = "azureml://registries/azureml/models/phi-fixture/versions/1";
const GiB = 1024 ** 3;

function catalogEntry(
  name: string,
  provider: string,
  task: string,
  extra: Record<string, unknown> = {},
) {
  return {
    assetId: `azureml://registries/azureml/models/${name}/versions/1`,
    annotations: { tags: { task }, systemCatalogData: { license: "MIT" } },
    properties: {
      name,
      version: 1,
      variantInfo: {
        variantMetadata: {
          modelType: "ONNX",
          device: "cpu",
          executionProvider: provider,
          fileSizeBytes: 123,
          vRamFootprintBytes: 456,
          ...extra,
        },
      },
    },
  };
}

/** Serves the catalogue, registry and blob container from 127.0.0.1. */
async function foundryServer(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devdash-agents-foundry-"));
  const files = new Map<string, Buffer>([
    ["v1/genai_config.json", Buffer.from('{"model":{"context_length":4096}}')],
    ["v1/model.onnx", Buffer.from("graph")],
    ["v1/model.onnx.data", Buffer.from("external weights")],
    ["v1/special & tokens.json", Buffer.from("{}")],
  ]);
  const requests: { path: string; query: URLSearchParams; body: string }[] = [];
  const state = {
    catalog: [
      catalogEntry("phi-fixture", "CPUExecutionProvider", "chat-completion"),
      catalogEntry("webgpu", "WebGPUExecutionProvider", "chat-completion"),
      catalogEntry(
        "whisper",
        "CPUExecutionProvider",
        "automatic-speech-recognition",
      ),
    ] as unknown[],
    catalogPages: false,
    catalogStatus: 200,
    listingPages: false,
    blobHost: "fixtures.blob.core.windows.net",
    transferStatus: 200,
    transferSuffix: "",
  };
  const escape = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = Buffer.concat(chunks).toString();
      requests.push({ path: url.pathname, query: url.searchParams, body });
      if (url.pathname === "/asset-gallery/v1.0/models") {
        const second = JSON.parse(body).continuationToken === "page2";
        res.writeHead(state.catalogStatus, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            value: state.catalogPages
              ? second
                ? state.catalog.slice(1)
                : state.catalog.slice(0, 1)
              : state.catalog,
            ...(state.catalogPages && !second
              ? { continuationToken: "page2" }
              : {}),
          }),
        );
      } else if (url.pathname.startsWith("/modelregistry/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            blobSasUri: `https://${state.blobHost}/package?sig=fixture-signature`,
          }),
        );
      } else if (url.searchParams.get("comp") === "list") {
        const second = url.searchParams.get("marker") === "page2";
        const entries = [...files];
        const page = state.listingPages
          ? entries.slice(second ? 2 : 0, second ? undefined : 2)
          : entries;
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ContainerName="package"><Blobs>${page
            .map(
              ([name, data]) =>
                `<Blob><Name>${escape(name)}</Name><Properties><Content-Length>${data.length}</Content-Length></Properties></Blob>`,
            )
            .join("")}</Blobs>${
            state.listingPages && !second
              ? "<NextMarker>page2</NextMarker>"
              : "<NextMarker />"
          }</EnumerationResults>`,
        );
      } else {
        const file = files.get(
          decodeURIComponent(url.pathname.slice("/package/".length)),
        );
        if (!file) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(state.transferStatus);
        res.end(Buffer.concat([file, Buffer.from(state.transferSuffix)]));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  const localFetch: typeof fetch = (input, init) => {
    const remote = new URL(input instanceof Request ? input.url : input);
    const local = new URL(`http://127.0.0.1:${port}${remote.pathname}`);
    local.search = remote.search;
    return fetch(local, init);
  };
  return { root, files, requests, state, fetch: localFetch };
}

test("Foundry Local lists only text-generation variants the worker can run", async (t) => {
  const hub = await foundryServer(t);
  hub.state.catalogPages = true;
  const { models, unsupported } = await listFoundryModels("cpu", hub);
  assert.deepEqual(
    models.map(({ id, localProvider, license, memory }) => ({
      id,
      localProvider,
      license,
      memory,
    })),
    [{ id: asset, localProvider: "cpu", license: "MIT", memory: 456 }],
  );
  assert.equal(unsupported, 2);
  const filters = JSON.parse(hub.requests[0]!.body).filters as {
    field: string;
    values: string[];
  }[];
  assert.ok(
    filters.some(
      ({ field, values }) => field.endsWith("/device") && values[0] === "cpu",
    ),
  );
  assert.equal(
    (await localFoundryModels("cpu", hub)).models[0]?.memoryLimit !== undefined,
    true,
  );
  hub.state.catalogStatus = 503;
  await assert.rejects(listFoundryModels("cpu", hub), /HTTP 503/);
});

test("Foundry memory filtering compares execution estimates with the matching memory pool", () => {
  const base: FoundryModel = {
    id: "",
    name: "fixture",
    device: "cpu",
    provider: "CPUExecutionProvider",
    localProvider: "cpu",
    task: "chat-completion",
    license: "MIT",
    size: 1,
  };
  const cuda = {
    device: "gpu",
    provider: "CUDAExecutionProvider",
    localProvider: "cuda" as const,
  };
  const models: FoundryModel[] = [
    { ...base, id: "cpu-too-large", memory: 33 * GiB },
    { ...base, id: "cpu-exact", memory: 32 * GiB },
    { ...base, id: "large-download", size: 80 * GiB, memory: 2 * GiB },
    { ...base, ...cuda, id: "cuda-too-large", memory: 9 * GiB },
    { ...base, ...cuda, id: "cuda-exact", memory: 8 * GiB },
    { ...base, id: "unknown-footprint" },
  ];
  const filtered = filterFoundryModels(
    models,
    { ram: 32 * GiB, nvidia: 8 * GiB },
    5,
  );
  assert.deepEqual(
    filtered.models.map(({ id }) => id),
    ["cpu-exact", "large-download", "cuda-exact", "unknown-footprint"],
  );
  assert.equal(filtered.hidden, 2);
  assert.equal(filtered.unchecked, 1);
  assert.equal(filtered.unsupported, 5);
  const unknownVram = filterFoundryModels(models, { ram: 32 * GiB });
  assert.ok(unknownVram.models.some(({ id }) => id === "cuda-too-large"));
  assert.equal(unknownVram.unchecked, 3);
});

test("Foundry Local downloads the complete package and returns the GenAI model directory", async (t) => {
  const hub = await foundryServer(t);
  hub.state.listingPages = true;
  const progress: { received: number; total: number }[] = [];
  const directory = await downloadFoundryModel(asset, hub.root, hub, (value) =>
    progress.push(value),
  );
  assert.equal(directory.endsWith(join("v1")), true);
  for (const [file, bytes] of hub.files)
    assert.deepEqual(await readFile(join(directory, "..", file)), bytes);
  assert.equal(progress.at(-1)?.received, progress.at(-1)?.total);
  assert.equal(hub.requests[0]?.query.get("assetId"), asset);
  const count = hub.requests.length;
  assert.equal(await downloadFoundryModel(asset, hub.root, hub), directory);
  assert.equal(hub.requests.length, count);
  const manifest = await readFile(
    join(directory, "..", ".devdash-download.json"),
    "utf8",
  );
  assert.equal(manifest.includes("fixture-signature"), false);
  await writeFile(join(directory, "model.onnx.data"), "truncated");
  await assert.rejects(
    downloadFoundryModel(asset, hub.root, hub),
    /Incomplete Foundry Local cache/,
  );
});

test("Foundry Local rejects unsafe paths, untrusted hosts and packages without one GenAI configuration", async (t) => {
  const hub = await foundryServer(t);
  await assert.rejects(
    downloadFoundryModel("https://example.com/model", hub.root, hub),
    /model ID/,
  );
  hub.state.blobHost = "example.com";
  await assert.rejects(downloadFoundryModel(asset, hub.root, hub), /blob host/);
  hub.state.blobHost = "fixtures.blob.core.windows.net";
  for (const name of [
    "../outside",
    "v1/../../x",
    "C:/file",
    "v1\\file",
    "v1/CON",
  ]) {
    hub.files.set(name, Buffer.from("unsafe"));
    await assert.rejects(
      downloadFoundryModel(asset, hub.root, hub),
      /Unsafe.*path/,
    );
    hub.files.delete(name);
  }
  hub.files.set("v2/genai_config.json", Buffer.from("{}"));
  await assert.rejects(
    downloadFoundryModel(asset, hub.root, hub),
    /exactly one genai_config.json/,
  );
  assert.deepEqual(await readdir(hub.root), []);
  assert.equal(
    hub.requests.some(
      ({ path, query }) => path.startsWith("/package/") && !query.has("comp"),
    ),
    false,
  );
});

test("Foundry Local never publishes failed, truncated or cancelled downloads", async (t) => {
  const hub = await foundryServer(t);
  const cache = join(hub.root, "foundry");
  hub.state.transferStatus = 403;
  await assert.rejects(downloadFoundryModel(asset, hub.root, hub), /HTTP 403/);
  assert.deepEqual(await readdir(cache), []);
  hub.state.transferStatus = 200;
  hub.state.transferSuffix = "extra";
  await assert.rejects(
    downloadFoundryModel(asset, hub.root, hub),
    /Incomplete Foundry Local file/,
  );
  assert.deepEqual(await readdir(cache), []);
  hub.state.transferSuffix = "";
  const controller = new AbortController();
  await assert.rejects(
    downloadFoundryModel(
      asset,
      hub.root,
      { ...hub, signal: controller.signal },
      () => controller.abort(),
    ),
    /abort/i,
  );
  assert.deepEqual(await readdir(cache), []);
});

test("blob listings decode entities and reject DTDs and malformed sizes", () => {
  assert.deepEqual(
    parseBlobListing(
      "<EnumerationResults><Blobs><Blob><Name>a &amp; b&#47;c</Name><Properties><Content-Length>3</Content-Length></Properties></Blob></Blobs><NextMarker>m</NextMarker></EnumerationResults>",
    ),
    { blobs: [{ name: "a & b/c", size: 3 }], nextMarker: "m" },
  );
  for (const xml of [
    '<!DOCTYPE x [<!ENTITY e "x">]><EnumerationResults/>',
    "<EnumerationResults><Blobs><Blob><Name>a</Name><Properties><Content-Length>-1</Content-Length></Properties></Blob></Blobs></EnumerationResults>",
    "<EnumerationResults><Blobs><Blob><Name>&e;</Name><Properties><Content-Length>1</Content-Length></Properties></Blob></Blobs></EnumerationResults>",
    "<Other/>",
  ])
    assert.throws(() => parseBlobListing(xml));
});
