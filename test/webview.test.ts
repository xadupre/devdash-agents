import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import type {
  ApplicationMessage,
  ApplicationState,
  DatasetSession,
} from "../src/application";
import {
  ConversationRenderer,
  renderApplication,
  renderGitHubDiscussion,
  renderGitHubComment,
} from "../src/render";
import type {
  GitHubUpdate,
  GitHubPage,
  GitHubDiscussionUpdate,
  GitHubCommentUpdate,
  GitHubDiscussion,
} from "../src/github";
import { testImage } from "./helpers";
import type { SettingsState } from "../src/settings";
import { MAX_IMAGE_BYTES } from "../src/images";

async function setup(t: TestContext) {
  const posted: ApplicationMessage[] = [];
  const dom = new JSDOM(
    renderApplication({
      cspSource: "https://webview.invalid",
      scriptUri: "https://webview.invalid/webview.js",
      styleUri: "https://webview.invalid/app.css",
    }),
    { runScripts: "outside-only" },
  );
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: ApplicationMessage) =>
        posted.push(structuredClone(message)),
    }),
  });
  const scriptPath = join(__dirname, "../src/webview.js");
  new Script(await readFile(scriptPath, "utf8"), {
    filename: scriptPath,
  }).runInContext(dom.getInternalVMContext());
  const renderer = new ConversationRenderer();
  const publish = (state: ApplicationState): void => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "state",
          state: structuredClone({
            ...state,
            messages: renderer.render(state.activeId, state.messages),
          }),
        },
      }),
    );
  };
  const state: ApplicationState = {
    root: "/projects",
    draft: "",
    repositories: [
      { id: "alpha", path: "/projects/alpha", name: "Alpha", status: "idle" },
      { id: "beta", path: "/projects/beta", name: "Beta", status: "idle" },
    ],
    messages: [],
    permissions: [],
    questions: [],
  };
  const document = dom.window.document;
  const publishGitHub = (
    update: GitHubUpdate | GitHubDiscussionUpdate | GitHubCommentUpdate,
  ): void => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: structuredClone(update),
      }),
    );
  };
  return { dom, document, posted, publish, publishGitHub, state };
}

async function setupDiscussion(t: TestContext, url: string) {
  const application = await setup(t);
  application.state.activeId = "alpha";
  application.publish(application.state);
  const open = (
    target: string,
    comments: GitHubDiscussion["comments"] = [],
  ) => {
    const discussion: GitHubDiscussion = {
      title: "#1 Discussion",
      url: target,
      kind: target.includes("/pull/") ? "PullRequest" : "Issue",
      state: "OPEN",
      author: "Ada",
      date: "2026-01-01T12:00:00Z",
      body: "Description",
      comments,
    };
    application.publishGitHub({
      type: "github",
      id: "alpha",
      section: "issues",
      status: "ready",
      append: false,
      page: {
        repository: "acme/project",
        items: [
          {
            id: "entry",
            title: discussion.title,
            url: target,
            author: "Ada",
            date: discussion.date,
            mine: false,
            replied: false,
            afterMe: false,
          },
        ],
      },
    });
    application.document
      .querySelector<HTMLButtonElement>(".github-discussion-title")!
      .click();
    const ready: GitHubDiscussionUpdate = {
      type: "github-discussion",
      id: "alpha",
      url: target,
      status: "ready",
      html: renderGitHubDiscussion(discussion),
    };
    application.publishGitHub(ready);
    return ready;
  };
  const ready = open(url);
  return { ...application, open, ready };
}

test("timing bands scale by duration, distinguish tools and separate overlapping work", async (t) => {
  const { document, state, publish } = await setup(t);
  state.activeId = "alpha";
  state.messages = [
    {
      role: "user",
      content: "Inspect files",
      timings: [
        {
          kind: "generation",
          name: "Token generation",
          start: 1000,
          end: 3000,
        },
        { kind: "tool", name: "read_file", start: 3000, end: 7000 },
        {
          kind: "tool",
          name: "search",
          start: 4000,
          end: 6000,
          agentId: "child",
        },
        {
          kind: "generation",
          name: "Token generation",
          start: 7000,
          end: 11000,
        },
      ],
    },
  ];
  publish(state);
  const panel = document.querySelector<HTMLElement>("#execution-timing")!;
  assert.equal(panel.hidden, false);
  const segments = [...panel.querySelectorAll<HTMLElement>(".timing-step")];
  assert.equal(segments.length, 4);
  assert.equal(segments[0]!.style.width, "20%");
  assert.equal(segments[1]!.style.width, "40%");
  assert.equal(segments[1]!.style.left, "20%");
  assert.equal(segments[2]!.style.top, "8px");
  assert.equal(
    segments[2]!.getAttribute("aria-label"),
    "search: 2.00 s (child)",
  );
  assert.notEqual(
    segments[1]!.style.backgroundColor,
    segments[2]!.style.backgroundColor,
  );
  assert.equal(
    segments[0]!.style.backgroundColor,
    segments[3]!.style.backgroundColor,
  );
  assert.equal(segments[1]!.tabIndex, 0);
  assert.equal(panel.parentElement?.className, "composer-actions");
  assert.equal(panel.previousElementSibling?.tagName, "SPAN");
  assert.equal(panel.nextElementSibling?.id, "cancel");
  assert.equal(panel.querySelector(".timing-legend"), null);
  assert.equal(panel.querySelector(".timing-heading"), null);
  assert.equal(panel.textContent, "");
  assert.equal(
    panel.querySelector<HTMLElement>(".timing-band")!.style.height,
    "16px",
  );
  assert.match(segments[0]!.title, /Token generation: 6.00 s/);
  assert.match(segments[0]!.title, /10.00 s · Inspect files/);
  const color = segments[1]!.style.backgroundColor;
  state.messages.push({
    role: "user",
    content: "Repeat",
    timings: [{ kind: "tool", name: "read_file", start: 12000, end: 13000 }],
  });
  publish(state);
  assert.equal(
    panel.querySelector<HTMLElement>(".timing-step")!.style.backgroundColor,
    color,
  );
  assert.equal(panel.querySelectorAll(".timing-request").length, 1);
  state.activeId = "beta";
  state.messages = [];
  publish(state);
  assert.equal(panel.hidden, true);
  assert.equal(panel.childElementCount, 0);
});

test("live timings update and freeze at completion while labels remain plain text", async (t) => {
  const { document, state, publish } = await setup(t);
  state.activeId = "alpha";
  const step = {
    kind: "tool" as const,
    name: '<img src=x onerror="alert(1)">',
    start: Date.now() - 1000,
    end: undefined as number | undefined,
  };
  state.messages = [{ role: "user", content: "Run", timings: [step] }];
  publish(state);
  const panel = document.querySelector<HTMLElement>("#execution-timing")!;
  const first = panel.querySelector<HTMLElement>(".timing-step")!.title;
  panel.querySelector<HTMLElement>(".timing-step")!.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.notEqual(
    panel.querySelector<HTMLElement>(".timing-step")!.title,
    first,
  );
  assert.equal(document.activeElement, panel.querySelector(".timing-step"));
  assert.match(
    panel.querySelector<HTMLElement>(".timing-step")!.title,
    /running/,
  );
  assert.equal(panel.querySelector("img"), null);
  step.end = step.start + 1500;
  publish(state);
  const completed = panel.querySelector<HTMLElement>(".timing-step")!.title;
  assert.equal(document.activeElement, panel.querySelector(".timing-step"));
  assert.doesNotMatch(completed!, /running/);
  assert.match(completed!, /1.50 s/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    panel.querySelector<HTMLElement>(".timing-step")!.title,
    completed,
  );
});

test("local generation is colored and exposes throughput only on hover", async (t) => {
  const { document, state, publish } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.backend = "local";
  state.repositories[0]!.view = "local";
  state.messages = [
    {
      role: "user",
      content: "<img src=x onerror=alert(1)>",
      timings: [
        {
          kind: "generation",
          name: "Token generation",
          start: 1000,
          end: 3000,
          outputTokens: 40,
        },
      ],
    },
  ];
  publish(state);
  const panel = document.querySelector<HTMLElement>("#execution-timing")!;
  const segment = panel.querySelector<HTMLElement>(".timing-step")!;
  assert.equal(panel.hidden, false);
  assert.equal(segment.style.backgroundColor, "rgb(55, 148, 255)");
  assert.equal(segment.style.width, "100%");
  assert.equal(panel.textContent, "");
  assert.match(segment.title, /20.00 tokens\/s/);
  assert.match(segment.getAttribute("aria-label")!, /20.00 tokens\/s/);
  assert.equal(panel.querySelector("img"), null);
  state.messages[0]!.timings![0]!.end = 1000;
  publish(state);
  assert.doesNotMatch(
    panel.querySelector<HTMLElement>(".timing-step")!.title,
    /tokens\/s|NaN|Infinity/,
  );
});

test("issue and PR comments publish only on explicit submit and append once without interrupting chat", async (t) => {
  for (const kind of ["issues", "pull"]) {
    await t.test(kind, async (t) => {
      const url = `https://github.com/acme/project/${kind}/1`;
      const { dom, document, posted, publishGitHub, ready } =
        await setupDiscussion(t, url);
      const form = document.querySelector<HTMLFormElement>(
        "#github-comment-form",
      )!;
      const body = document.querySelector<HTMLTextAreaElement>(
        "#github-comment-body",
      )!;
      const submit = document.querySelector<HTMLButtonElement>(
        "#github-comment-submit",
      )!;
      assert.equal(form.hidden, false);
      assert.equal(submit.disabled, true);
      body.value = " \n ";
      body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      assert.equal(submit.disabled, true);
      const text = "**New comment**\n\n<script>not executable</script>";
      body.value = text;
      body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      body.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
      assert.equal(
        posted.filter((message) => message.type === "github-comment").length,
        0,
      );
      assert.equal(submit.disabled, false);
      form.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
      const request = posted.at(-1);
      assert.ok(request?.type === "github-comment");
      assert.deepEqual(request, {
        type: "github-comment",
        id: "alpha",
        url,
        body: text,
        requestId: "comment-1",
      });
      assert.equal(body.disabled, true);
      assert.equal(submit.disabled, true);
      form.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
      assert.equal(
        posted.filter((message) => message.type === "github-comment").length,
        1,
      );
      document.getElementById("github-discussion-back")!.click();
      const created = {
        id: "IC_new",
        author: "Ada",
        body: text,
        date: "2026-01-02T12:00:00Z",
        url: `${url}#issuecomment-1`,
      };
      const update: GitHubCommentUpdate = {
        type: "github-comment",
        id: "alpha",
        url,
        requestId: request.requestId,
        status: "posted",
        commentId: created.id,
        html: renderGitHubComment(created),
      };
      publishGitHub(update);
      assert.equal(document.getElementById("github-discussion")?.hidden, true);
      document.getElementById("github-discussion-show")!.click();
      assert.equal(body.value, "");
      assert.equal(submit.disabled, true);
      assert.match(
        document.getElementById("github-comment-status")?.textContent ?? "",
        /published on GitHub/,
      );
      assert.equal(
        document.querySelectorAll(".github-discussion-comment").length,
        1,
      );
      assert.equal(
        document.querySelector(".github-discussion-comment strong")
          ?.textContent,
        "New comment",
      );
      assert.equal(
        document.querySelector("#github-discussion-content script"),
        null,
      );
      publishGitHub(update);
      publishGitHub(ready);
      assert.equal(
        document.querySelectorAll(".github-discussion-comment").length,
        1,
      );
      assert.equal(
        document.querySelector(".github-discussion-comments-heading")
          ?.textContent,
        "Comments (1)",
      );
      const full = renderGitHubDiscussion({
        title: "#1 Discussion",
        url,
        kind: "Issue",
        state: "OPEN",
        author: "Ada",
        date: "2026-01-01T12:00:00Z",
        body: "Description",
        comments: [created],
      });
      publishGitHub({ ...ready, html: full });
      assert.equal(
        document.querySelectorAll(".github-discussion-comment").length,
        1,
      );
      // Once GitHub confirms the comment, later refreshes reflect removals.
      publishGitHub(ready);
      assert.equal(
        document.querySelectorAll(".github-discussion-comment").length,
        0,
      );
      assert.equal(
        posted.filter((message) => message.type === "github-comment").length,
        1,
      );
      assert.equal(
        posted.filter((message) => message.type === "send").length,
        0,
      );
    });
  }
});

test("comment failures retain scoped drafts and stale acknowledgements cannot clear another submission", async (t) => {
  const url = "https://github.com/acme/project/issues/1";
  const { dom, document, posted, publishGitHub, open } = await setupDiscussion(
    t,
    url,
  );
  const body = document.querySelector<HTMLTextAreaElement>(
    "#github-comment-body",
  )!;
  const form = document.querySelector<HTMLFormElement>("#github-comment-form")!;
  const text = "Keep this draft";
  body.value = text;
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  const request = posted.at(-1);
  assert.ok(request?.type === "github-comment");
  publishGitHub({
    type: "github-comment",
    id: "alpha",
    url,
    requestId: request.requestId,
    status: "error",
    error: "Connection reset. Check GitHub before retrying.",
  });
  assert.equal(body.value, text);
  assert.equal(body.disabled, false);
  assert.equal(document.getElementById("github-comment-error")?.hidden, false);
  assert.match(
    document.getElementById("github-comment-error")?.textContent ?? "",
    /Check GitHub/,
  );
  assert.equal(
    posted.filter((message) => message.type === "github-comment").length,
    1,
  );
  open("https://github.com/acme/project/pull/2");
  assert.equal(body.value, "");
  body.value = "Other discussion";
  body.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  open(url);
  assert.equal(body.value, text);
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  const retry = posted.at(-1);
  assert.ok(retry?.type === "github-comment");
  assert.notEqual(retry.requestId, request.requestId);
  publishGitHub({
    type: "github-comment",
    id: "alpha",
    url,
    requestId: request.requestId,
    status: "error",
    error: "Old response",
  });
  assert.equal(body.disabled, true);
  assert.equal(body.value, text);
  assert.equal(
    posted.filter((message) => message.type === "github-comment").length,
    2,
  );
  publishGitHub({
    type: "github-comment",
    id: "alpha",
    url,
    requestId: retry.requestId,
    status: "error",
    error: "Still unavailable",
  });
  open("https://github.com/acme/project/pull/2");
  assert.equal(body.value, "Other discussion");
});

test("right panel switches between repositories and live application logs", async (t) => {
  const { document, publish, state } = await setup(t);
  publish(state);
  const repositories = document.querySelector<HTMLElement>("#repository-view")!;
  const activity = document.querySelector<HTMLElement>("#activity-view")!;
  const logs = document.querySelector<HTMLElement>("#log-view")!;
  const logButton = document.querySelector<HTMLButtonElement>(
    '#right-tabs [data-view="logs"]',
  )!;
  const repositoryButton = document.querySelector<HTMLButtonElement>(
    '#right-tabs [data-view="repositories"]',
  )!;
  assert.equal(repositories.hidden, false);
  assert.equal(activity.hidden, true);
  assert.equal(logs.hidden, true);
  logButton.click();
  assert.equal(logs.hidden, false);
  assert.equal(activity.hidden, true);
  assert.equal(repositories.hidden, true);
  assert.equal(logButton.getAttribute("aria-pressed"), "true");
  assert.match(logs.textContent!, /No events yet/);
  state.logs = [
    {
      id: 1,
      timestamp: "2026-11-11T09:00:00.000Z",
      repository: "alpha",
      message: "Loading <model>...",
      level: "info",
    },
  ];
  publish(state);
  assert.match(logs.textContent!, /Loading <model>/);
  assert.doesNotMatch(logs.textContent!, /\[alpha\]/);
  assert.equal(logs.querySelector("model"), null);
  const entry = logs.querySelector("article");
  state.activeId = "beta";
  publish(state);
  assert.equal(logs.querySelector("article"), entry);
  assert.equal(logs.hidden, false);
  state.logs.push({
    id: 2,
    timestamp: "2026-11-11T09:01:00.000Z",
    repository: "beta",
    message: "Load failed",
    level: "error",
  });
  publish(state);
  assert.match(logs.querySelector(".error")!.textContent!, /Load failed/);
  assert.doesNotMatch(logs.textContent!, /\[beta\]/);
  repositoryButton.click();
  assert.equal(repositories.hidden, false);
  assert.equal(logs.hidden, true);
  assert.equal(logButton.getAttribute("aria-pressed"), "false");
  state.root = "/other";
  state.logs = [{ ...state.logs[0]!, id: 2, message: "Other workspace" }];
  publish(state);
  logButton.click();
  assert.match(logs.textContent!, /Other workspace/);
  assert.doesNotMatch(logs.textContent!, /Load failed/);
});

