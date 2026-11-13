import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import type { ApplicationState } from "../src/application";
import type { GitHubUpdate } from "../src/github";
import { postMortemHash } from "../src/postmortem";
import { ConversationRenderer, renderApplication } from "../src/render";

const root = join(__dirname, "../..");
const output = join(root, "docs/images");
const origin = "https://arranged-agents.invalid";
const theme = `
:root {
  color-scheme: dark;
  --vscode-font-family: Arial, sans-serif;
  --vscode-font-size: 14px;
  --vscode-editor-font-family: monospace;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-foreground: #d4d4d4;
  --vscode-editor-background: #1e1e1e;
  --vscode-sideBar-background: #252526;
  --vscode-panel-border: #454545;
  --vscode-descriptionForeground: #b0b0b0;
  --vscode-focusBorder: #007fd4;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-list-activeSelectionBackground: #094771;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #555555;
  --vscode-textLink-foreground: #4daafc;
  --vscode-textLink-activeForeground: #80c4ff;
  --vscode-textCodeBlock-background: #282828;
  --vscode-textBlockQuote-background: #252b31;
  --vscode-textBlockQuote-border: #007acc;
  --vscode-errorForeground: #f48771;
  --vscode-progressBar-background: #0078d4;
  --vscode-menu-background: #252526;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-selectionBackground: #094771;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-widget-shadow: #00000066;
}`;

const state: ApplicationState = {
  root: "/projects",
  activeId: "arranged-agents",
  repositories: [
    {
      id: "arranged-agents",
      name: "arranged-agents",
      path: "/projects/arranged-agents",
      status: "ready",
      sessionCount: 3,
      generatedTokens: 2840,
    },
    {
      id: "sample-api",
      name: "sample-api",
      path: "/projects/sample-api",
      status: "busy",
    },
    {
      id: "sample-library",
      name: "sample-library",
      path: "/projects/sample-library",
      status: "saved",
      hasSavedSession: true,
      sessionCount: 1,
    },
    {
      id: "sample-website",
      name: "sample-website",
      path: "/projects/sample-website",
      status: "idle",
    },
  ],
  messages: [
    {
      role: "user",
      content:
        "Explain the workspace layout and show a small TypeScript example.",
    },
    {
      role: "tool",
      title: "Read file - completed",
      content: "src/render.ts",
      details: '{"tool":"view","path":"src/render.ts"}',
    },
    {
      role: "assistant",
      content: `## One workspace, independent sessions

Keep the conversation beside a shared sidebar for repositories, activity and logs.

| Panel | Purpose |
| --- | --- |
| Left | Copilot conversation, tools and approvals |
| Right | Repositories, GitHub activity and application logs |

### A small TypeScript example

\`\`\`typescript
const repositories = await discoverRepositories('/projects');
console.log(repositories.map(repository => repository.name));
\`\`\`

Equations render locally, too: $E = mc^2$.`,
    },
  ],
  draft: "",
  permissions: [],
  questions: [],
};

const activity: GitHubUpdate = {
  type: "github",
  id: "arranged-agents",
  section: "issues",
  status: "ready",
  append: false,
  page: {
    repository: "example/arranged-agents",
    items: [
      {
        id: "42",
        title: "#42 Document the workspace",
        url: "https://github.com/example/arranged-agents/issues/42",
        author: "demo-user",
        date: "2026-01-15T10:00:00Z",
        mine: true,
        replied: true,
        afterMe: true,
      },
      {
        id: "38",
        title: "#38 Preserve repository drafts",
        url: "https://github.com/example/arranged-agents/issues/38",
        author: "demo-contributor",
        date: "2026-01-14T09:00:00Z",
        mine: false,
        replied: true,
        afterMe: false,
      },
    ],
  },
};

