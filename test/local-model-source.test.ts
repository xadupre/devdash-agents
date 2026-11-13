import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  isTransformersModelId,
  prepareLocalModel,
} from "../src/local-model-source";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devdash-model-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = join(root, "checkpoint with spaces;literal");
  await mkdir(model);
  return { root, model, storage: join(root, "exports") };
}

test("Transformers IDs accept Hub names, not URLs, paths or command options", () => {
  for (const id of ["gpt2", "Qwen/Qwen3-0.6B", "org/model_name"])
    assert.equal(isTransformersModelId(id), true, id);
  for (const id of [
    "",
    "../model",
    "/models/checkpoint",
    "org/model/subfolder",
    "https://huggingface.co/org/model",
    "--help",
    "org/model@revision",
    "org/model;command",
    "org/model\n",
    "org/../model",
    "org/model..name",
    "org/model--name",
    "org/model.",
    "a".repeat(201),
  ])
    assert.equal(isTransformersModelId(id), false, id);
});

test("GenAI directories load unchanged without Python, including with NPU", async (t) => {
  const { model, storage } = await setup(t);
  await writeFile(join(model, "genai_config.json"), "{}");
  assert.equal(
    await prepareLocalModel(model, storage, {
      provider: "npu",
      run: async () => assert.fail("GenAI models must not be exported"),
    }),
    model,
  );
  await writeFile(join(model, "genai_config.json"), "{bad");
  await assert.rejects(
    prepareLocalModel(model, storage, { provider: "cpu" }),
    /Invalid JSON/,
  );
});

test("model files resolve their companion configuration and reject unsupported standalone formats", async (t) => {
  const { model, storage } = await setup(t);
  const weights = join(model, "weights.onnx");
  await writeFile(weights, "weights");
  await assert.rejects(
    prepareLocalModel(weights, storage, { provider: "cpu" }),
    /Choose a GenAI directory/,
  );
  await writeFile(join(model, "genai_config.json"), "{}");
  assert.equal(
    await prepareLocalModel(weights, storage, { provider: "cpu" }),
    model,
  );
  assert.equal(
    await prepareLocalModel(join(model, "genai_config.json"), storage, {
      provider: "cpu",
    }),
    model,
  );
  const gguf = join(model, "weights.gguf");
  await writeFile(gguf, "unsupported");
  await assert.rejects(
    prepareLocalModel(gguf, storage, { provider: "cpu" }),
    /Choose an ONNX/,
  );
});

test("local checkpoints use absolute literal paths and the selected CUDA target", async (t) => {
  const { model, storage } = await setup(t);
  await writeFile(join(model, "config.json"), '{"model_type":"qwen3"}');
  const controller = new AbortController();
  let exported = "";
  const prepared = await prepareLocalModel(model, storage, {
    provider: "cuda",
    signal: controller.signal,
    run: async (command, args = [], signal) => {
      assert.equal(
        command,
        process.platform === "win32" ? "python" : "python3",
      );
      assert.equal(signal, controller.signal);
      exported = args[5]!;
      assert.equal(isAbsolute(exported), true);
      assert.deepEqual(args, [
        "-m",
        "onnxruntime_genai.models.builder",
        "-i",
        model,
        "-o",
        exported,
        "-p",
        "int4",
        "-e",
        "cuda",
        "-c",
        join(exported, ".cache"),
        "--extra_options",
        "hf_remote=false",
      ]);
      await mkdir(join(exported, ".cache"));
      await writeFile(join(exported, ".cache", "weights"), "temporary weights");
      await writeFile(join(exported, "genai_config.json"), "{}");
    },
  });
  assert.equal(prepared, exported);
  assert.deepEqual(await readdir(exported), ["genai_config.json"]);
  assert.deepEqual(await readdir(storage), [
    exported.slice(storage.length + 1),
  ]);
  assert.deepEqual(await readdir(model), ["config.json"]);
});

test("Hub IDs use the builder model-name argument and automatic prepares for CPU", async (t) => {
  const { storage } = await setup(t);
  const prepared = await prepareLocalModel("Qwen/Qwen3-0.6B", storage, {
    provider: "auto",
    run: async (_command, args = []) => {
      assert.deepEqual(args.slice(2, 4), ["-m", "Qwen/Qwen3-0.6B"]);
      assert.deepEqual(args.slice(8, 10), ["-e", "cpu"]);
      await writeFile(join(args[5]!, "genai_config.json"), "{}");
    },
  });
  assert.match(prepared, /Qwen3-0\.6B-/);
});

test("failed or invalid exports are removed and can be retried", async (t) => {
  const { storage } = await setup(t);
  for (const failure of ["process", "missing config", "invalid config"]) {
    await assert.rejects(
      prepareLocalModel("org/model", storage, {
        provider: "cpu",
        run: async (_command, args = []) => {
          await writeFile(join(args[5]!, "partial.onnx"), "partial");
          if (failure === "process") throw new Error("builder unavailable");
          if (failure === "invalid config")
            await writeFile(join(args[5]!, "genai_config.json"), "{bad");
        },
      }),
      /Could not prepare org\/model.*model-builder dependencies/,
    );
    assert.deepEqual(await readdir(storage), []);
  }
});

test("cancellation removes partial exports and preserves the abort reason", async (t) => {
  const { storage } = await setup(t);
  const controller = new AbortController();
  const reason = new Error("Cancelled by user");
  await assert.rejects(
    prepareLocalModel("org/model", storage, {
      provider: "cpu",
      signal: controller.signal,
      run: async (_command, args = []) => {
        await writeFile(join(args[5]!, "genai_config.json"), "{}");
        controller.abort(reason);
      },
    }),
    (error) => error === reason,
  );
  assert.deepEqual(await readdir(storage), []);
  await assert.rejects(
    prepareLocalModel("org/model", storage, {
      provider: "cpu",
      signal: controller.signal,
      run: async () => assert.fail("Already cancelled"),
    }),
    (error) => error === reason,
  );
});

test("invalid sources and NPU checkpoint exports fail before invoking Python", async (t) => {
  const { model, storage, root } = await setup(t);
  const run = async () => assert.fail("Invalid sources must not invoke Python");
  await assert.rejects(
    prepareLocalModel(join(root, "missing"), storage, { provider: "cpu", run }),
    /does not exist/,
  );
  await assert.rejects(
    prepareLocalModel(model, storage, { provider: "cpu", run }),
    /checkpoint directory with config.json/,
  );
  await writeFile(join(model, "config.json"), "[]");
  await assert.rejects(
    prepareLocalModel(model, storage, { provider: "cpu", run }),
    /must contain a JSON object/,
  );
  await assert.rejects(
    prepareLocalModel(join(model, "config.json"), storage, {
      provider: "cpu",
      run,
    }),
    /must contain a JSON object/,
  );
  await assert.rejects(
    prepareLocalModel("org/model", storage, { provider: "npu", run }),
    /prebuilt GenAI model/,
  );
});
