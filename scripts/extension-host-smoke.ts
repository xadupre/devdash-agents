import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("xadupre.arranged-agents");
  assert.ok(extension, "The packaged extension must be installed.");
  await extension.activate();
  assert.ok(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("arrangedAgents.ask"));
  assert.ok(commands.includes("arrangedAgents.open"));
  await vscode.commands.executeCommand("arrangedAgents.open");
  const appTabOpened = vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.label === "Arranged Agents"),
  );
  assert.ok(appTabOpened, "The application must open in an editor tab.");
  await writeFile(
    join(__dirname, "extension-host-smoke-result.json"),
    JSON.stringify({
      vscode: vscode.version,
      node: process.version,
      extensionPath: extension.extensionPath,
      activated: extension.isActive,
      commandRegistered: true,
      appTabOpened,
    }),
  );
}
