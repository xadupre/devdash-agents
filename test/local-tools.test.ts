import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LocalConversation } from "../src/local-conversation";
import {
  executeLocalTool,
  MAX_LOCAL_TOOL_CALLS,
  parseLocalToolCall,
  type LocalToolCall,
  type LocalToolHost,
} from "../src/local-tools";

const response = (call: unknown): string =>
  `<arranged_tool_call>${JSON.stringify(call)}</arranged_tool_call>`;

async function repository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arranged-local-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function worker(
  generate: (
    messages: Parameters<
      ConstructorParameters<typeof LocalConversation>[0]["generateChat"]
    >[0],
    onToken: (text: string) => void,
  ) => void,
) {
  return {
    load: async () => ({ provider: "cpu" as const, deviceId: 0, name: "CPU" }),
    generateChat: async (
      messages: Parameters<
        ConstructorParameters<typeof LocalConversation>[0]["generateChat"]
      >[0],
      onToken: (text: string) => void,
    ) => generate(messages, onToken),
    stop: async () => {},
  };
}

function host(
  repositoryPath: string,
  ask: LocalToolHost["requestPermission"],
): LocalToolHost {
  return { repositoryPath, requestPermission: ask };
}

test("read-only local sessions can inspect files but cannot edit or execute commands", async (t) => {
  const root = await repository(t);
  const path = join(root, "notes.txt");
  await writeFile(path, "old content");
  let canEdit = false;
  let approvals = 0;
  const tools: LocalToolHost = {
    repositoryPath: root,
    canEdit: () => canEdit,
    requestPermission: async () => {
      approvals++;
      return true;
    },
  };
  const signal = new AbortController().signal;
  assert.match(
    await executeLocalTool(
      { name: "read_file", arguments: { path: "notes.txt" } },
      tools,
      signal,
    ),
    /old content/,
  );
  assert.match(
    await executeLocalTool(
      { name: "search_files", arguments: { query: "old content" } },
      tools,
      signal,
    ),
    /notes.txt/,
  );
  const edit: LocalToolCall = {
    name: "edit_file",
    arguments: { path: "notes.txt", oldText: "old", newText: "new" },
  };
  await assert.rejects(executeLocalTool(edit, tools, signal), /read-only/);
  await assert.rejects(
    executeLocalTool(
      {
        name: "run_command",
        arguments: { program: process.execPath, args: ["--version"] },
      },
      tools,
      signal,
    ),
    /read-only/,
  );
  assert.equal(approvals, 0);
  assert.equal(await readFile(path, "utf8"), "old content");
  canEdit = true;
  await executeLocalTool(edit, tools, signal);
  assert.equal(await readFile(path, "utf8"), "new content");
  assert.equal(approvals, 1);
});

test("editing eligibility is checked again after permission approval", async (t) => {
  const root = await repository(t);
  const path = join(root, "notes.txt");
  await writeFile(path, "old content");
  let canEdit = true;
  const tools: LocalToolHost = {
    repositoryPath: root,
    canEdit: () => canEdit,
    requestPermission: async () => {
      canEdit = false;
      return true;
    },
  };
  await assert.rejects(
    executeLocalTool(
      {
        name: "edit_file",
        arguments: { path: "notes.txt", oldText: "old", newText: "new" },
      },
      tools,
      new AbortController().signal,
    ),
    /read-only/,
  );
  assert.equal(await readFile(path, "utf8"), "old content");
});

test("local tool requests require exact JSON schemas and reject malformed calls", () => {
  assert.deepEqual(
    parseLocalToolCall(
      response({ name: "read_file", arguments: { path: "src/app.ts" } }),
    ),
    { name: "read_file", arguments: { path: "src/app.ts" } },
  );
  assert.equal(parseLocalToolCall("A normal answer."), undefined);
  assert.equal(parseLocalToolCall('{"answer":42}'), undefined);
  assert.deepEqual(
    parseLocalToolCall('{"name":"read_file","arguments":{"path":"README.md"}}'),
    { name: "read_file", arguments: { path: "README.md" } },
  );
  assert.deepEqual(
    parseLocalToolCall(
      '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
    ),
    { name: "read_file", arguments: { path: "README.md" } },
  );
  for (const text of [
    "<arranged_tool_call>{bad}</arranged_tool_call>",
    "<arranged_tool_call>",
    "</arranged_tool_call>",
    "<tool_call>",
    "</tool_call>",
    '{"name":"read_file","arguments":{"path":"README.md"},"extra":true}',
    '{"name":"unsupported","arguments":{}}',
    '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</arranged_tool_call>',
    response({ name: "read_file", arguments: { path: "a", extra: true } }),
    response({ name: "unsupported", arguments: {} }),
    response({
      name: "run_command",
      arguments: { program: "node", args: ["x"], shell: true },
    }),
  ]) {
    assert.throws(() => parseLocalToolCall(text));
  }
});

