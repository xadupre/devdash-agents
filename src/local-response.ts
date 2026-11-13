import { LOCAL_TOOL_MARKERS } from "./local-tools";

/** Separates model framing and reasoning from executable assistant output. */
export class LocalResponse {
  private pending = "";
  private phase:
    "prefix" | "think" | "header" | "body" | "answer" | "next" | "done" =
    "prefix";
  private channel = "final";
  private recipient?: string;
  private toolBody = "";
  private commentaryBody = "";
  private toolComplete = false;
  private payloadStart = true;
  private toolClose?: string;
  private jsonDepth = 0;
  private jsonString = false;
  private jsonEscape = false;

  constructor(
    private readonly answer: (text: string) => void,
    private readonly reasoning: (text: string) => void,
    private readonly commentary?: (text: string) => void,
  ) {}

  receive(text: string): void {
    this.pending += text;
    for (;;) {
      if (this.phase === "done") {
        if (this.pending.trim())
          throw new Error("Unexpected text after the local model response.");
        return;
      }
      if (this.phase === "prefix" || this.phase === "next") {
        const trimmed = this.pending.trimStart();
        const prefixes = [
          "<think>",
          "<|start|>assistant",
          "<|meta_sep|>",
          "<|channel|>",
        ];
        const prefix = prefixes.find((value) => trimmed.startsWith(value));
        if (prefix) {
          this.pending = trimmed.slice(prefix.length);
          this.phase = prefix === "<think>" ? "think" : "header";
          if (prefix === "<|meta_sep|>" || prefix === "<|channel|>")
            this.pending = prefix + this.pending;
          continue;
        }
        if (prefixes.some((value) => value.startsWith(trimmed))) return;
        if (this.phase === "next")
          throw new Error(
            "Expected an assistant message after local reasoning.",
          );
        this.phase = "answer";
        continue;
      }
      if (this.phase === "header") {
        const separator = ["<|im_sep|>", "<|message|>"]
          .filter((value) => this.pending.includes(value))
          .sort((a, b) => this.pending.indexOf(a) - this.pending.indexOf(b))[0];
        const end = separator ? this.pending.indexOf(separator) : -1;
        if (end === -1) return;
        const header = this.pending.slice(0, end);
        const match =
          /^(?: to=((?:functions\.)?[a-zA-Z_]\w*))?(?:<\|(?:meta_sep|channel)\|>(analysis|final|commentary)(?: to=((?:functions\.)?[a-zA-Z_]\w*))?)?(?:<\|(?:meta_start|constrain)\|>json)?$/.exec(
            header,
          );
        if (!match || (match[1] && match[3]))
          throw new Error("Unsupported local Harmony assistant header.");
        this.recipient = (match[1] ?? match[3])?.replace(/^functions\./, "");
        this.channel = match[2] ?? "final";
        this.pending = this.pending.slice(end + separator!.length);
        this.phase = "body";
        this.payloadStart = true;
        continue;
      }
      const markers =
        this.phase === "think"
          ? ["</think>"]
          : this.phase === "body"
            ? [
                "<|im_end|>",
                "<|end|>",
                "<|fim_suffix|>",
                "<|return|>",
                "<|ghissue|>",
                "<|call|>",
              ]
            : ["<|im_end|>", "<|endoftext|>", "<|fim_suffix|>", "<|return|>"];
      const { index, marker } = this.scan(markers);
      if (marker) {
        this.emit(this.pending.slice(0, index));
        this.pending = this.pending.slice(index + marker.length);
        if (this.phase === "think") this.phase = "answer";
        else if (this.phase === "body" && this.recipient) {
          if (!["<|ghissue|>", "<|call|>"].includes(marker))
            throw new Error(
              "Local Harmony tool request did not end with a handoff.",
            );
          this.toolComplete = true;
          this.phase = "done";
        } else if (this.phase === "body" && this.channel === "commentary") {
          if (["<|ghissue|>", "<|call|>"].includes(marker))
            throw new Error("Local Harmony handoff has no tool recipient.");
          if (["<|im_end|>", "<|end|>"].includes(marker)) {
            this.commentary?.(this.commentaryBody);
            this.phase = "next";
          } else {
            this.answer(this.commentaryBody);
            this.phase = "done";
          }
          this.commentaryBody = "";
        } else if (
          this.phase === "body" &&
          this.channel === "analysis" &&
          ["<|im_end|>", "<|end|>"].includes(marker)
        )
          this.phase = "next";
        else {
          if (
            ["<|ghissue|>", "<|call|>"].includes(marker) ||
            (this.phase === "body" && this.channel === "analysis")
          )
            throw new Error(
              "Incomplete local Harmony reasoning or tool request.",
            );
          this.phase = "done";
        }
        continue;
      }
      this.emit(this.pending.slice(0, index));
      this.pending = this.pending.slice(index);
      return;
    }
  }