test("the composer shows the active session model and free CPU/CUDA memory", async (t) => {
  const { document, dom, publish, state } = await setup(t);
  const model = document.querySelector<HTMLElement>("#session-model")!;
  const memory = document.querySelector<HTMLElement>("#system-memory")!;
  const info = document.querySelector<HTMLElement>("#composer-info")!;
  assert.ok(info.parentElement?.classList.contains("composer-heading"));
  assert.equal(info.parentElement?.nextElementSibling?.id, "question");
  publish(state);
  assert.ok(model.hidden && memory.hidden);
  state.activeId = "alpha";
  state.repositories[0]!.model = "qwen3-0.6b (local, CUDA 0)";
  publish(state);
  assert.equal(model.hidden, false);
  assert.equal(model.textContent, "Model: qwen3-0.6b (local, CUDA 0)");
  const GiB = 1024 ** 3;
  const send = (data: unknown) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  send({ type: "memory", cpu: { free: 12.34 * GiB, total: 32 * GiB } });
  assert.equal(memory.hidden, false);
  assert.equal(memory.textContent, "Free: CPU 12.3 GB");
  send({
    type: "memory",
    cpu: { free: 12.34 * GiB, total: 32 * GiB },
    cuda: [
      { free: 7.77 * GiB, total: 8 * GiB },
      { free: 20 * GiB, total: 24 * GiB },
    ],
  });
  assert.equal(
    memory.textContent,
    "Free: CPU 12.3 GB · CUDA 0 7.8 GB · CUDA 1 20.0 GB",
  );
  assert.match(memory.title, /CUDA 1: 20\.0 GB free of 24\.0 GB/);
  send({ type: "memory", cpu: { free: 299 * 1024 ** 2, total: 32 * GiB } });
  assert.match(memory.textContent ?? "", /Low memory: offload a model/);
  assert.equal(memory.classList.contains("memory-warning"), true);
  state.repositories[1]!.model = undefined;
  state.activeId = "beta";
  publish(state);
  assert.ok(model.hidden);
});

test("the Sessions panel shows per-session usage, the current device, session links and DISK unload", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.backend = "local";
  state.repositories[0]!.view = "local";
  state.repositories[0]!.localSession = {
    status: "ready",
    generatedTokens: 5,
    contextTokens: 20,
    contextLimit: 4096,
  };
  publish(state);
  document
    .querySelector<HTMLButtonElement>('#right-tabs [data-view="sessions"]')!
    .click();
  const models = {
    type: "local-models",
    models: [
      {
        modelPath: "/models/tiny",
        name: "tiny",
        sizeBytes: 1024,
        contextLength: 4096,
        bytesPerToken: { cpu: 512, cuda: 256 },
        sharedBuffer: true,
        status: "ready",
        placement: { provider: "cuda", deviceId: 0 },
        device: { provider: "cuda", deviceId: 0, name: "GPU" },
        busy: false,
        sessions: [
          { repositoryId: "alpha", cacheTokens: 10, cacheCapacity: 32 },
        ],
      },
    ],
  };
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", { data: models }),
  );
  const view = document.getElementById("sessions-view")!;
  assert.equal(view.hidden, false);
  assert.match(view.textContent ?? "", /tiny/);
  assert.match(view.textContent ?? "", /≈8 KiB KV/);
  assert.match(view.textContent ?? "", /20 \/ 4,096/);
  assert.match(view.textContent ?? "", /5 generated/);
  settingsSender(dom)({
    localDevicesStatus: "ready",
    localDevices: [
      { provider: "cpu", deviceId: 0, name: "CPU" },
      { provider: "cuda", deviceId: 0, name: "GPU" },
    ],
  });
  const buttons = [...view.querySelectorAll<HTMLButtonElement>("button")];
  const cpu = buttons.find((button) => button.textContent === "CPU 0")!;
  const cuda = buttons.find((button) => button.textContent === "CUDA 0")!;
  assert.equal(cpu.disabled, false);
  assert.equal(cuda.disabled, true);
  for (const mode of ["sliding", "compress"]) {
    const button = view.querySelector<HTMLButtonElement>(
      `[data-control-key="${mode}:alpha"]`,
    )!;
    assert.equal(button.disabled, false);
    button.click();
    assert.deepEqual(posted.at(-1), {
      type: "reduce-context",
      id: "alpha",
      mode,
    });
  }
  for (const blocked of ["busy", "disk", "empty", "session", "management"]) {
    models.models[0]!.busy = blocked === "busy";
    models.models[0]!.status = blocked === "disk" ? "disk" : "ready";
    models.models[0]!.sessions[0]!.cacheTokens = blocked === "empty" ? 0 : 10;
    state.repositories[0]!.localSession!.contextTokens =
      blocked === "empty" ? 0 : 20;
    state.repositories[0]!.localSession!.status =
      blocked === "session" ? "busy" : "ready";
    state.repositories[0]!.managementBusy = blocked === "management";
    publish(state);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", { data: models }),
    );
    for (const mode of ["sliding", "compress"])
      assert.equal(
        view.querySelector<HTMLButtonElement>(
          `[data-control-key="${mode}:alpha"]`,
        )!.disabled,
        true,
        blocked,
      );
  }
  state.repositories[0]!.managementBusy = false;
  models.models[0]!.sessions[0]!.cacheTokens = 0;
  state.repositories[0]!.localSession!.contextTokens = 20;
  publish(state);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", { data: models }),
  );
  for (const mode of ["sliding", "compress"])
    assert.equal(
      view.querySelector<HTMLButtonElement>(
        `[data-control-key="${mode}:alpha"]`,
      )!.disabled,
      false,
      "retained context remains reducible after its cache is released",
    );
  state.repositories[0]!.localSession!.status = "error";
  for (const canReduceContext of [false, true]) {
    state.repositories[0]!.localSession!.canReduceContext = canReduceContext;
    publish(state);
    for (const mode of ["sliding", "compress"]) {
      const reduce = view.querySelector<HTMLButtonElement>(
        `[data-control-key="${mode}:alpha"]`,
      )!;
      assert.equal(reduce.disabled, !canReduceContext);
      if (canReduceContext) {
        reduce.click();
        assert.deepEqual(posted.at(-1), {
          type: "reduce-context",
          id: "alpha",
          mode,
        });
      }
    }
  }
  state.repositories[0]!.localSession!.status = "ready";
  view.querySelector<HTMLButtonElement>('[data-control-key="cpu:0"]')!.focus();
  publish(state);
  assert.equal(
    document.activeElement?.getAttribute("data-control-key"),
    "cpu:0",
  );
  view.querySelector<HTMLButtonElement>(".local-session-link")!.click();
  assert.deepEqual(posted.at(-1), {
    type: "open-local-session",
    id: "alpha",
  });
  view
    .querySelector<HTMLButtonElement>('button[data-control-key="disk"]')!
    .click();
  assert.deepEqual(posted.at(-1), {
    type: "local-placement",
    modelPath: "/models/tiny",
    placement: { provider: "disk" },
  });
  state.repositories[0]!.status = "busy";
  state.repositories[0]!.localSession!.status = "busy";
  state.repositories[0]!.managementBusy = true;
  state.draft = "do not send during context reduction";
  publish(state);
  assert.equal(
    document.querySelector<HTMLButtonElement>("#send")!.disabled,
    true,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>("#cancel")!.disabled,
    false,
  );
  state.repositories[0]!.backend = "copilot";
  state.repositories[0]!.view = "copilot";
  state.repositories[0]!.localSession!.reducingContext = true;
  publish(state);
  view
    .querySelector<HTMLButtonElement>(
      '[data-control-key="cancel-context:alpha"]',
    )!
    .click();
  assert.deepEqual(posted.at(-1), {
    type: "cancel",
    id: "alpha",
    view: "local",
  });
});

test("offloading a local model blocks local sends but leaves Copilot sends enabled", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  const repository = state.repositories[0]!;
  state.activeId = "alpha";
  repository.status = "ready";
  repository.backend = "copilot";
  repository.view = "copilot";
  repository.localSession = {
    status: "ready",
    generation: 1,
    generatedTokens: 0,
  };
  publish(state);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: "local-models",
        models: [
          {
            modelPath: "/models/tiny",
            status: "disk",
            placement: { provider: "disk" },
            busy: false,
            sessions: [{ repositoryId: "alpha", cacheTokens: 0 }],
          },
        ],
      },
    }),
  );
  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  const send = document.querySelector<HTMLButtonElement>("#send")!;
  question.value = "Copilot is available";
  question.dispatchEvent(new dom.window.Event("input"));
  assert.equal(send.disabled, false);
  repository.backend = "local";
  repository.view = "local";
  publish(state);
  question.value = "Local model is offloaded";
  question.dispatchEvent(new dom.window.Event("input"));
  assert.equal(send.disabled, true);
});

test("offloading one local session leaves another instance of the same model available", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.activeId = "alpha";
  const repository = state.repositories[0]!;
  repository.status = "ready";
  repository.backend = "local";
  repository.localSessions = ["first", "second"].map((id) => ({
    id,
    status: "ready",
    generatedTokens: 0,
    readOnly: id === "second",
  }));
  repository.localSession = { ...repository.localSessions[0]! };
  repository.view = "local:first";
  publish(state);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: "local-models",
        models: ["first", "second"].map((id, deviceId) => ({
          id,
          modelPath: "/same-model",
          status: id === "first" ? "ready" : "disk",
          placement:
            id === "first"
              ? { provider: "cuda", deviceId }
              : { provider: "disk" },
          busy: false,
          sessions: [
            { repositoryId: "alpha", localSessionId: id, cacheTokens: 0 },
          ],
        })),
      },
    }),
  );
  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  const send = document.querySelector<HTMLButtonElement>("#send")!;
  question.value = "Ready session remains available";
  question.dispatchEvent(new dom.window.Event("input"));
  assert.equal(send.disabled, false);
  repository.localSession = { ...repository.localSessions[1]! };
  repository.view = "local:second";
  publish(state);
  question.value = "Offloaded session is blocked";
  question.dispatchEvent(new dom.window.Event("input"));
  assert.equal(send.disabled, true);
});

test("switching session views preserves each draft across the other view's generation changes", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  const repository = state.repositories[0]!;
  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  state.activeId = "alpha";
  repository.status = "ready";
  repository.generation = 2;
  repository.copilotGeneration = 0;
  repository.localSession = {
    status: "ready",
    generation: 2,
    generatedTokens: 0,
  };
  repository.backend = "local";
  repository.view = "local";
  publish(state);
  question.value = "local draft";
  question.dispatchEvent(new dom.window.Event("input"));
  repository.backend = "copilot";
  repository.view = "copilot";
  repository.generation = 0;
  publish(state);
  assert.equal(question.value, "");
  question.value = "Copilot draft";
  question.dispatchEvent(new dom.window.Event("input"));
  repository.backend = "local";
  repository.view = "local";
  publish(state);
  assert.equal(question.value, "local draft");
  repository.backend = "copilot";
  repository.view = "copilot";
  publish(state);
  repository.localSession!.generation =
    (repository.localSession!.generation ?? 0) + 1;
  publish(state);
  assert.equal(question.value, "Copilot draft");
  repository.backend = "local";
  repository.view = "local";
  publish(state);
  assert.equal(question.value, "");
});

test("the session header shows generated tokens without adding a separate row and follows session changes", async (t) => {
  const { document, publish, state } = await setup(t);
  const counter = document.querySelector<HTMLElement>("#session-tokens")!;
  publish(state);
  assert.ok(counter.hidden);
  state.activeId = "alpha";
  publish(state);
  assert.equal(counter.hidden, false);
  assert.equal(counter.textContent, "0 generated");
  assert.equal(counter.parentElement?.className, "session-activity");
  state.repositories[0]!.generatedTokens = 12345;
  state.repositories[0]!.status = "busy";
  publish(state);
  assert.equal(counter.textContent, `${(12345).toLocaleString()} generated`);
  assert.match(counter.title, /Generated output tokens/);
  state.activeId = "beta";
  state.repositories[1]!.generatedTokens = 42;
  publish(state);
  assert.equal(counter.textContent, "42 generated");
  state.activeId = "alpha";
  state.repositories[0]!.generation = 1;
  state.repositories[0]!.generatedTokens = 0;
  publish(state);
  assert.equal(counter.textContent, "0 generated");
  state.activeId = undefined;
  publish(state);
  assert.ok(counter.hidden);
  assert.equal(counter.textContent, "");
});

test(
  "image attachments preview, follow repository drafts, paste, remove and restore after rejected sends",
  { timeout: 5000 },
  async (t) => {
    const { dom, document, posted, publish, state } = await setup(t);
    state.activeId = "alpha";
    state.repositories[0]!.status = "ready";
    state.repositories[1]!.status = "ready";
    publish(state);
    assert.equal(document.querySelector('input[type="file"]'), null);
    assert.equal(document.querySelector('label[for="images"]'), null);
    const send = document.querySelector<HTMLButtonElement>("#send")!;
    const question = document.querySelector<HTMLTextAreaElement>("#question")!;
    const file = new dom.window.File(
      [Buffer.from(testImage.dataUrl.split(",")[1]!, "base64")],
      testImage.name,
      { type: "image/png" },
    );
    const changed = () =>
      new Promise<void>((resolve) => {
        const observer = new dom.window.MutationObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(document.querySelector("#image-previews")!, {
          childList: true,
        });
      });
    const clipboardPaste = new dom.window.Event("paste", {
      cancelable: true,
    });
    Object.defineProperty(clipboardPaste, "clipboardData", {
      value: { files: [file] },
    });
    let previewChanged = changed();
    question.dispatchEvent(clipboardPaste);
    assert.ok(clipboardPaste.defaultPrevented);
    assert.ok(send.disabled, "reading images must block submission");
    await previewChanged;
    assert.equal(
      document.querySelector<HTMLImageElement>("#image-previews img")?.src,
      testImage.dataUrl,
    );
    assert.equal(send.disabled, false, "image-only prompts can be sent");

    state.repositories[0]!.backend = "local";
    state.repositories[0]!.view = "local";
    state.repositories[0]!.localSession = {
      status: "ready",
      generation: 0,
      generatedTokens: 0,
    };
    publish(state);
    assert.equal(document.querySelector("#image-previews img"), null);
    state.repositories[0]!.backend = "copilot";
    state.repositories[0]!.view = "copilot";
    publish(state);
    assert.ok(document.querySelector("#image-previews img"));

    state.activeId = "beta";
    publish(state);
    assert.equal(document.querySelector("#image-previews img"), null);
    state.activeId = "alpha";
    publish(state);
    assert.ok(document.querySelector("#image-previews img"));
    document
      .querySelector<HTMLButtonElement>("#image-previews button")!
      .click();
    assert.equal(document.querySelector("#image-previews img"), null);
    assert.ok(send.disabled);

    const paste = new dom.window.Event("paste", { cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      },
    });
    previewChanged = changed();
    question.dispatchEvent(paste);
    assert.ok(paste.defaultPrevented);
    await previewChanged;
    send.click();
    const sent = posted.find((message) => message.type === "send");
    assert.deepEqual(sent, {
      type: "send",
      id: "alpha",
      question: "",
      parallel: true,
      images: [testImage],
    });
    assert.equal(document.querySelector("#image-previews img"), null);
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: { type: "error", id: "alpha", message: "Request rejected" },
      }),
    );
    assert.ok(document.querySelector("#image-previews img"));
    assert.equal(send.disabled, false);
    state.repositories[0]!.generation = 1;
    publish(state);
    assert.equal(document.querySelector("#image-previews img"), null);
  },
);

test("pasting images rejects unsupported types, empty files, oversized files and too many attachments", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  const pasteFiles = (files: File[]) => {
    const event = new dom.window.Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files } });
    question.dispatchEvent(event);
    return event;
  };
  assert.ok(question.disabled);
  assert.equal(
    pasteFiles([new dom.window.File(["x"], "image.png", { type: "image/png" })])
      .defaultPrevented,
    false,
  );
  assert.equal(document.querySelector("#image-previews img"), null);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  publish(state);
  const textPaste = new dom.window.Event("paste", { cancelable: true });
  Object.defineProperty(textPaste, "clipboardData", {
    value: { items: [{ kind: "string", type: "text/plain" }] },
  });
  question.dispatchEvent(textPaste);
  assert.equal(textPaste.defaultPrevented, false);
  for (const files of [
    [new dom.window.File(["<svg/>"], "unsafe.svg", { type: "image/svg+xml" })],
    [new dom.window.File([], "empty.png", { type: "image/png" })],
    [
      new dom.window.File(["x".repeat(MAX_IMAGE_BYTES + 1)], "large.png", {
        type: "image/png",
      }),
    ],
    Array.from(
      { length: 6 },
      () => new dom.window.File(["x"], "image.png", { type: "image/png" }),
    ),
  ]) {
    assert.ok(pasteFiles(files).defaultPrevented);
    assert.match(
      document.querySelector("#error")!.textContent!,
      /Attach up to five/,
    );
    assert.equal(document.querySelector("#image-previews img"), null);
    assert.ok(document.querySelector<HTMLButtonElement>("#send")!.disabled);
  }
});

test("dialog and tool-output images render and unchanged image articles survive streaming", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.messages = [
    { role: "user", content: "An image", images: [testImage] },
    { role: "assistant", content: `![response](${testImage.dataUrl})` },
    { role: "output", content: "*literal* output", images: [testImage] },
  ];
  publish(state);
  const outputFilter = document.querySelector<HTMLInputElement>(
    'input[value="output"]',
  )!;
  outputFilter.checked = true;
  outputFilter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(document.querySelectorAll(".message img").length, 3);
  assert.equal(
    document.querySelector(".output .content")!.textContent,
    "*literal* output",
  );
  const first = document.querySelector(".message");
  state.messages[1]!.content += "\n\nMore text.";
  publish(state);
  assert.equal(document.querySelector(".message"), first);
  state.messages[0]!.images = [];
  publish(state);
  assert.equal(
    document.querySelector(".message img"),
    document.querySelector(".assistant img"),
  );
});