test("local tool envelopes can omit one tag but must still contain exactly one valid call", () => {
  const json = '{"name":"read_file","arguments":{"path":"README.md"}}';
  for (const [open, close] of [
    ["<tool_call>", "</tool_call>"],
    ["<arranged_tool_call>", "</arranged_tool_call>"],
  ]) {
    for (const text of [open + json, json + close, open + json + close]) {
      assert.deepEqual(parseLocalToolCall(text), {
        name: "read_file",
        arguments: { path: "README.md" },
      });
    }
    for (const text of [
      open + json + json,
      json + close + close,
      open + json + "\nExplanation.",
      "Example:\n" + json + close,
      open + '{"name":"read_file","arguments":{"path":"README.md",}}',
    ])
      assert.throws(
        () => parseLocalToolCall(text),
        /Malformed local tool request/,
      );
  }
});

test("Qwen3.8 and Nemotron XML parameters use the existing exact tool schemas", () => {
  const xml = (body: string) => `<tool_call>\n${body}\n</tool_call>`;
  assert.deepEqual(
    parseLocalToolCall(
      xml(
        "<function=read_file>\n<parameter=path>\nREADME.md\n</parameter>\n</function>",
      ),
    ),
    { name: "read_file", arguments: { path: "README.md" } },
  );
  assert.deepEqual(
    parseLocalToolCall(
      xml(
        '<function=run_command><parameter=program>node</parameter><parameter=args>["--version"]</parameter></function>',
      ),
    ),
    {
      name: "run_command",
      arguments: { program: "node", args: ["--version"] },
    },
  );
  assert.deepEqual(
    parseLocalToolCall(
      xml(
        "<function=edit_file><parameter=path>notes.txt</parameter><parameter=oldText>\n  old\ntext\n\n</parameter><parameter=newText></parameter></function>",
      ),
    ),
    {
      name: "edit_file",
      arguments: { path: "notes.txt", oldText: "  old\ntext\n", newText: "" },
    },
  );
  for (const body of [
    "<function=read_file><parameter=path>a</parameter><parameter=path>b</parameter></function>",
    "<function=read_file><parameter=path>a</parameter><parameter=extra>x</parameter></function>",
    "<function=read_file><parameter=path>a</parameter>",
    "<function=read_file><parameter=path>a</parameter></function>prose",
    "<function=read_file><parameter=path>a</parameter></function><function=read_file></function>",
    "<function=read_file><parameter=__proto__>x</parameter></function>",
    "<function=unsupported></function>",
    '<function=run_command><parameter=program>node</parameter><parameter=args>"--version"</parameter></function>',
  ])
    assert.throws(() => parseLocalToolCall(xml(body)));
  const fn =
    "<function=read_file><parameter=path>README.md</parameter></function>";
  for (const text of [`<tool_call>${fn}`, `${fn}</tool_call>`])
    assert.throws(() => parseLocalToolCall(text), /Malformed local XML/);
});

