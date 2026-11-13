import assert from "node:assert/strict";
import { test } from "node:test";
import { contributes, version } from "../package.json";
import {
  ConversationRenderer,
  renderMarkdown,
  renderResult,
  renderText,
  renderApplication,
  renderGitHubDiscussion,
} from "../src/render";
import { describePermission, describeTool } from "../src/presentation";
import type { ChatMessage } from "../src/application";
import { isImageDataUrl, MAX_IMAGE_BYTES, parseImages } from "../src/images";
import { testImage } from "./helpers";

test("GitHub discussions render Markdown without executing issue or comment HTML", () => {
  const html = renderGitHubDiscussion({
    title: '#1 <img src=x onerror="alert(1)">',
    kind: "PullRequest",
    state: "<script>OPEN</script>",
    author: "<b>author</b>",
    date: "2026-01-01T12:00:00Z",
    url: "https://github.com/acme/project/pull/1",
    body: "**Description**\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))",
    comments: [
      {
        id: "comment",
        author: "Ada",
        date: "2026-01-02T12:00:00Z",
        url: "https://github.com/acme/project/pull/1#issuecomment-1",
        body: "## Reply\n\n<img src=x onerror=alert(1)>",
      },
    ],
  });
  assert.match(html, /<strong>Description<\/strong>/);
  assert.match(html, /<h2>Reply<\/h2>/);
  assert.match(html, /Comments \(1\)/);
  assert.doesNotMatch(html, /<script>|<img|href="javascript:/);
  assert.match(
    html,
    /href="https:\/\/github.com\/acme\/project\/pull\/1#issuecomment-1"/,
  );
});

test("the settings section shows the package version instead of the application header", () => {
  const html = renderApplication({
    cspSource: "https://webview.invalid",
    scriptUri: "https://webview.invalid/webview.js",
    styleUri: "https://webview.invalid/app.css",
  });
  assert.doesNotMatch(html, /app-version/);
  assert.equal(contributes.configuration.title, `DevDash Agents v${version}`);
});

test("cached conversation HTML follows edited content and roles while retaining fresh metadata and avoiding stale session entries", () => {
  const renderer = new ConversationRenderer();
  const messages: ChatMessage[] = [
    { role: "assistant", content: "**Answer**", title: "Draft" },
    { role: "tool", content: "npm test", details: "Pending" },
  ];
  const before = renderer.render("alpha", messages);
  messages[0]!.title = "Final";
  messages[1]!.details = "Completed";
  const metadata = renderer.render("alpha", messages);
  assert.equal(metadata[0]?.html, before[0]?.html);
  assert.equal(metadata[0]?.title, "Final");
  assert.equal(metadata[1]?.details, "Completed");
  messages[0]!.role = "tool";
  assert.equal(renderer.render("alpha", messages)[0]?.html, "**Answer**");
  messages[0]!.content = "<script>not executable</script>";
  assert.doesNotMatch(renderer.render("alpha", messages)[0]!.html, /<script>/);
  assert.equal(renderer.render("alpha", []).length, 0);
  assert.deepEqual(
    renderer.render("beta", [{ role: "assistant", content: "New session" }]),
    [
      {
        role: "assistant",
        content: "New session",
        html: renderMarkdown("New session"),
      },
    ],
  );
});

test("tool and approval summaries show readable commands, paths and warnings without JSON", () => {
  assert.equal(
    describeTool("read", { path: "README.md", viewRange: [1, 10] }),
    "Path: README.md\nView Range: 1\n10",
  );
  assert.equal(
    describeTool("bash", { command: "git status\nprintf done" }),
    "git status\nprintf done",
  );
  const permission = describePermission({
    kind: "read",
    path: "../private",
    intention: "Inspect instructions",
    requestSandboxBypass: true,
    requestSandboxBypassReason: "Outside the workspace",
  });
  assert.equal(permission.summary, "Read this file or directory?");
  assert.match(permission.content, /Inspect instructions\n\n\.\.\/private/);
  assert.match(permission.content, /Warning:.*outside the sandbox/);
  assert.match(permission.content, /Outside the workspace/);
  assert.doesNotMatch(permission.content, /"kind"|[{}]/);
  assert.match(permission.details, /"kind": "read"/);
  const write = describePermission({
    kind: "write",
    canOfferSessionApproval: false,
    fileName: "README.md",
    intention: "Update documentation",
    diff: "-old\n+new",
  });
  assert.equal(
    write.content,
    "Update documentation\n\nREADME.md\n\n-old\n+new",
  );
});

test("renders structured Markdown and code blocks", () => {
  const html = renderResult(
    "Explain this",
    "## Summary\n\n- One\n- Two\n\n```ts\nconst answer = 42;\n```",
  );
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<li>One<\/li>/);
  assert.match(html, /<code class="language-ts">const answer = 42;/);
});