async function main(): Promise<void> {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const resources = new Map([
      [
        "/",
        renderApplication({
          cspSource: origin,
          scriptUri: `${origin}/webview.js`,
          styleUri: `${origin}/app.css`,
        }),
      ],
      [
        "/app.css",
        `${await readFile(join(root, "media/app.css"), "utf8")}\n${theme}`,
      ],
      [
        "/webview.js",
        await readFile(join(__dirname, "../src/webview.js"), "utf8"),
      ],
    ]);
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const body =
        url.origin === origin ? resources.get(url.pathname) : undefined;
      assert.notEqual(body, undefined, `Unexpected screenshot request: ${url}`);
      await route.fulfill({
        body,
        contentType: url.pathname.endsWith(".css")
          ? "text/css"
          : url.pathname.endsWith(".js")
            ? "text/javascript"
            : "text/html",
      });
    });
    await page.addInitScript(() => {
      Object.defineProperty(window, "acquireVsCodeApi", {
        value: () => ({
          postMessage: (message: unknown) =>
            window.dispatchEvent(
              new CustomEvent("demo-message", { detail: message }),
            ),
        }),
      });
    });
    await page.goto(origin);
    const renderer = new ConversationRenderer();
    const publish = async () => {
      await page.evaluate(
        (data) => {
          window.dispatchEvent(new MessageEvent("message", { data }));
        },
        {
          type: "state",
          state: {
            ...state,
            messages: renderer.render(state.activeId, state.messages),
          },
        },
      );
      await page.evaluate((data) => {
        window.dispatchEvent(new MessageEvent("message", { data }));
      }, activity);
    };
    const capture = async (
      name: string,
      selector?: string,
      bottomSelector?: string,
    ) => {
      const options = {
        path: join(output, `${name}.png`),
        animations: "disabled" as const,
      };
      if (selector && bottomSelector) {
        const bounds = await page.locator(selector).boundingBox();
        const bottom = await page.locator(bottomSelector).boundingBox();
        assert.ok(bounds);
        assert.ok(bottom);
        await page.screenshot({
          ...options,
          clip: { ...bounds, height: bottom.y + bottom.height - bounds.y + 16 },
        });
      } else if (selector) await page.locator(selector).screenshot(options);
      else await page.screenshot(options);
      assert.deepEqual(
        errors,
        [],
        "Screenshot webview must run without errors",
      );
      console.log(`Captured ${name}.png`);
    };
    await publish();
    const bounds = await page.locator("#right-divider").boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, 400);
    await page.mouse.down();
    await page.mouse.move(1370, 400);
    await page.mouse.up();
    await capture("workspace");
    await page.locator('#right-tabs [data-view="activity"]').click();
    await capture("github-activity", "#activity-view", "#github-items");
    await page.locator('#right-tabs [data-view="repositories"]').click();
    await capture("conversations", "#chat-panel");
    await page
      .locator('[data-repository-id="arranged-agents"]')
      .press("Shift+F10");
    await capture(
      "sessions",
      "#repository-panel",
      "#repository-view .repository-hint",
    );
    await page.keyboard.press("Escape");

    state.repositories[0]!.status = "busy";
    state.repositories[0]!.parallelCount = 1;
    state.repositories[0]!.queuedCount = 1;
    state.messages.push(
      {
        role: "user",
        content: "Check the documentation while the main task continues.",
        title: "Parallel request",
        agentId: "parallel-demo",
      },
      {
        role: "tool",
        content: "python -m sphinx -n -W -b html docs build/docs/html",
        title: "Parallel command - running",
        agentId: "parallel-demo",
      },
    );
    await publish();
    await capture("parallel-work", "#chat-panel");

    state.permissions = [
      {
        id: "demo-permission",
        repositoryId: "arranged-agents",
        kind: "shell",
        summary: "Publish the documentation commit",
        content: "git push origin docs-screenshots",
        details:
          "This command updates the remote repository and requires your approval.",
      },
    ];
    await publish();
    await page.locator("#permissions").waitFor({ state: "visible" });
    await capture("safeguards", "#chat-panel");

    state.permissions = [];
    state.repositories[0]!.status = "ready";
    state.repositories[0]!.parallelCount = 0;
    state.repositories[0]!.queuedCount = 0;
    state.messages = [
      { role: "user", content: "Build the feature documentation." },
      {
        role: "tool",
        title: "Command - completed",
        content:
          "python -m sphinx -n -W -b html docs build/docs/html\nbuild succeeded.",
      },
      {
        role: "assistant",
        content: "The feature documentation builds without warnings.",
      },
    ];
    state.postMortem = {
      version: 1,
      repository: state.repositories[0]!,
      generatedAt: "2026-01-15T10:30:00Z",
      sourceCount: state.messages.length,
      sourceHash: postMortemHash(state.messages),
      rows: [
        {
          phase: "Validation",
          objective: "Build feature documentation",
          production: "Generated Sphinx HTML",
          filesAndCommits: "docs/features/",
          validation: "Strict Sphinx build succeeded",
          errors: "None reported",
          firstMessage: 1,
          lastMessage: 3,
        },
      ],
    };
    await publish();
    await page.locator("#postmortem-report").waitFor({ state: "visible" });
    await capture("postmortem", "#postmortem-report");
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
