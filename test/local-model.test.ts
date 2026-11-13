import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  inspectLocalModel,
  localModelName,
  localModelSize,
  validateLocalModelDirectory,
} from "../src/local-model";

test("model inspection reads the configured context length and rejects invalid limits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arranged-agents-model-info-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = '{"model":{"context_length":40960}}';
  await writeFile(join(root, "genai_config.json"), config);
  assert.deepEqual(await inspectLocalModel(root), {
    name: basename(root),
    sizeBytes: Buffer.byteLength(config),
    contextLength: 40960,
  });

  test("model inspection estimates KV bytes and detects shared CUDA cache allocation", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "arranged-agents-model-kv-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "genai_config.json"),
      JSON.stringify({
        model: {
          context_length: 4096,
          decoder: {
            num_hidden_layers: 4,
            num_key_value_heads: 2,
            head_size: 8,
            provider_options: { cuda: {} },
          },
        },
        search: { past_present_share_buffer: true },
      }),
    );
    const info = await inspectLocalModel(root);
    assert.deepEqual(info.bytesPerToken, {
      cpu: 512,
      npu: 256,
      cuda: 256,
    });
    assert.equal(info.sharedBuffer, true);
  });
  for (const context_length of [undefined, 0, -1, 1.5, "4096"]) {
    await writeFile(
      join(root, "genai_config.json"),
      JSON.stringify({ model: { context_length } }),
    );
    await assert.rejects(inspectLocalModel(root), /model.context_length/);
  }
});

test("model names come from the Foundry Local manifest or the directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arranged-agents-model-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = join(root, "0123abcd", "v2");
  await mkdir(model, { recursive: true });
  assert.equal(await localModelName(model), "v2");
  await writeFile(
    join(root, "0123abcd", ".arranged-download.json"),
    JSON.stringify({
      id: "azureml://registries/azureml/models/qwen3-0.6b-generic-cpu-dq44/versions/2",
      files: [],
    }),
  );
  assert.equal(await localModelName(model), "qwen3-0.6b-generic-cpu-dq44");
  await writeFile(join(root, "0123abcd", ".arranged-download.json"), "{bad");
  assert.equal(await localModelName(model), "v2");
});

test("model size includes nested weights and tokenizer files and reports missing paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arranged-agents-model-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "weights"));
  await writeFile(join(root, "genai_config.json"), "{}");
  await writeFile(join(root, "weights", "model.onnx.data"), Buffer.alloc(1234));
  await writeFile(join(root, "tokenizer.json"), "tokenizer");
  assert.equal(await localModelSize(root), 1245);
  if (process.platform !== "win32") {
    await symlink(root, join(root, "cycle"), "dir");
    await symlink(
      join(root, "weights", "model.onnx.data"),
      join(root, "linked.data"),
    );
    assert.equal(await localModelSize(root), 2479);
  }
  await assert.rejects(localModelSize(join(root, "missing")), {
    code: "ENOENT",
  });
});

test("validates and resolves a local ONNX GenAI model directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "arranged-agents-model-"));
  const model = join(root, "model");
  await mkdir(model);
  await writeFile(
    join(model, "genai_config.json"),
    '{"model":{"type":"test"}}',
  );
  try {
    assert.equal(await validateLocalModelDirectory(model), model);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing directory, missing configuration, invalid JSON, and non-object configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "arranged-agents-model-"));
  const missingConfig = join(root, "missing-config");
  const invalidConfig = join(root, "invalid-config");
  const arrayConfig = join(root, "array-config");
  const file = join(root, "file");
  await mkdir(missingConfig);
  await mkdir(invalidConfig);
  await mkdir(arrayConfig);
  await writeFile(file, "");
  await writeFile(join(invalidConfig, "genai_config.json"), "{");
  await writeFile(join(arrayConfig, "genai_config.json"), "[]");
  try {
    await assert.rejects(
      validateLocalModelDirectory(join(root, "missing")),
      /does not exist/,
    );
    await assert.rejects(
      validateLocalModelDirectory(missingConfig),
      /missing .*genai_config\.json/,
    );
    await assert.rejects(
      validateLocalModelDirectory(invalidConfig),
      /Invalid JSON/,
    );
    await assert.rejects(
      validateLocalModelDirectory(arrayConfig),
      /must contain a JSON object/,
    );
    await assert.rejects(
      validateLocalModelDirectory(root),
      /missing .*genai_config/,
    );
    await assert.rejects(validateLocalModelDirectory(file), /not a directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