test("repository reads are confined and edits require explicit approval", async (t) => {
  const root = await repository(t);
  const file = join(root, "notes.txt");
  await writeFile(file, "before\n");
  const requests: string[] = [];
  let approve = false;
  const permissions = host(root, async (description) => {
    requests.push(description.kind);
    assert.equal(description.source, "Local model");
    return approve;
  });

  assert.equal(
    await executeLocalTool(
      { name: "read_file", arguments: { path: "notes.txt" } },
      permissions,
      new AbortController().signal,
    ),
    "before\n",
  );
  assert.match(
    await executeLocalTool(
      { name: "search_files", arguments: { query: "before" } },
      permissions,
      new AbortController().signal,
    ),
    /notes\.txt:1: before/,
  );
  await assert.rejects(
    executeLocalTool(
      { name: "read_file", arguments: { path: "../outside.txt" } },
      permissions,
      new AbortController().signal,
    ),
    /inside the repository/,
  );

  const edit: LocalToolCall = {
    name: "edit_file",
    arguments: { path: "notes.txt", oldText: "before", newText: "after" },
  };
  await assert.rejects(
    executeLocalTool(edit, permissions, new AbortController().signal),
    /Permission denied/,
  );
  assert.equal(await readFile(file, "utf8"), "before\n");
  approve = true;
  assert.match(
    await executeLocalTool(edit, permissions, new AbortController().signal),
    /Updated/,
  );
  assert.equal(await readFile(file, "utf8"), "after\n");
  assert.deepEqual(requests, ["write", "write"]);
});

test("local search preserves line boundaries and reports each matching line once", async (t) => {
  const root = await repository(t);
  await writeFile(
    join(root, "notes.txt"),
    "needle one needle\r\nmiss\nneedle two\r\nlast needle",
  );
  const permissions = host(root, async () => false);
  const signal = new AbortController().signal;
  assert.equal(
    await executeLocalTool(
      { name: "search_files", arguments: { query: "needle" } },
      permissions,
      signal,
    ),
    [
      "notes.txt:1: needle one needle",
      "notes.txt:3: needle two",
      "notes.txt:4: last needle",
    ].join("\n"),
  );
  assert.match(
    await executeLocalTool(
      { name: "search_files", arguments: { query: "needle\r\nmiss" } },
      permissions,
      signal,
    ),
    /^No matches/,
  );
});

test("an edit does not overwrite a replacement file after approval", async (t) => {
  const root = await repository(t);
  const file = join(root, "notes.txt");
  await writeFile(file, "before\n");
  const permissions = host(root, async () => {
    await rename(file, join(root, "original.txt"));
    await writeFile(file, "before\n");
    return true;
  });
  await assert.rejects(
    executeLocalTool(
      {
        name: "edit_file",
        arguments: { path: "notes.txt", oldText: "before", newText: "after" },
      },
      permissions,
      new AbortController().signal,
    ),
    /File changed while awaiting approval/,
  );
  assert.equal(await readFile(file, "utf8"), "before\n");
});

test(
  "an edit cannot follow a symlink introduced while awaiting approval",
  { skip: process.platform === "win32" },
  async (t) => {
    const parent = await repository(t);
    const root = join(parent, "workspace");
    await mkdir(root);
    const file = join(root, "notes.txt");
    const outside = join(parent, "outside.txt");
    await writeFile(file, "before\n");
    await writeFile(outside, "before\n");
    const permissions = host(root, async () => {
      await rename(file, join(root, "original.txt"));
      await symlink(outside, file);
      return true;
    });
    await assert.rejects(
      executeLocalTool(
        {
          name: "edit_file",
          arguments: { path: "notes.txt", oldText: "before", newText: "after" },
        },
        permissions,
        new AbortController().signal,
      ),
      /File changed while awaiting approval|symbolic links/,
    );
    assert.equal(await readFile(outside, "utf8"), "before\n");
  },
);

test("edits reject non-UTF-8 files without changing their bytes", async (t) => {
  const root = await repository(t);
  const file = join(root, "notes.txt");
  const original = Buffer.concat([
    Buffer.from([0xff]),
    Buffer.from("before\n"),
  ]);
  await writeFile(file, original);
  await assert.rejects(
    executeLocalTool(
      {
        name: "edit_file",
        arguments: { path: "notes.txt", oldText: "before", newText: "after" },
      },
      host(root, async () => true),
      new AbortController().signal,
    ),
    /valid UTF-8/,
  );
  assert.deepEqual(await readFile(file), original);
});

test("local commands require approval and disclose that they are not sandboxed", async (t) => {
  const root = await repository(t);
  const marker = join(root, "ran.txt");
  const tool: LocalToolCall = {
    name: "run_command",
    arguments: {
      program: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ],
    },
  };
  let approved = false;
  let permissionContent = "";
  const permissions = host(root, async (description) => {
    permissionContent = description.content;
    return approved;
  });
  await assert.rejects(
    executeLocalTool(tool, permissions, new AbortController().signal),
    /Permission denied/,
  );
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.match(permissionContent, /not sandboxed/i);

  approved = true;
  assert.match(
    await executeLocalTool(tool, permissions, new AbortController().signal),
    /Command completed/,
  );
  assert.equal(await readFile(marker, "utf8"), "ran");
});