test("renders inline and display equations as native MathML without external assets", () => {
  const html = renderMarkdown("Inline $x^2$.\n\n$$\\frac{a}{b}=\\sqrt{c}$$");
  assert.equal((html.match(/<math\b/g) ?? []).length, 2);
  assert.match(html, /display="block"/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
  assert.doesNotMatch(html, /<script|<link|<img|src=/);
});

test("math cannot turn trusted TeX commands into active links or remote images", () => {
  const html = renderMarkdown(
    "$\\href{https://attacker.invalid}{click}$\n\n" +
      "$\\includegraphics{https://attacker.invalid/image}$\n\n" +
      "$\\notacommand$",
  );
  assert.doesNotMatch(html, /<a\b|<img\b|<script\b|href=|src=/);
  assert.match(html, /notacommand/);
});

test("escapes untrusted prompt and answer HTML", () => {
  const html = renderResult(
    "</p><script>alert(1)</script>",
    '<img src="https://attacker.invalid/secret" onerror="alert(1)">',
  );
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test("plain tool output preserves command syntax and only linkifies safe URLs", () => {
  const html = renderText(
    "echo *literal*\n<script>bad()</script>\nhttps://example.com/log\ncommand:run",
  );
  assert.match(html, /echo \*literal\*\n&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /<a href="https:\/\/example.com\/log"/);
  assert.doesNotMatch(html, /<script|<em>|href="command:/);
});

test("renders clickable HTTP URLs and HTTPS images but blocks executable links", () => {
  const html = renderResult(
    "Links",
    "[Run](command:workbench.action.terminal.new)\n\n" +
      "[External](https://example.com)\n\n" +
      "http://example.org/path\n\n" +
      "[Script](javascript:alert(1))\n\n" +
      "[Local](file:///etc/passwd)\n\n" +
      "[Editor](vscode://some.extension/action)\n\n" +
      "![secret](https://attacker.invalid/collect)",
  );
  assert.match(
    html,
    /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">External<\/a>/,
  );
  assert.match(html, /href="http:\/\/example.org\/path"/);
  assert.doesNotMatch(html, /href="(?:command:|javascript:|file:|vscode:)/);
  assert.match(
    html,
    /<img src="https:\/\/attacker.invalid\/collect" alt="secret"/,
  );
  const nonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`style-src 'nonce-${nonce}'`));
});

test("image validation limits payloads and only accepts embedded raster images", () => {
  assert.deepEqual(parseImages([testImage]), [testImage]);
  for (const value of [
    null,
    {},
    [null],
    [{ ...testImage, name: "" }],
    [{ ...testImage, name: "x".repeat(256) }],
    Array(6).fill(testImage),
    [{ ...testImage, dataUrl: "https://example.com/image.png" }],
    [{ ...testImage, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }],
    [{ ...testImage, dataUrl: "data:text/html;base64,PHNjcmlwdD4=" }],
    [{ ...testImage, dataUrl: "data:image/png;base64,invalid!" }],
    [{ ...testImage, dataUrl: "data:image/png;base64,YQ=" }],
    [{ ...testImage, dataUrl: "data:image/png;base64," }],
    [
      {
        ...testImage,
        dataUrl: `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")}`,
      },
    ],
  ]) {
    assert.throws(() => parseImages(value), /Attach up to five/);
  }
  assert.ok(
    isImageDataUrl(
      `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES).toString("base64")}`,
    ),
  );
  for (const type of ["jpeg", "gif", "webp"]) {
    assert.ok(
      isImageDataUrl(testImage.dataUrl.replace("image/png", `image/${type}`)),
    );
  }
});

test("Markdown images escape attributes and reject local, insecure and active sources", () => {
  const html = renderMarkdown(
    `![pixel](${testImage.dataUrl} "Preview")\n\n` +
      '![a"b](https://example.com/image.png "c\\"d")\n\n' +
      "![insecure](http://example.com/image.png)\n\n" +
      "![local](file:///tmp/image.png)\n\n" +
      "![relative](image.png)\n\n" +
      "![credentials](https://user@example.com/image.png)\n\n" +
      "![vector](data:image/svg+xml;base64,PHN2Zz4=)\n\n" +
      `[not a link](${testImage.dataUrl})\n\n` +
      "```md\n![literal](https://example.com/not-loaded.png)\n```",
  );
  assert.match(
    html,
    /alt="pixel" title="Preview" loading="lazy" referrerpolicy="no-referrer"/,
  );
  assert.match(html, /alt="a&quot;b" title="c&quot;d"/);
  assert.equal((html.match(/<img /g) ?? []).length, 2);
  assert.doesNotMatch(
    html,
    /(?:src|href)="(?:http:|file:|data:image\/svg|image\.png|https:\/\/user@)/,
  );
  assert.doesNotMatch(html, /href="data:/);
});

test("both windows allow images through CSP while retaining script restrictions", () => {
  for (const html of [
    renderResult("Question", `![pixel](${testImage.dataUrl})`),
    renderApplication({
      cspSource: "https://webview.invalid",
      scriptUri: "https://webview.invalid/webview.js",
      styleUri: "https://webview.invalid/app.css",
    }),
  ]) {
    assert.match(html, /default-src 'none'; img-src https: data:;/);
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|img-src \*/);
  }
});

test("conversation image caches follow attachments without interpreting user or output text as Markdown", () => {
  const renderer = new ConversationRenderer();
  for (const role of ["user", "output"] as const) {
    const message: ChatMessage = {
      role,
      content: "*literal* <script>bad()</script>",
      images: [{ ...testImage, name: '"><script>bad()</script>' }],
    };
    const before = renderer.render("alpha", [message])[0]!.html;
    assert.match(before, /\*literal\* &lt;script&gt;/);
    assert.match(before, /<img /);
    assert.doesNotMatch(before, /<script\b|<em\b/i);
    assert.match(before, /alt="&quot;&gt;&lt;script&gt;/);
    message.images![0]!.name = "Updated description";
    assert.match(
      renderer.render("alpha", [message])[0]!.html,
      /alt="Updated description"/,
    );
    message.images = [];
    assert.doesNotMatch(renderer.render("alpha", [message])[0]!.html, /<img /);
  }
});