test("transcript selections survive state updates and streamed Markdown without intercepting native copy", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.messages = [
    { role: "assistant", content: "Select **this text** to copy." },
  ];
  publish(state);
  const selection = dom.window.getSelection()!;
  const selected = document.querySelector(".message strong")!.firstChild!;
  selection.setBaseAndExtent(selected, 9, selected, 0);
  assert.equal(selection.toString(), "this text");

  publish(state);
  assert.equal(selection.toString(), "this text");
  assert.equal(selection.anchorOffset, 9);
  assert.equal(selection.getRangeAt(0).startContainer, selection.focusNode);
  assert.equal(selection.getRangeAt(0).endContainer, selection.anchorNode);

  state.messages[0]!.content += "\n\nMore streamed text.";
  state.messages.push({ role: "tool", content: "echo done" });
  publish(state);
  assert.equal(selection.toString(), "this text");

  const content = document.querySelector(".message .content")!;
  for (const key of ["c", "C"]) {
    const event = new dom.window.KeyboardEvent("keydown", {
      key,
      ctrlKey: key === "c",
      metaKey: key === "C",
      bubbles: true,
      cancelable: true,
    });
    content.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  const menu = new dom.window.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
  });
  content.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, false);
  assert.equal(selection.toString(), "this text");

  state.activeId = "beta";
  state.messages = [{ role: "assistant", content: "Another conversation." }];
  publish(state);
  assert.equal(selection.toString(), "");
});

test("copy selections can span messages and clamp to shortened streaming content", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  state.messages = [
    { role: "user", content: "First message" },
    { role: "tool", content: "Second message" },
  ];
  publish(state);
  const selection = dom.window.getSelection()!;
  const contents = document.querySelectorAll(".message .content");
  selection.setBaseAndExtent(
    contents[0]!.firstChild!,
    6,
    contents[1]!.firstChild!,
    6,
  );
  const text = selection.toString();
  publish(state);
  assert.equal(selection.toString(), text);

  state.messages[1]!.content = "End";
  publish(state);
  assert.equal(selection.focusNode?.textContent, "End");
  assert.equal(selection.focusOffset, 3);

  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  question.value = "Editable draft";
  question.focus();
  question.setSelectionRange(0, 8);
  const paste = new dom.window.KeyboardEvent("keydown", {
    key: "v",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  question.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, false);
  publish(state);
  assert.equal(document.activeElement, question);
  assert.equal(question.selectionStart, 0);
  assert.equal(question.selectionEnd, 8);
});

test("the activity sidebar shows viewer flags, preserves cached content during streaming, and opens GitHub links", async (t) => {
  const { dom, document, posted, publish, publishGitHub, state } =
    await setup(t);
  state.activeId = "alpha";
  publish(state);
  const sidebar = document.getElementById("repository-panel")!;
  const activity = document.getElementById("activity-view")!;
  const activityButton = document.querySelector<HTMLButtonElement>(
    '#right-tabs [data-view="activity"]',
  )!;
  assert.equal(document.getElementById("left-panel"), null);
  assert.equal(activity.parentElement, sidebar);
  activityButton.click();
  assert.equal(activity.hidden, false);
  assert.equal(document.getElementById("repository-view")!.hidden, true);
  assert.equal(activityButton.getAttribute("aria-pressed"), "true");
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "alpha",
    section: "issues",
    cursor: undefined,
  });
  const page: GitHubPage = {
    repository: "acme/project",
    viewer: "Ada",
    cursor: "next",
    items: [
      {
        id: "one",
        title: "#1 <script>Issue</script>",
        author: "Ada",
        date: "2026-01-01T12:00:00Z",
        url: "https://github.com/acme/project/issues/1",
        mine: true,
        replied: true,
        afterMe: true,
      },
    ],
  };
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "ready",
    append: false,
    page,
  });
  const card = document.querySelector(".github-item");
  assert.ok(card?.classList.contains("github-mine"));
  const beforeViewSwitch = posted.length;
  for (const view of ["logs", "repositories"]) {
    document
      .querySelector<HTMLButtonElement>(`#right-tabs [data-view="${view}"]`)!
      .click();
    assert.equal(activity.hidden, true);
    activityButton.click();
    assert.equal(activity.hidden, false);
    assert.equal(document.querySelector(".github-item"), card);
  }
  assert.equal(posted.length, beforeViewSwitch);
  assert.deepEqual(
    [...document.querySelectorAll(".github-badge")].map(
      (badge) => badge.textContent,
    ),
    ["Yours", "Replied", "After you"],
  );
  assert.equal(document.querySelector("#github-items script"), null);
  const title = document.querySelector<HTMLButtonElement>(
    "#github-items h3 .github-discussion-title",
  );
  assert.ok(title);
  const beforeTitle = posted.length;
  title.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  assert.deepEqual(posted.at(-1), {
    type: "github-discussion",
    id: "alpha",
    url: "https://github.com/acme/project/issues/1",
  });
  assert.deepEqual(posted.slice(beforeTitle), [
    {
      type: "github-discussion",
      id: "alpha",
      url: "https://github.com/acme/project/issues/1",
    },
  ]);
  state.messages = [{ role: "assistant", content: "Streaming response" }];
  const count = posted.length;
  publish(state);
  assert.equal(posted.length, count);
  assert.equal(document.querySelector(".github-item"), card);
  document.querySelector<HTMLButtonElement>("#github-more")?.click();
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "alpha",
    section: "issues",
    cursor: "next",
  });
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "ready",
    append: true,
    page: {
      ...page,
      cursor: undefined,
      items: [
        ...page.items,
        { ...page.items[0]!, id: "two", title: "#2 Another" },
      ],
    },
  });
  assert.equal(document.querySelectorAll(".github-item").length, 2);
  assert.equal(
    document.querySelector<HTMLButtonElement>("#github-more")?.hidden,
    true,
  );
  state.activeId = "beta";
  publish(state);
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "beta",
    section: "issues",
    cursor: undefined,
  });
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "ready",
    append: false,
    page,
  });
  assert.equal(document.querySelectorAll(".github-item").length, 0);
  const before = posted.length;
  state.activeId = "alpha";
  publish(state);
  assert.equal(posted.length, before);
  assert.equal(document.querySelectorAll(".github-item").length, 1);
  document.querySelector<HTMLButtonElement>("#github-refresh")?.click();
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "error",
    append: false,
    error: "Run gh auth login",
  });
  assert.match(
    document.getElementById("github-error")?.textContent ?? "",
    /gh auth login/,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>("#github-refresh")?.disabled,
    false,
  );
  assert.equal(document.getElementById("error")?.hidden, true);
});

test("issue and PR titles open a main-panel reader without changing the conversation or draft", async (t) => {
  const { dom, document, posted, publish, publishGitHub, state } =
    await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  state.draft = "Keep this draft";
  state.messages = [{ role: "assistant", content: "Existing conversation" }];
  publish(state);
  const showDiscussion = document.querySelector<HTMLButtonElement>(
    "#github-discussion-show",
  )!;
  assert.equal(showDiscussion.hidden, true);
  const url = "https://github.com/acme/project/pull/1";
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "issues",
    status: "ready",
    append: false,
    page: {
      repository: "acme/project",
      items: [
        {
          id: "pull",
          title: "#1 PR",
          url,
          author: "Ada",
          date: "2026-01-01T12:00:00Z",
          mine: true,
          replied: false,
          afterMe: false,
        },
      ],
    },
  });
  const title = document.querySelector<HTMLButtonElement>(
    "#github-items h3 .github-discussion-title",
  )!;
  const conversation = document.querySelector("#messages article");
  title.click();
  assert.deepEqual(posted.at(-1), {
    type: "github-discussion",
    id: "alpha",
    url,
  });
  assert.equal(title.closest("a"), null);
  assert.equal(
    posted.filter((message) => message.type === "openExternal").length,
    0,
  );
  const external = document.querySelector<HTMLButtonElement>(
    "#github-items .github-external",
  )!;
  const beforeExternal = posted.length;
  external.click();
  assert.deepEqual(posted.slice(beforeExternal), [
    { type: "openExternal", url },
  ]);
  assert.equal(external.closest("a"), null);
  assert.match(
    external.getAttribute("aria-label") ?? "",
    /Open #1 PR on GitHub/,
  );
  const reader = document.getElementById("github-discussion")!;
  const panel = document.getElementById("chat-panel")!;
  assert.equal(reader.hidden, false);
  assert.ok(panel.classList.contains("reading-discussion"));
  const discussion = {
    title: "#1 PR",
    url,
    kind: "PullRequest" as const,
    state: "OPEN",
    author: "Ada",
    date: "2026-01-01T12:00:00Z",
    body: "**Description**\n\n[Details](https://example.com/details)",
    comments: [],
  };
  const ready: GitHubDiscussionUpdate = {
    type: "github-discussion",
    id: "alpha",
    url,
    status: "ready",
    discussion,
    html: renderGitHubDiscussion(discussion),
  };
  publishGitHub(ready);
  assert.equal(
    document.querySelector("#github-discussion-content h1")?.textContent,
    "#1 PR",
  );
  assert.equal(
    document.querySelector("#github-discussion-content strong")?.textContent,
    "Description",
  );
  const article = document.querySelector("#github-discussion-content article");
  state.messages.push({ role: "assistant", content: "Work continues" });
  publish(state);
  assert.equal(
    document.querySelector("#github-discussion-content article"),
    article,
  );
  assert.equal(document.querySelector("#messages article"), conversation);
  assert.equal(
    document.querySelector<HTMLTextAreaElement>("#question")?.value,
    "Keep this draft",
  );
  document
    .querySelector<HTMLAnchorElement>("#github-discussion-content a")!
    .click();
  assert.deepEqual(posted.at(-1), {
    type: "openExternal",
    url: "https://example.com/details",
  });
  document.getElementById("github-discussion-external")!.click();
  assert.deepEqual(posted.at(-1), { type: "openExternal", url });
  const beforeModifiedTitle = posted.length;
  title.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    }),
  );
  assert.deepEqual(posted.slice(beforeModifiedTitle), [
    { type: "github-discussion", id: "alpha", url },
  ]);
  const beforeMiddleTitle = posted.length;
  title.dispatchEvent(
    new dom.window.MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    }),
  );
  assert.equal(posted.length, beforeMiddleTitle);
  publishGitHub(ready);
  const refresh = document.querySelector<HTMLButtonElement>(
    "#github-discussion-refresh",
  )!;
  refresh.click();
  assert.deepEqual(posted.at(-1), {
    type: "github-discussion",
    id: "alpha",
    url,
  });
  publishGitHub({
    type: "github-discussion",
    id: "alpha",
    url,
    status: "error",
    error: "Rate limit exceeded",
  });
  assert.equal(
    document.getElementById("github-discussion-error")?.hidden,
    false,
  );
  assert.match(
    document.getElementById("github-discussion-error")?.textContent ?? "",
    /Rate limit/,
  );
  assert.equal(refresh.disabled, false);
  refresh.click();
  const beforeBack = posted.length;
  document.getElementById("github-discussion-back")!.click();
  assert.equal(posted.length, beforeBack);
  assert.equal(reader.hidden, true);
  assert.equal(showDiscussion.hidden, false);
  assert.equal(panel.classList.contains("reading-discussion"), false);
  assert.equal(document.querySelector("#messages article"), conversation);
  assert.equal(
    document.querySelector<HTMLTextAreaElement>("#question")?.value,
    "Keep this draft",
  );
  publishGitHub(ready);
  assert.equal(reader.hidden, true);
  const savedDiscussion = document.querySelector(
    "#github-discussion-content article",
  );
  assert.ok(savedDiscussion);
  showDiscussion.click();
  assert.equal(posted.length, beforeBack);
  assert.equal(reader.hidden, false);
  assert.equal(
    document.querySelector("#github-discussion-content article"),
    savedDiscussion,
  );
  document.getElementById("github-discussion-back")!.click();
  showDiscussion.click();
  assert.equal(posted.length, beforeBack);
  assert.equal(
    document.querySelector("#github-discussion-content article"),
    savedDiscussion,
  );
  state.activeId = "beta";
  publish(state);
  publishGitHub(ready);
  assert.equal(reader.hidden, true);
  assert.equal(showDiscussion.hidden, true);
  assert.ok(
    posted
      .slice(beforeBack)
      .some(
        (message) =>
          message.type === "close-github-discussion" && message.id === "alpha",
      ),
  );
  assert.equal(
    document.querySelector("#github-discussion-content article"),
    null,
  );
  assert.equal(posted.filter((message) => message.type === "send").length, 0);
});

test("sidebar tabs request separate feeds and safely display comments and commit permalinks", async (t) => {
  const { dom, document, posted, publish, publishGitHub, state } =
    await setup(t);
  state.activeId = "alpha";
  publish(state);
  for (const section of [
    "reviews",
    "oldest-prs",
    "commits",
    "comments",
    "mentions",
  ] as const) {
    document
      .querySelector<HTMLButtonElement>(
        `#github-tabs [data-section="${section}"]`,
      )
      ?.click();
    assert.deepEqual(posted.at(-1), {
      type: "github",
      id: "alpha",
      section,
      cursor: undefined,
    });
    const url =
      section === "commits"
        ? "https://github.com/acme/project/commit/abc123"
        : "https://github.com/acme/project/pull/1";
    publishGitHub({
      type: "github",
      id: "alpha",
      section,
      status: "ready",
      append: false,
      page: {
        repository: "acme/project",
        items: [
          {
            id: "entry",
            title: section,
            author: "Ada",
            date: "2026-01-01T12:00:00Z",
            url,
            mine: false,
            replied: false,
            afterMe: false,
            comments:
              section === "comments" || section === "mentions"
                ? [
                    {
                      id: "own",
                      author: "Ada",
                      mine: true,
                      body: "<script>My comment</script>",
                      date: "2026-01-01T12:00:00Z",
                      url: `${url}#comment`,
                    },
                  ]
                : undefined,
          },
        ],
      },
    });
    const external = document.querySelector<HTMLElement>(
      section === "commits"
        ? "#github-items h3 a"
        : "#github-items .github-external",
    );
    assert.ok(external);
    external.dispatchEvent(
      new dom.window.MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.deepEqual(posted.at(-1), { type: "openExternal", url });
    if (section === "comments" || section === "mentions") {
      assert.equal(document.querySelector("#github-items script"), null);
      assert.match(
        document.querySelector(".github-comment-body")?.textContent ?? "",
        /<script>My comment<\/script>/,
      );
      document.querySelector<HTMLAnchorElement>(".github-comment a")?.click();
      assert.deepEqual(posted.at(-1), {
        type: "openExternal",
        url: `${url}#comment`,
      });
    }
  }
  const before = posted.length;
  document
    .querySelector<HTMLButtonElement>('#github-tabs [data-section="commits"]')
    ?.click();
  assert.equal(posted.length, before);
  assert.equal(
    document.querySelectorAll("#github-tabs [aria-pressed=true]").length,
    1,
  );
});

test("all sidebar feeds remain newest-first after pagination and duplicate updates", async (t) => {
  const { document, publish, publishGitHub, state } = await setup(t);
  state.activeId = "alpha";
  publish(state);
  const item = (id: string, date: string) => ({
    id,
    title: id,
    date,
    author: "Ada",
    mine: false,
    replied: false,
    afterMe: false,
  });
  const titles = (): (string | null)[] =>
    [...document.querySelectorAll(".github-item h3")].map(
      (heading) => heading.textContent,
    );
  for (const section of [
    "issues",
    "reviews",
    "comments",
    "commits",
    "mentions",
  ] as const) {
    document
      .querySelector<HTMLButtonElement>(
        `#github-tabs [data-section="${section}"]`,
      )
      ?.click();
    publishGitHub({
      type: "github",
      id: "alpha",
      section,
      status: "ready",
      append: false,
      page: {
        repository: "acme/project",
        cursor: "next",
        items: [
          item("older", "2026-01-03T01:00:00+02:00"),
          item("newer", "2026-01-03T00:00:00Z"),
        ],
      },
    });
    assert.deepEqual(titles(), ["newer", "older"]);
    document.querySelector<HTMLButtonElement>("#github-more")?.click();
    publishGitHub({
      type: "github",
      id: "alpha",
      section,
      status: "ready",
      append: true,
      page: {
        repository: "acme/project",
        items: [
          item("oldest", "2026-01-01T12:00:00Z"),
          item("older", "2026-01-05T12:00:00Z"),
        ],
      },
    });
    assert.deepEqual(titles(), ["older", "newer", "oldest"]);
  }
});

test("oldest PRs stay oldest-first, refresh without pagination, and cache separately for each repository", async (t) => {
  const { document, posted, publish, publishGitHub, state } = await setup(t);
  state.activeId = "alpha";
  publish(state);
  const tab = document.querySelector<HTMLButtonElement>(
    '#github-tabs [data-section="oldest-prs"]',
  )!;
  tab.click();
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "alpha",
    section: "oldest-prs",
    cursor: undefined,
  });
  assert.equal(
    document.getElementById("github-heading")?.textContent,
    "Oldest PRs",
  );
  const item = (id: string, date: string) => ({
    id,
    title: id,
    date,
    author: "Ada",
    mine: false,
    replied: false,
    afterMe: false,
  });
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "oldest-prs",
    status: "ready",
    append: false,
    page: {
      repository: "acme/project",
      items: [
        item("newer", "2026-01-03T00:00:00Z"),
        item("oldest", "2026-01-01T12:00:00Z"),
        item("middle", "2026-01-03T01:00:00+02:00"),
      ],
    },
  });
  const titles = () =>
    [...document.querySelectorAll(".github-item h3")].map(
      (heading) => heading.textContent,
    );
  assert.deepEqual(titles(), ["oldest", "middle", "newer"]);
  assert.equal(
    document.querySelector<HTMLButtonElement>("#github-more")?.hidden,
    true,
  );
  const oldest = document.querySelector<HTMLTimeElement>(".github-item time");
  assert.equal(oldest?.dateTime, "2026-01-01T12:00:00Z");
  state.activeId = "beta";
  publish(state);
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "beta",
    section: "oldest-prs",
    cursor: undefined,
  });
  const before = posted.length;
  state.activeId = "alpha";
  publish(state);
  assert.equal(posted.length, before);
  assert.deepEqual(titles(), ["oldest", "middle", "newer"]);
  document.querySelector<HTMLButtonElement>("#github-refresh")!.click();
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "alpha",
    section: "oldest-prs",
    cursor: undefined,
  });
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "oldest-prs",
    status: "ready",
    append: false,
    page: { repository: "acme/project", items: [] },
  });
  assert.equal(
    document.getElementById("github-items")?.textContent,
    "No entries found.",
  );
});

