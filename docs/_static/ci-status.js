(async () => {
  const document = globalThis.document;
  const container = document.getElementById("ci-status-results");
  if (!container) return;

  const repository = "xadupre/devdash-agents";
  const web = `https://github.com/${repository}`;
  const api = `https://api.github.com/repos/${repository}`;
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const failures = new Set(["failure", "timed_out", "startup_failure"]);

  function element(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  async function get(path) {
    const response = await globalThis.fetch(`${api}${path}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: globalThis.AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    return response.json();
  }

  async function dailyRuns(id) {
    const runs = [];
    for (let page = 1; page <= 10; page++) {
      const data = await get(
        `/actions/workflows/${id}/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`,
      );
      if (data.total_count > 1000) {
        throw new Error("Too many runs to calculate a complete 24-hour ratio");
      }
      runs.push(...data.workflow_runs);
      if (runs.length >= data.total_count) return runs;
    }
    throw new Error("Incomplete 24-hour results");
  }

  try {
    const [metadata, data] = await Promise.all([
      get(""),
      get("/actions/workflows?per_page=100"),
    ]);
    if (data.total_count > 100)
      throw new Error("Too many workflows to display");
    const workflows = data.workflows.filter((workflow) =>
      workflow.path.startsWith(".github/workflows/"),
    );
    const summary = element(
      "p",
      `Fetched ${now.toISOString()}. Latest status: ${metadata.default_branch}.`,
    );
    const table = document.createElement("table");
    const header = document.createElement("tr");
    for (const title of [
      "Workflow",
      "Latest default-branch run",
      "Failure ratio (last 24 hours)",
    ]) {
      const cell = element("th", title);
      cell.scope = "col";
      header.append(cell);
    }
    const head = document.createElement("thead");
    head.append(header);
    const body = document.createElement("tbody");
    table.append(head, body);
    container.replaceChildren(summary, table);
    if (!workflows.length) {
      container.append(element("p", "No repository workflows found."));
    }

    await Promise.all(
      workflows.map(async (workflow) => {
        const id = encodeURIComponent(workflow.id);
        const row = document.createElement("tr");
        const name = document.createElement("td");
        const link = element("a", workflow.name);
        link.href = `${web}/actions/workflows/${id}`;
        name.append(link);
        const latest = element("td", "Loading…");
        const ratio = element("td", "Loading…");
        row.append(name, latest, ratio);
        body.append(row);
        await Promise.all([
          (async () => {
            try {
              const results = await get(
                `/actions/workflows/${id}/runs?branch=${encodeURIComponent(metadata.default_branch)}&per_page=1`,
              );
              const run = results.workflow_runs[0];
              if (!run) {
                latest.textContent = "No runs";
                return;
              }
              const status =
                run.status === "completed"
                  ? run.conclusion || "unknown"
                  : run.status;
              const runLink = element(
                "a",
                `${failures.has(status) ? "BROKEN: " : ""}${status} (${run.created_at})`,
              );
              runLink.href = `${web}/actions/runs/${encodeURIComponent(run.id)}`;
              latest.replaceChildren(runLink);
            } catch (error) {
              latest.textContent = `Unavailable: ${error.message}`;
            }
          })(),
          (async () => {
            try {
              const runs = await dailyRuns(id);
              const completed = runs.filter(
                (run) =>
                  run.status === "completed" &&
                  (run.conclusion === "success" ||
                    failures.has(run.conclusion)),
              );
              const failed = completed.filter((run) =>
                failures.has(run.conclusion),
              ).length;
              ratio.textContent = completed.length
                ? `${((100 * failed) / completed.length).toFixed(1)}% (${failed}/${completed.length})`
                : "N/A (no successful or failed runs)";
            } catch (error) {
              ratio.textContent = `Unavailable: ${error.message}`;
            }
          })(),
        ]);
      }),
    );
  } catch (error) {
    container.replaceChildren(
      element("p", `CI status unavailable: ${error.message}. Try again later.`),
    );
    const link = element("a", "View workflows on GitHub Actions");
    link.href = `${web}/actions`;
    container.append(link);
  }
})();