test("local conversation surfaces tool results and stops at the bounded tool loop", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "notes.txt"), "needle\n");
  const call = response({
    name: "search_files",
    arguments: { query: "needle" },
  });
  let generations = 0;
  const events: string[] = [];
  const conversation = new LocalConversation(
    worker((_messages, onToken) => {
      generations++;
      onToken(call);
    }),
    "/model",
    "cpu",
    0,
    host(root, async () => false),
  );
  await conversation.start(new AbortController().signal, (event) =>
    events.push(event.type),
  );
  await assert.rejects(
    conversation.send("Find needle", new AbortController().signal),
    new RegExp(`${MAX_LOCAL_TOOL_CALLS}-call tool limit`),
  );
  assert.equal(generations, MAX_LOCAL_TOOL_CALLS + 1);
  assert.equal(
    events.filter((event) => event === "tool.execution_start").length,
    MAX_LOCAL_TOOL_CALLS,
  );
  await conversation.dispose();
});

test("local conversation streams the buffered prefix of ordinary responses", async () => {
  const chunks: string[] = [];
  const conversation = new LocalConversation(
    worker((_messages, onToken) => {
      onToken("  ");
      onToken("<");
      onToken("note>");
    }),
    "/model",
  );
  await conversation.start(new AbortController().signal, (event) => {
    if (event.type === "assistant.message_delta")
      chunks.push(event.data.deltaContent);
  });
  assert.equal(
    await conversation.send("hello", new AbortController().signal),
    "  <note>",
  );
  assert.equal(chunks.join(""), "  <note>");
  await conversation.dispose();
});

test("Qwen reasoning is streamed separately before a validated tool call, regardless of token boundaries", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "README.md"), "Real README contents\n");
  const call =
    '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>';
  const thought = `I should read the file, not execute this example: ${response({ name: "run_command", arguments: { program: "never", args: [] } })}`;
  const toolResponse = ` \n<think>${thought}</think>\n\n${call}`;
  for (const chunkSize of [1, 3, 17, toolResponse.length]) {
    const reasoning: string[] = [];
    const answer: string[] = [];
    let executions = 0;
    let generations = 0;
    const conversation = new LocalConversation(
      worker((messages, onToken) => {
        assert.match(
          messages[0]!.content,
          /Repository root entries.*README\.md/,
        );
        const content =
          generations++ === 0
            ? toolResponse
            : "<think>The tool confirmed the contents.</think>Read successfully.";
        if (generations === 2) {
          assert.match(
            messages.at(-1)!.content,
            /Result for read_file:\nReal README contents/,
          );
        }
        for (let index = 0; index < content.length; index += chunkSize)
          onToken(content.slice(index, index + chunkSize));
      }),
      "/model",
      "cpu",
      0,
      host(root, async () => {
        assert.fail("A repository read must not request command approval.");
      }),
    );
    await conversation.start(new AbortController().signal, (event) => {
      if (event.type === "assistant.reasoning_delta")
        reasoning.push(event.data.deltaContent);
      if (event.type === "assistant.message_delta")
        answer.push(event.data.deltaContent);
      if (event.type === "tool.execution_start") {
        assert.equal(event.data.toolName, "read_file");
        executions++;
      }
    });
    assert.equal(
      await conversation.send("lit README", new AbortController().signal),
      "Read successfully.",
    );
    assert.equal(executions, 1);
    assert.equal(
      reasoning.join(""),
      thought + "The tool confirmed the contents.",
    );
    assert.equal(answer.join(""), "Read successfully.");
    await conversation.dispose();
  }
});