  finish(): void {
    if (this.phase === "think")
      throw new Error(
        "The local model response ended before closing its <think> block.",
      );
    if (
      this.phase === "header" ||
      this.phase === "next" ||
      this.phase === "body"
    )
      throw new Error(
        "The local model response ended inside a Harmony message.",
      );
    if (this.toolComplete) {
      this.answer(
        JSON.stringify({
          name: this.recipient,
          arguments: JSON.parse(this.toolBody) as unknown,
        }),
      );
    } else if (this.phase !== "done") this.emit(this.pending);
    this.pending = "";
  }

  private scan(markers: string[]): { index: number; marker?: string } {
    const protectPayload =
      this.phase === "answer" ||
      (this.phase === "body" &&
        (this.recipient !== undefined || this.channel !== "analysis"));
    let index = 0;
    while (index < this.pending.length) {
      const character = this.pending[index]!;
      if (protectPayload && this.jsonString) {
        if (this.jsonEscape) this.jsonEscape = false;
        else if (character === "\\") this.jsonEscape = true;
        else if (character === '"') this.jsonString = false;
      } else {
        if (character === "<") {
          const tokens =
            protectPayload && this.toolClose
              ? [this.toolClose]
              : [
                  ...markers,
                  ...(protectPayload && this.payloadStart
                    ? LOCAL_TOOL_MARKERS.map(([open]) => open)
                    : []),
                ];
          const token = tokens.find((value) =>
            this.pending.startsWith(value, index),
          );
          if (token) {
            if (markers.includes(token)) return { index, marker: token };
            const envelope = LOCAL_TOOL_MARKERS.find(
              ([open]) => open === token,
            );
            this.toolClose = envelope?.[1];
            this.payloadStart = envelope !== undefined;
            index += token.length;
            continue;
          }
          // Retain a possible delimiter prefix until the next chunk.
          const remaining = this.pending.length - index;
          if (
            tokens.some(
              (value) =>
                remaining < value.length &&
                this.pending.slice(index) === value.slice(0, remaining),
            )
          )
            return { index };
        }
        if (protectPayload) {
          if (this.payloadStart && !/\s/.test(character)) {
            this.payloadStart = false;
            if (character === "{") this.jsonDepth = 1;
          } else if (this.jsonDepth > 0) {
            if (character === '"') this.jsonString = true;
            else if (character === "{" || character === "[") this.jsonDepth++;
            else if (character === "}" || character === "]") {
              this.jsonDepth--;
              if (this.jsonDepth === 0) this.toolClose = undefined;
            }
          }
        }
      }
      index++;
    }
    return { index };
  }

  private emit(text: string): void {
    if (!text) return;
    if (this.phase === "think") this.reasoning(text);
    else if (this.phase === "body" && this.recipient) this.toolBody += text;
    else if (this.phase === "body" && this.channel === "analysis")
      this.reasoning(text);
    else if (this.phase === "body" && this.channel === "commentary")
      this.commentaryBody += text;
    else this.answer(text);
  }
}
