import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalResponse } from "../src/local-response";
import { parseLocalToolCall } from "../src/local-tools";

function decode(text: string, chunkSize: number) {
  let answer = "";
  let reasoning = "";
  const response = new LocalResponse(
    (chunk) => (answer += chunk),
    (chunk) => (reasoning += chunk),
  );
  for (let index = 0; index < text.length; index += chunkSize)
    response.receive(text.slice(index, index + chunkSize));
  response.finish();
  return { answer, reasoning };
}

test("local response framing works independently of token boundaries", () => {
  const thought =
    "Inspect <tool_call>examples</tool_call>, never execute them.";
  for (const [text, answer, reasoning] of [
    ["Plain <note>answer</note>", "Plain <note>answer</note>", ""],
    [" \n<think>thought</think>Answer<|im_end|>", "Answer", "thought"],
    ["<think>\n</think>Answer", "Answer", "\n"],
    [
      `<|meta_sep|>analysis<|im_sep|>${thought}<|im_end|><|start|>assistant<|meta_sep|>final<|im_sep|>Answer<|fim_suffix|>`,
      "Answer",
      thought,
    ],
    [
      `<|start|>assistant<|channel|>analysis<|message|>${thought}<|end|><|start|>assistant<|channel|>final<|message|>Answer<|return|>`,
      "Answer",
      thought,
    ],
    ["<|start|>assistant<|im_sep|>Answer<|fim_suffix|>", "Answer", ""],
    ["<|channel|>final<|message|>Answer<|return|>", "Answer", ""],
    ["<|channel|>commentary<|message|>Answer<|return|>", "Answer", ""],
    [
      "<|channel|>commentary<|message|>Working.<|end|><|start|>assistant<|channel|>final<|message|>Answer<|return|>",
      "Answer",
      "",
    ],
  ]) {
    for (let chunkSize = 1; chunkSize <= text!.length; chunkSize++)
      assert.deepEqual(decode(text!, chunkSize), { answer, reasoning });
  }
});

test("Harmony routing becomes one JSON tool request only after a complete handoff", () => {
  for (const text of [
    '<|start|>assistant to=read_file<|meta_sep|>commentary<|im_sep|>{"path":"README.md"}<|ghissue|>',
    '<|channel|>commentary to=functions.read_file<|constrain|>json<|message|>{"path":"README.md"}<|call|>',
    '<|start|>assistant to=functions.read_file<|channel|>analysis<|message|>{"path":"README.md"}<|call|>',
  ]) {
    for (let chunkSize = 1; chunkSize <= text.length; chunkSize++) {
      const { answer, reasoning } = decode(text, chunkSize);
      assert.deepEqual(JSON.parse(answer), {
        name: "read_file",
        arguments: { path: "README.md" },
      });
      assert.equal(reasoning, "");
    }
  }
});

test("framing tokens inside JSON and XML tool arguments remain literal", () => {
  for (const token of [
    "<|im_end|>",
    "<|endoftext|>",
    "<|fim_suffix|>",
    "<|return|>",
    "<|end|>",
    "<|ghissue|>",
    "<|call|>",
    "<|im_sep|>",
  ]) {
    const query = `Find "${token}" and \\escaped text`;
    const call = { name: "search_files", arguments: { query } };
    const json = JSON.stringify(call);
    for (const text of [
      `<tool_call>${json}</tool_call><|im_end|>`,
      `<devdash_tool_call>${json}</devdash_tool_call><|im_end|>`,
      `<tool_call>${json}<|im_end|>`,
      `${json}</tool_call><|im_end|>`,
      `${json}<|im_end|>`,
      `<tool_call><function=search_files><parameter=query>${query}</parameter></function></tool_call><|im_end|>`,
      `<|start|>assistant to=search_files<|message|>${JSON.stringify(call.arguments)}<|call|>`,
      `<|start|>assistant to=search_files<|channel|>analysis<|message|>${JSON.stringify(call.arguments)}<|call|>`,
      `<|channel|>final<|message|><tool_call>${json}</tool_call><|return|>`,
      `<|channel|>commentary<|message|>${json}<|return|>`,
    ]) {
      for (const chunkSize of [1, text.length]) {
        const { answer } = decode(text, chunkSize);
        assert.deepEqual(parseLocalToolCall(answer), call);
      }
    }
  }
});

test("truncated reasoning and malformed Harmony frames fail closed", () => {
  for (const text of [
    "<think>unfinished <tool_call>example</tool_call>",
    "<|start|>assistant",
    "<|channel|>analysis<|message|>unfinished",
    "<|channel|>analysis<|message|>unfinished<|return|>",
    "<|channel|>analysis<|message|>thought<|end|>",
    "<|channel|>commentary<|message|>unfinished",
    "<|channel|>unknown<|message|>answer<|return|>",
    "<|channel|>final<|message|>answer<|call|>",
    '<|start|>assistant to=read_file<|message|>{"path":"README.md"}',
    '<|start|>assistant to=read_file<|message|>{"path":"README.md"}<|return|>',
    "<|start|>assistant to=read_file<|message|>{bad}<|call|>",
    '<|start|>assistant to=search_files<|message|>{"query":"<|call|>',
    "<|start|>assistant to=read_file<|message|>{}<|call|>extra",
    "<|channel|>final<|message|>answer<|return|><|start|>user",
  ]) {
    for (const chunkSize of [1, text.length])
      assert.throws(() => decode(text, chunkSize), text);
  }
});