test("an empty Mentions page still allows loading older pings and refreshing", async (t) => {
  const { document, posted, publish, publishGitHub, state } = await setup(t);
  state.activeId = "alpha";
  publish(state);
  document
    .querySelector<HTMLButtonElement>('#github-tabs [data-section="mentions"]')
    ?.click();
  assert.equal(
    document.getElementById("github-heading")?.textContent,
    "Mentions",
  );
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "mentions",
    status: "ready",
    append: false,
    page: { repository: "acme/project", items: [], cursor: "older-pings" },
  });
  assert.equal(
    document.getElementById("github-items")?.textContent,
    "No unanswered mentions in this page.",
  );
  const more = document.querySelector<HTMLButtonElement>("#github-more");
  assert.equal(more?.hidden, false);
  more?.click();
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "alpha",
    section: "mentions",
    cursor: "older-pings",
  });
  publishGitHub({
    type: "github",
    id: "alpha",
    section: "mentions",
    status: "ready",
    append: true,
    page: { repository: "acme/project", items: [] },
  });
  assert.equal(more?.hidden, true);
  document.querySelector<HTMLButtonElement>("#github-refresh")?.click();
  assert.deepEqual(posted.at(-1), {
    type: "github",
    id: "alpha",
    section: "mentions",
    cursor: undefined,
  });
});

test("local session selection and model controls retain independent session and GPU targets", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  const repository = state.repositories[0]!;
  repository.backend = "local";
  repository.status = "ready";
  repository.view = "local:first";
  repository.localSessions = [
    {
      id: "first",
      status: "ready",
      model: "model GPU 0",
      readOnly: false,
      generatedTokens: 1,
      generation: 0,
      contextTokens: 10,
    },
    {
      id: "second",
      status: "ready",
      model: "model GPU 1",
      readOnly: true,
      generatedTokens: 2,
      generation: 0,
      contextTokens: 20,
    },
  ];
  repository.localSession = { ...repository.localSessions[0]! };
  publish(state);
  document.querySelector<HTMLButtonElement>("#add-session")!.click();
  assert.deepEqual(posted.at(-1), { type: "add-session", id: "alpha" });
  const picker = document.querySelector<HTMLSelectElement>("#session-picker")!;
  assert.equal(picker.options.length, 2);
  picker.value = "local:second";
  picker.dispatchEvent(new dom.window.Event("change"));
  assert.deepEqual(posted.at(-1), {
    type: "select-session",
    id: "alpha",
    view: "local:second",
  });
  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  question.value = "first draft";
  question.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(posted.at(-1), {
    type: "draft",
    id: "alpha",
    text: "first draft",
    view: "local:first",
  });
  repository.view = "local:second";
  repository.localSession = { ...repository.localSessions[1]! };
  state.draft = "second draft";
  publish(state);
  assert.equal(question.value, "second draft");
  repository.view = "local:first";
  repository.localSession = { ...repository.localSessions[0]! };
  state.draft = "";
  publish(state);
  assert.equal(question.value, "first draft");
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: "local-models",
        models: [0, 1].map((deviceId) => ({
          id: `gpu-${deviceId}`,
          modelPath: "/same-model",
          status: "ready",
          placement: { provider: "cuda", deviceId },
          sessions: [
            {
              repositoryId: "alpha",
              localSessionId: deviceId ? "second" : "first",
              cacheTokens: 10,
            },
          ],
        })),
      },
    }),
  );
  document
    .querySelector<HTMLButtonElement>('[data-control-key="session:second"]')!
    .click();
  assert.deepEqual(posted.at(-1), {
    type: "select-local-session",
    id: "alpha",
    localSessionId: "second",
  });
  assert.match(
    document.querySelector('[data-control-key="session:second"]')!.textContent!,
    /read-only/,
  );
  document
    .querySelector<HTMLButtonElement>('[data-control-key="sliding:second"]')!
    .click();
  assert.deepEqual(posted.at(-1), {
    type: "reduce-context",
    id: "alpha",
    mode: "sliding",
    view: "local:second",
  });
  const offload = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-control-key="disk"]',
    ),
  ].find((button) => button.dataset.modelPath === "gpu-1")!;
  offload.click();
  assert.deepEqual(posted.at(-1), {
    type: "local-placement",
    modelPath: "/same-model",
    hostId: "gpu-1",
    placement: { provider: "disk" },
  });
});

test("the session selector lists only this repository's open sessions and targets each Copilot independently", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  const repository = state.repositories[0]!;
  repository.backend = "copilot";
  repository.view = "copilot";
  repository.status = "ready";
  repository.sessions = [
    {
      view: "copilot",
      backend: "copilot",
      open: true,
      status: "ready",
      generation: 0,
    },
    {
      view: "copilot:second",
      backend: "copilot",
      open: true,
      status: "ready",
      generation: 0,
    },
    {
      view: "local:first",
      backend: "local",
      open: true,
      status: "ready",
      generation: 0,
      readOnly: false,
    },
    {
      view: "copilot:closed",
      backend: "copilot",
      open: false,
      status: "saved",
      generation: 0,
    },
  ];
  state.repositories[1]!.sessions = [
    {
      view: "copilot:other-repository",
      backend: "copilot",
      open: true,
      status: "ready",
      generation: 0,
    },
  ];
  publish(state);
  const picker = document.querySelector<HTMLSelectElement>("#session-picker")!;
  assert.deepEqual(
    [...picker.options].map((option) => option.value),
    ["copilot", "copilot:second", "local:first"],
  );
  const firstOption = picker.options[0];
  repository.generatedTokens = 1;
  publish(state);
  assert.equal(picker.options[0], firstOption);
  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  question.value = "First draft";
  question.dispatchEvent(new dom.window.Event("input"));
  picker.value = "copilot:second";
  picker.dispatchEvent(new dom.window.Event("change"));
  assert.deepEqual(posted.at(-1), {
    type: "select-session",
    id: "alpha",
    view: "copilot:second",
  });
  repository.view = "copilot:second";
  state.draft = "Second draft";
  publish(state);
  assert.equal(question.value, "Second draft");
  question.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(posted.at(-1), {
    type: "draft",
    id: "alpha",
    text: "Second draft",
    view: "copilot:second",
  });
  document.querySelector<HTMLButtonElement>("#new-session")!.click();
  assert.deepEqual(posted.at(-1), {
    type: "new-session",
    id: "alpha",
    view: "copilot:second",
  });
  document.querySelector<HTMLButtonElement>("#close-session")!.click();
  assert.deepEqual(posted.at(-1), {
    type: "close-session",
    id: "alpha",
    view: "copilot:second",
  });
  document.querySelector<HTMLButtonElement>("#resume-session")!.click();
  assert.deepEqual(posted.at(-1), {
    type: "resume-session",
    id: "alpha",
    view: "copilot:second",
  });
  document
    .querySelector<HTMLFormElement>("#composer")!
    .dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  assert.equal(posted.at(-1)?.type, "send");
  assert.equal(Reflect.get(posted.at(-1)!, "view"), "copilot:second");
  repository.view = "copilot";
  state.draft = "";
  publish(state);
  assert.equal(question.value, "First draft");
  repository.status = "saved";
  repository.sessions[0]!.open = false;
  repository.sessions[1]!.status = "busy";
  publish(state);
  const activeRepository = document.querySelector<HTMLElement>(
    '#started-repositories [data-repository-id="alpha"]',
  )!;
  assert.ok(activeRepository.classList.contains("session-open"));
  assert.equal(activeRepository.getAttribute("aria-busy"), "true");
});

test("repository navigation selects without opening and explicit controls open and close the selected session", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  assert.equal(
    document.querySelectorAll(".application > aside, .application > section")
      .length,
    2,
  );
  assert.equal(document.querySelectorAll('[role="separator"]').length, 1);
  assert.deepEqual(
    [...document.querySelectorAll("#github-tabs button")].map(
      (button) => button.textContent,
    ),
    ["Issues", "Reviews", "Oldest PRs", "Commits", "Comments", "Mentions"],
  );
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
  publish(state);
  assert.equal(
    document.querySelector<HTMLTextAreaElement>("#question")?.disabled,
    true,
  );
  document.querySelector<HTMLButtonElement>(".repository")?.click();
  assert.deepEqual(posted, [
    { type: "ready" },
    { type: "select", id: "alpha" },
  ]);
  const add = document.querySelector<HTMLButtonElement>("#add-session")!;
  const close = document.querySelector<HTMLButtonElement>("#close-session")!;
  assert.ok(add.disabled);
  state.activeId = "alpha";
  publish(state);
  assert.equal(add.disabled, false);
  assert.ok(close.disabled);
  add.click();
  assert.deepEqual(posted.at(-1), { type: "add-session", id: "alpha" });
  const resume = document.querySelector<HTMLButtonElement>("#resume-session")!;
  const fresh = document.querySelector<HTMLButtonElement>("#new-session")!;
  assert.equal(resume.disabled, false);
  resume.click();
  assert.deepEqual(posted.at(-1), {
    type: "resume-session",
    id: "alpha",
    view: "copilot",
  });
  assert.equal(fresh.disabled, false);
  fresh.click();
  assert.deepEqual(posted.at(-1), {
    type: "new-session",
    id: "alpha",
    view: "copilot",
  });
  for (const status of ["starting", "ready", "busy"] as const) {
    state.repositories[0]!.status = status;
    publish(state);
    assert.equal(resume.hidden, false);
    assert.equal(resume.disabled, status === "starting");
    assert.equal(fresh.disabled, status === "starting");
    assert.equal(close.hidden, false);
    assert.equal(close.disabled, false);
  }
  close.click();
  assert.deepEqual(posted.at(-1), {
    type: "close-session",
    id: "alpha",
    view: "copilot",
  });
  state.repositories[0]!.status = "stopping";
  publish(state);
  assert.ok(add.disabled);
  assert.ok(resume.disabled);
  assert.ok(fresh.disabled);
  assert.ok(close.disabled);
  for (const status of ["saved", "error"] as const) {
    state.repositories[0]!.status = status;
    publish(state);
    assert.equal(add.disabled, false);
    assert.ok(close.disabled);
  }
  document
    .querySelector<HTMLButtonElement>('[data-repository-id="beta"]')!
    .click();
  assert.deepEqual(posted.at(-1), { type: "select", id: "beta" });
  state.activeId = "beta";
  publish(state);
  add.click();
  assert.deepEqual(posted.at(-1), { type: "add-session", id: "beta" });
});

test("the conversation heading groups its actions while the session status sits beside the composer label", async (t) => {
  const { document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "saved";
  publish(state);
  const heading = document.querySelector(".chat-heading");
  assert.ok(heading);
  assert.deepEqual(
    [...heading.children].map((element) => element.id || element.className),
    [
      "active-repository",
      "session-selection",
      "add-session",
      "new-session",
      "close-session",
      "resume-session",
    ],
  );
  assert.equal(
    heading.querySelector("#active-repository")?.textContent,
    "Alpha",
  );
  const composerHeading = document.querySelector(".composer-heading");
  assert.deepEqual(
    [...composerHeading!.children].map(
      (element) => element.textContent?.trim() || element.id,
    ),
    [
      "Message to Copilot",
      "Export session JSON",
      "Session closed - use Resume or New0 generated",
      "composer-info",
    ],
  );
  assert.equal(document.querySelector("#information-filters legend"), null);
  assert.equal(
    document.querySelector("#information-filters")?.getAttribute("aria-label"),
    "Show information",
  );
  assert.equal(document.querySelector(".chat-header h1"), null);
  assert.equal(document.querySelector("#settings"), null);
  assert.equal(document.querySelector("#transfer-session"), null);
  assert.equal(document.querySelector("#restart"), null);
});

test("local session state enables sends, cancellation, close and explicit Copilot switching", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  publish(state);
  state.repositories[0]!.sessions = [
    {
      view: "copilot",
      backend: "copilot",
      status: "ready",
      open: true,
      generation: 0,
    },
    {
      view: "local",
      backend: "local",
      status: "ready",
      open: true,
      generation: 0,
    },
  ];
  state.repositories[0]!.backend = "local";
  publish(state);
  assert.match(
    document.getElementById("session-status")?.textContent ?? "",
    /Local model ready/,
  );
  const question = document.querySelector<HTMLTextAreaElement>("#question")!;
  const send = document.querySelector<HTMLButtonElement>("#send")!;
  const picker = document.querySelector<HTMLSelectElement>("#session-picker")!;
  assert.equal(question.disabled, false);
  assert.ok(send.disabled);
  assert.equal(picker.options.length, 2);
  assert.match(
    document.querySelector<HTMLTextAreaElement>("#question")?.placeholder ?? "",
    /local model/,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>("#close-session")!.disabled,
    false,
  );
  question.value = "raw local prompt";
  question.dispatchEvent(new document.defaultView!.Event("input"));
  document.querySelector<HTMLFormElement>("#composer")!.dispatchEvent(
    new document.defaultView!.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  const sent = posted.at(-1);
  assert.equal(sent?.type, "send");
  assert.ok(sent && "question" in sent);
  assert.equal(sent.question, "raw local prompt");
  assert.match(
    document.getElementById("session-status")?.textContent ?? "",
    /Local model is generating/,
  );
  state.messages = [{ role: "user", content: "raw local prompt" }];
  state.repositories[0]!.status = "busy";
  publish(state);
  document.querySelector<HTMLButtonElement>("#cancel")!.click();
  assert.deepEqual(posted.at(-1), {
    type: "cancel",
    id: "alpha",
    view: "local",
  });
  assert.match(
    document.getElementById("session-status")?.textContent ?? "",
    /Local model is generating/,
  );
  state.repositories[0]!.status = "error";
  publish(state);
  assert.match(
    document.getElementById("session-status")?.textContent ?? "",
    /New to retry/,
  );
  picker.value = "copilot";
  picker.dispatchEvent(new document.defaultView!.Event("change"));
  assert.deepEqual(posted.at(-1), {
    type: "select-session",
    id: "alpha",
    view: "copilot",
  });
  state.repositories[0]!.backend = "copilot";
  state.repositories[0]!.status = "ready";
  publish(state);
  assert.equal(picker.value, "copilot");
});

test("managed startup disables session actions but keeps cancellation available", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  const repository = state.repositories[0]!;
  state.activeId = "alpha";
  repository.backend = "local";
  repository.status = "starting";
  repository.managementBusy = true;
  repository.sessionCount = 1;
  publish(state);
  const close = document.querySelector<HTMLButtonElement>("#close-session")!;
  const add = document.querySelector<HTMLButtonElement>("#add-session")!;
  const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
  assert.equal(close.disabled, true);
  assert.equal(add.disabled, true);
  assert.equal(cancel.disabled, false);
  const count = posted.length;
  close.click();
  add.click();
  assert.equal(posted.length, count);
  document
    .querySelector<HTMLButtonElement>('[data-repository-id="alpha"]')!
    .dispatchEvent(
      new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      }),
    );
  for (const action of [
    "close-session",
    "new-session",
    "resume-session",
    "delete-last-session",
    "delete-all-sessions",
  ]) {
    assert.equal(
      document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
        .disabled,
      true,
    );
  }
  cancel.click();
  assert.deepEqual(posted.at(-1), {
    type: "cancel",
    id: "alpha",
    view: "local",
  });
  repository.backend = "copilot";
  publish(state);
  assert.equal(close.disabled, true);
  repository.managementBusy = false;
  publish(state);
  assert.equal(close.disabled, false);
  repository.backend = "local";
  repository.status = "ready";
  publish(state);
  assert.equal(close.disabled, false);
  assert.equal(add.disabled, false);
});

test("local chat disables PostMortem with an explicit Copilot explanation", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  state.repositories[0]!.backend = "local";
  state.messages = [{ role: "user", content: "Private local conversation" }];
  publish(state);
  document
    .querySelector<HTMLButtonElement>('[data-repository-id="alpha"]')!
    .dispatchEvent(
      new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      }),
    );
  const button = document.querySelector<HTMLButtonElement>(
    '[data-action="postmortem"]',
  )!;
  assert.ok(button.disabled);
  assert.match(button.title, /uses Copilot and is disabled for local/);
  button.click();
  assert.equal(
    posted.some((message) => message.type === "postmortem"),
    false,
  );
  state.repositories[0]!.backend = "copilot";
  publish(state);
  assert.equal(button.disabled, false);
  assert.equal(button.title, "");
});

