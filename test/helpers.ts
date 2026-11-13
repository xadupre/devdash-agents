import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const testImage = {
  name: "pixel.png",
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0AAAAABJRU5ErkJggg==",
};

export async function waitForRequest(
  workingDirectory: string,
  method: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const log = await readFile(
        join(workingDirectory, "requests.jsonl"),
        "utf8",
      );
      if (log.includes(`"method":"${method}"`)) {
        return;
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await delay(10);
  }
  assert.fail(`The CLI never received ${method}.`);
}