test("XML and Harmony tool cycles read real files and retain command approval", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "README.md"), "Real contents");
  for (const format of ["xml", "harmony"]) {
    let generation = 0;
    let approvals = 0;
    const answers: string[] = [];
    const conversation = new LocalConversation(
      worker((messages, onToken) => {
        generation++;
        if (generation === 2)
          assert.match(messages.at(-1)!.content, /Real contents/);
        if (generation === 3)
          assert.match(messages.at(-1)!.content, /Permission denied/);
        const content =
          generation === 1
            ? format === "xml"
              ? "<think>\nread</think><tool_call>\n<function=read_file>\n<parameter=path>\nREADME.md\n</parameter>\n</function>\n</tool_call><|im_end|>"
              : '<|channel|>commentary<|message|>Reading.<|end|><|start|>assistant to=functions.read_file<|channel|>commentary<|message|>{"path":"README.md"}<|call|>'
            : generation === 2
              ? format === "xml"
                ? '<think>ask</think><tool_call><function=run_command><parameter=program>node</parameter><parameter=args>["--version"]</parameter></function></tool_call>'
                : '<|start|>assistant to=run_command<|meta_sep|>commentary<|im_sep|>{"program":"node","args":["--version"]}<|ghissue|>'
              : format === "xml"
                ? "<think>done</think>Finished.<|im_end|>"
                : "<|channel|>final<|message|>Finished.<|return|>";
        for (const token of content) onToken(token);
      }),
      "/model",
      "cpu",
      0,
      host(root, async (permission) => {
        approvals++;
        assert.match(permission.content, /not sandboxed/i);
        return false;
      }),
    );
    await conversation.start(new AbortController().signal, (event) => {
      if (event.type === "assistant.message_delta")
        answers.push(event.data.deltaContent);
    });
    assert.equal(
      await conversation.send("read and run", new AbortController().signal),
      "Finished.",
    );
    assert.equal(generation, 3);
    assert.equal(approvals, 1);
    assert.equal(
      answers.join(""),
      format === "xml" ? "Finished." : "Reading.Finished.",
    );
    await conversation.dispose();
  }
});

test("invalid streamed framing rejects the turn without throwing into the worker callback", async () => {
  let generation = 0;
  const conversation = new LocalConversation(
    worker((_messages, onToken) => {
      assert.doesNotThrow(() =>
        onToken(
          generation++ === 0
            ? "<|channel|>invalid<|message|>not an answer"
            : "Recovered.",
        ),
      );
    }),
    "/model",
  );
  await conversation.start(new AbortController().signal);
  await assert.rejects(
    conversation.send("hello", new AbortController().signal),
    /Unsupported local Harmony/,
  );
  assert.equal(
    await conversation.send("retry", new AbortController().signal),
    "Recovered.",
  );
  await conversation.dispose();
});

test("unfinished reasoning and invalid tool requests after reasoning never execute tools", async (t) => {
  const root = await repository(t);
  for (const content of [
    '<think>still thinking <arranged_tool_call>{"name":"run_command"}',
    '<think>done</think><arranged_tool_call>{"name":"unsupported","arguments":{}}</arranged_tool_call>',
    `<think>done</think>prose ${response({ name: "read_file", arguments: { path: "README.md" } })}`,
  ]) {
    let executions = 0;
    const conversation = new LocalConversation(
      worker((_messages, onToken) => onToken(content)),
      "/model",
      "cpu",
      0,
      host(root, async () => assert.fail("No tool should run.")),
    );
    await conversation.start(new AbortController().signal, (event) => {
      if (event.type === "tool.execution_start") executions++;
    });
    await assert.rejects(
      conversation.send("lit README", new AbortController().signal),
      /before closing|unsupported tool|Malformed local tool request/,
    );
    assert.equal(executions, 0);
    await conversation.dispose();
  }
});

test("bare JSON calls are validated, withheld from assistant text, and followed by a normal JSON answer", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "README.md"), "contents");
  let generation = 0;
  const deltas: string[] = [];
  let executions = 0;
  const conversation = new LocalConversation(
    worker((_messages, onToken) => {
      const content =
        generation++ === 0
          ? '{"name":"read_file","arguments":{"path":"README.md"}}'
          : '{"answer":"contents"}';
      for (const token of content) onToken(token);
    }),
    "/model",
    "cpu",
    0,
    host(root, async () => assert.fail("Read must not ask for approval.")),
  );
  await conversation.start(new AbortController().signal, (event) => {
    if (event.type === "assistant.message_delta")
      deltas.push(event.data.deltaContent);
    if (event.type === "tool.execution_start") executions++;
  });
  assert.equal(
    await conversation.send("read README", new AbortController().signal),
    '{"answer":"contents"}',
  );
  assert.equal(executions, 1);
  assert.doesNotMatch(deltas.join(""), /read_file/);
  await conversation.dispose();
});