test("session export is available for the selected session without waiting for Copilot", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  const button = document.querySelector<HTMLButtonElement>("#export-session");
  assert.ok(button);
  publish(state);
  assert.equal(button.disabled, true);
  state.activeId = "alpha";
  publish(state);
  assert.equal(button.disabled, true);
  state.repositories[0]!.hasSavedSession = true;
  state.repositories[0]!.status = "saved";
  publish(state);
  assert.equal(button.disabled, false);
  button.click();
  assert.deepEqual(posted.at(-1), { type: "export-session", id: "alpha" });
  state.repositories[0]!.status = "busy";
  publish(state);
  assert.equal(button.disabled, false);
  for (const status of ["starting", "stopping"] as const) {
    state.repositories[0]!.status = status;
    publish(state);
    assert.equal(button.disabled, true);
  }
  state.activeId = "beta";
  state.messages = [{ role: "user", content: "A different session" }];
  publish(state);
  assert.equal(button.disabled, false);
  button.click();
  assert.deepEqual(posted.at(-1), { type: "export-session", id: "beta" });
});

test("dataset panel lists sessions and validates annotations before saving or exporting", async (t) => {
  const { dom, document, posted } = await setup(t);
  document.querySelector<HTMLButtonElement>('[data-view="dataset"]')!.click();
  assert.deepEqual(posted.at(-1), { type: "dataset-sessions" });
  const sessions = [
    {
      repository: { id: "alpha", name: "Alpha", path: "/projects/alpha" },
      recordId: "record-1",
      sessionId: "session-1",
      backend: "copilot",
      location: "archived",
      models: ["model-a"],
      references: ["#84"],
    },
    {
      repository: { id: "beta", name: "Beta", path: "/projects/beta" },
      recordId: "record-2",
      backend: "local",
      location: "current",
      models: [],
      references: [],
      annotation: { mark: "success", comments: "Good result" },
    },
  ];
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "dataset-sessions", sessions },
    }),
  );
  const rows = document.querySelectorAll<HTMLTableRowElement>(
    "#dataset-table tbody tr",
  );
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.textContent!, /Alpha.*archived.*model-a.*#84/);
  assert.match(rows[1]!.textContent!, /Beta.*success.*Good result/);
  rows[0]!.querySelectorAll<HTMLButtonElement>("button")[0]!.click();
  const form = document.querySelector<HTMLFormElement>("#dataset-annotation")!;
  const mark = document.querySelector<HTMLSelectElement>("#dataset-mark")!;
  const reason =
    document.querySelector<HTMLTextAreaElement>("#dataset-reason")!;
  assert.equal(form.hidden, false);
  mark.value = "failure";
  mark.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(reason.required, true);
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  assert.match(
    document.querySelector("#dataset-error")!.textContent!,
    /reason/i,
  );
  assert.notEqual(posted.at(-1)?.type, "annotate-session");
  reason.value = "Tests failed";
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  assert.deepEqual(posted.at(-1), {
    type: "annotate-session",
    id: "alpha",
    recordId: "record-1",
    annotation: { mark: "failure", reason: "Tests failed", comments: "" },
  });
  assert.equal(reason.disabled, true);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: "dataset-error",
        action: "export-dataset-session",
        message: "Export failed",
      },
    }),
  );
  assert.equal(reason.disabled, true);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "dataset-sessions", sessions, saved: true },
    }),
  );
  assert.equal(form.hidden, true);
  assert.equal(reason.disabled, false);
  const second = document.querySelectorAll<HTMLTableRowElement>(
    "#dataset-table tbody tr",
  )[1]!;
  second.querySelectorAll<HTMLButtonElement>("button")[0]!.click();
  const remove = document.querySelector<HTMLButtonElement>("#dataset-remove")!;
  assert.equal(remove.hidden, false);
  remove.click();
  assert.deepEqual(posted.at(-1), {
    type: "annotate-session",
    id: "beta",
    recordId: "record-2",
    annotation: null,
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "dataset-sessions", sessions, saved: true },
    }),
  );
  document
    .querySelectorAll<HTMLTableRowElement>("#dataset-table tbody tr")[1]!
    .querySelectorAll<HTMLButtonElement>("button")[1]!
    .click();
  assert.deepEqual(posted.at(-1), {
    type: "export-dataset-session",
    id: "beta",
    recordId: "record-2",
  });
});

test("dataset columns sort in both directions and retain sorting after refresh", async (t) => {
  const { dom, document, posted } = await setup(t);
  const sessions: DatasetSession[] = [
    {
      repository: { id: "zeta", name: "Zeta", path: "/projects/zeta" },
      recordId: "record-10",
      sessionId: "session-10",
      backend: "copilot",
      location: "current",
      models: ["model-10"],
      references: ["#10"],
      annotation: { mark: "success" },
    },
    {
      repository: { id: "alpha", name: "alpha", path: "/projects/alpha" },
      recordId: "record-2",
      sessionId: "session-2",
      backend: "copilot",
      location: "current",
      models: ["model-2"],
      references: ["#2"],
      annotation: { mark: "failure", reason: "Tests failed" },
    },
    {
      repository: { id: "beta", name: "Beta", path: "/projects/beta" },
      recordId: "record-1",
      backend: "local",
      location: "archived",
      models: ["model-1"],
      references: ["#1"],
      annotation: { mark: "abandon", reason: "Cancelled" },
    },
  ];
  const publish = (items = sessions): void => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: { type: "dataset-sessions", sessions: items },
      }),
    );
  };
  const table = document.querySelector<HTMLTableElement>("#dataset-table")!;
  const headers = [...table.tHead!.rows[0]!.cells];
  const order = (): string[] =>
    [...table.tBodies[0]!.rows].map((row) => row.cells[0]!.textContent!);
  publish();
  assert.deepEqual(order(), ["Zeta", "alpha", "Beta"]);
  const expected = [
    ["alpha", "Beta", "Zeta"],
    ["alpha", "Zeta", "Beta"],
    ["Beta", "alpha", "Zeta"],
    ["Beta", "alpha", "Zeta"],
    ["Beta", "alpha", "Zeta"],
  ];
  expected.forEach((ascending, column) => {
    const header = headers[column]!;
    const button = header.querySelector("button")!;
    button.click();
    assert.deepEqual(order(), ascending);
    assert.equal(header.getAttribute("aria-sort"), "ascending");
    headers.slice(0, 5).forEach((other, index) => {
      if (index !== column)
        assert.equal(other.getAttribute("aria-sort"), "none");
    });
    button.click();
    assert.deepEqual(order(), [...ascending].reverse());
    assert.equal(header.getAttribute("aria-sort"), "descending");
  });
  assert.equal(headers[5]!.querySelector("button"), null);
  publish();
  assert.deepEqual(order(), ["Zeta", "alpha", "Beta"]);
  const actions = table.tBodies[0]!.rows[1]!.querySelector(".dataset-actions")!;
  const buttons = actions.querySelectorAll<HTMLButtonElement>("button");
  assert.equal(buttons.length, 2);
  buttons[0]!.click();
  assert.match(
    document.querySelector("#dataset-annotation-title")!.textContent!,
    /alpha · session-2/,
  );
  buttons[1]!.click();
  assert.deepEqual(posted.at(-1), {
    type: "export-dataset-session",
    id: "alpha",
    recordId: "record-2",
  });
  publish([
    { ...sessions[2]!, models: [], references: [], annotation: undefined },
  ]);
  assert.match(table.tBodies[0]!.textContent!, /Unknown.*—.*Not annotated/);
  publish([]);
  headers[0]!.querySelector("button")!.click();
  assert.deepEqual(order(), []);
  assert.equal(
    document.querySelector<HTMLElement>("#dataset-empty")!.hidden,
    false,
  );
  publish();
  assert.deepEqual(order(), ["alpha", "Beta", "Zeta"]);
});

test("Settings shows the settings panel without selecting a repository and remains available during work", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  const button = document.querySelector<HTMLButtonElement>(
    '#right-tabs [data-view="settings"]',
  );
  const view = document.querySelector<HTMLElement>("#settings-view");
  assert.ok(button && view);
  assert.equal(view.hidden, true);
  button.click();
  assert.equal(view.hidden, false);
  assert.equal(
    document.querySelector<HTMLElement>("#repository-view")!.hidden,
    true,
  );
  assert.equal(
    document
      .querySelector('#right-tabs [data-view="settings"]')
      ?.getAttribute("aria-pressed"),
    "true",
  );
  assert.deepEqual(posted.at(-1), { type: "copilot-models" });
  document.querySelector<HTMLButtonElement>("#open-vscode-settings")!.click();
  assert.deepEqual(posted.at(-1), { type: "settings" });
  button.click();
  assert.equal(
    posted.filter((message) => message.type === "copilot-models").length,
    1,
  );
  assert.equal(document.querySelector("#change-model"), null);
  state.activeId = "alpha";
  state.repositories[0]!.status = "busy";
  publish(state);
  assert.equal(button.disabled, false);
});

function settingsSender(dom: JSDOM) {
  const base: SettingsState = {
    type: "settings-state",
    cliPath: "copilot",
    localWorkerPath: "devdash-genai-worker",
    requestTimeoutMinutes: 60,
    approvedUrlOrigins: [],
    copilotModel: "",
    copilotModelsStatus: "idle",
    localModelPath: "",
    remoteMachines: [],
    remoteMachine: "",
    localProvider: "auto",
    localDeviceId: -1,
    localDevicesStatus: "idle",
    foundryDevice: "cpu",
    foundryStatus: "idle",
  };
  return (update: Partial<SettingsState>): void => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: { ...base, ...update },
      }),
    );
  };
}

function optionsOf(select: HTMLSelectElement): string[][] {
  return [...select.options].map((option) => [option.value, option.text]);
}

test("harness setting edits wait for initial configuration before saving", async (t) => {
  const { dom, document, posted } = await setup(t);
  const send = settingsSender(dom);
  const origins = document.querySelector<HTMLTextAreaElement>(
    "#approved-url-origins",
  )!;
  const form = document.querySelector<HTMLFormElement>("#harness-settings")!;
  const save = document.querySelector<HTMLButtonElement>(
    "#save-harness-settings",
  )!;
  origins.value = "https://new.example";
  origins.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(save.disabled, true);
  send({ approvedUrlOrigins: ["https://existing.example"] });
  assert.equal(origins.value, "https://new.example");
  assert.equal(save.disabled, false);
  form.requestSubmit();
  assert.deepEqual(posted.at(-1), {
    type: "harness-settings",
    requestId: 1,
    settings: { approvedUrlOrigins: ["https://new.example"] },
    baseApprovedUrlOrigins: ["https://existing.example"],
  });
});

test("the settings panel displays and explicitly saves usual harness settings", async (t) => {
  const { dom, document, posted } = await setup(t);
  const send = settingsSender(dom);
  const cli = document.querySelector<HTMLInputElement>("#cli-path")!;
  const worker =
    document.querySelector<HTMLInputElement>("#local-worker-path")!;
  const timeout = document.querySelector<HTMLInputElement>(
    "#request-timeout-minutes",
  )!;
  const origins = document.querySelector<HTMLTextAreaElement>(
    "#approved-url-origins",
  )!;
  const form = document.querySelector<HTMLFormElement>("#harness-settings")!;
  const settings = {
    cliPath: "/tools/copilot",
    localWorkerPath: "/tools/local worker",
    requestTimeoutMinutes: 15,
    approvedUrlOrigins: ["https://example.com", "http://localhost:8080"],
  };
  send(settings);
  assert.equal(cli.value, settings.cliPath);
  assert.equal(worker.value, settings.localWorkerPath);
  assert.equal(timeout.valueAsNumber, 15);
  assert.equal(origins.value, settings.approvedUrlOrigins.join("\n"));
  const save = document.querySelector<HTMLButtonElement>(
    "#save-harness-settings",
  )!;
  const status = document.querySelector<HTMLElement>(
    "#harness-settings-status",
  )!;
  assert.equal(save.disabled, true);
  cli.value = "/other/copilot";
  cli.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(save.disabled, false);
  send({ ...settings, copilotModelsStatus: "loading" });
  assert.equal(cli.value, "/other/copilot", "async discovery preserves edits");
  assert.equal(
    posted.some((message) => message.type === "harness-settings"),
    false,
  );
  send({ ...settings, approvedUrlOrigins: [] });
  assert.equal(
    origins.value,
    "",
    "external revocations update untouched fields",
  );
  form.requestSubmit();
  assert.deepEqual(posted.at(-1), {
    type: "harness-settings",
    requestId: 1,
    settings: { cliPath: "/other/copilot" },
  });
  assert.equal(save.disabled, true);
  assert.equal(status.textContent, "Saving harness settings...");
  send({ ...settings, cliPath: "/other/copilot" });
  assert.equal(cli.value, "/other/copilot", "submitted edits stay pending");
  cli.value = "/newer/copilot";
  cli.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "harness-settings-result", requestId: 1 },
    }),
  );
  assert.equal(cli.value, "/newer/copilot", "edits during save are preserved");
  assert.equal(save.disabled, false);
  assert.match(status.textContent!, /Newer edits are still unsaved/);
  form.requestSubmit();
  assert.deepEqual(posted.at(-1), {
    type: "harness-settings",
    requestId: 2,
    settings: { cliPath: "/newer/copilot" },
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "harness-settings-result", requestId: 2 },
    }),
  );
  assert.equal(save.disabled, true);

  send(settings);
  origins.value = " https://example.com \n\nhttp://localhost:8080\n";
  origins.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  send({ ...settings, copilotModelsStatus: "ready" });
  assert.equal(
    origins.value,
    " https://example.com \n\nhttp://localhost:8080\n",
  );
  form.requestSubmit();
  assert.deepEqual(posted.at(-1), {
    type: "harness-settings",
    requestId: 3,
    settings: { approvedUrlOrigins: settings.approvedUrlOrigins },
    baseApprovedUrlOrigins: settings.approvedUrlOrigins,
  });
  send({ ...settings, approvedUrlOrigins: [] });
  assert.equal(
    origins.value,
    " https://example.com \n\nhttp://localhost:8080\n",
    "settings updates do not replace the origin list while saving",
  );
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: "harness-settings-result",
        requestId: 3,
        error: "Configuration is read-only.",
      },
    }),
  );
  assert.equal(save.disabled, false);
  assert.match(status.textContent!, /read-only/);
  assert.equal(
    origins.value,
    " https://example.com \n\nhttp://localhost:8080\n",
    "failed saves retain pending values",
  );
  send(settings);
  assert.equal(cli.value, settings.cliPath, "external settings synchronize");
  assert.equal(
    origins.value,
    " https://example.com \n\nhttp://localhost:8080\n",
    "failed origin edit remains dirty",
  );
  form.requestSubmit();
  assert.deepEqual(posted.at(-1), {
    type: "harness-settings",
    requestId: 4,
    settings: { approvedUrlOrigins: settings.approvedUrlOrigins },
    baseApprovedUrlOrigins: settings.approvedUrlOrigins,
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: "harness-settings-result",
        requestId: 4,
        approvedUrlOrigins: settings.approvedUrlOrigins,
      },
    }),
  );
  origins.value = "";
  origins.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  form.requestSubmit();
  assert.deepEqual(posted.at(-1), {
    type: "harness-settings",
    requestId: 5,
    settings: { approvedUrlOrigins: [] },
    baseApprovedUrlOrigins: settings.approvedUrlOrigins,
  });
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "harness-settings-result", requestId: 5 },
    }),
  );
  for (const invalid of ["", "0", "1.5", "35792"]) {
    timeout.value = invalid;
    timeout.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const count = posted.length;
    form.requestSubmit();
    assert.equal(posted.length, count, `invalid timeout: ${invalid}`);
  }
});

test("the settings panel lists Copilot models and saves the chosen model", async (t) => {
  const { dom, document, posted } = await setup(t);
  const send = settingsSender(dom);
  const select = document.querySelector<HTMLSelectElement>("#copilot-model")!;
  const refresh = document.querySelector<HTMLButtonElement>(
    "#refresh-copilot-models",
  )!;
  const status = document.querySelector<HTMLElement>("#copilot-model-status")!;
  const error = document.querySelector<HTMLElement>("#copilot-model-error")!;
  send({ copilotModel: "old-model" });
  assert.deepEqual(optionsOf(select), [
    ["", "CLI default"],
    ["old-model", "old-model (configured)"],
  ]);
  assert.equal(select.value, "old-model");
  send({ copilotModel: "old-model", copilotModelsStatus: "loading" });
  assert.equal(refresh.disabled, true);
  assert.equal(status.textContent, "Loading Copilot models...");
  send({
    copilotModel: "old-model",
    copilotModelsStatus: "ready",
    copilotModels: [
      { id: "gpt-x", name: "GPT X" },
      { id: "plain", name: "plain" },
    ],
  });
  assert.equal(refresh.disabled, false);
  assert.equal(status.textContent, "2 model(s) available.");
  assert.deepEqual(optionsOf(select), [
    ["", "CLI default"],
    ["gpt-x", "GPT X (gpt-x)"],
    ["plain", "plain"],
    ["old-model", "old-model (configured)"],
  ]);
  select.value = "gpt-x";
  select.dispatchEvent(new dom.window.Event("change"));
  assert.deepEqual(posted.at(-1), { type: "copilot-model", model: "gpt-x" });
  refresh.click();
  assert.deepEqual(posted.at(-1), { type: "copilot-models" });
  send({ copilotModelsStatus: "error", copilotModelsError: "No CLI." });
  assert.equal(select.value, "");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "No CLI.");
});

