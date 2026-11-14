import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const script = readFile(resolve("docs/_static/ci-status.js"), "utf8");
const api = "https://api.github.com/repos/xadupre/devdash-agents";
const workflow = {
  id: 12,
  name: "Tests",
  path: ".github/workflows/tests.yml",
};

function run(conclusion: string | null, status = "completed") {
  return {
    id: 34,
    status,
    conclusion,
    created_at: "2026-11-14T09:00:00Z",
  };
}

async function render(
  respond: (url: URL) => unknown,
  html = '<section id="ci-status"><h1>CI status</h1><div id="ci-status-results"></div></section>',
) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const requests: URL[] = [];
  dom.window.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin + "/repos/xadupre/devdash-agents", api);
    requests.push(url);
    const data = respond(url);
    return {
      ok: !(data instanceof Error),
      status: data instanceof Error ? 403 : 200,
      json: async () => data,
    } as Response;
  };
  try {
    await dom.window.eval(await script);
    return { document: dom.window.document, requests };
  } finally {
    dom.window.close();
  }
}

function fixture(
  url: URL,
  daily: ReturnType<typeof run>[],
  latest = run("failure"),
) {
  if (url.pathname === "/repos/xadupre/devdash-agents") {
    return { default_branch: "main" };
  }
  if (url.pathname.endsWith("/workflows")) {
    return { total_count: 1, workflows: [workflow] };
  }
  if (url.searchParams.has("branch")) return { workflow_runs: [latest] };
  return { total_count: daily.length, workflow_runs: daily };
}

test("CI page shows broken workflows and excludes non-results from the ratio", async () => {
  const daily = [
    run("success"),
    run("failure"),
    run("timed_out"),
    run("startup_failure"),
    run("cancelled"),
    run("skipped"),
    run("neutral"),
    run("action_required"),
    run(null, "in_progress"),
    run(null, "queued"),
  ];
  const before = Date.now() - 24 * 60 * 60 * 1000;
  const { document, requests } = await render((url) => fixture(url, daily));
  assert.match(document.body.textContent!, /BROKEN: failure/);
  assert.equal(document.querySelector("h1")?.textContent, "CI status");
  assert.match(document.body.textContent!, /75.0% \(3\/4\)/);
  assert.equal(
    document.querySelectorAll("tbody a")[1]?.getAttribute("href"),
    "https://github.com/xadupre/devdash-agents/actions/runs/34",
  );
  assert.equal(
    requests
      .find((url) => url.searchParams.has("branch"))
      ?.searchParams.get("branch"),
    "main",
  );
  const recent = requests.find((url) => url.searchParams.has("created"))!;
  const since = Date.parse(recent.searchParams.get("created")!.slice(2));
  assert.ok(since >= before && since <= Date.now() - 24 * 60 * 60 * 1000);
  assert.equal(recent.searchParams.has("branch"), false);
});

test("CI page shows pending status and an unavailable empty sample", async () => {
  const { document } = await render((url) =>
    fixture(url, [run("cancelled")], run(null, "queued")),
  );
  assert.match(document.body.textContent!, /queued/);
  assert.match(
    document.body.textContent!,
    /N\/A \(no successful or failed runs\)/,
  );
  assert.doesNotMatch(document.body.textContent!, /BROKEN|0.0%/);
});

test("CI page paginates daily results without dropping older failures", async () => {
  const { document, requests } = await render((url) => {
    if (!url.searchParams.has("created")) return fixture(url, []);
    return {
      total_count: 101,
      workflow_runs:
        url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, () => run("success"))
          : [run("failure")],
    };
  });
  assert.match(document.body.textContent!, /1.0% \(1\/101\)/);
  assert.ok(requests.some((url) => url.searchParams.get("page") === "2"));
});

test("CI page preserves latest status when daily results are incomplete", async () => {
  for (const result of [
    new Error("rate limited"),
    { total_count: 1001, workflow_runs: [] },
  ]) {
    const { document } = await render((url) =>
      url.searchParams.has("created")
        ? result
        : fixture(url, [], run("success")),
    );
    assert.match(document.body.textContent!, /success/);
    assert.match(document.body.textContent!, /Unavailable:/);
    assert.doesNotMatch(document.body.textContent!, /0.0%/);
  }
});

test("CI page reports API errors with an Actions fallback", async () => {
  const { document } = await render(() => new Error("rate limited"));
  assert.match(document.body.textContent!, /CI status unavailable:.*403/);
  assert.equal(
    document.querySelector("a")?.href,
    "https://github.com/xadupre/devdash-agents/actions",
  );
});

test("CI page handles absent runs and renders workflow names as text", async () => {
  const { document } = await render((url) => {
    if (url.pathname.endsWith("/workflows")) {
      return {
        total_count: 2,
        workflows: [
          { ...workflow, name: "<img src=x onerror=alert(1)>" },
          { ...workflow, id: 99, path: "dynamic/copilot" },
        ],
      };
    }
    if (url.searchParams.has("branch")) return { workflow_runs: [] };
    return fixture(url, []);
  });
  assert.match(document.body.textContent!, /No runs/);
  assert.match(document.body.textContent!, /<img src=x onerror=alert\(1\)>/);
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelectorAll("tbody tr").length, 1);
});

test("CI script does not fetch on other documentation pages", async () => {
  const { requests } = await render(() => {
    assert.fail("Unexpected API request");
  }, "<p>Other documentation</p>");
  assert.equal(requests.length, 0);
});