test("a malformed call is reported and corrected once without bypassing validation", async (t) => {
  const root = await repository(t);
  await writeFile(join(root, "README.md"), "contents");
  let generation = 0;
  let executions = 0;
  const info: string[] = [];
  const conversation = new LocalConversation(
    worker((messages, onToken) => {
      generation++;
      if (generation === 1) {
        onToken(
          '<tool_call>{"name":"read_file","arguments":{"path":"README.md",}}</tool_call>',
        );
      } else if (generation === 2) {
        assert.match(messages.at(-1)!.content, /Tool request rejected/);
        onToken(
          '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
        );
      } else {
        assert.match(
          messages.at(-1)!.content,
          /<tool_response>.*\nResult for read_file:\ncontents/,
        );
        onToken("Read successfully.");
      }
    }),
    "/model",
    "cpu",
    0,
    host(root, async () => assert.fail("Read must not ask for approval.")),
  );
  await conversation.start(new AbortController().signal, (event) => {
    if (event.type === "tool.execution_start") executions++;
    if (event.type === "session.info") info.push(event.data.message);
  });
  assert.equal(
    await conversation.send("read README", new AbortController().signal),
    "Read successfully.",
  );
  assert.equal(executions, 1);
  const rejected = info.filter((message) =>
    message.includes("request rejected"),
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!, /Model response \(not executed\)/);
  assert.match(rejected[0]!, /"path":"README\.md",}/);
  await conversation.dispose();
});

test("repeated invalid tool requests expose a bounded model response without executing", async (t) => {
  const root = await repository(t);
  const invalid =
    '<tool_call>{"name":"read_file","arguments":' + "x".repeat(3000);
  const events: string[] = [];
  let generations = 0;
  const conversation = new LocalConversation(
    worker((_messages, onToken) => {
      generations++;
      onToken(invalid);
    }),
    "/model",
    "cpu",
    0,
    host(root, async () => assert.fail("Invalid calls must not execute.")),
  );
  await conversation.start(new AbortController().signal, (event) => {
    if (event.type === "tool.execution_start") events.push("executed");
    if (event.type === "session.info") events.push(event.data.message);
  });
  await assert.rejects(
    conversation.send("read README", new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Model response \(not executed\):\n<tool_call>/,
      );
      assert.match(error.message, /\[truncated\]/);
      assert.ok(error.message.length < 2400);
      return true;
    },
  );
  assert.equal(generations, 2);
  assert.ok(!events.includes("executed"));
  assert.equal(
    events.filter((event) => event.includes("request rejected")).length,
    2,
  );
  await conversation.dispose();
});

test("local generation limits include tool results and respect the model context", async () => {
  for (const contextLength of [4096, 40960]) {
    const conversation = new LocalConversation(
      {
        load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
        generateChat: async (_messages, onToken, _signal, maxLength) => {
          assert.equal(maxLength, Math.min(contextLength, 8192));
          onToken("answer");
        },
        stop: async () => {},
      },
      "/model",
      "cpu",
      0,
      undefined,
      { name: "model", sizeBytes: 1234, contextLength },
    );
    await conversation.start(new AbortController().signal);
    await conversation.send("hello", new AbortController().signal);
    await conversation.dispose();
  }
});

test("cancelling while a local tool awaits approval prevents the edit", async (t) => {
  const root = await repository(t);
  const file = join(root, "notes.txt");
  await writeFile(file, "before\n");
  const controller = new AbortController();
  let permissionRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    permissionRequested = resolve;
  });
  const conversation = new LocalConversation(
    worker((_messages, onToken) =>
      onToken(
        response({
          name: "edit_file",
          arguments: { path: "notes.txt", oldText: "before", newText: "after" },
        }),
      ),
    ),
    "/model",
    "cpu",
    0,
    host(root, (_description, signal) => {
      permissionRequested();
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(false), {
          once: true,
        });
      });
    }),
  );
  await conversation.start(new AbortController().signal);
  const sending = conversation.send("Edit notes", controller.signal);
  await requested;
  controller.abort();
  await assert.rejects(sending, { name: "AbortError" });
  assert.equal(await readFile(file, "utf8"), "before\n");
  await conversation.dispose();
});