test("the settings panel chooses a local model source", async (t) => {
  const { dom, document, posted } = await setup(t);
  const send = settingsSender(dom);
  const path = document.querySelector<HTMLElement>("#local-model-path")!;
  assert.equal(path.textContent, "No local model is selected.");
  const choose = document.querySelector<HTMLButtonElement>(
    "#choose-local-model",
  )!;
  assert.match(choose.title, /local Transformers checkpoint/);
  assert.match(choose.title, /Hugging Face model ID/);
  choose.click();
  assert.deepEqual(posted.at(-1), { type: "local-model" });
  send({ localModelPath: "/models/phi" });
  assert.equal(path.textContent, "/models/phi");
});

test("the settings panel detects local devices and saves the chosen device", async (t) => {
  const { dom, document, posted } = await setup(t);
  const send = settingsSender(dom);
  const select = document.querySelector<HTMLSelectElement>("#local-device")!;
  const detect = document.querySelector<HTMLButtonElement>(
    "#detect-local-devices",
  )!;
  const status = document.querySelector<HTMLElement>("#local-device-status")!;
  const error = document.querySelector<HTMLElement>("#local-device-error")!;
  send({ localProvider: "cuda", localDeviceId: 1 });
  assert.deepEqual(optionsOf(select), [
    ["auto:-1", "Automatic (prefer CUDA)"],
    ["cuda:1", "CUDA device 1 (configured)"],
  ]);
  assert.equal(select.value, "cuda:1");
  detect.click();
  assert.deepEqual(posted.at(-1), { type: "local-devices" });
  send({
    localProvider: "cuda",
    localDeviceId: 1,
    localDevicesStatus: "loading",
  });
  assert.equal(detect.disabled, true);
  assert.equal(status.textContent, "Detecting local devices...");
  send({
    localProvider: "cuda",
    localDeviceId: 1,
    localDevicesStatus: "ready",
    localDevices: [
      { provider: "cpu", deviceId: 0, name: "CPU" },
      { provider: "cuda", deviceId: 0, name: "RTX" },
    ],
  });
  assert.equal(detect.disabled, false);
  assert.equal(status.textContent, "2 device(s) detected.");
  assert.deepEqual(optionsOf(select), [
    ["auto:-1", "Automatic (prefer CUDA)"],
    ["cpu:0", "CPU - CPU (device 0)"],
    ["cuda:0", "CUDA - RTX (device 0)"],
    ["cuda:1", "CUDA device 1 (configured)"],
  ]);
  select.value = "cpu:0";
  select.dispatchEvent(new dom.window.Event("change"));
  assert.deepEqual(posted.at(-1), {
    type: "local-device",
    provider: "cpu",
    deviceId: 0,
  });
  send({
    localDevicesStatus: "error",
    localDevicesError: "No usable CPU or GPU was found.",
  });
  assert.equal(select.value, "auto:-1");
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "No usable CPU or GPU was found.");
});

test("the settings panel lists Foundry Local models and downloads the chosen variant", async (t) => {
  const { dom, document, posted } = await setup(t);
  const send = settingsSender(dom);
  const byId = <T extends HTMLElement>(id: string): T =>
    document.querySelector<T>(`#${id}`)!;
  const device = byId<HTMLSelectElement>("foundry-device");
  const select = byId<HTMLSelectElement>("foundry-model");
  const download = byId<HTMLButtonElement>("download-foundry-model");
  const cancel = byId<HTMLButtonElement>("cancel-foundry");
  const status = byId<HTMLElement>("foundry-status");
  const details = byId<HTMLElement>("foundry-model-details");
  assert.equal(select.disabled, true);
  assert.equal(download.disabled, true);
  byId<HTMLButtonElement>("list-foundry-models").click();
  assert.deepEqual(posted.at(-1), { type: "foundry-models", device: "cpu" });
  device.value = "gpu";
  device.dispatchEvent(new dom.window.Event("change"));
  assert.deepEqual(posted.at(-1), { type: "foundry-models", device: "gpu" });
  send({ foundryDevice: "gpu", foundryStatus: "loading" });
  assert.equal(cancel.hidden, false);
  assert.equal(status.textContent, "Listing Foundry Local models...");
  cancel.click();
  assert.deepEqual(posted.at(-1), { type: "foundry-cancel" });
  const GiB = 1024 ** 3;
  const base = {
    device: "gpu",
    provider: "CUDAExecutionProvider",
    localProvider: "cuda" as const,
    task: "chat-completion",
    license: "MIT",
  };
  const catalog = {
    models: [
      {
        ...base,
        id: "azureml://registries/azureml/models/a/versions/1",
        name: "a:1",
        size: 1536 * 1024 ** 2,
        memory: 2 * GiB,
        memoryLimit: 8 * GiB,
      },
      {
        ...base,
        id: "azureml://registries/azureml/models/b/versions/1",
        name: "b:1",
        size: 1024,
      },
    ],
    memory: { ram: 32 * GiB, nvidia: 8 * GiB },
    hidden: 3,
    unchecked: 1,
    unsupported: 4,
  };
  send({
    foundryDevice: "gpu",
    foundryStatus: "ready",
    foundryCatalog: catalog,
  });
  assert.equal(device.value, "gpu");
  assert.deepEqual(optionsOf(select), [
    [catalog.models[0]!.id, "a:1 - 1.5 GiB"],
    [catalog.models[1]!.id, "b:1 - 1 KiB"],
  ]);
  assert.match(details.textContent!, /CUDAExecutionProvider.*MIT.*2 GiB$/);
  assert.match(
    status.textContent!,
    /2 model.*3 hidden.*4 unsupported.*RAM: 32 GiB.*VRAM: 8 GiB/,
  );
  select.value = catalog.models[1]!.id;
  select.dispatchEvent(new dom.window.Event("change"));
  assert.match(details.textContent!, /memory unknown \(unverified\)/);
  download.click();
  assert.deepEqual(posted.at(-1), {
    type: "foundry-download",
    id: catalog.models[1]!.id,
  });
  send({
    foundryDevice: "gpu",
    foundryStatus: "ready",
    foundryCatalog: catalog,
    foundryDownload: {
      id: catalog.models[1]!.id,
      name: "b:1",
      received: 512,
      total: 1024,
    },
  });
  assert.equal(select.value, catalog.models[1]!.id);
  assert.equal(download.disabled, true);
  assert.equal(device.disabled, true);
  assert.equal(cancel.hidden, false);
  assert.equal(status.textContent, "Downloading b:1: 512 bytes / 1 KiB (50%)");
  send({
    foundryDevice: "gpu",
    foundryStatus: "ready",
    foundryCatalog: catalog,
    foundryError: "Download cancelled.",
    localModelPath: "/cache/foundry/v1",
  });
  assert.equal(download.disabled, false);
  assert.equal(cancel.hidden, true);
  assert.equal(
    byId<HTMLElement>("foundry-error").textContent,
    "Download cancelled.",
  );
});

test("streaming changes only the affected message and preserves repository controls and expanded evidence", async (t) => {
  const { document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "busy";
  state.messages = [
    {
      role: "tool",
      content: "npm test",
      title: "bash - running",
      details: "Recorded command",
    },
    { role: "assistant", content: "Answer" },
  ];
  publish(state);
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="system"]',
    )
    ?.click();
  const first = document.querySelector<HTMLElement>("#messages article");
  const repository = document.querySelector(".repository");
  const details = first?.querySelector("details");
  assert.ok(first && details);
  details.open = true;
  for (let index = 0; index < 20; index++) {
    state.messages[1]!.content += ".";
    publish(state);
  }
  assert.equal(document.querySelector("#messages article"), first);
  assert.equal(document.querySelector(".repository"), repository);
  assert.equal(first.querySelector("details"), details);
  assert.equal(details.open, true);
  assert.match(
    document.querySelector("#messages article:last-child")?.textContent ?? "",
    /Answer\.{20}/,
  );
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="tools"]',
    )
    ?.click();
  assert.equal(document.querySelector("#messages article"), first);
  assert.equal(first.hidden, true);
  state.messages[0]!.title = "bash - failed";
  state.messages[0]!.error = true;
  state.messages[0]!.details = "Updated evidence";
  publish(state);
  const updated = document.querySelector<HTMLElement>("#messages article");
  assert.notEqual(updated, first);
  assert.equal(updated?.hidden, false);
  assert.equal(updated?.querySelector("details")?.open, true);
  assert.match(
    updated?.querySelector("details")?.textContent ?? "",
    /Updated evidence/,
  );
  state.messages.pop();
  publish(state);
  assert.equal(document.querySelectorAll("#messages article").length, 1);
  state.repositories[0]!.generation = 1;
  publish(state);
  assert.notEqual(document.querySelector("#messages article"), updated);
  assert.equal(
    document.querySelector("#messages details")?.hasAttribute("open"),
    false,
  );
  state.activeId = "beta";
  state.messages = [{ role: "assistant", content: "Independent conversation" }];
  publish(state);
  assert.equal(document.querySelectorAll("#messages article").length, 1);
  assert.match(
    document.getElementById("messages")?.textContent ?? "",
    /Independent conversation/,
  );
  assert.doesNotMatch(
    document.getElementById("messages")?.textContent ?? "",
    /Updated evidence/,
  );
});

test("PostMortem renders a safe evidence-linked table independently of transcript filters and exports its JSON", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  state.messages = [
    { role: "user", content: "Produce the feature" },
    {
      role: "tool",
      content: "npm test\n<script>not HTML</script>",
      details: '{"command":"npm test"}',
    },
    { role: "assistant", content: "Committed abcdef0123456789" },
  ];
  publish(state);
  document
    .querySelector<HTMLButtonElement>('[data-repository-id="alpha"]')!
    .dispatchEvent(
      new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      }),
    );
  const button = document.querySelector<HTMLButtonElement>(
    '[data-action="postmortem"]',
  );
  assert.ok(button);
  assert.equal(button.disabled, false);
  button.click();
  assert.deepEqual(posted.at(-1), { type: "postmortem", id: "alpha" });
  state.postMortemBusy = true;
  state.repositories[0]!.status = "stopping";
  publish(state);
  document
    .querySelector<HTMLButtonElement>('[data-repository-id="alpha"]')!
    .dispatchEvent(
      new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      }),
    );
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-action="postmortem"]')
      ?.disabled,
    true,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>("#cancel")?.disabled,
    false,
  );
  assert.match(
    document.getElementById("postmortem-status")?.textContent ?? "",
    /^Starting\.\.\. Separate tool-free/,
  );
  state.postMortemProgress = "Analysing records 3-4 of 9 (model request 2)...";
  publish(state);
  for (const id of ["postmortem-status", "session-status"]) {
    assert.match(
      document.getElementById(id)?.textContent ?? "",
      /Analysing records 3-4 of 9 \(model request 2\)/,
    );
  }
  state.postMortemProgress = undefined;
  state.postMortemBusy = false;
  state.repositories[0]!.status = "ready";
  state.postMortem = {
    version: 1,
    repository: { id: "alpha", name: "Alpha", path: "/projects/alpha" },
    generatedAt: "2026-01-01T12:00:00Z",
    sourceCount: 3,
    sourceHash: "a".repeat(64),
    rows: [
      {
        phase: "Implementation",
        objective: "Produce the feature",
        production: "<img src=x onerror=alert(1)>",
        filesAndCommits: "src/feature.ts; abcdef0123456789",
        validation: "npm test",
        errors: "Not recorded",
        firstMessage: 1,
        lastMessage: 3,
      },
    ],
  };
  publish(state);
  assert.equal(
    document.querySelectorAll("#postmortem-report tbody tr").length,
    1,
  );
  assert.equal(
    document.querySelector("#postmortem-report img, #postmortem-report script"),
    null,
  );
  const details = document.querySelector<HTMLDetailsElement>(
    "#postmortem-report details",
  );
  assert.ok(details);
  assert.equal(details.querySelector("pre"), null);
  details.open = true;
  details.dispatchEvent(new dom.window.Event("toggle"));
  assert.match(details.textContent ?? "", /npm test/);
  assert.match(details.textContent ?? "", /<script>not HTML<\/script>/);
  const cells = document.querySelector("#postmortem-table table");
  state.postMortemBusy = true;
  state.postMortemProgress = "Analysing records 1-3 of 3 (model request 1)...";
  publish(state);
  assert.equal(document.querySelector("#postmortem-table table"), cells);
  assert.equal(details.open, true);
  assert.match(
    document.getElementById("postmortem-status")?.textContent ?? "",
    /Analysing records 1-3 of 3/,
  );
  state.postMortemProgress = "Analysing records 3-3 of 3 (model request 2)...";
  publish(state);
  assert.equal(document.querySelector("#postmortem-table table"), cells);
  assert.equal(details.open, true);
  state.postMortemBusy = false;
  state.postMortemProgress = undefined;
  publish(state);
  assert.equal(document.querySelector("#postmortem-table table"), cells);
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="messages"]',
    )
    ?.click();
  assert.equal(document.getElementById("postmortem-report")?.hidden, false);
  document.querySelector<HTMLButtonElement>("#export-postmortem")?.click();
  assert.deepEqual(posted.at(-1), { type: "export-postmortem", id: "alpha" });
  state.messages.push({ role: "user", content: "Later work" });
  publish(state);
  assert.match(
    document.getElementById("postmortem-status")?.textContent ?? "",
    /New exchanges are not included/,
  );
  state.activeId = "beta";
  state.messages = [];
  state.postMortem = undefined;
  publish(state);
  assert.equal(document.getElementById("postmortem-report")?.hidden, true);
  assert.equal(
    document.querySelector<HTMLButtonElement>("#export-postmortem")?.disabled,
    true,
  );
});

test("the first repository box groups active sessions and moves closed sessions back without duplicates", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  const started = document.getElementById("started-repositories");
  const others = document.getElementById("other-repositories");
  assert.ok(started && others);
  const ids = (group: HTMLElement): string[] =>
    [...group.querySelectorAll<HTMLButtonElement>(".repository")].map(
      (button) => button.dataset.repositoryId!,
    );
  publish(state);
  assert.equal(
    document.querySelector(".repository-group h3")?.textContent,
    "Active sessions",
  );
  assert.deepEqual(ids(started), []);
  assert.match(started.textContent ?? "", /No active session/);
  assert.deepEqual(ids(others), ["alpha", "beta"]);
  for (const status of ["starting", "ready", "busy", "stopping"] as const) {
    state.repositories[1]!.status = status;
    publish(state);
    assert.deepEqual(ids(started), ["beta"]);
    assert.deepEqual(ids(others), ["alpha"]);
    assert.equal(document.querySelectorAll(".repository").length, 2);
  }
  state.repositories[1]!.status = "ready";
  publish(state);
  started.querySelector<HTMLButtonElement>(".repository")?.click();
  assert.deepEqual(posted.at(-1), { type: "select", id: "beta" });
  started.querySelector<HTMLButtonElement>(".repository")?.dispatchEvent(
    new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    }),
  );
  document
    .querySelector<HTMLButtonElement>('[data-action="close-session"]')
    ?.click();
  assert.deepEqual(posted.at(-1), { type: "close-session", id: "beta" });
  for (const status of ["saved", "error", "idle"] as const) {
    state.repositories[1]!.status = status;
    publish(state);
    assert.deepEqual(ids(started), []);
    assert.deepEqual(ids(others), ["alpha", "beta"]);
  }
  state.repositories.forEach((repository) => {
    repository.status = "ready";
  });
  publish(state);
  assert.deepEqual(ids(started), ["alpha", "beta"]);
  assert.deepEqual(ids(others), []);
  assert.match(
    others.textContent ?? "",
    /All repositories have an active session/,
  );
  state.repositories = [];
  publish(state);
  assert.match(started.textContent ?? "", /No active session/);
  assert.match(others.textContent ?? "", /No direct child repository/);
  assert.equal(document.querySelectorAll(".repository").length, 0);
});

test("right-click menus manage the clicked repository and confirm irreversible deletion without popups", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.repositories.forEach((entry) => {
    entry.status = "ready";
    entry.sessionCount = 2;
  });
  state.activeId = "alpha";
  publish(state);
  const menu = document.getElementById("repository-menu");
  assert.ok(menu);
  const open = (id: string): HTMLButtonElement => {
    const repository = [
      ...document.querySelectorAll<HTMLButtonElement>(".repository"),
    ].find((button) => button.dataset.repositoryId === id);
    assert.ok(repository);
    const event = new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    });
    repository.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(menu.hidden, false);
    return repository;
  };
  const action = (name: string): HTMLButtonElement => {
    const button = menu.querySelector<HTMLButtonElement>(
      `[data-action="${name}"]`,
    );
    assert.ok(button);
    return button;
  };
  open("beta");
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
  const close = action("close-session");
  state.repositories[0]!.status = "busy";
  publish(state);
  assert.equal(document.activeElement, action("add-session"));
  close.click();
  assert.deepEqual(posted.at(-1), { type: "close-session", id: "beta" });
  open("alpha");
  action("new-session").click();
  assert.deepEqual(posted.at(-1), { type: "new-session", id: "alpha" });
  open("alpha");
  action("resume-session").click();
  assert.deepEqual(posted.at(-1), { type: "resume-session", id: "alpha" });
  open("beta");
  const count = posted.length;
  action("delete-last-session").click();
  assert.equal(menu.hidden, false);
  assert.equal(posted.length, count);
  assert.match(menu.textContent ?? "", /latest session.*Beta.*Copilot history/);
  action("delete-last-session").click();
  assert.deepEqual(posted.at(-1), { type: "delete-last-session", id: "beta" });
  open("beta");
  action("delete-all-sessions").click();
  menu.querySelector<HTMLButtonElement>("button:last-child")?.click();
  assert.equal(posted.length, count + 1);
  const beta = open("beta");
  menu.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, beta);
  beta.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true }),
  );
  assert.equal(menu.hidden, false);
  menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End" }));
  assert.equal(document.activeElement, action("delete-all-sessions"));
  action("delete-all-sessions").click();
  action("delete-all-sessions").click();
  assert.deepEqual(posted.at(-1), { type: "delete-all-sessions", id: "beta" });
  state.repositories[1]!.sessionCount = 0;
  state.repositories[1]!.status = "idle";
  publish(state);
  open("beta");
  assert.equal(action("close-session").disabled, true);
  assert.equal(action("delete-last-session").disabled, true);
  assert.equal(action("new-session").disabled, false);
  document.getElementById("root")?.click();
  assert.equal(menu.hidden, true);
});

test("fresh and restored sessions replace cached drafts even when the repository stays selected", async (t) => {
  const { document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.repositories[0]!.status = "ready";
  state.repositories[0]!.generation = 0;
  publish(state);
  const input = document.querySelector<HTMLTextAreaElement>("#question");
  assert.ok(input);
  input.value = "Old draft";
  state.repositories[0]!.generation = 1;
  state.draft = "";
  publish(state);
  assert.equal(input.value, "");
  input.value = "New draft";
  state.activeId = "beta";
  publish(state);
  state.repositories[0]!.generation = 2;
  publish(state);
  state.activeId = "alpha";
  state.draft = "Restored older draft";
  publish(state);
  assert.equal(input.value, "Restored older draft");
});

test("activity icons follow startup and generation independently for each repository", async (t) => {
  const { document, publish, state } = await setup(t);
  const icon = document.getElementById("activity-icon");
  assert.ok(icon);
  state.activeId = "alpha";
  state.repositories[0]!.status = "starting";
  state.repositories[1]!.status = "busy";
  publish(state);
  assert.equal(icon.hidden, false);
  assert.equal(document.querySelectorAll(".repository .spinner").length, 2);
  assert.equal(
    document.getElementById("chat-panel")?.getAttribute("aria-busy"),
    "true",
  );
  state.repositories[0]!.status = "ready";
  publish(state);
  assert.equal(icon.hidden, true);
  assert.equal(document.querySelectorAll(".repository .spinner").length, 1);
  state.repositories[1]!.status = "error";
  state.activeId = "beta";
  publish(state);
  assert.equal(icon.hidden, true);
  assert.equal(document.querySelectorAll(".repository .spinner").length, 0);
});

test("repository indicators distinguish an open session from work independently of selection", async (t) => {
  const { document, publish, state } = await setup(t);
  state.activeId = "beta";
  const alpha = state.repositories[0]!;
  const repository = (): HTMLButtonElement => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-repository-id="alpha"]',
    );
    assert.ok(button);
    return button;
  };
  alpha.status = "ready";
  publish(state);
  assert.equal(repository().getAttribute("aria-pressed"), "false");
  assert.equal(repository().classList.contains("session-open"), true);
  assert.equal(repository().classList.contains("session-working"), false);
  assert.ok(repository().querySelector(".session-indicator"));
  assert.match(repository().textContent ?? "", /Session open - ready/);
  alpha.status = "busy";
  publish(state);
  assert.equal(repository().classList.contains("session-open"), true);
  assert.equal(repository().classList.contains("session-working"), true);
  assert.equal(repository().getAttribute("aria-busy"), "true");
  assert.ok(repository().querySelector(".spinner"));
  assert.equal(repository().querySelector(".session-indicator"), null);
  assert.match(repository().textContent ?? "", /Copilot is working/);
  assert.equal(
    document.querySelector('[data-repository-id="beta"]')?.className,
    "repository",
  );
  state.activeId = "alpha";
  alpha.status = "ready";
  publish(state);
  assert.equal(repository().getAttribute("aria-pressed"), "true");
  assert.equal(repository().classList.contains("session-open"), true);
  assert.equal(repository().classList.contains("session-working"), false);
  for (const status of ["saved", "error", "idle"] as const) {
    alpha.status = status;
    publish(state);
    assert.equal(repository().classList.contains("session-open"), false);
    assert.equal(repository().classList.contains("session-working"), false);
    assert.equal(repository().getAttribute("aria-busy"), "false");
    assert.equal(
      repository().querySelector(".session-indicator, .spinner"),
      null,
    );
  }
});

test("the merged sidebar divider resizes with pointer and keyboard while preserving both panel widths", async (t) => {
  const { dom, document } = await setup(t);
  const layout = document.querySelector<HTMLElement>(".application");
  const right = document.getElementById("right-divider");
  assert.ok(layout && right);
  assert.equal(document.getElementById("left-divider"), null);
  assert.equal(document.querySelectorAll(".divider").length, 1);
  // jsdom has no layout engine; supply only the container's measured width.
  Object.defineProperty(layout, "clientWidth", {
    value: 1006,
    configurable: true,
  });
  const pointer = (
    target: EventTarget,
    type: string,
    x: number,
    id = 1,
  ): void => {
    const event = new dom.window.MouseEvent(type, {
      clientX: x,
      button: 0,
      bubbles: true,
    });
    Object.defineProperty(event, "pointerId", { value: id });
    target.dispatchEvent(event);
  };
  const widths = (): number[] =>
    layout.style.gridTemplateColumns
      .split(" ")
      .filter((part) => part.endsWith("fr"))
      .map(parseFloat);
  pointer(right, "pointerdown", 750);
  pointer(document, "pointermove", 830, 2);
  assert.equal(layout.style.gridTemplateColumns, "");
  pointer(document, "pointermove", 830);
  const afterPointer = widths();
  assert.equal(afterPointer.length, 2);
  assert.ok(afterPointer[0]! > 0.75);
  assert.equal(document.body.classList.contains("resizing"), true);
  pointer(document, "pointerup", 830);
  pointer(document, "pointermove", 900);
  assert.deepEqual(widths(), afterPointer);
  assert.equal(document.body.classList.contains("resizing"), false);
  right.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      cancelable: true,
    }),
  );
  assert.ok(widths()[1]! > afterPointer[1]!);
  pointer(right, "pointerdown", 800);
  pointer(document, "pointermove", 100_000);
  assert.ok(widths().every((width) => width > 0));
  assert.ok(widths()[1]! * 1000 >= 140 - 1e-10);
  assert.ok(
    Math.abs(widths().reduce((sum, width) => sum + width, 0) - 1) < 1e-10,
  );
  dom.window.dispatchEvent(new dom.window.Event("blur"));
  assert.equal(document.body.classList.contains("resizing"), false);
  assert.notEqual(right.getAttribute("aria-valuenow"), null);
  Object.defineProperty(layout, "clientWidth", { value: 206 });
  pointer(right, "pointerdown", 100);
  pointer(document, "pointermove", -100_000);
  assert.ok(widths().every((width) => width > 0));
  assert.equal(widths().length, 2);
  pointer(document, "pointercancel", -100_000);
  assert.equal(document.body.classList.contains("resizing"), false);
});

test("long transcripts preserve unchanged nodes and scroll position during updates and resizing", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.messages = Array.from({ length: 300 }, (_, index) => ({
    role: "assistant",
    content: `## Message ${index}\n\nSome content with $x^2$.`,
  }));
  state.messages.push({
    role: "tool",
    content: "Run tests",
    details: '{"command":"npm test"}',
  });
  publish(state);
  const transcript = document.getElementById("messages")!;
  const articles = [...transcript.children];
  const details = transcript.querySelector("details")!;
  details.open = true;
  Object.defineProperties(transcript, {
    scrollHeight: { value: 30_000 },
    clientHeight: { value: 600 },
  });
  transcript.scrollTop = 500;
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(transcript, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  publish(state);
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  assert.equal(observer.takeRecords().length, 0);
  assert.equal(transcript.scrollTop, 500);

  state.messages[299]!.content += "\n\nStreaming continuation";
  state.messages.push({ role: "assistant", content: "New response" });
  publish(state);
  for (let index = 0; index < 299; index++) {
    assert.equal(transcript.children[index], articles[index]);
  }
  assert.notEqual(transcript.children[299], articles[299]);
  assert.match(
    transcript.children[299]!.textContent ?? "",
    /Streaming continuation/,
  );
  assert.equal(transcript.children[300], articles[300]);
  assert.equal(transcript.children.length, 302);
  assert.equal(details.open, true);
  assert.equal(transcript.scrollTop, 500);
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="messages"]',
    )!
    .click();
  assert.equal(transcript.children[0], articles[0]);
  assert.equal((articles[0] as HTMLElement).hidden, true);
  observer.disconnect();
});

test("following the transcript reveals its last message before measuring the scroll height", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  const revealed: Element[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  dom.window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  dom.window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  const flushFrames = (): void => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  };
  Object.defineProperty(dom.window.Element.prototype, "scrollIntoView", {
    value(this: Element, options: ScrollIntoViewOptions) {
      assert.equal(options.block, "end");
      revealed.push(this);
    },
  });
  const transcript = document.getElementById("messages")!;
  Object.defineProperties(transcript, {
    scrollHeight: { get: () => (revealed.length ? 2000 : 1000) },
    clientHeight: { value: 600 },
  });
  state.activeId = "alpha";
  state.messages = [
    { role: "assistant", content: "Latest response" },
    { role: "system", content: "Hidden trailing event" },
  ];
  publish(state);
  assert.equal(transcript.scrollTop, 1000);
  flushFrames();
  assert.equal(revealed.at(-1), transcript.firstElementChild);
  assert.equal(transcript.scrollTop, 2000);
  transcript.scrollTop = 1400;
  state.messages[0]!.content += " continued";
  publish(state);
  flushFrames();
  assert.equal(revealed.length, 2);
  assert.equal(revealed.at(-1), transcript.firstElementChild);
  transcript.scrollTop = 100;
  publish(state);
  flushFrames();
  assert.equal(revealed.length, 2);
  assert.equal(transcript.scrollTop, 100);
  transcript.scrollTop = 1400;
  publish(state);
  transcript.scrollTop = 100;
  flushFrames();
  assert.equal(revealed.length, 2);
  assert.equal(transcript.scrollTop, 100);
  state.activeId = "beta";
  publish(state);
  transcript.scrollTop = 100;
  publish(state);
  assert.equal(frames.size, 0);
  assert.equal(transcript.scrollTop, 100);
});

test("message reuse handles metadata changes, truncation, session switches and resets", async (t) => {
  const { document, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.messages = [
    { role: "assistant", content: "First" },
    { role: "output", content: "Second" },
  ];
  publish(state);
  const transcript = document.getElementById("messages")!;
  const first = transcript.firstElementChild;
  state.messages[1] = {
    role: "tool",
    content: "Second",
    title: "Command failed",
    error: true,
    timestamp: "2026-01-01T12:00:00Z",
    agentId: "worker",
    details: '{"exitCode":1}',
  };
  publish(state);
  assert.equal(transcript.firstElementChild, first);
  assert.ok(transcript.children[1]!.classList.contains("failed"));
  assert.equal((transcript.children[1] as HTMLElement).hidden, false);
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="system"]',
    )!
    .click();
  assert.match(transcript.children[1]!.textContent ?? "", /\[worker\]/);
  assert.ok(transcript.querySelector("time"));
  const details = transcript.querySelector("details")!;
  details.open = true;
  state.messages[1]!.details = '{"exitCode":2}';
  publish(state);
  assert.equal(transcript.querySelector("details")?.open, true);
  assert.match(
    transcript.querySelector("details pre")?.textContent ?? "",
    /"exitCode":2/,
  );
  state.messages.pop();
  publish(state);
  assert.equal(transcript.children.length, 1);
  const beforeSwitch = transcript.firstElementChild;
  state.activeId = "beta";
  publish(state);
  assert.notEqual(transcript.firstElementChild, beforeSwitch);
  const beforeReset = transcript.firstElementChild;
  state.repositories[1]!.generation = 1;
  publish(state);
  assert.notEqual(transcript.firstElementChild, beforeReset);
  state.messages = [];
  publish(state);
  assert.equal(transcript.children.length, 0);
});

test("transcript CSS skips off-screen layout and remembers rendered message heights", async (t) => {
  const { document } = await setup(t);
  const style = document.createElement("style");
  style.textContent = await readFile(
    join(__dirname, "../../media/app.css"),
    "utf8",
  );
  document.head.append(style);
  const rule = [...style.sheet!.cssRules].find(
    (rule) => "selectorText" in rule && rule.selectorText === ".message",
  ) as CSSStyleRule;
  assert.ok(rule);
  assert.equal(rule.style.getPropertyValue("content-visibility"), "auto");
  assert.equal(
    rule.style.getPropertyValue("contain-intrinsic-block-size"),
    "auto 160px",
  );
});

test("chat sends to the selected repository, blocks double submission and renders safe HTML equations", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  const alpha = state.repositories[0];
  assert.ok(alpha);
  alpha.status = "ready";
  state.activeId = "alpha";
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  const form = document.getElementById("composer");
  assert.ok(question && form);
  question.value = "Explain $x^2$.";
  question.dispatchEvent(new dom.window.Event("input"));
  for (let attempt = 0; attempt < 2; attempt++) {
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  }
  assert.deepEqual(
    posted.filter((message) => message.type === "send"),
    [{ type: "send", id: "alpha", question: "Explain $x^2$.", parallel: true }],
  );
  assert.equal(document.getElementById("activity-icon")?.hidden, false);
  alpha.status = "busy";
  state.messages = [{ role: "user", content: "<script>untrusted</script>" }];
  publish(state);
  document.querySelector<HTMLButtonElement>("#cancel")?.click();
  assert.deepEqual(posted.at(-1), { type: "cancel", id: "alpha" });
  alpha.status = "ready";
  state.messages.push({
    role: "assistant",
    content:
      "## Equation\n\n$$x^2=4$$\n\n[Link](https://example.com)\n<script>bad()</script>",
  });
  publish(state);
  assert.equal(document.getElementById("activity-icon")?.hidden, true);
  assert.ok(document.querySelector("#messages h2"));
  assert.ok(document.querySelector("#messages math"));
  assert.equal(document.querySelector("#messages script, #messages img"), null);
  assert.match(
    document.querySelector(".message.user")?.textContent ?? "",
    /<script>untrusted/,
  );
});

test("Enter sends once, Shift+Enter inserts a newline, and IME composition is not submitted", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.repositories[0]!.status = "ready";
  state.activeId = "alpha";
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  assert.ok(question);
  question.value = "First line\nSecond line";
  for (const options of [
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ]) {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
      ...options,
    });
    question.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(posted.filter((message) => message.type === "send").length, 0);
  const enter = (): KeyboardEvent =>
    new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  const event = enter();
  question.dispatchEvent(event);
  question.dispatchEvent(enter());
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(
    posted.filter((message) => message.type === "send"),
    [
      {
        type: "send",
        id: "alpha",
        question: "First line\nSecond line",
        parallel: true,
      },
    ],
  );
  state.repositories[0]!.status = "busy";
  publish(state);
  question.value = "Ask while busy";
  question.dispatchEvent(enter());
  assert.equal(posted.filter((message) => message.type === "send").length, 2);
  assert.deepEqual(posted.at(-1), {
    type: "send",
    id: "alpha",
    question: "Ask while busy",
    parallel: true,
  });
  publish(state);
  const parallel = document.querySelector<HTMLButtonElement>("#parallel");
  assert.ok(parallel);
  parallel.click();
  assert.equal(parallel.getAttribute("aria-pressed"), "false");
  assert.equal(parallel.textContent, "Parallel OFF");
  question.value = "Wait until the end";
  question.dispatchEvent(enter());
  assert.deepEqual(posted.at(-1), {
    type: "send",
    id: "alpha",
    question: "Wait until the end",
    parallel: false,
  });
  publish(state);
  parallel.click();
  assert.equal(parallel.getAttribute("aria-pressed"), "true");
  assert.equal(parallel.textContent, "Parallel ON");
});

test("clicking rendered URLs asks the extension to open the browser without webview navigation", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.messages = [
    {
      role: "assistant",
      content:
        "[**GitHub**](https://github.com/xadupre/devdash-agents)\n\nhttps://example.com",
    },
  ];
  publish(state);
  const link = document.querySelector("#messages a strong");
  assert.ok(link);
  const click = new dom.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(posted.at(-1), {
    type: "openExternal",
    url: "https://github.com/xadupre/devdash-agents",
  });
  const middle = new dom.window.MouseEvent("auxclick", {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
  link.dispatchEvent(middle);
  assert.equal(middle.defaultPrevented, true);
  state.messages.push({
    role: "output",
    content: "Result: https://example.org/output\n<script>untrusted</script>",
  });
  publish(state);
  assert.equal(
    document.querySelector(".message.output a")?.getAttribute("href"),
    "https://example.org/output",
  );
  assert.equal(document.querySelector(".message.output script"), null);
});

test("the default transcript is concise and optional filters reveal information without changing history", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  state.repositories[0]!.status = "ready";
  state.activeId = "alpha";
  state.messages = [
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
    { role: "reasoning", content: "Runtime reasoning" },
    {
      role: "tool",
      content: "gh pr list\n<script>not HTML</script>",
      title: "Tool: bash",
      details: '{"command":"gh pr list"}',
    },
    { role: "output", content: "stdout\nstderr" },
    { role: "system", content: '{"status":"running"}' },
  ];
  publish(state);
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 3);
  assert.equal(
    document.querySelectorAll("#information-filters input:checked").length,
    2,
  );
  assert.equal(document.querySelector("details:not([hidden])"), null);
  for (const filter of document.querySelectorAll<HTMLInputElement>(
    "#information-filters input:not(:checked)",
  )) {
    filter.click();
  }
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 6);
  assert.equal(document.querySelector(".message.tool script"), null);
  assert.match(
    document.querySelector(".message.tool pre")?.textContent ?? "",
    /<script>not HTML/,
  );
  assert.equal(
    document.querySelector(".message.output pre")?.textContent,
    "stdout\nstderr",
  );
  const details = document.querySelector<HTMLDetailsElement>(
    ".message.tool details",
  );
  assert.ok(details);
  details.open = true;
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  assert.ok(question);
  question.value = "Keep this draft";
  for (const category of [
    "tools",
    "output",
    "reasoning",
    "system",
    "messages",
  ]) {
    const filter = document.querySelector<HTMLInputElement>(
      `#information-filters input[value="${category}"]`,
    );
    assert.ok(filter);
    filter.click();
  }
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 0);
  assert.equal(question.value, "Keep this draft");
  publish(state);
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 0);
  assert.equal(
    document.querySelector<HTMLDetailsElement>(".message.tool details")?.open,
    true,
  );
  state.activeId = "beta";
  state.messages = [{ role: "tool", content: "Other repository command" }];
  publish(state);
  assert.equal(
    document.querySelector(".message.tool")?.hasAttribute("hidden"),
    true,
  );
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="tools"]',
    )
    ?.click();
  assert.equal(
    document.querySelector(".message.tool")?.hasAttribute("hidden"),
    false,
  );
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
});

test("Session / events also hides raw event details without hiding tools or output", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  state.messages = [
    { role: "assistant", content: "Checking the repository." },
    {
      role: "tool",
      content: "gh pr list",
      details: '{"toolCallId":"call-1","command":"gh pr list"}',
    },
    {
      role: "output",
      content: "No pull requests found",
      details: '{"toolCallId":"call-1","success":true}',
    },
    { role: "system", content: "Session ready" },
  ];
  publish(state);
  for (const category of ["output", "system"]) {
    document
      .querySelector<HTMLInputElement>(
        `#information-filters input[value="${category}"]`,
      )
      ?.click();
  }
  const filter = document.querySelector<HTMLInputElement>(
    '#information-filters input[value="system"]',
  );
  const toolDetails = document.querySelector<HTMLDetailsElement>(
    ".message.tool details",
  );
  assert.ok(filter && toolDetails);
  toolDetails.open = true;
  assert.equal(document.querySelectorAll("details:not([hidden])").length, 2);
  filter.click();
  for (let update = 0; update < 2; update++) {
    assert.equal(document.querySelectorAll("details:not([hidden])").length, 0);
    assert.equal(document.querySelectorAll(".message:not([hidden])").length, 3);
    assert.equal(
      document.querySelector(".message.tool .content")?.textContent,
      "gh pr list",
    );
    assert.equal(
      document.querySelector(".message.output .content")?.textContent,
      "No pull requests found",
    );
    publish(state);
  }
  filter.click();
  assert.equal(document.querySelectorAll("details:not([hidden])").length, 2);
  const restored = document.querySelector<HTMLDetailsElement>(
    ".message.tool details",
  );
  assert.equal(restored?.open, true);
  assert.equal(
    restored?.querySelector("pre")?.textContent,
    state.messages[1]!.details,
  );
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 4);
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
});

test("URL root consent is clearly labeled and sent as an explicit approval", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  state.permissions = [
    {
      id: "url-read",
      repositoryId: "alpha",
      kind: "url",
      summary: "Access this URL?",
      content: "https://example.com/docs",
      details: "{}",
      approvalLabel: "Allow https://example.com and remember",
    },
  ];
  publish(state);
  const allow = document.querySelector<HTMLButtonElement>(
    "#permissions button",
  );
  assert.ok(allow);
  assert.equal(allow.textContent, "Allow https://example.com and remember");
  allow.click();
  assert.deepEqual(posted.at(-1), {
    type: "permission",
    id: "url-read",
    approve: true,
  });
});

test("inline permission controls remain visible across filters and repository changes without grabbing focus", async (t) => {
  const { document, posted, publish, state } = await setup(t);
  state.repositories[0]!.status = "ready";
  state.activeId = "alpha";
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  const permissions = document.getElementById("permissions");
  assert.ok(question && permissions);
  question.focus();
  assert.equal(permissions.hidden, true);
  state.permissions = [
    {
      id: "alpha-read",
      repositoryId: "alpha",
      kind: "read",
      summary: "Read this file or directory?",
      content: "<script>not executable</script>\nREADME.md",
      details: "<script>not executable</script>\nREADME.md",
    },
    {
      id: "beta-shell",
      repositoryId: "beta",
      kind: "shell",
      summary: "Run this command?",
      content: "gh pr list",
      details: "gh pr list",
    },
  ];
  publish(state);
  assert.equal(document.activeElement, question);
  assert.equal(permissions.hidden, false);
  assert.equal(
    permissions.closest('[aria-live], [role="alert"], [role="dialog"]'),
    null,
  );
  assert.equal(permissions.querySelector("script"), null);
  assert.match(permissions.textContent ?? "", /<script>not executable/);
  assert.match(
    permissions.textContent ?? "",
    /Copilot \(Alpha\): Read this file/,
  );
  assert.match(
    permissions.textContent ?? "",
    /Copilot \(Beta\): Run this command/,
  );
  assert.equal(permissions.querySelector("details:not([hidden])"), null);
  for (const filter of document.querySelectorAll<HTMLInputElement>(
    "#information-filters input",
  )) {
    filter.click();
  }
  assert.equal(permissions.hidden, false);
  const allow = permissions.querySelector<HTMLButtonElement>("button");
  assert.ok(allow);
  allow.focus();
  state.activeId = "beta";
  publish(state);
  assert.equal(document.activeElement, allow);
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
  allow.click();
  allow.click();
  assert.deepEqual(posted.at(-1), {
    type: "permission",
    id: "alpha-read",
    approve: true,
  });
  assert.equal(
    permissions.querySelectorAll(".permission:first-child button:disabled")
      .length,
    2,
  );
  publish(state);
  assert.equal(allow.disabled, true);
  state.permissions.shift();
  publish(state);
  const reject =
    permissions.querySelector<HTMLButtonElement>("button:last-child");
  assert.ok(reject);
  reject.click();
  assert.deepEqual(posted.at(-1), {
    type: "permission",
    id: "beta-shell",
    approve: false,
  });
  assert.equal(
    posted.filter((message) => message.type === "permission").length,
    2,
  );
  state.permissions = [];
  publish(state);
  assert.equal(permissions.hidden, true);
  assert.equal(permissions.children.length, 0);
});

test("technical tool fragments from saved histories stay hidden and failures remain visible", async (t) => {
  const { document, publish, state } = await setup(t);
  state.messages = [
    {
      role: "tool",
      title: "assistant.tool_call_delta",
      content: '{"inputDelta":"foo"}',
    },
    {
      role: "tool",
      title: "tool.execution_progress",
      content: '{"progress":1}',
    },
    {
      role: "tool",
      title: "Tool: read",
      content: '{"toolCallId":"old","arguments":{"path":"README.md"}}',
    },
    {
      role: "tool",
      title: "bash - completed",
      content: "git status",
      timestamp: "2026-10-28T12:00:00Z",
    },
    { role: "output", content: "Permission denied", error: true },
    {
      role: "output",
      title: "Tool old: failed",
      content: "Previous command failed",
    },
  ];
  publish(state);
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 3);
  assert.equal(document.querySelector("#messages time"), null);
  const system = document.querySelector<HTMLInputElement>(
    'input[value="system"]',
  );
  assert.ok(system);
  system.click();
  assert.equal(document.querySelectorAll(".message:not([hidden])").length, 6);
  assert.ok(document.querySelector("#messages time"));
  system.click();
  document.querySelector<HTMLInputElement>('input[value="tools"]')?.click();
  assert.deepEqual(
    [...document.querySelectorAll(".message:not([hidden]) .content")].map(
      (content) => content.textContent,
    ),
    ["Permission denied", "Previous command failed"],
  );
});

test("Copilot questions use safe choice buttons and editable answers rather than JSON", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.questions = [
    {
      id: "choice",
      repositoryId: "alpha",
      question: "Which tests?",
      choices: ["Targeted", "All"],
      allowFreeform: false,
    },
    {
      id: "text",
      repositoryId: "beta",
      question: "<script>Which files?</script>",
      choices: ["README"],
      allowFreeform: true,
    },
  ];
  publish(state);
  const cards = document.querySelectorAll<HTMLFormElement>(".agent-question");
  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.querySelector("textarea"), null);
  assert.equal(document.querySelector("#questions script"), null);
  assert.match(cards[1]?.textContent ?? "", /<script>Which files\?<\/script>/);
  assert.equal(
    document.getElementById("questions")?.closest("[aria-live]"),
    null,
  );
  cards[0]?.querySelector<HTMLButtonElement>("button")?.click();
  assert.deepEqual(posted.at(-1), {
    type: "answer",
    id: "choice",
    answer: "Targeted",
  });
  const input = cards[1]?.querySelector("textarea");
  assert.ok(input);
  input.value = "src/example.ts\nREADME.md";
  input.dispatchEvent(new dom.window.Event("input"));
  input.focus();
  publish(state);
  assert.equal(document.activeElement, input);
  assert.equal(input.value, "src/example.ts\nREADME.md");
  for (const options of [{ shiftKey: true }, { isComposing: true }]) {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
      ...options,
    });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
  );
  input.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
  );
  assert.deepEqual(
    posted.filter((message) => message.type === "answer"),
    [
      { type: "answer", id: "choice", answer: "Targeted" },
      { type: "answer", id: "text", answer: "src/example.ts\nREADME.md" },
    ],
  );
  state.questions = [
    { id: "cancel", repositoryId: "beta", question: "Continue?" },
  ];
  publish(state);
  document
    .querySelector<HTMLButtonElement>(".agent-question > button:last-child")
    ?.click();
  assert.deepEqual(posted.at(-1), { type: "cancel", id: "beta" });
  state.questions = [];
  publish(state);
  assert.equal(document.getElementById("questions")?.hidden, true);
});

test("repository switching keeps drafts separate and failed submissions remain editable", async (t) => {
  const { dom, document, publish, state } = await setup(t);
  state.repositories.forEach((repository) => {
    repository.status = "ready";
  });

  state.activeId = "alpha";
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  const form = document.getElementById("composer");
  assert.ok(question && form);
  question.value = "Alpha draft";
  state.activeId = "beta";
  publish(state);
  assert.equal(question.value, "");
  question.value = "Beta draft";
  state.activeId = "alpha";
  publish(state);
  assert.equal(question.value, "Alpha draft");
  question.dispatchEvent(new dom.window.Event("input"));
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "error", id: "beta", message: "Other session failed" },
    }),
  );
  assert.equal(question.value, "");
  assert.equal(document.getElementById("error")?.hidden, true);
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: "error", message: "Session unavailable" },
    }),
  );
  assert.equal(question.value, "Alpha draft");
  assert.equal(document.getElementById("error")?.hidden, false);
  assert.equal(
    document.getElementById("error")?.textContent,
    "Session unavailable",
  );
});

test("saved drafts restore without starting Copilot, edits are persisted and failed resumes offer an explicit fresh session", async (t) => {
  const { dom, document, posted, publish, state } = await setup(t);
  state.activeId = "alpha";
  state.draft = "A draft from the previous window";
  state.repositories[0]!.status = "saved";
  state.repositories[0]!.hasSavedSession = true;
  state.messages = [{ role: "user", content: "An earlier question" }];
  publish(state);
  const question = document.querySelector<HTMLTextAreaElement>("#question");
  assert.ok(question);
  assert.equal(question.value, state.draft);
  assert.equal(question.disabled, true);
  assert.deepEqual(
    posted.filter((message) => message.type !== "github"),
    [{ type: "ready" }],
  );
  document.querySelector<HTMLButtonElement>(".repository")?.click();
  assert.deepEqual(posted.at(-1), { type: "select", id: "alpha" });
  state.repositories[0]!.status = "ready";
  publish(state);
  question.value = "Updated draft";
  question.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(posted.at(-1), {
    type: "draft",
    id: "alpha",
    text: "Updated draft",
  });
  state.repositories[0]!.status = "error";
  state.error = "Could not resume";
  publish(state);
  const fresh = document.querySelector<HTMLButtonElement>("#new-session");
  assert.ok(fresh);
  assert.equal(fresh.disabled, false);
  fresh.click();
  assert.deepEqual(posted.at(-1), {
    type: "new-session",
    id: "alpha",
    view: "copilot",
  });
});

test("user and Copilot messages have no role heading while titled and technical entries keep theirs", async (t) => {
  const { document, publish, state } = await setup(t);
  state.messages = [
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
    { role: "assistant", content: "Side answer", title: "Parallel 12345678" },
    { role: "tool", content: "gh pr list" },
  ];
  publish(state);
  const headings = [...document.querySelectorAll(".message")].map(
    (article) => article.querySelector("h3")?.textContent ?? null,
  );
  assert.deepEqual(headings, [null, null, "Parallel 12345678", "Tool"]);
  assert.deepEqual(
    [...document.querySelectorAll(".message")].map(
      (article) => article.className,
    ),
    ["message user", "message assistant", "message assistant", "message tool"],
  );
});

test("prompt navigation scrolls to the previous and next visible prompt", async (t) => {
  const { document, publish, state } = await setup(t);
  const previous =
    document.querySelector<HTMLButtonElement>("#previous-prompt")!;
  const next = document.querySelector<HTMLButtonElement>("#next-prompt")!;
  publish(state);
  assert.ok(previous.disabled && next.disabled);
  state.messages = [
    { role: "user", content: "First" },
    { role: "assistant", content: "One" },
    { role: "user", content: "Second" },
    { role: "assistant", content: "Two" },
    { role: "user", content: "Third" },
  ];
  publish(state);
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, false);
  const transcript = document.querySelector<HTMLElement>("#messages")!;
  const articles = [...transcript.querySelectorAll<HTMLElement>(".message")];
  const positions = [0, 100, 200, 300, 400];
  const scrolled: string[] = [];
  const box = (top: number) => ({ top }) as DOMRect;
  transcript.scrollTop = 0;
  let scrollTop = 150;
  Object.defineProperty(transcript, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  transcript.getBoundingClientRect = () => box(0);
  articles.forEach((article, index) => {
    article.getBoundingClientRect = () => box(positions[index]! - scrollTop);
    article.scrollIntoView = () => scrolled.push(article.textContent ?? "");
  });
  next.click();
  assert.equal(scrollTop, 200);
  assert.deepEqual(scrolled, ["Second"]);
  next.click();
  assert.equal(scrollTop, 400);
  next.click();
  assert.equal(scrollTop, 400);
  previous.click();
  assert.equal(scrollTop, 200);
  previous.click();
  assert.equal(scrollTop, 0);
  previous.click();
  assert.equal(scrollTop, 0);
  assert.deepEqual(scrolled, ["Second", "Third", "Second", "First"]);
  document
    .querySelector<HTMLInputElement>(
      '#information-filters input[value="messages"]',
    )!
    .click();
  assert.ok(previous.disabled && next.disabled);
});

test("the settings panel adds, selects and removes remote execution machines", async (t) => {
  const { dom, document, posted } = await setup(t);
  const send = settingsSender(dom);
  send({});
  const select =
    document.querySelector<HTMLSelectElement>("#execution-machine")!;
  const remove = document.querySelector<HTMLButtonElement>(
    "#remove-remote-machine",
  )!;
  const details = document.querySelector<HTMLElement>(
    "#execution-machine-details",
  )!;
  assert.deepEqual(optionsOf(select), [["", "This computer"]]);
  assert.equal(remove.disabled, true);
  const machine = {
    name: "azure-vm",
    command: "az ssh vm --ip <ip-address> --subscription <subscription-id>",
    workerPath: "/opt/devdash/devdash-genai-worker",
    modelPath: "/home/azureuser/models/phi",
    repositoriesPath: "/home/azureuser/github",
  };
  const fields = {
    name: "#remote-machine-name",
    command: "#remote-machine-command",
    workerPath: "#remote-worker-path",
    modelPath: "#remote-model-path",
    repositoriesPath: "#remote-repositories-path",
  };
  for (const [key, selector] of Object.entries(fields))
    document.querySelector<HTMLInputElement>(selector)!.value =
      machine[key as keyof typeof machine];
  document
    .querySelector<HTMLFormElement>("#remote-machine-form")!
    .requestSubmit();
  assert.deepEqual(posted.at(-1), {
    type: "remote-machines",
    machines: [machine],
    selected: "azure-vm",
  });
  send({ remoteMachines: [machine], remoteMachine: "azure-vm" });
  assert.deepEqual(optionsOf(select), [
    ["", "This computer"],
    ["azure-vm", "azure-vm"],
  ]);
  assert.equal(select.value, "azure-vm");
  assert.match(details.textContent ?? "", /on azure-vm/);
  select.value = "";
  select.dispatchEvent(new dom.window.Event("change"));
  assert.deepEqual(posted.at(-1), {
    type: "remote-machines",
    machines: [machine],
    selected: "",
  });
  remove.click();
  send({ remoteMachines: [machine], remoteMachine: "azure-vm" });
  remove.click();
  assert.deepEqual(posted.at(-1), {
    type: "remote-machines",
    machines: [],
    selected: "",
  });
});
