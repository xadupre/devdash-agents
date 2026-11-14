declare function acquireVsCodeApi(): {
  postMessage(message: import("./application").ApplicationMessage): void;
};

(() => {
  type State = Omit<import("./application").ApplicationState, "messages"> & {
    messages: (import("./application").ChatMessage & { html?: string })[];
  };
  function element<T extends HTMLElement>(
    id: string,
    constructor: new () => T,
  ): T {
    const result = document.getElementById(id);
    if (!(result instanceof constructor)) {
      throw new Error(`Missing application element: ${id}`);
    }
    return result;
  }
  const vscode = acquireVsCodeApi();
  const repositories = element("repositories", HTMLElement);
  const startedRepositories = element("started-repositories", HTMLElement);
  const otherRepositories = element("other-repositories", HTMLElement);
  const rightTabs = element("right-tabs", HTMLElement);
  const repositoryView = element("repository-view", HTMLElement);
  const activityView = element("activity-view", HTMLElement);
  const sessionsView = element("sessions-view", HTMLElement);
  const datasetView = element("dataset-view", HTMLElement);
  const logView = element("log-view", HTMLElement);
  const traceView = element("trace-view", HTMLElement);
  const traceEvent = element("trace-event", HTMLElement);
  const traceReasoning = element("trace-reasoning", HTMLElement);
  const traceCommands = element("trace-commands", HTMLElement);
  const TRACE_COMMANDS = 5;
  const TRACE_OUTPUT_CHARS = 8000;
  let traceRenderedKey: string | undefined;
  function toolCallIdOf(
    message: State["messages"][number],
  ): string | undefined {
    if (message.toolCallId) return message.toolCallId;
    if (!message.details) return undefined;
    try {
      const id = (JSON.parse(message.details) as { toolCallId?: unknown })
        .toolCallId;
      return typeof id === "string" ? id : undefined;
    } catch {
      return undefined;
    }
  }
  function traceTail(text: string): string {
    return text.length > TRACE_OUTPUT_CHARS
      ? `… (${text.length - TRACE_OUTPUT_CHARS} earlier characters omitted)\n${text.slice(-TRACE_OUTPUT_CHARS)}`
      : text;
  }
  function renderTrace(): void {
    const all = state?.messages ?? [];
    const latest = all.at(-1);
    const reasoning = [...all]
      .reverse()
      .find((message) => message.role === "reasoning");
    const commands: {
      tool: State["messages"][number];
      outputs: State["messages"][number][];
    }[] = [];
    for (let index = all.length - 1; index >= 0; index--) {
      const tool = all[index]!;
      if (tool.role !== "tool") continue;
      const id = toolCallIdOf(tool);
      const outputs = id
        ? all
            .slice(index + 1)
            .filter(
              (message) =>
                message.role === "output" &&
                (message.agentId ?? "") === (tool.agentId ?? "") &&
                toolCallIdOf(message) === id,
            )
        : [];
      commands.push({ tool, outputs });
      if (commands.length === TRACE_COMMANDS) break;
    }
    const key = JSON.stringify([
      state?.activeId,
      latest && [
        latest.role,
        latest.title,
        latest.timestamp,
        latest.agentId,
        latest.error,
        latest.content.length,
        latest.content.slice(-200),
      ],
      reasoning?.html ?? reasoning?.content,
      commands.map(({ tool, outputs }) => [
        tool.title,
        tool.content,
        tool.error,
        outputs.map((output) => [output.content.length, output.error]),
      ]),
    ]);
    if (key === traceRenderedKey) return;
    traceRenderedKey = key;
    if (latest) {
      const article = document.createElement("article");
      article.className = `trace-command trace-event ${latest.role}`;
      if (latest.error) article.classList.add("failed");
      const heading = document.createElement("h4");
      heading.textContent =
        (latest.title ||
          { ...roleLabels, user: "User", assistant: "Assistant" }[
            latest.role
          ]) + (latest.agentId ? ` [${latest.agentId}]` : "");
      if (latest.timestamp) {
        const time = document.createElement("time");
        time.dateTime = latest.timestamp;
        time.textContent = ` · ${new Date(latest.timestamp).toLocaleTimeString()}`;
        heading.append(time);
      }
      const content = document.createElement("pre");
      content.className = "trace-output";
      content.textContent = traceTail(latest.content);
      article.append(heading, content);
      traceEvent.replaceChildren(article);
    } else traceEvent.textContent = "No events yet.";
    if (reasoning) {
      const content = document.createElement("div");
      content.className = "trace-reasoning content";
      if (reasoning.html !== undefined) content.innerHTML = reasoning.html;
      else content.textContent = reasoning.content;
      traceReasoning.replaceChildren(content);
    } else traceReasoning.textContent = "No reasoning yet.";
    traceCommands.replaceChildren(
      ...commands.map(({ tool, outputs }) => {
        const article = document.createElement("article");
        article.className = "trace-command";
        const completion = [...outputs]
          .reverse()
          .find((output) => output.details);
        if (tool.error || completion?.error) article.classList.add("failed");
        const heading = document.createElement("h4");
        heading.textContent =
          (tool.title ?? "Tool") + (tool.agentId ? ` [${tool.agentId}]` : "");
        const command = document.createElement("pre");
        command.className = "trace-input";
        command.textContent = tool.content;
        const output = document.createElement("pre");
        output.className = "trace-output";
        const text = (completion ? [completion] : outputs)
          .map((message) => message.content)
          .join("\n");
        output.textContent =
          traceTail(text) ||
          (tool.title?.endsWith(" - running") ? "Running…" : "No output.");
        article.append(heading, command, output);
        return article;
      }),
    );
    if (!commands.length) traceCommands.textContent = "No commands yet.";
  }
  const settingsView = element("settings-view", HTMLElement);
  const applicationLogs = element("application-logs", HTMLElement);
  const executionTiming = element("execution-timing", HTMLElement);
  const timingTooltip = document.createElement("div");
  timingTooltip.id = "timing-tooltip";
  timingTooltip.role = "tooltip";
  timingTooltip.hidden = true;
  document.body.append(timingTooltip);
  const timingDetails = new Map<string, () => void>();
  let activeTimingKey: string | undefined;
  function updateTimingTooltip(): void {
    const show = activeTimingKey && timingDetails.get(activeTimingKey);
    timingTooltip.hidden = !show;
    if (show) show();
  }
  for (const eventName of ["mouseover", "focusin"]) {
    executionTiming.addEventListener(eventName, (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-timing-key]")
          : null;
      activeTimingKey = target?.dataset.timingKey;
      updateTimingTooltip();
    });
  }
  for (const eventName of ["mouseout", "focusout"]) {
    executionTiming.addEventListener(eventName, (event) => {
      const related = (event as MouseEvent | FocusEvent).relatedTarget;
      if (related instanceof Node && executionTiming.contains(related)) return;
      activeTimingKey = undefined;
      updateTimingTooltip();
    });
  }
  executionTiming.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      activeTimingKey = undefined;
      updateTimingTooltip();
    }
  });
  const toolColors = new Map<string, string>();
  let timingTimer: ReturnType<typeof setInterval> | undefined;
  function renderTiming(switched = false): void {
    if (switched) activeTimingKey = undefined;
    timingDetails.clear();
    const focusedKey =
      !switched && document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.timingKey
        : undefined;
    let focusTarget: HTMLElement | undefined;
    const requests = state?.messages.filter(
      (message) => message.timings?.length,
    );
    const latest = requests?.at(-1);
    const visible =
      requests?.filter(
        (message) =>
          message === latest ||
          message.timings!.some((step) => step.end === undefined),
      ) ?? [];
    executionTiming.hidden = !visible.length;
    executionTiming.replaceChildren();
    const now = Date.now();
    let running = false;
    for (const request of visible) {
      const requestIndex = state!.messages.indexOf(request);
      const steps = request.timings!;
      const start = steps.reduce(
        (first, step) => Math.min(first, step.start),
        steps[0]!.start,
      );
      const end = steps.reduce(
        (last, step) => Math.max(last, step.end ?? now, step.start),
        start,
      );
      const elapsed = Math.max(1, end - start);
      const section = document.createElement("div");
      section.className = "timing-request";
      const heading = `Step timing · ${((end - start) / 1000).toFixed(2)} s · ${request.title ? `${request.title}: ` : ""}${request.content.slice(0, 120)}`;
      const band = document.createElement("div");
      band.className = "timing-band";
      band.dataset.timingKey = `${requestIndex}:band`;
      const laneEnds: number[] = [];
      const totals = new Map<
        string,
        { name: string; color: string; ms: number; outputTokens?: number }
      >();
      const throughput = (tokens: number | undefined, ms: number): string =>
        tokens !== undefined && ms > 0
          ? ` · ${((tokens * 1000) / ms).toFixed(2)} tokens/s`
          : "";
      for (const [index, step] of [...steps]
        .sort((a, b) => a.start - b.start)
        .entries()) {
        running ||= step.end === undefined;
        const stop = Math.max(step.start, step.end ?? now);
        const duration = stop - step.start;
        let color = "#3794ff";
        if (step.kind === "tool") {
          if (!toolColors.has(step.name))
            toolColors.set(
              step.name,
              `hsl(${(30 + toolColors.size * 137.508) % 360}, 65%, 70%)`,
            );
          color = toolColors.get(step.name)!;
        }
        const key = `${step.kind}:${step.name}`;
        const total = totals.get(key) ?? { name: step.name, color, ms: 0 };
        total.ms += duration;
        if (step.outputTokens !== undefined)
          total.outputTokens = (total.outputTokens ?? 0) + step.outputTokens;
        totals.set(key, total);
        let lane = laneEnds.findIndex((end) => end <= step.start);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = stop;
        const segment = document.createElement("span");
        segment.className = `timing-step ${step.kind}`;
        segment.style.left = `${((step.start - start) / elapsed) * 100}%`;
        segment.style.width = `${(duration / elapsed) * 100}%`;
        segment.style.top = `${lane * 8}px`;
        segment.style.backgroundColor = color;
        const label = `${step.name}: ${(duration / 1000).toFixed(2)} s${step.agentId ? ` (${step.agentId})` : ""}${throughput(step.outputTokens, duration)}${step.end === undefined ? " · running" : ""}`;
        segment.setAttribute("aria-label", label);
        segment.tabIndex = 0;
        segment.dataset.timingKey = `${requestIndex}:${index}`;
        if (segment.dataset.timingKey === focusedKey) focusTarget = segment;
        band.append(segment);
      }
      band.style.height = `${laneEnds.length * 8}px`;
      for (const target of [
        band,
        ...band.querySelectorAll<HTMLElement>("span"),
      ]) {
        target.setAttribute("aria-describedby", timingTooltip.id);
        timingDetails.set(target.dataset.timingKey!, () => {
          timingTooltip.replaceChildren();
          const headingNode = document.createElement("div");
          headingNode.textContent = heading;
          timingTooltip.append(headingNode);
          const explanation = document.createElement("div");
          explanation.textContent =
            `${laneEnds.length} timeline ${laneEnds.length === 1 ? "row" : "rows"}. ` +
            "Overlapping steps use separate rows; rows do not identify agents. " +
            "Colors identify generation or tool names. Totals sum step durations.";
          timingTooltip.append(explanation);
          for (const total of totals.values()) {
            const row = document.createElement("div");
            row.className = "timing-legend";
            const swatch = document.createElement("span");
            swatch.className = "timing-swatch";
            swatch.style.backgroundColor = total.color;
            swatch.setAttribute("aria-hidden", "true");
            const label = document.createElement("span");
            label.textContent = `${total.name}: ${(total.ms / 1000).toFixed(2)} s${throughput(total.outputTokens, total.ms)}`;
            row.append(swatch, label);
            timingTooltip.append(row);
          }
          if (target !== band) {
            const detail = document.createElement("div");
            detail.textContent = `Selected step · ${target.getAttribute("aria-label")}`;
            timingTooltip.append(detail);
          }
          const rect = band.getBoundingClientRect();
          timingTooltip.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - timingTooltip.offsetWidth - 12))}px`;
          timingTooltip.style.top = `${Math.max(timingTooltip.offsetHeight + 8, rect.top - 8)}px`;
        });
      }
      section.append(band);
      executionTiming.append(section);
    }
    focusTarget?.focus({ preventScroll: true });
    updateTimingTooltip();
    if (running && timingTimer === undefined)
      timingTimer = setInterval(renderTiming, 250);
    else if (!running && timingTimer !== undefined) {
      clearInterval(timingTimer);
      timingTimer = undefined;
    }
  }
  let logsRenderedId: number | undefined;
  let logsRenderedRoot: string | undefined;
  rightTabs.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-view]")
        : null;
    if (!button) return;
    const view = button.dataset.view;
    repositoryView.hidden = view !== "repositories";
    activityView.hidden = view !== "activity";
    traceView.hidden = view !== "trace";
    sessionsView.hidden = view !== "sessions";
    datasetView.hidden = view !== "dataset";
    logView.hidden = view !== "logs";
    settingsView.hidden = view !== "settings";
    for (const tab of rightTabs.querySelectorAll<HTMLButtonElement>("button"))
      tab.setAttribute("aria-pressed", String(tab === button));
    if (view === "sessions" && settingsState?.localDevicesStatus !== "ready")
      vscode.postMessage({ type: "local-devices" });
    if (view === "dataset") vscode.postMessage({ type: "dataset-sessions" });
  });
  type DatasetSession = import("./application").DatasetSession;
  const datasetTable = element("dataset-table", HTMLTableElement);
  let datasetSortColumn: number | undefined;
  let datasetSortAscending = true;
  function sortDatasetRows(): void {
    if (datasetSortColumn === undefined) return;
    const column = datasetSortColumn;
    const body = datasetTable.tBodies[0]!;
    const rows = [...body.rows].sort(
      (a, b) =>
        (a.cells[column]!.textContent ?? "").localeCompare(
          b.cells[column]!.textContent ?? "",
          undefined,
          { numeric: true, sensitivity: "base" },
        ) * (datasetSortAscending ? 1 : -1),
    );
    body.append(...rows);
  }
  const datasetHeaders = datasetTable.querySelectorAll("th[aria-sort]");
  datasetHeaders.forEach((header, column) => {
    header.querySelector("button")!.addEventListener("click", () => {
      datasetSortAscending =
        datasetSortColumn === column ? !datasetSortAscending : true;
      datasetSortColumn = column;
      datasetHeaders.forEach((item, index) =>
        item.setAttribute(
          "aria-sort",
          index === column
            ? datasetSortAscending
              ? "ascending"
              : "descending"
            : "none",
        ),
      );
      sortDatasetRows();
    });
  });
  const datasetEmpty = element("dataset-empty", HTMLElement);
  const datasetError = element("dataset-error", HTMLElement);
  const datasetForm = element("dataset-annotation", HTMLFormElement);
  const datasetTitle = element("dataset-annotation-title", HTMLElement);
  const datasetMark = element("dataset-mark", HTMLSelectElement);
  const datasetReason = element("dataset-reason", HTMLTextAreaElement);
  const datasetComments = element("dataset-comments", HTMLTextAreaElement);
  const datasetSave = element("dataset-save", HTMLButtonElement);
  const datasetRemove = element("dataset-remove", HTMLButtonElement);
  const datasetCancel = element("dataset-cancel", HTMLButtonElement);
  let editingDataset: DatasetSession | undefined;
  let datasetPending = false;
  const setDatasetPending = (pending: boolean): void => {
    datasetPending = pending;
    datasetSave.disabled = pending;
    datasetRemove.disabled = pending;
    datasetCancel.disabled = pending;
    datasetMark.disabled = pending;
    datasetReason.disabled = pending;
    datasetComments.disabled = pending;
  };
  const showDatasetError = (message = ""): void => {
    datasetError.textContent = message;
    datasetError.hidden = !message;
  };
  const updateDatasetReason = (): void => {
    datasetReason.required =
      datasetMark.value === "failure" || datasetMark.value === "abandon";
  };
  datasetMark.addEventListener("change", updateDatasetReason);
  element("dataset-refresh", HTMLButtonElement).addEventListener("click", () =>
    vscode.postMessage({ type: "dataset-sessions" }),
  );
  datasetCancel.addEventListener("click", () => {
    if (datasetPending) return;
    editingDataset = undefined;
    datasetForm.hidden = true;
    showDatasetError();
  });
  datasetRemove.addEventListener("click", () => {
    if (!editingDataset || datasetPending) return;
    setDatasetPending(true);
    showDatasetError();
    vscode.postMessage({
      type: "annotate-session",
      id: editingDataset.repository.id,
      recordId: editingDataset.recordId,
      annotation: null,
    });
  });
  datasetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!editingDataset || datasetPending) return;
    if (
      datasetMark.value !== "success" &&
      datasetMark.value !== "failure" &&
      datasetMark.value !== "abandon"
    ) {
      showDatasetError("Choose a mark.");
      return;
    }
    if (datasetMark.value !== "success" && !datasetReason.value.trim()) {
      showDatasetError("Provide a reason for failure or abandonment.");
      return;
    }
    setDatasetPending(true);
    showDatasetError();
    vscode.postMessage({
      type: "annotate-session",
      id: editingDataset.repository.id,
      recordId: editingDataset.recordId,
      annotation: {
        mark: datasetMark.value,
        reason: datasetReason.value,
        comments: datasetComments.value,
      },
    });
  });
  function renderDataset(sessions: DatasetSession[]): void {
    const body = datasetTable.tBodies[0]!;
    const rows = sessions.map((session) => {
      const row = document.createElement("tr");
      const cell = (text: string): void => {
        const item = document.createElement("td");
        item.textContent = text;
        row.append(item);
      };
      cell(session.repository.name);
      cell(
        `${session.backend} · ${session.location} · ${session.sessionId ?? session.recordId}`,
      );
      cell(session.models.join(", ") || "Unknown");
      cell(session.references.join(", ") || "—");
      cell(
        session.annotation
          ? [
              session.annotation.mark,
              session.annotation.reason,
              session.annotation.comments,
            ]
              .filter(Boolean)
              .join(" · ")
          : "Not annotated",
      );
      const actions = document.createElement("td");
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Annotate";
      edit.addEventListener("click", () => {
        if (datasetPending) return;
        editingDataset = session;
        datasetTitle.textContent = `Annotate ${session.repository.name} · ${session.sessionId ?? session.recordId}`;
        datasetMark.value = session.annotation?.mark ?? "";
        datasetReason.value = session.annotation?.reason ?? "";
        datasetComments.value = session.annotation?.comments ?? "";
        datasetRemove.hidden = !session.annotation;
        updateDatasetReason();
        datasetForm.hidden = false;
        showDatasetError();
        datasetMark.focus();
      });
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.textContent = "Export JSON";
      exportButton.addEventListener("click", () => {
        showDatasetError();
        vscode.postMessage({
          type: "export-dataset-session",
          id: session.repository.id,
          recordId: session.recordId,
        });
      });
      const actionButtons = document.createElement("div");
      actionButtons.className = "dataset-actions";
      actionButtons.append(edit, exportButton);
      actions.append(actionButtons);
      row.append(actions);
      return row;
    });
    body.replaceChildren(...rows);
    sortDatasetRows();
    datasetEmpty.hidden = sessions.length > 0;
  }
  const messages = element("messages", HTMLElement);
  const messageCards: {
    message: State["messages"][number];
    showEventDetails: boolean;
    article: HTMLElement;
  }[] = [];
  const messageFields = [
    "role",
    "content",
    "html",
    "title",
    "agentId",
    "timestamp",
    "details",
    "error",
  ] as const;
  let repositoriesRenderedKey: string | undefined;
  const permissions = element("permissions", HTMLElement);
  const permissionCards = new Map<string, HTMLElement>();
  const questions = element("questions", HTMLElement);
  const questionCards = new Map<string, HTMLElement>();
  const question = element("question", HTMLTextAreaElement);
  type ImageAttachment = import("./images").ImageAttachment;
  const imagePreviews = element("image-previews", HTMLElement);
  const imageDrafts = new Map<string, ImageAttachment[]>();
  const readingImages = new Set<string>();
  const send = element("send", HTMLButtonElement);
  const parallel = element("parallel", HTMLButtonElement);
  const exportSession = element("export-session", HTMLButtonElement);
  type SettingsState = import("./settings").SettingsState;
  const harnessSettings = element("harness-settings", HTMLFormElement);
  const cliPath = element("cli-path", HTMLInputElement);
  const localWorkerPath = element("local-worker-path", HTMLInputElement);
  const requestTimeoutMinutes = element(
    "request-timeout-minutes",
    HTMLInputElement,
  );
  const workerIdleMinutes = element("worker-idle-minutes", HTMLInputElement);
  const approvedUrlOrigins = element(
    "approved-url-origins",
    HTMLTextAreaElement,
  );
  const saveHarnessSettings = element(
    "save-harness-settings",
    HTMLButtonElement,
  );
  const harnessSettingsStatus = element("harness-settings-status", HTMLElement);
  type HarnessSettingKey = keyof import("./settings").HarnessSettings;
  const harnessFieldById: Record<string, HarnessSettingKey> = {
    "cli-path": "cliPath",
    "local-worker-path": "localWorkerPath",
    "request-timeout-minutes": "requestTimeoutMinutes",
    "worker-idle-minutes": "workerIdleMinutes",
    "approved-url-origins": "approvedUrlOrigins",
  };
  const dirtyHarnessFields = new Map<HarnessSettingKey, number>();
  const pendingHarnessSaves = new Map<number, Map<HarnessSettingKey, number>>();
  let settingsState: SettingsState | undefined;
  let harnessSettingsRevision = 0;
  let harnessSettingsRequestId = 0;
  let approvedUrlOriginsBase: string[] | undefined;
  const updateHarnessSaveButton = (): void => {
    saveHarnessSettings.disabled =
      !settingsState ||
      pendingHarnessSaves.size > 0 ||
      dirtyHarnessFields.size === 0;
  };
  updateHarnessSaveButton();
  harnessSettings.addEventListener("input", (event) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      const field = harnessFieldById[event.target.id];
      if (field) {
        if (field === "approvedUrlOrigins" && !dirtyHarnessFields.has(field))
          approvedUrlOriginsBase = settingsState?.approvedUrlOrigins.slice();
        dirtyHarnessFields.set(field, ++harnessSettingsRevision);
      }
      harnessSettingsStatus.textContent = "Unsaved harness settings.";
      updateHarnessSaveButton();
    }
  });
  harnessSettings.addEventListener("submit", (event) => {
    event.preventDefault();
    if (
      pendingHarnessSaves.size > 0 ||
      dirtyHarnessFields.size === 0 ||
      !harnessSettings.reportValidity()
    )
      return;
    const requestId = ++harnessSettingsRequestId;
    const dirty = new Map(dirtyHarnessFields);
    const settings: Partial<import("./settings").HarnessSettings> = {};
    if (dirty.has("cliPath")) settings.cliPath = cliPath.value;
    if (dirty.has("localWorkerPath"))
      settings.localWorkerPath = localWorkerPath.value;
    if (dirty.has("requestTimeoutMinutes"))
      settings.requestTimeoutMinutes = requestTimeoutMinutes.valueAsNumber;
    if (dirty.has("workerIdleMinutes"))
      settings.workerIdleMinutes = workerIdleMinutes.valueAsNumber;
    if (dirty.has("approvedUrlOrigins"))
      settings.approvedUrlOrigins = approvedUrlOrigins.value
        .split(/\r?\n/)
        .map((origin) => origin.trim())
        .filter(Boolean);
    pendingHarnessSaves.set(requestId, dirty);
    updateHarnessSaveButton();
    harnessSettingsStatus.textContent = "Saving harness settings...";
    vscode.postMessage({
      type: "harness-settings",
      requestId,
      settings,
      ...(settings.approvedUrlOrigins !== undefined
        ? { baseApprovedUrlOrigins: approvedUrlOriginsBase ?? [] }
        : {}),
    });
  });
  const copilotModel = element("copilot-model", HTMLSelectElement);
  const refreshCopilotModels = element(
    "refresh-copilot-models",
    HTMLButtonElement,
  );
  const copilotModelStatus = element("copilot-model-status", HTMLElement);
  const copilotModelError = element("copilot-model-error", HTMLElement);
  const localModelPath = element("local-model-path", HTMLElement);
  const localDevice = element("local-device", HTMLSelectElement);
  const detectLocalDevices = element("detect-local-devices", HTMLButtonElement);
  const localDeviceStatus = element("local-device-status", HTMLElement);
  const localDeviceError = element("local-device-error", HTMLElement);
  const foundryDevice = element("foundry-device", HTMLSelectElement);
  const listFoundryModels = element("list-foundry-models", HTMLButtonElement);
  const foundryModel = element("foundry-model", HTMLSelectElement);
  const foundryModelDetails = element("foundry-model-details", HTMLElement);
  const downloadFoundryModel = element(
    "download-foundry-model",
    HTMLButtonElement,
  );
  const cancelFoundry = element("cancel-foundry", HTMLButtonElement);
  const foundryStatus = element("foundry-status", HTMLElement);
  const foundryError = element("foundry-error", HTMLElement);
  const formatBytes = (bytes: number): string => {
    const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${unit ? Number(value.toFixed(1)) : value} ${units[unit]}`;
  };
  const sessionModel = element("session-model", HTMLElement);
  const systemMemory = element("system-memory", HTMLElement);
  const localModelsContainer = element("local-models", HTMLElement);
  const gigabytes = (bytes: number): string =>
    `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  const renderMemory = (
    update: import("./system-memory").MemoryUpdate,
  ): void => {
    const gpus = update.cuda ?? [];
    // With a CUDA worker, only its device matters; otherwise list every GPU.
    const shown = gpus
      .map((gpu, index) => ({ gpu, index }))
      .filter(
        ({ index }) =>
          update.deviceId === undefined || index === update.deviceId,
      );
    const parts = [
      `CPU ${gigabytes(update.cpu.free)}`,
      ...shown.map(
        ({ gpu, index }) =>
          `CUDA${gpus.length > 1 ? ` ${index}` : ""} ${gigabytes(gpu.free)}`,
      ),
    ];
    systemMemory.textContent = `${update.machine ? `${update.machine} free` : "Free"}: ${parts.join(" · ")}`;
    const lowMemory =
      update.cpu.free < 300 * 1024 ** 2 ||
      shown.some(({ gpu }) => gpu.free < 300 * 1024 ** 2);
    if (lowMemory) systemMemory.textContent += " · Low memory: offload a model";
    systemMemory.classList.toggle("memory-warning", lowMemory);
    systemMemory.title = [
      `Memory of ${update.machine ?? "this computer"} (the worker machine of the displayed session)`,
      `CPU: ${gigabytes(update.cpu.free)} available of ${gigabytes(update.cpu.total)}`,
      ...gpus.map(
        (gpu, index) =>
          `CUDA ${index}: ${gigabytes(gpu.free)} free of ${gigabytes(gpu.total)}`,
      ),
    ].join("\n");
    systemMemory.hidden = false;
  };
  const assignmentDialog = element("assignment-dialog", HTMLElement);
  const assignmentForm = element("assignment-form", HTMLFormElement);
  const assignmentTitle = element("assignment-title", HTMLElement);
  const assignmentWorker = element("assignment-worker", HTMLSelectElement);
  const assignmentWorkerMachine = element(
    "assignment-worker-machine",
    HTMLSelectElement,
  );
  const assignmentHarness = element(
    "assignment-harness-machine",
    HTMLSelectElement,
  );
  const assignmentSummary = element("assignment-summary", HTMLElement);
  const assignmentBackground = [
    document.querySelector<HTMLElement>("main.application")!,
    element("repository-menu", HTMLElement),
  ];
  let assignmentFocus: HTMLElement | undefined;
  let backgroundWasInert: boolean[] | undefined;
  let assignmentRequest:
    { requestId: string; repositoryId: string; backend?: string } | undefined;
  const assignmentModelKinds: Record<string, string> = {
    copilot: "Copilot",
    file: "GenAI files",
    checkpoint: "Transformers checkpoint",
    "model-id": "Hugging Face",
    foundry: "Foundry",
  };
  const describeWorker = (
    worker: import("./execution").WorkerConfiguration,
  ): string =>
    worker.backend === "copilot"
      ? `Copilot agent · model ${worker.model.source || "CLI default"}`
      : `${assignmentModelKinds[worker.model.kind] ?? worker.model.kind}: ${worker.model.source} · ${worker.provider === "cuda" ? `CUDA device ${worker.deviceId}` : "CPU"}`;
  const describeMachine = (
    machine: import("./execution").MachineConfiguration,
  ): string =>
    `${machine.name} (${machine.command ? "remote" : "this computer"})`;
  const repositoryFolder = (id: string): string =>
    id.split(/[\\/]/).filter(Boolean).at(-1) ?? id;
  const updateAssignmentDialog = (): void => {
    const execution = settingsState?.execution;
    const worker = execution?.workers.find(
      (entry) => entry.id === assignmentWorker.value,
    );
    const copilot = worker?.backend === "copilot";
    // Copilot always runs on the harness machine.
    if (copilot) assignmentWorkerMachine.value = assignmentHarness.value;
    assignmentWorkerMachine.disabled = copilot;
    const machine = (id: string) =>
      execution?.machines.find((entry) => entry.id === id);
    const workerMachine = machine(assignmentWorkerMachine.value);
    const harness = machine(assignmentHarness.value);
    element("assignment-worker-hint", HTMLElement).textContent = worker
      ? describeWorker(worker)
      : "";
    element("assignment-worker-machine-hint", HTMLElement).textContent = copilot
      ? "Copilot runs on the harness machine."
      : workerMachine
        ? `Model files in ${workerMachine.modelsPath}${workerMachine.command ? `; native worker ${workerMachine.workerPath} (built on first use if missing)` : ""}.`
        : "";
    const folder = assignmentRequest
      ? repositoryFolder(assignmentRequest.repositoryId)
      : "";
    const repositoryPath = harness
      ? `${harness.repositoriesPath.replace(/[\\/]+$/, "")}/${folder}`
      : "";
    element("assignment-harness-machine-hint", HTMLElement).textContent =
      harness ? `Repository: ${repositoryPath}` : "";
    assignmentSummary.textContent =
      worker && workerMachine && harness
        ? [
            `Agent and model: ${worker.name} (${describeWorker(worker)})`,
            `Model runs on: ${describeMachine(workerMachine)}`,
            `Files and commands on: ${describeMachine(harness)} in ${repositoryPath}`,
          ].join("\n")
        : "";
  };
  const closeAssignmentDialog = (choice?: {
    workerId: string;
    workerMachineId: string;
    executionMachineId: string;
  }): void => {
    if (!assignmentRequest) return;
    vscode.postMessage({
      type: "assignment-choice",
      requestId: assignmentRequest.requestId,
      ...(choice ? { choice } : {}),
    });
    assignmentRequest = undefined;
    assignmentDialog.hidden = true;
    if (backgroundWasInert)
      assignmentBackground.forEach((element, index) => {
        if (!backgroundWasInert?.[index]) element.removeAttribute("inert");
      });
    backgroundWasInert = undefined;
    if (assignmentFocus?.isConnected) assignmentFocus.focus();
    assignmentFocus = undefined;
  };
  const openAssignmentDialog = (request: {
    requestId: string;
    repositoryId: string;
    backend?: string;
  }): void => {
    closeAssignmentDialog();
    const execution = settingsState?.execution;
    const workers =
      execution?.workers.filter(
        (worker) => !request.backend || worker.backend === request.backend,
      ) ?? [];
    assignmentRequest = request;
    if (!execution || !workers.length) {
      closeAssignmentDialog();
      return;
    }
    assignmentFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    backgroundWasInert = assignmentBackground.map((element) =>
      element.hasAttribute("inert"),
    );
    assignmentBackground.forEach((element) =>
      element.setAttribute("inert", ""),
    );
    assignmentTitle.textContent = `New ${request.backend === "local" ? "local model " : request.backend === "copilot" ? "Copilot " : ""}session for ${repositoryFolder(request.repositoryId)}`;
    const fill = (
      select: HTMLSelectElement,
      entries: { value: string; label: string }[],
    ): void => {
      select.replaceChildren(
        ...entries.map(({ value, label }) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          return option;
        }),
      );
    };
    fill(
      assignmentWorker,
      workers.map((worker) => ({
        value: worker.id,
        label: `${worker.name} — ${describeWorker(worker)}`,
      })),
    );
    const machines = execution.machines.map((machine) => ({
      value: machine.id,
      label: describeMachine(machine),
    }));
    fill(assignmentWorkerMachine, machines);
    fill(assignmentHarness, machines);
    const selectWorker = (): void => {
      const worker = workers.find(
        (entry) => entry.id === assignmentWorker.value,
      );
      if (worker) {
        assignmentWorkerMachine.value = worker.machineId;
        if (worker.backend === "copilot")
          assignmentHarness.value = worker.machineId;
      }
      updateAssignmentDialog();
    };
    assignmentHarness.value =
      execution.machines.find((machine) => !machine.command)?.id ??
      execution.machines[0]?.id ??
      "";
    selectWorker();
    assignmentWorker.onchange = selectWorker;
    assignmentDialog.hidden = false;
    assignmentWorker.focus();
  };
  assignmentWorkerMachine.addEventListener("change", updateAssignmentDialog);
  assignmentHarness.addEventListener("change", updateAssignmentDialog);
  assignmentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    closeAssignmentDialog({
      workerId: assignmentWorker.value,
      workerMachineId: assignmentWorkerMachine.value,
      executionMachineId: assignmentHarness.value,
    });
  });
  element("assignment-cancel", HTMLButtonElement).addEventListener(
    "click",
    () => closeAssignmentDialog(),
  );
  assignmentDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAssignmentDialog();
    } else if (event.key === "Tab") {
      const controls = [
        ...assignmentForm.querySelectorAll<
          HTMLButtonElement | HTMLSelectElement
        >("button, select"),
      ].filter((control) => !control.disabled);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  document.addEventListener("focusin", (event) => {
    if (
      assignmentRequest &&
      event.target instanceof Node &&
      !assignmentDialog.contains(event.target)
    )
      assignmentWorker.focus();
  });
  let copilotModelsRequested = false;
  const showSettings = (): void => {
    if (copilotModelsRequested) return;
    copilotModelsRequested = true;
    vscode.postMessage({ type: "copilot-models" });
  };
  rightTabs.addEventListener("click", () => {
    if (!settingsView.hidden) showSettings();
  });
  element("open-vscode-settings", HTMLButtonElement).addEventListener(
    "click",
    () => vscode.postMessage({ type: "settings" }),
  );
  const replaceOptions = (
    select: HTMLSelectElement,
    options: { value: string; label: string }[],
    current: string,
  ): void => {
    select.replaceChildren(
      ...options.map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    select.value = current;
  };
  type ExecutionConfiguration = import("./execution").ExecutionConfiguration;
  type MachineConfiguration = import("./execution").MachineConfiguration;
  type WorkerConfiguration = import("./execution").WorkerConfiguration;
  const machineEntry = element("machine-entry", HTMLSelectElement);
  const workerEntry = element("worker-entry", HTMLSelectElement);
  const machineForm = element("machine-configuration", HTMLFormElement);
  const workerForm = element("worker-configuration", HTMLFormElement);
  const machineFields = {
    id: element("machine-id", HTMLInputElement),
    name: element("machine-name", HTMLInputElement),
    command: element("machine-command", HTMLInputElement),
    repositoriesPath: element("machine-repositories", HTMLInputElement),
    modelsPath: element("machine-models", HTMLInputElement),
    workerPath: element("machine-worker", HTMLInputElement),
    cliPath: element("machine-copilot", HTMLInputElement),
  } satisfies Record<keyof MachineConfiguration, HTMLInputElement>;
  const workerId = element("worker-id", HTMLInputElement);
  const workerName = element("worker-name", HTMLInputElement);
  const workerMachine = element("worker-machine", HTMLSelectElement);
  const workerKind = element("worker-kind", HTMLSelectElement);
  const workerSource = element("worker-source", HTMLInputElement);
  const workerProvider = element("worker-provider", HTMLSelectElement);
  const workerDevice = element("worker-device", HTMLInputElement);
  const workerFoundry = element("worker-foundry", HTMLElement);
  const workerFoundryModel = element("worker-foundry-model", HTMLSelectElement);
  const listWorkerFoundryModels = element(
    "list-worker-foundry-models",
    HTMLButtonElement,
  );
  const workerFoundryStatus = element("worker-foundry-status", HTMLElement);
  type WorkerFoundryCatalogue =
    | { status: "loading"; requestId: string }
    | { status: "error"; error: string }
    | {
        status: "ready";
        models: { id: string; name: string; size: number }[];
      };
  const workerFoundryCatalogues = new Map<
    "cpu" | "gpu",
    WorkerFoundryCatalogue
  >();
  const saveMachine = element("save-machine", HTMLButtonElement);
  const saveWorker = element("save-worker", HTMLButtonElement);
  const deleteMachine = element("delete-machine", HTMLButtonElement);
  const deleteWorker = element("delete-worker", HTMLButtonElement);
  const addMachineCopilotWorker = element(
    "add-machine-copilot-worker",
    HTMLButtonElement,
  );
  const machineConfigurationStatus = element(
    "machine-configuration-status",
    HTMLElement,
  );
  const executionConfigurationStatus = element(
    "execution-configuration-status",
    HTMLElement,
  );
  let executionConfigurationState:
    "idle" | "saving" | "saved" | "dirty" | "error" = "idle";
  let executionEditVersion = 0;
  let savingExecutionEditVersion = 0;
  const editorEditVersions = { machine: 0, worker: 0 };
  let pendingExecutionSave:
    | {
        requestId: string;
        editor: "machine" | "worker";
        id: string;
        operation: "save" | "delete";
        editVersion: number;
      }
    | undefined;
  const setExecutionConfigurationStatus = (
    message: string,
    status: typeof executionConfigurationState = "idle",
  ): void => {
    executionConfigurationState = status;
    machineConfigurationStatus.textContent = message;
    executionConfigurationStatus.textContent = message;
  };
  const updateExecutionConfigurationControls = (): void => {
    const saving = executionConfigurationState === "saving";
    machineEntry.disabled = saving;
    workerEntry.disabled = saving;
    saveMachine.disabled = saving;
    saveWorker.disabled = saving;
    deleteMachine.disabled =
      saving || !machineEntry.value || machineEntry.value === "local";
    deleteWorker.disabled = saving || !workerEntry.value;
    addMachineCopilotWorker.disabled =
      saving ||
      !settingsState?.execution?.machines.some(
        (machine) => machine.id === machineEntry.value,
      );
  };
  const noteExecutionEdit = (): void => {
    executionEditVersion++;
    if (executionConfigurationState === "saved")
      setExecutionConfigurationStatus(
        "Machine or worker changes are unsaved.",
        "dirty",
      );
  };
  const saveExecutionConfiguration = (
    configuration: ExecutionConfiguration,
    editor: "machine" | "worker",
    id: string,
    operation: "save" | "delete" = "save",
  ): void => {
    if (executionConfigurationState === "saving") return;
    const requestId = crypto.randomUUID();
    pendingExecutionSave = {
      requestId,
      editor,
      id,
      operation,
      editVersion: editorEditVersions[editor],
    };
    savingExecutionEditVersion = executionEditVersion;
    setExecutionConfigurationStatus("Saving machines and workers...", "saving");
    updateExecutionConfigurationControls();
    vscode.postMessage({
      type: "execution-configuration",
      requestId,
      configuration,
    });
  };
  let machineEditorInitialized = false;
  let machineEditorTouched = false;
  const fillMachineForm = (): void => {
    const machine = settingsState?.execution?.machines.find(
      (entry) => entry.id === machineEntry.value,
    );
    machineForm.reset();
    for (const key of Object.keys(
      machineFields,
    ) as (keyof MachineConfiguration)[])
      machineFields[key].value =
        machine?.[key] ??
        (key === "workerPath"
          ? "devdash-genai-worker"
          : key === "cliPath"
            ? "copilot"
            : "");
    machineFields.id.readOnly = !!machine;
    machineFields.command.readOnly = machine?.id === "local";
    updateExecutionConfigurationControls();
  };
  const noteMachineEdit = (): void => {
    machineEditorTouched = true;
    editorEditVersions.machine++;
    noteExecutionEdit();
  };
  const noteWorkerEdit = (): void => {
    editorEditVersions.worker++;
    noteExecutionEdit();
  };
  machineForm.addEventListener("input", noteMachineEdit);
  machineForm.addEventListener("change", noteMachineEdit);
  workerForm.addEventListener("input", noteWorkerEdit);
  workerForm.addEventListener("change", noteWorkerEdit);
  machineEntry.addEventListener("change", () => {
    machineEditorTouched = true;
    editorEditVersions.machine++;
    fillMachineForm();
    if (executionConfigurationState === "error")
      setExecutionConfigurationStatus("");
  });
  machineForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (executionConfigurationState === "saving") return;
    const config = settingsState?.execution;
    if (!config) {
      setExecutionConfigurationStatus(
        "Machines and workers are still loading.",
      );
      return;
    }
    if (!machineForm.reportValidity()) return;
    const machine: MachineConfiguration = {
      id: machineFields.id.value.trim(),
      name: machineFields.name.value.trim(),
      command: machineFields.command.value.trim(),
      repositoriesPath: machineFields.repositoriesPath.value.trim(),
      modelsPath: machineFields.modelsPath.value.trim(),
      workerPath: machineFields.workerPath.value.trim(),
      cliPath: machineFields.cliPath.value.trim(),
    };
    if (
      !machineEntry.value &&
      config.machines.some((entry) => entry.id === machine.id)
    ) {
      setExecutionConfigurationStatus(
        machine.id === "local"
          ? "The local machine already exists; select it in Edit machine."
          : "Choose a unique machine identifier; the host/connection may be repeated.",
        "error",
      );
      return;
    }
    saveExecutionConfiguration(
      {
        ...config,
        machines: [
          ...config.machines.filter((entry) => entry.id !== machine.id),
          machine,
        ],
      },
      "machine",
      machine.id,
    );
  });
  deleteMachine.addEventListener("click", () => {
    if (executionConfigurationState === "saving") return;
    const config = settingsState?.execution;
    if (!config || !machineEntry.value || machineEntry.value === "local")
      return;
    if (
      config.workers.some((worker) => worker.machineId === machineEntry.value)
    ) {
      setExecutionConfigurationStatus(
        "Delete or reassign this machine's workers first.",
        "error",
      );
      return;
    }
    saveExecutionConfiguration(
      {
        ...config,
        machines: config.machines.filter(
          (entry) => entry.id !== machineEntry.value,
        ),
      },
      "machine",
      machineEntry.value,
      "delete",
    );
  });
  const workerFoundryDevice = (): "cpu" | "gpu" =>
    workerProvider.value === "cuda" ? "gpu" : "cpu";
  const requestWorkerFoundryModels = (): void => {
    const device = workerFoundryDevice();
    const requestId = crypto.randomUUID();
    workerFoundryCatalogues.set(device, { status: "loading", requestId });
    vscode.postMessage({ type: "worker-foundry-models", requestId, device });
  };
  const renderWorkerFoundry = (): void => {
    const foundry = workerKind.value === "foundry";
    workerFoundry.hidden = !foundry;
    if (!foundry) return;
    const device = workerFoundryDevice();
    if (!workerFoundryCatalogues.has(device)) requestWorkerFoundryModels();
    const catalogue = workerFoundryCatalogues.get(device)!;
    const models = catalogue.status === "ready" ? catalogue.models : [];
    const source = workerSource.value.trim();
    const known = models.some((model) => model.id === source);
    replaceOptions(
      workerFoundryModel,
      [
        {
          value: "",
          label:
            catalogue.status === "loading"
              ? "Loading the catalogue..."
              : catalogue.status === "error"
                ? "Catalogue unavailable"
                : models.length
                  ? "Choose a model"
                  : "No compatible model",
        },
        ...(source && !known && catalogue.status === "ready"
          ? [{ value: source, label: `${source} (not in the catalogue)` }]
          : []),
        ...models.map((model) => ({
          value: model.id,
          label: `${model.name} - ${formatBytes(model.size)}`,
        })),
      ],
      catalogue.status === "ready" ? source : "",
    );
    workerFoundryModel.disabled = catalogue.status !== "ready";
    listWorkerFoundryModels.disabled = catalogue.status === "loading";
    workerFoundryStatus.textContent =
      catalogue.status === "loading"
        ? `Listing Foundry Local ${device === "gpu" ? "CUDA" : "CPU"} models...`
        : catalogue.status === "error"
          ? `Could not list Foundry Local models: ${catalogue.error}`
          : `${models.length} ${device === "gpu" ? "CUDA" : "CPU"} model(s) in the catalogue.`;
  };
  workerFoundryModel.addEventListener("change", () => {
    workerSource.value = workerFoundryModel.value;
  });
  workerProvider.addEventListener("change", () => renderWorkerFoundry());
  workerSource.addEventListener("input", () => renderWorkerFoundry());
  listWorkerFoundryModels.addEventListener("click", () => {
    requestWorkerFoundryModels();
    renderWorkerFoundry();
  });
  addMachineCopilotWorker.addEventListener("click", () => {
    if (executionConfigurationState === "saving") return;
    const config = settingsState?.execution;
    const machine = config?.machines.find(
      (entry) => entry.id === machineEntry.value,
    );
    if (!config || !machine) return;
    let id = `copilot-${machine.id}`.slice(0, 100);
    for (
      let index = 2;
      config.workers.some((entry) => entry.id === id);
      index++
    )
      id = `copilot-${machine.id}`.slice(0, 90) + `-${index}`;
    saveExecutionConfiguration(
      {
        ...config,
        workers: [
          ...config.workers,
          {
            id,
            name: `Copilot @ ${machine.name}`.slice(0, 100),
            machineId: machine.id,
            backend: "copilot",
            model: { kind: "copilot", source: "" },
            provider: "cpu",
            deviceId: 0,
          },
        ],
      },
      "worker",
      id,
    );
  });
  const workerKindHint = element("worker-kind-hint", HTMLElement);
  const updateWorkerKind = (): void => {
    const copilot = workerKind.value === "copilot";
    const machine = settingsState?.execution?.machines.find(
      (entry) => entry.id === workerMachine.value,
    );
    const place = machine
      ? `${machine.name}${machine.command ? " (remote)" : " (this computer)"}`
      : "the selected machine";
    workerKindHint.textContent = copilot
      ? `The Copilot CLI (${machine?.cliPath ?? "copilot"}) runs on ${place}; it must be installed and signed in there. Its sessions edit files and run commands on ${place}.`
      : `The model runs on ${place}. Each session using this worker chooses separately which machine edits files and runs commands.`;
    workerSource.required = !copilot;
    workerProvider.disabled = copilot;
    workerDevice.disabled = copilot;
    const suggestions = copilot
      ? (settingsState?.copilotModels ?? []).map((model) => ({
          id: model.id,
          name: model.name,
        }))
      : [];
    element("worker-model-suggestions", HTMLDataListElement).replaceChildren(
      ...suggestions.map((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        option.label = model.name;
        return option;
      }),
    );
    renderWorkerFoundry();
  };
  workerKind.addEventListener("change", updateWorkerKind);
  workerMachine.addEventListener("change", updateWorkerKind);
  const fillWorkerForm = (): void => {
    const worker = settingsState?.execution?.workers.find(
      (entry) => entry.id === workerEntry.value,
    );
    workerForm.reset();
    workerId.value = worker?.id ?? "";
    workerId.readOnly = !!worker;
    workerName.value = worker?.name ?? "";
    workerMachine.value = worker?.machineId ?? "local";
    workerKind.value = worker?.model.kind ?? "copilot";
    workerSource.value = worker?.model.source ?? "";
    workerProvider.value = worker?.provider ?? "cpu";
    workerDevice.value = String(worker?.deviceId ?? 0);
    updateExecutionConfigurationControls();
    updateWorkerKind();
  };
  workerEntry.addEventListener("change", () => {
    editorEditVersions.worker++;
    fillWorkerForm();
    if (executionConfigurationState === "error")
      setExecutionConfigurationStatus("");
  });
  workerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (executionConfigurationState === "saving") return;
    const config = settingsState?.execution;
    if (!config || !workerForm.reportValidity()) return;
    if (
      !workerEntry.value &&
      config.workers.some((entry) => entry.id === workerId.value.trim())
    ) {
      setExecutionConfigurationStatus(
        "Choose a unique worker identifier.",
        "error",
      );
      return;
    }
    const worker: WorkerConfiguration = {
      id: workerId.value.trim(),
      name: workerName.value.trim(),
      machineId: workerMachine.value,
      backend: workerKind.value === "copilot" ? "copilot" : "local",
      model: {
        kind: workerKind.value as WorkerConfiguration["model"]["kind"],
        source: workerSource.value.trim(),
      },
      provider: workerProvider.value as WorkerConfiguration["provider"],
      deviceId: Number(workerDevice.value),
    };
    saveExecutionConfiguration(
      {
        ...config,
        workers: [
          ...config.workers.filter((entry) => entry.id !== worker.id),
          worker,
        ],
      },
      "worker",
      worker.id,
    );
  });
  deleteWorker.addEventListener("click", () => {
    if (executionConfigurationState === "saving") return;
    const config = settingsState?.execution;
    if (!config || !workerEntry.value) return;
    saveExecutionConfiguration(
      {
        ...config,
        workers: config.workers.filter(
          (entry) => entry.id !== workerEntry.value,
        ),
      },
      "worker",
      workerEntry.value,
      "delete",
    );
  });
  const renderExecutionConfiguration = (): void => {
    const config = settingsState?.execution;
    if (!config) return;
    const initializeMachine =
      !machineEditorInitialized && !machineEditorTouched;
    replaceOptions(
      machineEntry,
      [
        { value: "", label: "Add a remote machine" },
        ...config.machines.map((machine) => ({
          value: machine.id,
          label: `${machine.name} (${machine.id})`,
        })),
      ],
      initializeMachine ? "local" : machineEntry.value,
    );
    if (initializeMachine) fillMachineForm();
    machineEditorInitialized = true;
    replaceOptions(
      workerEntry,
      [
        { value: "", label: "Add a worker" },
        ...config.workers.map((worker) => ({
          value: worker.id,
          label: `${worker.name} - ${worker.model.source || "CLI default"} @ ${worker.machineId}`,
        })),
      ],
      workerEntry.value,
    );
    replaceOptions(
      workerMachine,
      config.machines.map((machine) => ({
        value: machine.id,
        label: `${machine.name} (${machine.id})`,
      })),
      workerMachine.value || "local",
    );
    updateWorkerKind();
    if (executionConfigurationState === "idle")
      setExecutionConfigurationStatus(
        `${config.machines.length} machine(s), ${config.workers.length} worker(s).`,
      );
    updateExecutionConfigurationControls();
  };
  type RemoteMachine = import("./remote").RemoteMachine;
  const executionMachine = element("execution-machine", HTMLSelectElement);
  const removeRemoteMachine = element(
    "remove-remote-machine",
    HTMLButtonElement,
  );
  const executionMachineDetails = element(
    "execution-machine-details",
    HTMLElement,
  );
  const remoteMachineForm = element("remote-machine-form", HTMLFormElement);
  const remoteMachineFields = {
    name: element("remote-machine-name", HTMLInputElement),
    command: element("remote-machine-command", HTMLInputElement),
    workerPath: element("remote-worker-path", HTMLInputElement),
    modelPath: element("remote-model-path", HTMLInputElement),
    repositoriesPath: element("remote-repositories-path", HTMLInputElement),
  } satisfies Record<keyof RemoteMachine, HTMLInputElement>;
  const saveRemoteMachines = (
    machines: RemoteMachine[],
    selected: string,
  ): void =>
    vscode.postMessage({ type: "remote-machines", machines, selected });
  const fillRemoteMachineForm = (machine: RemoteMachine | undefined): void => {
    if (!machine) return;
    for (const [key, input] of Object.entries(remoteMachineFields))
      input.value = machine[key as keyof RemoteMachine];
  };
  executionMachine.addEventListener("change", () => {
    if (!settingsState) return;
    fillRemoteMachineForm(
      settingsState.remoteMachines.find(
        (machine) => machine.name === executionMachine.value,
      ),
    );
    saveRemoteMachines(settingsState.remoteMachines, executionMachine.value);
  });
  removeRemoteMachine.addEventListener("click", () => {
    if (!settingsState || !settingsState.remoteMachine) return;
    saveRemoteMachines(
      settingsState.remoteMachines.filter(
        (machine) => machine.name !== settingsState?.remoteMachine,
      ),
      "",
    );
  });
  remoteMachineForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!settingsState || !remoteMachineForm.reportValidity()) return;
    const machine = Object.fromEntries(
      Object.entries(remoteMachineFields).map(([key, input]) => [
        key,
        input.value.trim(),
      ]),
    ) as unknown as RemoteMachine;
    const machines = settingsState.remoteMachines.filter(
      (entry) => entry.name !== machine.name,
    );
    saveRemoteMachines([...machines, machine], machine.name);
  });
  const renderExecutionMachine = (
    settings: SettingsState | undefined,
  ): void => {
    const machines = settings?.remoteMachines ?? [];
    const selected = settings?.remoteMachine ?? "";
    const options = [
      { value: "", label: "This computer" },
      ...machines.map((machine) => ({
        value: machine.name,
        label: machine.name,
      })),
    ];
    if (selected && !machines.some((machine) => machine.name === selected))
      options.push({ value: selected, label: `${selected} (not configured)` });
    replaceOptions(executionMachine, options, selected);
    removeRemoteMachine.disabled = !selected;
    const machine = machines.find((entry) => entry.name === selected);
    executionMachineDetails.textContent = machine
      ? `Local sessions run ${machine.workerPath} with ${machine.modelPath} on ${machine.name}; tools use ${machine.repositoriesPath}/<repository folder>.`
      : selected
        ? `${selected} is not configured; local sessions cannot start.`
        : "Local sessions run on this computer.";
  };
  const showLoadError = (target: HTMLElement, error?: string): void => {
    target.textContent = error ?? "";
    target.hidden = !error;
  };
  const renderSettings = (): void => {
    const settings = settingsState;
    renderExecutionConfiguration();
    if (settings) {
      if (!dirtyHarnessFields.has("cliPath")) cliPath.value = settings.cliPath;
      if (!dirtyHarnessFields.has("localWorkerPath"))
        localWorkerPath.value = settings.localWorkerPath;
      if (!dirtyHarnessFields.has("requestTimeoutMinutes"))
        requestTimeoutMinutes.value = String(settings.requestTimeoutMinutes);
      if (!dirtyHarnessFields.has("workerIdleMinutes"))
        workerIdleMinutes.value = String(settings.workerIdleMinutes);
      if (!dirtyHarnessFields.has("approvedUrlOrigins"))
        approvedUrlOrigins.value = settings.approvedUrlOrigins.join("\n");
    }
    const models = [
      { value: "", label: "CLI default" },
      ...(settings?.copilotModels ?? []).map((model) => ({
        value: model.id,
        label:
          model.name === model.id ? model.id : `${model.name} (${model.id})`,
      })),
    ];
    const currentModel = settings?.copilotModel ?? "";
    if (!models.some((option) => option.value === currentModel))
      models.push({
        value: currentModel,
        label: `${currentModel} (configured)`,
      });
    replaceOptions(copilotModel, models, currentModel);
    const modelsLoading = settings?.copilotModelsStatus === "loading";
    refreshCopilotModels.disabled = modelsLoading;
    copilotModelStatus.textContent = modelsLoading
      ? "Loading Copilot models..."
      : settings?.copilotModelsStatus === "ready"
        ? `${settings.copilotModels?.length ?? 0} model(s) available.`
        : "";
    showLoadError(copilotModelError, settings?.copilotModelsError);
    localModelPath.textContent =
      settings?.localModelPath || "No local model is selected.";
    const devices = [
      { value: "auto:-1", label: "Automatic (prefer CUDA)" },
      ...(settings?.localDevices ?? []).map((device) => ({
        value: `${device.provider}:${device.deviceId}`,
        label: `${device.provider.toUpperCase()} - ${device.name} (device ${device.deviceId})`,
      })),
    ];
    const currentDevice = settings
      ? `${settings.localProvider}:${settings.localDeviceId}`
      : "auto:-1";
    if (settings && !devices.some((option) => option.value === currentDevice))
      devices.push({
        value: currentDevice,
        label: `${settings.localProvider.toUpperCase()}${settings.localDeviceId >= 0 ? ` device ${settings.localDeviceId}` : ""} (configured)`,
      });
    replaceOptions(localDevice, devices, currentDevice);
    const devicesLoading = settings?.localDevicesStatus === "loading";
    detectLocalDevices.disabled = devicesLoading;
    localDeviceStatus.textContent = devicesLoading
      ? "Detecting local devices..."
      : settings?.localDevicesStatus === "ready"
        ? `${settings.localDevices?.length ?? 0} device(s) detected.`
        : settings?.localDevicesStatus === "error"
          ? ""
          : "Select Detect devices to list the devices available to local models.";
    showLoadError(localDeviceError, settings?.localDevicesError);
    renderExecutionMachine(settings);
    renderFoundry(settings);
  };
  const renderFoundry = (settings: SettingsState | undefined): void => {
    const download = settings?.foundryDownload;
    const listing = settings?.foundryStatus === "loading";
    if (settings) foundryDevice.value = settings.foundryDevice;
    const catalog = settings?.foundryCatalog;
    const models = catalog?.models ?? [];
    const selected = download?.id ?? foundryModel.value;
    replaceOptions(
      foundryModel,
      models.length
        ? models.map((model) => ({
            value: model.id,
            label: `${model.name} - ${formatBytes(model.size)}`,
          }))
        : [
            {
              value: "",
              label: catalog ? "No compatible model" : "List models first",
            },
          ],
      models.some((model) => model.id === selected)
        ? selected
        : (models[0]?.id ?? ""),
    );
    const model = models.find((entry) => entry.id === foundryModel.value);
    foundryModelDetails.textContent = model
      ? `${model.provider} · ${model.task} · License: ${model.license} · ${
          model.memory === undefined
            ? "Execution memory unknown"
            : `Estimated execution memory: ${formatBytes(model.memory)}`
        }${model.memoryLimit === undefined ? " (unverified)" : ""}`
      : "";
    foundryDevice.disabled = listing || !!download;
    listFoundryModels.disabled = listing || !!download;
    foundryModel.disabled = !models.length || !!download;
    downloadFoundryModel.disabled = !model || !!download || listing;
    cancelFoundry.hidden = !listing && !download;
    if (download) {
      const percent = download.total
        ? Math.min(100, Math.floor((download.received / download.total) * 100))
        : 0;
      foundryStatus.textContent = `Downloading ${download.name}: ${formatBytes(download.received)} / ${formatBytes(download.total)} (${percent}%)`;
    } else if (listing) {
      foundryStatus.textContent = "Listing Foundry Local models...";
    } else if (catalog) {
      const memory = catalog.memory;
      foundryStatus.textContent = [
        `${models.length} model(s) available`,
        `${catalog.hidden} hidden (exceed local memory)`,
        `${catalog.unsupported} unsupported (provider or task)`,
        `RAM: ${formatBytes(memory.ram)}`,
        ...(memory.nvidia === undefined
          ? []
          : [`VRAM: ${formatBytes(memory.nvidia)}`]),
        ...(memory.warning ? [memory.warning] : []),
      ].join(" · ");
    } else {
      foundryStatus.textContent =
        "Select List models to browse Microsoft's public Foundry Local catalogue.";
    }
    showLoadError(foundryError, settings?.foundryError);
  };
  renderSettings();
  copilotModel.addEventListener("change", () => {
    vscode.postMessage({ type: "copilot-model", model: copilotModel.value });
  });
  refreshCopilotModels.addEventListener("click", () => {
    copilotModelsRequested = true;
    vscode.postMessage({ type: "copilot-models" });
  });
  element("choose-local-model", HTMLButtonElement).addEventListener(
    "click",
    () => vscode.postMessage({ type: "local-model" }),
  );
  localDevice.addEventListener("change", () => {
    const [provider, deviceId] = localDevice.value.split(":");
    vscode.postMessage({
      type: "local-device",
      provider: provider as SettingsState["localProvider"],
      deviceId: Number(deviceId),
    });
  });
  detectLocalDevices.addEventListener("click", () => {
    vscode.postMessage({ type: "local-devices" });
  });
  const requestFoundryModels = (): void => {
    vscode.postMessage({
      type: "foundry-models",
      device: foundryDevice.value as SettingsState["foundryDevice"],
    });
  };
  listFoundryModels.addEventListener("click", requestFoundryModels);
  foundryDevice.addEventListener("change", requestFoundryModels);
  foundryModel.addEventListener("change", () => renderFoundry(settingsState));
  downloadFoundryModel.addEventListener("click", () => {
    if (foundryModel.value)
      vscode.postMessage({ type: "foundry-download", id: foundryModel.value });
  });
  cancelFoundry.addEventListener("click", () => {
    vscode.postMessage({ type: "foundry-cancel" });
  });
  const exportPostMortem = element("export-postmortem", HTMLButtonElement);
  let postMortemRenderedKey: string | undefined;
  let postMortemTableKey: string | undefined;
  const cancel = element("cancel", HTMLButtonElement);
  const addSession = element("add-session", HTMLButtonElement);
  const sessionPicker = element("session-picker", HTMLSelectElement);
  let sessionViews = new Map<string, import("./application").SessionView>();
  sessionPicker.addEventListener("change", () => {
    const view = sessionViews.get(sessionPicker.value);
    if (state?.activeId && view)
      vscode.postMessage({
        type: "select-session",
        id: state.activeId,
        view,
      });
  });
  const resumeSession = element("resume-session", HTMLButtonElement);
  const newSession = element("new-session", HTMLButtonElement);
  const closeSession = element("close-session", HTMLButtonElement);
  for (const [button, type] of [
    [addSession, "add-session"],
    [resumeSession, "resume-session"],
    [newSession, "new-session"],
    [closeSession, "close-session"],
  ] as const) {
    button.addEventListener("click", () => {
      if (state?.activeId) {
        vscode.postMessage({
          type,
          id: state.activeId,
          ...(type !== "add-session" ? { view: activeView() } : {}),
        });
      }
    });
  }
  const error = element("error", HTMLElement);
  const composer = element("composer", HTMLFormElement);
  const filters = element("information-filters", HTMLFieldSetElement);
  const previousPrompt = element("previous-prompt", HTMLButtonElement);
  const nextPrompt = element("next-prompt", HTMLButtonElement);
  const repositoryMenu = element("repository-menu", HTMLElement);
  const githubTabs = element("github-tabs", HTMLElement);
  const githubItems = element("github-items", HTMLElement);
  const githubRefresh = element("github-refresh", HTMLButtonElement);
  const githubMore = element("github-more", HTMLButtonElement);
  const discussionView = element("github-discussion", HTMLElement);
  const discussionContent = element("github-discussion-content", HTMLElement);
  const discussionStatus = element("github-discussion-status", HTMLElement);
  const discussionError = element("github-discussion-error", HTMLElement);
  const discussionRefresh = element(
    "github-discussion-refresh",
    HTMLButtonElement,
  );
  const discussionExternal = element(
    "github-discussion-external",
    HTMLButtonElement,
  );
  const discussionShow = element("github-discussion-show", HTMLButtonElement);
  const commentForm = element("github-comment-form", HTMLFormElement);
  const commentBody = element("github-comment-body", HTMLTextAreaElement);
  const commentSubmit = element("github-comment-submit", HTMLButtonElement);
  const commentStatus = element("github-comment-status", HTMLElement);
  const commentError = element("github-comment-error", HTMLElement);
  interface CommentDraft {
    text: string;
    pending?: { requestId: string; body: string };
    message?: string;
    error?: string;
    published: { id: string; html: string }[];
  }
  const commentDrafts = new Map<string, CommentDraft>();
  let commentSequence = 0;
  let discussionReady = false;
  let selectedDiscussion: { id: string; url: string } | undefined;
  type GitHubSection = import("./github").GitHubSection;
  type GitHubPage = import("./github").GitHubPage;
  type GitHubUpdate = import("./github").GitHubUpdate;
  type GitHubDiscussionUpdate = import("./github").GitHubDiscussionUpdate;
  type GitHubCommentUpdate = import("./github").GitHubCommentUpdate;
  const githubLabels: Record<GitHubSection, string> = {
    issues: "Issues",
    reviews: "Reviews",
    "oldest-prs": "Oldest PRs",
    comments: "Comments",
    commits: "Commits",
    mentions: "Mentions",
  };
  let githubSection: GitHubSection = "issues";
  const githubPages = new Map<
    string,
    {
      status: GitHubUpdate["status"];
      page?: GitHubPage;
      error?: string;
    }
  >();
  let githubRenderedKey: string | undefined;
  let githubRenderedPage: object | undefined;
  let menuRepositoryId: string | undefined;
  let menuConfirmation:
    "delete-last-session" | "delete-all-sessions" | undefined;
  const categories: Record<
    import("./application").ChatMessage["role"],
    import("./application").InformationType
  > = {
    user: "messages",
    assistant: "messages",
    reasoning: "reasoning",
    tool: "tools",
    output: "output",
    system: "system",
  };
  const roleLabels = {
    user: "",
    assistant: "",
    reasoning: "Reasoning",
    tool: "Tool",
    output: "Output",
    system: "Session",
  };
  const application = document.querySelector<HTMLElement>(".application");
  if (!application) {
    throw new Error("Missing application layout.");
  }
  const layout = application;
  const divider = element("right-divider", HTMLElement);
  let chatWidth = 0.75;
  let drag: { pointerId: number; x: number; width: number } | undefined;

  function resize(delta: number, initial = chatWidth): void {
    const available = layout.clientWidth - 6;
    if (available <= 0) {
      return;
    }
    const minimumScale = Math.min(1, available / 380);
    chatWidth = Math.max(
      (240 / available) * minimumScale,
      Math.min(
        1 - (140 / available) * minimumScale,
        initial + delta / available,
      ),
    );
    layout.style.gridTemplateColumns = `${chatWidth}fr 6px ${1 - chatWidth}fr`;
    updateDivider();
  }

  function updateDivider(): void {
    divider.setAttribute("aria-valuenow", String(Math.round(chatWidth * 100)));
    divider.setAttribute("aria-valuemin", "0");
    divider.setAttribute("aria-valuemax", "100");
  }

  function stopResize(): void {
    drag = undefined;
    document.body.classList.remove("resizing");
    divider.classList.remove("dragging");
  }

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: chatWidth,
    };
    divider.setPointerCapture?.(event.pointerId);
    document.body.classList.add("resizing");
    divider.classList.add("dragging");
  });
  divider.addEventListener("lostpointercapture", stopResize);
  divider.addEventListener("keydown", (event) => {
    const delta =
      event.key === "ArrowLeft"
        ? -16
        : event.key === "ArrowRight"
          ? 16
          : undefined;
    if (delta !== undefined) {
      event.preventDefault();
      resize(delta);
    }
  });
  document.addEventListener("pointermove", (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      resize(event.clientX - drag.x, drag.width);
    }
  });
  for (const type of ["pointerup", "pointercancel"] as const) {
    document.addEventListener(type, (event) => {
      if (drag?.pointerId === event.pointerId) {
        stopResize();
      }
    });
  }
  window.addEventListener("blur", stopResize);
  updateDivider();
  let state: State | undefined;
  let pending:
    | {
        id: string;
        view: import("./application").SessionView;
        text: string;
        images?: ImageAttachment[];
      }
    | undefined;
  const drafts = new Map<string, string>();
  const draftKey = (
    id: string,
    view: import("./application").SessionView,
  ): string => `${id}:${view}`;
  const imageDraftKey = (
    id: string,
    view: import("./application").SessionView,
  ): string => `${id}:${view}`;
  const activeView = (): import("./application").SessionView => {
    const repository = state?.repositories.find(
      (entry) => entry.id === state?.activeId,
    );
    return (
      repository?.view ??
      (repository?.backend === "local" ? "local" : "copilot")
    );
  };
  function sessionGeneration(
    repository: State["repositories"][number] | undefined,
    view: import("./application").SessionView,
  ): number | undefined {
    const session = repository?.sessions?.find((entry) => entry.view === view);
    if (session) return session.generation;
    if (view.startsWith("local:"))
      return repository?.localSessions?.find(
        (entry) => entry.id === view.slice(6),
      )?.generation;
    if (view === "local") return repository?.localSession?.generation;
    if (view === "copilot")
      return (
        repository?.copilotGeneration ??
        (repository?.backend !== "local" ? repository?.generation : undefined)
      );
    return undefined;
  }
  let localModels: import("./local-model-host").LocalModelSnapshot[] = [];
  let copilotWorkers: import("./application").CopilotWorkerSnapshot[] = [];
  const statusLabels = {
    idle: "Not started",
    saved: "Session closed - use Resume or New",
    starting: "Starting Copilot...",
    ready: "Session open - ready",
    busy: "Session open - Copilot is working...",
    error: "Session stopped - use Resume or New",
    stopping: "Updating sessions...",
  };
  const localStatusLabels: Record<
    import("./application").SessionStatus,
    string
  > = {
    idle: "No local model loaded",
    saved: "Local session closed - use New to start again",
    starting: "Starting local model...",
    ready: "Local model ready",
    busy: "Local model is generating...",
    error: "Local model stopped - use New to retry",
    stopping: "Stopping local model...",
  };
  function statusLabel(
    repository: State["repositories"][number],
    status: import("./application").SessionStatus = repository.status,
  ): string {
    return repository.backend === "local"
      ? localStatusLabels[status]
      : statusLabels[status];
  }

  function renderWorkerTable(): void {
    const body = document.querySelector<HTMLTableSectionElement>(
      "#worker-table tbody",
    )!;
    const focused =
      document.activeElement instanceof HTMLButtonElement &&
      body.contains(document.activeElement)
        ? document.activeElement.dataset.hostId
        : undefined;
    const running = localModels.filter(
      (model) => model.status !== "disk" && model.status !== "unloaded",
    );
    const count = running.length + copilotWorkers.length;
    element("worker-table", HTMLTableElement).hidden = !count;
    element("worker-table-empty", HTMLElement).hidden = !!count;
    const autoStop = (busy: boolean, at?: number): string =>
      busy
        ? "not while running"
        : at === undefined
          ? "never"
          : `at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const row = (
      cells: string[],
      key: string,
      disabled: boolean,
      title: string,
      message: import("./application").ApplicationMessage,
    ): HTMLTableRowElement => {
      const row = document.createElement("tr");
      for (const text of cells) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      const actions = document.createElement("td");
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "Stop";
      stop.dataset.hostId = key;
      stop.title = title;
      stop.disabled = disabled;
      stop.addEventListener("click", () => vscode.postMessage(message));
      actions.append(stop);
      row.append(actions);
      return row;
    };
    body.replaceChildren(
      ...running.map((model) =>
        row(
          [
            model.workerName ?? "Legacy local model",
            model.machineName ?? "This computer",
            model.name ?? model.modelPath,
            model.device
              ? `${model.device.provider.toUpperCase()} ${model.device.deviceId}`
              : model.placement.provider.toUpperCase(),
            model.busy ? "running a request" : model.status,
            String(model.sessions.length),
            autoStop(model.busy, model.idleStopAt),
          ],
          model.id ?? "",
          !model.id || model.busy || model.status === "loading",
          model.busy
            ? "Wait for the running request to finish"
            : "Stop this worker and free its memory; sessions reload it when needed",
          { type: "stop-local-worker", hostId: model.id ?? "" },
        ),
      ),
      ...copilotWorkers.map((worker) =>
        row(
          [
            worker.workerName,
            worker.machineName,
            `Copilot: ${worker.model}`,
            "Copilot CLI",
            worker.busy ? "running a request" : "ready",
            String(worker.sessions.length),
            autoStop(worker.busy, worker.idleStopAt),
          ],
          `copilot:${worker.groupId}`,
          worker.busy,
          worker.busy
            ? "Wait for the running requests to finish"
            : "Close this worker's Copilot CLI sessions and free their memory; Resume continues them",
          { type: "stop-copilot-worker", groupId: worker.groupId },
        ),
      ),
    );
    if (focused)
      [...body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.dataset.hostId === focused)
        ?.focus();
  }

  function renderLocalModels(): void {
    renderWorkerTable();
    const focused =
      document.activeElement instanceof HTMLButtonElement &&
      localModelsContainer.contains(document.activeElement)
        ? {
            modelPath: document.activeElement.dataset.modelPath,
            controlKey: document.activeElement.dataset.controlKey,
          }
        : undefined;
    if (!localModels.length) {
      localModelsContainer.textContent = "";
      const empty = document.createElement("p");
      empty.textContent = "No local model is loaded.";
      localModelsContainer.append(empty);
      return;
    }
    const sections = localModels.map((model) => {
      const section = document.createElement("section");
      section.className = "local-model-card";
      const heading = document.createElement("h3");
      heading.textContent = model.name ?? model.modelPath;
      const detail = document.createElement("p");
      const location =
        model.status === "disk"
          ? "DISK (unloaded)"
          : model.device
            ? `${model.device.provider.toUpperCase()} ${model.device.deviceId}: ${model.device.name}`
            : `${model.placement.provider.toUpperCase()} (not loaded)`;
      detail.textContent = `${model.status} · ${location}${model.contextLength ? ` · context ${model.contextLength.toLocaleString()} tokens` : ""}${model.sizeBytes ? ` · model ${formatBytes(model.sizeBytes)}` : ""}`;
      section.append(heading, detail);
      if (model.error) {
        const error = document.createElement("p");
        error.className = "settings-error";
        error.textContent = model.error;
        section.append(error);
      }
      const controls = document.createElement("div");
      controls.className = "settings-row";
      const unavailable = model.busy || model.status === "loading";
      for (const device of settingsState?.localDevices ?? []) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.modelPath = model.id ?? model.modelPath;
        button.dataset.controlKey = `${device.provider}:${device.deviceId}`;
        button.textContent = `${device.provider.toUpperCase()} ${device.deviceId}`;
        const current =
          model.status === "ready" &&
          model.device?.provider === device.provider &&
          model.device.deviceId === device.deviceId;
        button.title = current
          ? `The shared model is on ${device.name}`
          : `Move the shared model to ${device.name}`;
        button.disabled = unavailable || current;
        if (current) button.setAttribute("aria-current", "true");
        button.addEventListener("click", () =>
          vscode.postMessage({
            type: "local-placement",
            modelPath: model.modelPath,
            ...(model.id ? { hostId: model.id } : {}),
            placement: {
              provider: device.provider,
              deviceId: device.deviceId,
            },
          }),
        );
        controls.append(button);
      }
      const disk = document.createElement("button");
      disk.type = "button";
      disk.dataset.modelPath = model.id ?? model.modelPath;
      disk.dataset.controlKey = "disk";
      disk.textContent = "DISK (unload)";
      disk.title =
        "Unload the model and all session caches; nothing is saved to disk.";
      disk.disabled = unavailable || model.status === "disk";
      disk.addEventListener("click", () =>
        vscode.postMessage({
          type: "local-placement",
          modelPath: model.modelPath,
          ...(model.id ? { hostId: model.id } : {}),
          placement: { provider: "disk" },
        }),
      );
      controls.append(disk);
      section.append(controls);
      const sessions = document.createElement("ul");
      for (const entry of model.sessions) {
        const repository = state?.repositories.find(
          (item) => item.id === entry.repositoryId,
        );
        const local = entry.localSessionId
          ? repository?.localSessions?.find(
              (session) => session.id === entry.localSessionId,
            )
          : repository?.localSession;
        const row = document.createElement("li");
        const open = document.createElement("button");
        open.type = "button";
        open.className = "local-session-link";
        open.dataset.modelPath = model.id ?? model.modelPath;
        open.dataset.controlKey = `session:${entry.localSessionId ?? entry.repositoryId}`;
        open.title = "Show this local session";
        open.disabled = !repository;
        open.addEventListener("click", () => {
          showConversation(true);
          vscode.postMessage(
            entry.localSessionId
              ? {
                  type: "select-local-session",
                  id: entry.repositoryId,
                  localSessionId: entry.localSessionId,
                }
              : { type: "open-local-session", id: entry.repositoryId },
          );
        });
        const provider =
          model.device?.provider ??
          (model.placement.provider === "disk"
            ? undefined
            : model.placement.provider);
        const bytesPerToken = provider
          ? model.bytesPerToken?.[provider as "cpu" | "cuda" | "npu"]
          : undefined;
        const allocatedTokens =
          model.sharedBuffer && provider === "cuda"
            ? (entry.cacheCapacity ?? entry.cacheTokens)
            : entry.cacheTokens;
        const cacheSize = bytesPerToken
          ? ` · ≈${formatBytes(allocatedTokens * bytesPerToken)} KV`
          : "";
        open.textContent = `${repository?.name ?? entry.repositoryId}: ${entry.cacheTokens.toLocaleString()} cached${entry.cacheCapacity ? ` / ${entry.cacheCapacity.toLocaleString()} capacity` : ""}${cacheSize}${local?.contextTokens !== undefined ? ` · context ${local.contextTokens.toLocaleString()} / ${(local.contextLimit ?? model.contextLength ?? 0).toLocaleString()}` : ""}${local ? ` · ${local.generatedTokens.toLocaleString()} generated` : ""}`;
        if (entry.localSessionId)
          open.textContent += ` · ${local?.readOnly ? "read-only" : "editing"}`;
        row.append(open);
        for (const mode of ["sliding", "compress"] as const) {
          const reduce = document.createElement("button");
          reduce.type = "button";
          reduce.dataset.modelPath = model.id ?? model.modelPath;
          reduce.dataset.controlKey = `${mode}:${entry.localSessionId ?? entry.repositoryId}`;
          reduce.textContent =
            mode === "sliding" ? "Discard oldest half" : "Compress & prefill";
          reduce.title =
            mode === "sliding"
              ? "Keep the newest half of the context and system instructions. This runtime rebuilds the cache because in-place KV eviction is unavailable. The displayed transcript is kept."
              : "Summarize context to half its token size, keep system instructions, clear the old cache and prefill a new one. The displayed transcript is kept.";
          reduce.disabled =
            unavailable ||
            model.status !== "ready" ||
            !local?.contextTokens ||
            (local?.status !== "ready" &&
              !(local?.status === "error" && local.canReduceContext)) ||
            Boolean(repository?.managementBusy);
          reduce.addEventListener("click", () =>
            vscode.postMessage({
              type: "reduce-context",
              id: entry.repositoryId,
              mode,
              ...(entry.localSessionId
                ? { view: `local:${entry.localSessionId}` }
                : {}),
            }),
          );
          row.append(reduce);
        }
        if (local?.reducingContext) {
          const cancelReduction = document.createElement("button");
          cancelReduction.type = "button";
          cancelReduction.dataset.modelPath = model.id ?? model.modelPath;
          cancelReduction.dataset.controlKey = `cancel-context:${entry.localSessionId ?? entry.repositoryId}`;
          cancelReduction.textContent = "Cancel context reduction";
          cancelReduction.addEventListener("click", () =>
            vscode.postMessage({
              type: "cancel",
              id: entry.repositoryId,
              view: entry.localSessionId
                ? `local:${entry.localSessionId}`
                : "local",
            }),
          );
          row.append(cancelReduction);
        }
        sessions.append(row);
      }
      if (!model.sessions.length) {
        const row = document.createElement("li");
        row.textContent = "No open conversation sessions.";
        sessions.append(row);
      }
      section.append(sessions);
      return section;
    });
    localModelsContainer.replaceChildren(...sections);
    if (focused?.modelPath && focused.controlKey) {
      const target = [
        ...localModelsContainer.querySelectorAll<HTMLButtonElement>(
          "button[data-model-path][data-control-key]",
        ),
      ].find(
        (button) =>
          button.dataset.modelPath === focused.modelPath &&
          button.dataset.controlKey === focused.controlKey,
      );
      target?.focus();
    }
  }

  function showError(message = ""): void {
    error.textContent = message;
    error.hidden = !message;
  }

  function updateControls(): void {
    const repository = state?.repositories.find(
      (entry) => entry.id === state?.activeId,
    );
    const ready =
      repository?.status === "ready" || repository?.status === "busy";
    const submitting =
      pending !== undefined &&
      pending.id === repository?.id &&
      pending.view === activeView();
    const localMode = repository?.backend === "local";
    const disk = localModels.some(
      (model) =>
        model.status === "disk" &&
        model.sessions.some(
          (session) =>
            session.repositoryId === repository?.id &&
            (!session.localSessionId ||
              session.localSessionId === repository?.localSession?.id),
        ),
    );
    const sessionOpen =
      repository?.sessions?.find((session) => session.view === activeView())
        ?.open ??
      ["starting", "ready", "busy"].includes(repository?.status ?? "idle");
    addSession.disabled =
      !repository ||
      Boolean(repository.managementBusy) ||
      repository.status === "stopping" ||
      Boolean(state?.postMortemBusy);
    const sessions = repository?.sessions ?? [
      ...(!localMode && sessionOpen
        ? [
            {
              view: "copilot" as const,
              backend: "copilot" as const,
              open: true,
              model: repository?.model,
              status: repository?.status,
              readOnly: undefined,
            },
          ]
        : []),
      ...(repository?.localSessions ?? []).map((local) => ({
        ...local,
        view: `local:${local.id}` as const,
        backend: "local" as const,
        open: ["starting", "ready", "busy", "error"].includes(local.status),
      })),
    ];
    const openSessions = sessions.filter((session) => session.open);
    const counts = { copilot: 0, local: 0 };
    const options: { value: string; text: string }[] = sessions.flatMap(
      (session) => {
        const index = ++counts[session.backend];
        if (!session.open) return [];
        return [
          {
            value: session.view,
            text: `${session.backend === "copilot" ? "Copilot" : "Local"} ${index}${"assignment" in session && session.assignment ? ` - ${session.assignment.worker.name} | commands: ${session.assignment.executionMachine.name}` : ""}${session.model ? ` - ${session.model}` : ""}${session.readOnly ? " (read-only)" : ""}`,
          },
        ];
      },
    );
    const selected = openSessions.some(
      (session) => session.view === activeView(),
    )
      ? activeView()
      : "";
    if (!selected)
      options.unshift({
        value: "",
        text: openSessions.length
          ? "Select an open session"
          : "No open session",
      });
    const pickerKey = JSON.stringify(options);
    if (sessionPicker.dataset.options !== pickerKey) {
      sessionViews = new Map(
        openSessions.map((session) => [session.view, session.view]),
      );
      sessionPicker.replaceChildren(
        ...options.map(({ value, text }) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          return option;
        }),
      );
      sessionPicker.dataset.options = pickerKey;
    }
    sessionPicker.disabled = !openSessions.length;
    if (sessionPicker.value !== selected) sessionPicker.value = selected;
    resumeSession.disabled =
      !repository ||
      submitting ||
      Boolean(repository.managementBusy) ||
      ["starting", "stopping"].includes(repository.status) ||
      Boolean(state?.postMortemBusy);
    newSession.disabled = resumeSession.disabled;
    closeSession.disabled =
      !repository ||
      !sessionOpen ||
      submitting ||
      Boolean(repository.managementBusy) ||
      Boolean(state?.postMortemBusy);
    question.disabled =
      !ready || submitting || Boolean(repository?.managementBusy);
    send.disabled =
      !ready ||
      Boolean(repository?.managementBusy) ||
      (disk && localMode) ||
      submitting ||
      readingImages.has(
        repository ? imageDraftKey(repository.id, activeView()) : "",
      ) ||
      (!question.value.trim() &&
        !imageDrafts.get(
          repository ? imageDraftKey(repository.id, activeView()) : "",
        )?.length);
    exportSession.disabled =
      !repository ||
      submitting ||
      (!repository.hasSavedSession &&
        !state?.messages.length &&
        !state?.draft) ||
      ["starting", "stopping"].includes(repository.status);
    cancel.disabled =
      !state?.postMortemBusy &&
      !["starting", "busy"].includes(repository?.status ?? "idle");
    const running =
      submitting ||
      repository?.status === "starting" ||
      repository?.status === "busy" ||
      repository?.status === "stopping";
    element("activity-icon", HTMLElement).hidden = !running;
    element("chat-panel", HTMLElement).setAttribute(
      "aria-busy",
      String(running),
    );
    if (submitting) {
      element("session-status", HTMLElement).textContent = repository
        ? statusLabel(repository, "busy")
        : statusLabels.busy;
    } else if (localMode) {
      element("session-status", HTMLElement).textContent =
        statusLabel(repository);
    }
  }

  function render(next: State): void {
    const previousRepositories = new Map(
      state?.repositories.map((repository) => [repository.id, repository]),
    );
    const previousActive = previousRepositories.get(state?.activeId ?? "");
    const nextActive = next.repositories.find(
      (entry) => entry.id === next.activeId,
    );
    const previousView =
      previousActive?.view ??
      (previousActive?.backend === "local" ? "local" : "copilot");
    const nextView =
      nextActive?.view ??
      (nextActive?.backend === "local" ? "local" : "copilot");
    const previousGeneration = sessionGeneration(previousActive, previousView);
    const nextGeneration = sessionGeneration(nextActive, nextView);
    const reset =
      previousActive?.id === nextActive?.id &&
      previousView === nextView &&
      previousGeneration !== nextGeneration;
    if (state?.activeId && !reset && previousActive) {
      drafts.set(draftKey(state.activeId, previousView), question.value);
    }
    for (const repository of next.repositories) {
      const previous = previousRepositories.get(repository.id);
      if (previous) {
        const previousGenerations = new Map(
          previous.sessions?.map((session) => [
            session.view,
            session.generation,
          ]),
        );
        const nextGenerations = new Map(
          repository.sessions?.map((session) => [
            session.view,
            session.generation,
          ]),
        );
        const views = new Set<import("./application").SessionView>([
          "copilot",
          "local",
          ...(previous.sessions ?? []).map((session) => session.view),
          ...(repository.sessions ?? []).map((session) => session.view),
          ...(previous.localSessions ?? []).map(
            (local): import("./application").SessionView => `local:${local.id}`,
          ),
          ...(repository.localSessions ?? []).map(
            (local): import("./application").SessionView => `local:${local.id}`,
          ),
        ]);
        for (const view of views) {
          const previousGeneration =
            previousGenerations.get(view) ?? sessionGeneration(previous, view);
          const nextGeneration =
            nextGenerations.get(view) ?? sessionGeneration(repository, view);
          if (previousGeneration !== nextGeneration) {
            drafts.delete(draftKey(repository.id, view));
            imageDrafts.delete(imageDraftKey(repository.id, view));
          }
        }
      }
    }
    const switched =
      state?.activeId !== next.activeId || previousView !== nextView || reset;
    if (selectedDiscussion && selectedDiscussion.id !== next.activeId) {
      showConversation(true);
    }
    state = next;
    renderTiming(switched);
    renderTrace();
    const logs = next.logs ?? [];
    const lastLogId = logs.at(-1)?.id;
    if (
      next.root !== logsRenderedRoot ||
      lastLogId !== logsRenderedId ||
      !applicationLogs.hasChildNodes()
    ) {
      logsRenderedId = lastLogId;
      logsRenderedRoot = next.root;
      const entries = logs.map((entry) => {
        const article = document.createElement("article");
        article.className = `application-log ${entry.level}`;
        const time = document.createElement("time");
        time.dateTime = entry.timestamp;
        time.textContent = new Date(entry.timestamp).toLocaleTimeString();
        const text = document.createElement("p");
        text.textContent = entry.message;
        article.append(time, text);
        return article;
      });
      applicationLogs.replaceChildren(...entries);
      if (!entries.length) applicationLogs.textContent = "No events yet.";
    }
    if (
      pending &&
      state.repositories.some(
        (repository) =>
          repository.id === pending?.id &&
          (repository.view ??
            (repository.backend === "local" ? "local" : "copilot")) ===
            pending.view &&
          repository.status === "busy",
      )
    ) {
      pending = undefined;
    }
    if (switched) {
      question.value =
        (state.activeId
          ? drafts.get(draftKey(state.activeId, nextView))
          : undefined) ?? state.draft;
      renderImagePreviews();
    }
    element("root", HTMLElement).textContent = state.root;
    const active = state.repositories.find(
      (repository) => repository.id === state?.activeId,
    );
    element("active-repository", HTMLElement).textContent =
      active?.name ?? "Select a repository on the right";
    element("question-label", HTMLLabelElement).textContent =
      active?.backend === "local"
        ? "Message to local model"
        : "Message to Copilot";
    element("session-status", HTMLElement).textContent = active
      ? state.postMortemBusy
        ? `PostMortem: ${state.postMortemProgress ?? "starting..."}`
        : statusLabel(active) +
          (active.parallelCount ? ` (${active.parallelCount} parallel)` : "") +
          (active.queuedCount ? ` (${active.queuedCount} queued)` : "")
      : "No Copilot session has started.";
    const tokens = element("session-tokens", HTMLElement);
    tokens.hidden = !active;
    tokens.textContent = active
      ? `${(active.generatedTokens ?? 0).toLocaleString()} generated${active.contextTokens !== undefined ? ` · ${active.contextTokens.toLocaleString()} / ${(active.contextLimit ?? 0).toLocaleString()} context` : ""}`
      : "";
    tokens.title =
      "Generated output tokens reported for this session, including subagents and parallel requests.";
    sessionModel.hidden = !active?.model;
    sessionModel.textContent = active?.model ? `Model: ${active.model}` : "";
    if (active?.backend === "local" && active.localSession?.readOnly)
      sessionModel.textContent += " · read-only";
    sessionModel.title = sessionModel.textContent;
    question.placeholder = active
      ? `Ask ${active.backend === "local" ? "the local model" : "Copilot"} about ${active.name}...`
      : "Select a repository to begin.";

    const repositoriesKey = JSON.stringify([
      state.activeId,
      state.repositories,
    ]);
    if (repositoriesRenderedKey !== repositoriesKey) {
      repositoriesRenderedKey = repositoriesKey;
      startedRepositories.replaceChildren();
      otherRepositories.replaceChildren();
      for (const repository of state.repositories) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "repository";
        button.dataset.repositoryId = repository.id;
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-controls", "repository-menu");
        button.setAttribute(
          "aria-pressed",
          String(repository.id === state.activeId),
        );
        button.title = repository.path;
        const name = document.createElement("span");
        name.className = "repository-name";
        const running =
          repository.status === "starting" ||
          repository.status === "busy" ||
          repository.status === "stopping" ||
          repository.sessions?.some(
            (session) =>
              session.open && ["starting", "busy"].includes(session.status),
          ) === true;
        const open =
          repository.status === "ready" ||
          repository.status === "busy" ||
          repository.sessions?.some(
            (session) =>
              session.open && ["ready", "busy"].includes(session.status),
          ) === true;
        button.classList.toggle("session-open", open);
        button.classList.toggle("session-working", running);
        button.setAttribute("aria-busy", String(running));
        if (running || open) {
          const icon = document.createElement("span");
          icon.className = running ? "spinner" : "session-indicator";
          icon.setAttribute("aria-hidden", "true");
          name.append(icon);
        }
        name.append(document.createTextNode(repository.name));
        const status = document.createElement("small");
        status.textContent = statusLabel(repository);
        button.append(name, status);
        button.addEventListener("click", () =>
          vscode.postMessage({ type: "select", id: repository.id }),
        );
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openRepositoryMenu(repository.id, event.clientX, event.clientY);
        });
        button.addEventListener("keydown", (event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            const bounds = button.getBoundingClientRect();
            openRepositoryMenu(repository.id, bounds.left, bounds.bottom);
          }
        });
        (open || running ? startedRepositories : otherRepositories).append(
          button,
        );
      }
      if (startedRepositories.children.length === 0) {
        startedRepositories.textContent = "No active session.";
      }
      if (otherRepositories.children.length === 0) {
        otherRepositories.textContent =
          state.repositories.length === 0
            ? "No direct child repository containing .git was found."
            : "All repositories have an active session.";
      }
    }

    renderPermissions();
    renderQuestions();
    renderMessages(switched);
    showError(state.error);
    updateControls();
    updateRepositoryMenu();
    renderGitHub();
    renderPostMortem();
    renderLocalModels();
  }

  function renderPostMortem(): void {
    const report = state?.postMortem;
    const stale = Boolean(
      report && (state?.messages.length ?? 0) > report.sourceCount,
    );
    const key = JSON.stringify([
      state?.activeId,
      report?.sourceHash,
      report?.generatedAt,
      state?.postMortemBusy,
      state?.postMortemProgress,
      state?.postMortemError,
      stale,
    ]);
    if (postMortemRenderedKey === key) return;
    postMortemRenderedKey = key;
    const section = element("postmortem-report", HTMLElement);
    section.hidden =
      !report && !state?.postMortemBusy && !state?.postMortemError;
    exportPostMortem.disabled = !report;
    const status = element("postmortem-status", HTMLElement);
    status.textContent = state?.postMortemBusy
      ? `${state.postMortemProgress ?? "Starting..."} Separate tool-free model requests; the conversation and repository are not changed.`
      : report
        ? `${report.sourceCount} source records - ${new Date(report.generatedAt).toLocaleString()}. Model-generated analysis; consult its sources.${stale ? " New exchanges are not included; generate again when work finishes." : ""}`
        : "";
    const error = element("postmortem-error", HTMLElement);
    error.textContent = state?.postMortemError ?? "";
    error.hidden = !error.textContent;
    const tableKey = JSON.stringify([
      state?.activeId,
      report?.sourceHash,
      report?.generatedAt,
      stale,
    ]);
    if (postMortemTableKey === tableKey) return;
    postMortemTableKey = tableKey;
    const container = element("postmortem-table", HTMLElement);
    container.replaceChildren();
    if (!report) return;
    const table = document.createElement("table");
    const caption = document.createElement("caption");
    caption.textContent = `Conversation analysis - ${report.repository.name}`;
    table.append(caption);
    const head = document.createElement("thead");
    const headings = document.createElement("tr");
    for (const label of [
      "Stage",
      "Objective",
      "Production / decisions",
      "Files / PR / commit",
      "Validation",
      "Errors / corrections",
      "Sources",
    ]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headings.append(cell);
    }
    head.append(headings);
    table.append(head);
    const body = document.createElement("tbody");
    const sourceMessages = state?.messages ?? [];
    for (const row of report.rows) {
      const tr = document.createElement("tr");
      for (const value of [
        row.phase,
        row.objective,
        row.production,
        row.filesAndCommits,
        row.validation,
        row.errors,
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        tr.append(cell);
      }
      const cell = document.createElement("td");
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${row.firstMessage}-${row.lastMessage}`;
      details.append(summary);
      let rendered = false;
      details.addEventListener("toggle", () => {
        if (!details.open || rendered) return;
        rendered = true;
        for (
          let index = row.firstMessage - 1;
          index < row.lastMessage;
          index++
        ) {
          const message = sourceMessages[index];
          if (!message) continue;
          const heading = document.createElement("h4");
          heading.textContent = `#${index + 1} ${message.role}${message.title ? ` - ${message.title}` : ""}`;
          const content = document.createElement("pre");
          content.textContent = message.content;
          details.append(heading, content);
          if (message.details) {
            const metadata = document.createElement("pre");
            metadata.textContent = message.details;
            details.append(metadata);
          }
        }
      });
      cell.append(details);
      tr.append(cell);
      body.append(tr);
    }
    table.append(body);
    container.append(table);
  }

  exportSession.addEventListener("click", () => {
    if (state?.activeId && !exportSession.disabled) {
      vscode.postMessage({ type: "export-session", id: state.activeId });
    }
  });
  exportPostMortem.addEventListener("click", () => {
    if (state?.activeId && !exportPostMortem.disabled) {
      vscode.postMessage({ type: "export-postmortem", id: state.activeId });
    }
  });

  function githubKey(id: string): string {
    return JSON.stringify([id, githubSection]);
  }

  function showConversation(discardDiscussion = false): void {
    if (discardDiscussion) {
      if (selectedDiscussion) {
        vscode.postMessage({
          type: "close-github-discussion",
          id: selectedDiscussion.id,
        });
      }
      selectedDiscussion = undefined;
      discussionReady = false;
      discussionContent.replaceChildren();
      commentForm.hidden = true;
      commentBody.value = "";
    }
    discussionShow.hidden = !selectedDiscussion;
    discussionView.hidden = true;
    const panel = element("chat-panel", HTMLElement);
    panel.classList.remove("reading-discussion");
    panel.setAttribute("aria-label", "Copilot conversation");
  }

  function showDiscussion(): void {
    if (!selectedDiscussion || selectedDiscussion.id !== state?.activeId)
      return;
    const panel = element("chat-panel", HTMLElement);
    panel.classList.add("reading-discussion");
    panel.setAttribute("aria-label", "GitHub issue or pull request");
    discussionView.hidden = false;
    discussionStatus.focus();
  }

  function requestDiscussion(url: string): void {
    const id = state?.activeId;
    if (!id) return;
    selectedDiscussion = { id, url };
    discussionReady = false;
    const key = JSON.stringify([id, url]);
    if (!commentDrafts.has(key)) {
      commentDrafts.set(key, { text: "", published: [] });
    }
    commentBody.value = commentDrafts.get(key)!.text;
    updateCommentControls();
    discussionShow.hidden = false;
    discussionStatus.textContent = "Loading issue or pull request...";
    discussionError.hidden = true;
    discussionContent.replaceChildren();
    discussionRefresh.disabled = true;
    showDiscussion();
    vscode.postMessage({ type: "github-discussion", id, url });
  }

  element("github-discussion-back", HTMLButtonElement).addEventListener(
    "click",
    () => {
      showConversation();
      if (!question.disabled) question.focus();
    },
  );
  discussionShow.addEventListener("click", showDiscussion);
  discussionRefresh.addEventListener("click", () => {
    if (selectedDiscussion) requestDiscussion(selectedDiscussion.url);
  });
  discussionExternal.addEventListener("click", () => {
    if (selectedDiscussion) {
      vscode.postMessage({ type: "openExternal", url: selectedDiscussion.url });
    }
  });

  function currentCommentDraft(): CommentDraft | undefined {
    return selectedDiscussion
      ? commentDrafts.get(
          JSON.stringify([selectedDiscussion.id, selectedDiscussion.url]),
        )
      : undefined;
  }

  function updateCommentControls(): void {
    const draft = currentCommentDraft();
    commentForm.hidden = !discussionReady || !draft;
    commentBody.disabled = Boolean(draft?.pending);
    commentSubmit.disabled =
      !discussionReady ||
      !draft ||
      Boolean(draft.pending) ||
      !commentBody.value.trim() ||
      commentBody.value.length > commentBody.maxLength;
    commentStatus.textContent = draft?.pending
      ? "Publishing comment on GitHub..."
      : (draft?.message ?? "");
    commentError.textContent = draft?.error ?? "";
    commentError.hidden = !draft?.error;
  }

  function appendPublishedComments(
    draft: CommentDraft,
    snapshot = false,
  ): void {
    if (!discussionReady) return;
    const comments =
      discussionContent.querySelectorAll<HTMLElement>("[data-comment-id]");
    const ids = new Set(
      [...comments].map((comment) => comment.dataset.commentId),
    );
    if (snapshot) {
      draft.published = draft.published.filter(
        (comment) => !ids.has(comment.id),
      );
    }
    for (const comment of draft.published) {
      if (!ids.has(comment.id)) {
        discussionContent.insertAdjacentHTML("beforeend", comment.html);
        ids.add(comment.id);
      }
    }
    const heading = discussionContent.querySelector(
      ".github-discussion-comments-heading",
    );
    if (heading) heading.textContent = `Comments (${ids.size})`;
  }

  commentBody.addEventListener("input", () => {
    const draft = currentCommentDraft();
    if (draft) {
      draft.text = commentBody.value;
      draft.message = undefined;
    }
    updateCommentControls();
  });
  commentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const draft = currentCommentDraft();
    if (!selectedDiscussion || !discussionReady || !draft || draft.pending)
      return;
    const body = commentBody.value;
    if (!body.trim() || body.length > commentBody.maxLength) {
      draft.error = `Enter a comment of 1 to ${commentBody.maxLength} characters.`;
      updateCommentControls();
      return;
    }
    const requestId = `comment-${++commentSequence}`;
    draft.text = body;
    draft.pending = { requestId, body };
    draft.message = undefined;
    draft.error = undefined;
    updateCommentControls();
    vscode.postMessage({
      type: "github-comment",
      id: selectedDiscussion.id,
      url: selectedDiscussion.url,
      body,
      requestId,
    });
  });

  function requestGitHub(more = false): void {
    const id = state?.activeId;
    if (!id) return;
    const key = githubKey(id);
    const previous = githubPages.get(key);
    const cursor = more ? previous?.page?.cursor : undefined;
    githubPages.set(key, {
      status: "loading",
      page: more ? previous?.page : undefined,
    });
    renderGitHub();
    vscode.postMessage({ type: "github", id, section: githubSection, cursor });
  }

  function renderGitHub(): void {
    const id = state?.activeId;
    const key = id ? githubKey(id) : githubSection;
    const entry = id ? githubPages.get(key) : undefined;
    if (id && !entry) {
      requestGitHub();
      return;
    }
    if (key === githubRenderedKey && entry === githubRenderedPage) return;
    githubRenderedKey = key;
    githubRenderedPage = entry;
    for (const button of githubTabs.querySelectorAll<HTMLButtonElement>(
      "button",
    )) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.section === githubSection),
      );
    }
    element("github-heading", HTMLElement).textContent =
      githubLabels[githubSection];
    githubRefresh.disabled = !id || entry?.status === "loading";
    githubMore.hidden = !entry?.page?.cursor;
    githubMore.disabled = entry?.status === "loading";
    const status = element("github-status", HTMLElement);
    status.textContent = !id
      ? "Select a repository to view its activity."
      : entry?.status === "loading"
        ? "Loading repository activity..."
        : entry?.page
          ? `${entry.page.repository}${entry.page.viewer ? ` - ${entry.page.viewer}` : ""} (${entry.page.items.length})`
          : "";
    githubItems.setAttribute("aria-busy", String(entry?.status === "loading"));
    const failure = element("github-error", HTMLElement);
    failure.textContent = entry?.error ?? "";
    failure.hidden = !entry?.error;
    const notice = element("github-notice", HTMLElement);
    notice.textContent = entry?.page?.notice ?? "";
    notice.hidden = !notice.textContent;
    githubItems.replaceChildren();
    const link = (label: string, href?: string): HTMLElement => {
      const node = document.createElement(href ? "a" : "span");
      node.textContent = label;
      if (node instanceof HTMLAnchorElement && href) {
        node.href = href;
        node.title = "Open on GitHub";
      }
      return node;
    };
    for (const item of entry?.page?.items ?? []) {
      const card = document.createElement("article");
      card.className = "github-item";
      card.classList.toggle("github-mine", item.mine);
      const heading = document.createElement("h3");
      if (
        item.url &&
        /^\/[^/]+\/[^/]+\/(?:issues|pull)\/[1-9]\d*\/?$/.test(
          new URL(item.url).pathname,
        )
      ) {
        const title = document.createElement("button");
        title.type = "button";
        title.className = "github-discussion-title";
        title.textContent = item.title;
        title.title = "Read in the application";
        title.dataset.discussionUrl = item.url;
        const external = document.createElement("button");
        external.type = "button";
        external.className = "github-external";
        external.textContent = "\u2197";
        external.title = "Open on GitHub in browser";
        external.setAttribute("aria-label", `Open ${item.title} on GitHub`);
        external.dataset.externalUrl = item.url;
        heading.append(title, external);
      } else {
        heading.append(link(item.title, item.url));
      }
      const metadata = document.createElement("p");
      metadata.className = "github-metadata";
      const time = document.createElement("time");
      time.dateTime = item.date;
      time.textContent = new Date(item.date).toLocaleString();
      metadata.append(document.createTextNode(`${item.author} - `), time);
      const badges = document.createElement("div");
      badges.className = "github-badges";
      for (const [show, label, title, className] of [
        [item.mine, "Yours", "You created this issue or PR.", "mine"],
        [
          item.replied,
          "Replied",
          "You commented or submitted a review.",
          "replied",
        ],
        [
          item.afterMe,
          "After you",
          "Someone posted after your latest response.",
          "after-me",
        ],
      ] as const) {
        if (!show) continue;
        const badge = document.createElement("span");
        badge.className = `github-badge ${className}`;
        badge.textContent = label;
        badge.title = title;
        badges.append(badge);
      }
      card.append(heading, metadata, badges);
      for (const comment of item.comments ?? []) {
        const block = document.createElement("section");
        block.className = "github-comment";
        block.classList.toggle("github-mine", comment.mine);
        const author = document.createElement("p");
        author.append(
          link(
            `${comment.author} - ${new Date(comment.date).toLocaleString()}`,
            comment.url,
          ),
        );
        const body = document.createElement("div");
        body.className = "github-comment-body";
        body.textContent = comment.body;
        block.append(author, body);
        card.append(block);
      }
      githubItems.append(card);
    }
    if (entry?.status === "ready" && !entry.page?.items.length) {
      githubItems.textContent =
        githubSection === "mentions"
          ? "No unanswered mentions in this page."
          : githubSection === "comments"
            ? "No matching comments in this page."
            : "No entries found.";
    }
  }

  githubTabs.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element ? event.target.closest("button") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    const section = button.dataset.section;
    if (
      section === "issues" ||
      section === "reviews" ||
      section === "oldest-prs" ||
      section === "comments" ||
      section === "mentions" ||
      section === "commits"
    ) {
      githubSection = section;
      renderGitHub();
    }
  });
  githubRefresh.addEventListener("click", () => requestGitHub());
  githubMore.addEventListener("click", () => requestGitHub(true));

  function closeRepositoryMenu(restoreFocus = false): void {
    const id = menuRepositoryId;
    menuRepositoryId = undefined;
    menuConfirmation = undefined;
    repositoryMenu.hidden = true;
    repositoryMenu.replaceChildren();
    if (restoreFocus) {
      [...repositories.querySelectorAll<HTMLButtonElement>(".repository")]
        .find((button) => button.dataset.repositoryId === id)
        ?.focus();
    }
  }

  function updateRepositoryMenu(): void {
    const repository = state?.repositories.find(
      (entry) => entry.id === menuRepositoryId,
    );
    if (!repository) {
      closeRepositoryMenu();
      return;
    }
    for (const button of repositoryMenu.querySelectorAll<HTMLButtonElement>(
      "button[data-action]",
    )) {
      const action = button.dataset.action;
      if (action === "postmortem") {
        button.title =
          repository.backend === "local"
            ? "PostMortem uses Copilot and is disabled for local sessions."
            : "";
      }
      button.disabled =
        Boolean(repository.managementBusy) ||
        repository.status === "stopping" ||
        (action === "close-session" &&
          !["starting", "busy", "ready"].includes(repository.status)) ||
        (action === "postmortem" &&
          (repository.backend === "local" ||
            repository.id !== state?.activeId ||
            !state.messages.length ||
            pending?.id === repository.id ||
            ["starting", "busy"].includes(repository.status) ||
            Boolean(state.postMortemBusy))) ||
        (action?.startsWith("delete-") === true && !repository.sessionCount);
    }
  }

  function openRepositoryMenu(id: string, x: number, y: number): void {
    closeRepositoryMenu();
    menuRepositoryId = id;
    repositoryMenu.hidden = false;
    const actions = [
      ["add-session", "Add session..."],
      ["close-session", "Close session"],
      ["new-session", "New session"],
      ["postmortem", "PostMortem"],
      ["resume-session", "Resume session..."],
      ["delete-last-session", "Delete latest session..."],
      ["delete-all-sessions", "Delete all sessions for this repository..."],
    ] as const;
    for (const [action, label] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset.action = action;
      button.textContent = label;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (
          action === "delete-last-session" ||
          action === "delete-all-sessions"
        ) {
          confirmDeletion(action);
        } else {
          closeRepositoryMenu(true);
          vscode.postMessage({ type: action, id });
        }
      });
      repositoryMenu.append(button);
    }
    updateRepositoryMenu();
    positionRepositoryMenu(x, y);
    repositoryMenu.querySelector<HTMLButtonElement>("button:enabled")?.focus();
  }

  function positionRepositoryMenu(x: number, y: number): void {
    repositoryMenu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - repositoryMenu.offsetWidth))}px`;
    repositoryMenu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - repositoryMenu.offsetHeight))}px`;
  }

  function confirmDeletion(
    action: "delete-last-session" | "delete-all-sessions",
  ): void {
    const repository = state?.repositories.find(
      (entry) => entry.id === menuRepositoryId,
    );
    if (!repository) {
      closeRepositoryMenu();
      return;
    }
    menuConfirmation = action;
    repositoryMenu.replaceChildren();
    const prompt = document.createElement("p");
    prompt.textContent = `Permanently delete ${action === "delete-all-sessions" ? "all sessions" : "the latest session"} for ${repository.name}, including their Copilot history? Repository files will not be changed.`;
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.setAttribute("role", "menuitem");
    confirm.dataset.action = action;
    confirm.textContent = "Delete permanently";
    confirm.addEventListener("click", () => {
      const id = menuRepositoryId;
      const type = menuConfirmation;
      if (id && type) {
        closeRepositoryMenu(true);
        vscode.postMessage({ type, id });
      }
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.setAttribute("role", "menuitem");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => closeRepositoryMenu(true));
    repositoryMenu.append(prompt, confirm, cancel);
    updateRepositoryMenu();
    const bounds = repositoryMenu.getBoundingClientRect();
    positionRepositoryMenu(bounds.left, bounds.top);
    cancel.focus();
  }

  repositoryMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRepositoryMenu(true);
      return;
    }
    const buttons = [
      ...repositoryMenu.querySelectorAll<HTMLButtonElement>("button:enabled"),
    ];
    const index = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % buttons.length
        : event.key === "ArrowUp"
          ? (index - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (
      event.target instanceof Node &&
      !repositoryMenu.contains(event.target)
    ) {
      closeRepositoryMenu();
    }
  });
  window.addEventListener("blur", () => closeRepositoryMenu());

  function renderPermissions(): void {
    const pending = state?.permissions ?? [];
    const ids = new Set(pending.map((request) => request.id));
    for (const [id, card] of permissionCards) {
      if (!ids.has(id)) {
        card.remove();
        permissionCards.delete(id);
      }
    }
    for (const request of pending) {
      if (permissionCards.has(request.id)) {
        continue;
      }
      const card = document.createElement("article");
      card.className = "permission";
      const heading = document.createElement("h3");
      const repository = state?.repositories.find(
        (entry) => entry.id === request.repositoryId,
      );
      heading.textContent = `${request.source ?? "Copilot"} (${repository?.name ?? request.repositoryId}): ${request.summary}`;
      const content = document.createElement("pre");
      content.textContent = request.content;
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Event details";
      const raw = document.createElement("pre");
      raw.textContent = request.details;
      details.append(summary, raw);
      const actions = document.createElement("div");
      actions.className = "permission-actions";
      for (const approve of [true, false]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = approve
          ? (request.approvalLabel ?? "Allow once")
          : "Reject";
        button.addEventListener("click", () => {
          for (const control of actions.querySelectorAll("button")) {
            control.disabled = true;
          }
          vscode.postMessage({
            type: "permission",
            id: request.id,
            approve,
          });
        });
        actions.append(button);
      }
      card.append(heading, content, details, actions);
      permissionCards.set(request.id, card);
      permissions.append(card);
    }
    const showDetails =
      filters.querySelector<HTMLInputElement>('input[value="system"]')
        ?.checked !== false;
    for (const details of permissions.querySelectorAll("details")) {
      details.hidden = !showDetails;
    }
    permissions.hidden = pending.length === 0;
  }

  function renderQuestions(): void {
    const pending = state?.questions ?? [];
    const ids = new Set(pending.map((request) => request.id));
    for (const [id, card] of questionCards) {
      if (!ids.has(id)) {
        card.remove();
        questionCards.delete(id);
      }
    }
    for (const request of pending) {
      if (questionCards.has(request.id)) {
        continue;
      }
      const card = document.createElement("form");
      card.className = "agent-question";
      const heading = document.createElement("h3");
      const repository = state?.repositories.find(
        (entry) => entry.id === request.repositoryId,
      );
      heading.textContent = `Copilot (${repository?.name ?? request.repositoryId})`;
      const prompt = document.createElement("p");
      prompt.className = "question-text";
      prompt.textContent = request.question;
      const actions = document.createElement("div");
      actions.className = "permission-actions";
      const answer = (text: string): void => {
        for (const control of card.querySelectorAll("button, textarea")) {
          if (
            control instanceof HTMLButtonElement ||
            control instanceof HTMLTextAreaElement
          ) {
            control.disabled = true;
          }
        }
        vscode.postMessage({ type: "answer", id: request.id, answer: text });
      };
      for (const choice of request.choices ?? []) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = choice;
        button.addEventListener("click", () => answer(choice));
        actions.append(button);
      }
      card.append(heading, prompt, actions);
      if (request.allowFreeform !== false) {
        const label = document.createElement("label");
        label.textContent = "Your answer";
        const input = document.createElement("textarea");
        input.rows = 2;
        input.maxLength = 20000;
        input.id = `answer-${request.id}`;
        label.htmlFor = input.id;
        const submit = document.createElement("button");
        submit.type = "submit";
        submit.textContent = "Reply";
        submit.disabled = true;
        input.addEventListener("input", () => {
          submit.disabled = !input.value.trim();
        });
        input.addEventListener("keydown", (event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (!submit.disabled) {
              card.requestSubmit();
            }
          }
        });
        card.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!submit.disabled && input.value.trim()) {
            answer(input.value);
          }
        });
        card.append(label, input, submit);
      }
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel request";
      cancel.addEventListener("click", () => {
        vscode.postMessage({ type: "cancel", id: request.repositoryId });
      });
      card.append(cancel);
      questionCards.set(request.id, card);
      questions.append(card);
    }
    questions.hidden = pending.length === 0;
  }

  let scrollFrame: number | undefined;

  function renderMessages(switched = false): void {
    if (scrollFrame !== undefined) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
    const selection = window.getSelection();
    const savePoint = (node: Node | null, offset: number) => {
      const article = (
        node instanceof Element ? node : node?.parentElement
      )?.closest<HTMLElement>(".message");
      if (!node || article?.parentElement !== messages) return undefined;
      const range = document.createRange();
      range.selectNodeContents(article);
      range.setEnd(node, offset);
      return { index: article.dataset.index, offset: range.toString().length };
    };
    const anchor =
      !switched && selection && !selection.isCollapsed
        ? savePoint(selection.anchorNode, selection.anchorOffset)
        : undefined;
    const focus = anchor
      ? savePoint(selection!.focusNode, selection!.focusOffset)
      : undefined;
    const showEventDetails =
      filters.querySelector<HTMLInputElement>('input[value="system"]')
        ?.checked !== false;
    const scrollTop = messages.scrollTop;
    const nearBottom =
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    const enabled = new Set(
      [...filters.querySelectorAll<HTMLInputElement>("input:checked")].map(
        (input) => input.value,
      ),
    );
    if (switched) {
      messages.replaceChildren();
      messageCards.length = 0;
    }
    let lastVisibleMessage: HTMLElement | undefined;
    for (const [index, message] of (state?.messages ?? []).entries()) {
      const failed =
        message.error ||
        (message.role === "output" && message.title?.endsWith(": failed"));
      const category =
        message.role === "tool" &&
        (message.title === "assistant.tool_call_delta" ||
          message.title?.startsWith("tool.") ||
          (message.title?.startsWith("Tool: ") &&
            !message.details &&
            message.content.trimStart().startsWith("{")))
          ? "system"
          : categories[message.role];
      const hidden = !failed && !enabled.has(category);
      const previous = messageCards[index];
      if (
        previous &&
        previous.showEventDetails === showEventDetails &&
        messageFields.every(
          (field) => previous.message[field] === message[field],
        )
      ) {
        if (previous.article.hidden !== hidden)
          previous.article.hidden = hidden;
        if (!hidden) {
          lastVisibleMessage = previous.article;
        }
        continue;
      }
      const article = document.createElement("article");
      article.className = `message ${message.role}`;
      if (failed) article.classList.add("failed");
      article.dataset.index = String(index);
      article.hidden = hidden;
      if (!hidden) {
        lastVisibleMessage = article;
      }
      const heading = document.createElement("h3");
      heading.textContent =
        (message.title ?? roleLabels[message.role]) +
        (message.agentId && showEventDetails ? ` [${message.agentId}]` : "");
      if (message.timestamp && showEventDetails) {
        const time = document.createElement("time");
        time.dateTime = message.timestamp;
        time.textContent = message.timestamp;
        heading.append(time);
      }
      const content = document.createElement(
        message.role === "tool" ||
          message.role === "output" ||
          message.role === "system"
          ? "pre"
          : "div",
      );
      content.className = "content";
      if (message.html !== undefined) {
        content.innerHTML = message.html;
      } else {
        content.textContent = message.content;
      }
      if (heading.textContent) article.append(heading);
      article.append(content);
      if (message.details) {
        const details = document.createElement("details");
        details.hidden = !showEventDetails;
        details.open =
          previous?.article.querySelector("details")?.open ?? false;
        const summary = document.createElement("summary");
        summary.textContent = "Event details";
        const data = document.createElement("pre");
        data.textContent = message.details;
        details.append(summary, data);
        article.append(details);
      }
      if (previous) previous.article.replaceWith(article);
      else messages.append(article);
      messageCards[index] = { message, showEventDetails, article };
    }
    while (messageCards.length > (state?.messages.length ?? 0)) {
      messageCards.pop()?.article.remove();
    }
    if (anchor && focus) {
      const restorePoint = (
        point: typeof anchor,
      ): [Node, number] | undefined => {
        const article = messages.querySelector(
          `.message[data-index="${point.index}"]`,
        );
        if (!article || (article as HTMLElement).hidden) return undefined;
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        let offset = point.offset;
        let last: Node = article;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          last = node;
          const length = node.textContent?.length ?? 0;
          if (offset <= length) return [node, offset];
          offset -= length;
        }
        return [last, last.textContent?.length ?? 0];
      };
      const start = restorePoint(anchor);
      const end = restorePoint(focus);
      if (start && end) {
        selection!.setBaseAndExtent(...start, ...end);
      }
    }
    if (switched || nearBottom) {
      messages.scrollTop = messages.scrollHeight;
      const pendingScrollTop = messages.scrollTop;
      // Resolve skipped content after layout has updated its estimated heights.
      scrollFrame = window.requestAnimationFrame?.(() => {
        scrollFrame = undefined;
        if (messages.scrollTop < pendingScrollTop) {
          return;
        }
        lastVisibleMessage?.scrollIntoView?.({ block: "end" });
        messages.scrollTop = messages.scrollHeight;
      });
    } else {
      messages.scrollTop = scrollTop;
    }
    updatePromptNavigation();
  }

  function visiblePrompts(): HTMLElement[] {
    return [
      ...messages.querySelectorAll<HTMLElement>(".message.user:not([hidden])"),
    ];
  }

  function updatePromptNavigation(): void {
    const none = visiblePrompts().length === 0;
    previousPrompt.disabled = none;
    nextPrompt.disabled = none;
  }

  function goToPrompt(direction: -1 | 1): void {
    const top = messages.getBoundingClientRect().top;
    const offsets = visiblePrompts().map(
      (prompt) => [prompt, prompt.getBoundingClientRect().top - top] as const,
    );
    const target =
      direction < 0
        ? offsets.filter(([, offset]) => offset < -1).at(-1)
        : offsets.find(([, offset]) => offset > 1);
    if (!target) return;
    messages.scrollTop += target[1];
    target[0].scrollIntoView?.({ block: "start" });
  }

  previousPrompt.addEventListener("click", () => goToPrompt(-1));
  nextPrompt.addEventListener("click", () => goToPrompt(1));

  parallel.addEventListener("click", () => {
    const enabled = parallel.getAttribute("aria-pressed") !== "true";
    parallel.setAttribute("aria-pressed", String(enabled));
    parallel.textContent = enabled ? "Parallel ON" : "Parallel OFF";
  });

  function renderImagePreviews(): void {
    imagePreviews.replaceChildren();
    const id = state?.activeId;
    const key = id ? imageDraftKey(id, activeView()) : "";
    for (const [index, attachment] of (imageDrafts.get(key) ?? []).entries()) {
      const preview = document.createElement("div");
      const image = document.createElement("img");
      image.src = attachment.dataUrl;
      image.alt = attachment.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = `Remove ${attachment.name}`;
      remove.addEventListener("click", () => {
        if (!id || readingImages.has(key)) return;
        imageDrafts.get(key)?.splice(index, 1);
        renderImagePreviews();
        updateControls();
      });
      preview.append(image, remove);
      imagePreviews.append(preview);
    }
  }

  async function addImages(files: File[]): Promise<void> {
    const id = state?.activeId;
    if (!id || question.disabled || !files.length) return;
    const view = activeView();
    const key = imageDraftKey(id, view);
    if (readingImages.has(key)) return;
    const repository = state?.repositories.find((repo) => repo.id === id);
    const generation = sessionGeneration(repository, view);
    const existing = imageDrafts.get(key) ?? [];
    if (
      existing.length + files.length > Number(imagePreviews.dataset.maxCount) ||
      files.some(
        (file) =>
          !imagePreviews.dataset.mimeTypes!.split(",").includes(file.type) ||
          !file.size ||
          file.size > Number(imagePreviews.dataset.maxBytes),
      )
    ) {
      showError(
        "Attach up to five PNG, JPEG, GIF or WebP images, at most 5 MiB each.",
      );
      return;
    }
    readingImages.add(key);
    updateControls();
    try {
      const images = await Promise.all(
        files.map(
          (file) =>
            new Promise<ImageAttachment>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  name: file.name.slice(0, 255) || "Image",
                  dataUrl: String(reader.result),
                });
              reader.onerror = () =>
                reject(new Error(`Could not read ${file.name}.`));
              reader.onabort = () =>
                reject(new Error(`Reading ${file.name} was cancelled.`));
              reader.readAsDataURL(file);
            }),
        ),
      );
      const currentRepository = state?.repositories.find(
        (repo) => repo.id === id,
      );
      const currentGeneration = sessionGeneration(currentRepository, view);
      if (currentRepository && currentGeneration === generation) {
        imageDrafts.set(key, [...existing, ...images]);
        if (state?.activeId === id && activeView() === view) {
          renderImagePreviews();
          showError();
        }
      }
    } catch (error) {
      if (state?.activeId === id && activeView() === view)
        showError(String(error));
    } finally {
      readingImages.delete(key);
      updateControls();
    }
  }

  question.addEventListener("paste", (event) => {
    let files = [...(event.clipboardData?.files ?? [])].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!files.length) {
      files = [...(event.clipboardData?.items ?? [])]
        .filter(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        )
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
    }
    if (
      files.length &&
      !question.disabled &&
      !readingImages.has(
        state?.activeId ? imageDraftKey(state.activeId, activeView()) : "",
      )
    ) {
      event.preventDefault();
      void addImages(files);
    }
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (send.disabled || !state?.activeId) {
      return;
    }
    const view = activeView();
    const imageKey = imageDraftKey(state.activeId, view);
    const images = imageDrafts.get(imageKey);
    pending = {
      id: state.activeId,
      view,
      text: question.value,
      ...(images?.length ? { images } : {}),
    };
    question.value = "";
    drafts.delete(draftKey(state.activeId, pending.view));
    imageDrafts.delete(imageKey);
    renderImagePreviews();
    updateControls();
    showError();
    vscode.postMessage({
      type: "send",
      id: state.activeId,
      question: pending.text,
      ...(pending.view !== "copilot" ? { view: pending.view } : {}),
      parallel: parallel.getAttribute("aria-pressed") === "true",
      ...(pending.images ? { images: pending.images } : {}),
    });
  });
  question.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      updateControls();
      if (!send.disabled) {
        composer.requestSubmit();
      }
    }
  });
  filters.addEventListener("change", () => {
    renderMessages();
    renderPermissions();
  });
  const openLink = (event: MouseEvent): void => {
    if (event.type === "auxclick" && event.button !== 1) {
      return;
    }
    const link =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (link instanceof HTMLAnchorElement) {
      event.preventDefault();
      vscode.postMessage({ type: "openExternal", url: link.href });
    }
  };
  messages.addEventListener("click", openLink);
  messages.addEventListener("auxclick", openLink);
  const openGitHubItem = (event: MouseEvent): void => {
    if (event.type === "auxclick" && event.button !== 1) return;
    const button =
      event.target instanceof Element
        ? event.target.closest(
            "button[data-discussion-url], button[data-external-url]",
          )
        : null;
    if (button instanceof HTMLButtonElement) {
      event.preventDefault();
      if (button.dataset.externalUrl) {
        vscode.postMessage({
          type: "openExternal",
          url: button.dataset.externalUrl,
        });
      } else if (button.dataset.discussionUrl && event.type === "click") {
        requestDiscussion(button.dataset.discussionUrl);
      }
    } else {
      openLink(event);
    }
  };
  githubItems.addEventListener("click", openGitHubItem);
  githubItems.addEventListener("auxclick", openGitHubItem);
  discussionView.addEventListener("click", openLink);
  discussionView.addEventListener("auxclick", openLink);
  question.addEventListener("input", () => {
    updateControls();
    if (state?.activeId) {
      vscode.postMessage({
        type: "draft",
        id: state.activeId,
        text: question.value,
        ...(activeView() !== "copilot" ? { view: activeView() } : {}),
      });
    }
  });
  cancel.addEventListener("click", () => {
    if (state?.activeId) {
      vscode.postMessage({
        type: "cancel",
        id: state.activeId,
        ...(activeView() !== "copilot" ? { view: activeView() } : {}),
      });
    }
  });
  element("refresh", HTMLButtonElement).addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });
  window.addEventListener(
    "message",
    (
      event: MessageEvent<
        | { type: "state"; state: State }
        | {
            type: "local-models";
            models: import("./local-model-host").LocalModelSnapshot[];
          }
        | {
            type: "copilot-workers";
            workers: import("./application").CopilotWorkerSnapshot[];
          }
        | { type: "error"; message: string; id?: string }
        | {
            type: "execution-configuration-error";
            requestId?: string;
            message: string;
          }
        | ({
            type: "worker-foundry-models";
            requestId: string;
            device: "cpu" | "gpu";
          } & (
            | { models: { id: string; name: string; size: number }[] }
            | { error: string }
          ))
        | {
            type: "choose-assignment";
            requestId: string;
            repositoryId: string;
            backend?: "copilot" | "local";
          }
        | {
            type: "execution-configuration-saved";
            requestId: string;
            configuration: ExecutionConfiguration;
          }
        | {
            type: "dataset-sessions";
            sessions: DatasetSession[];
            saved?: boolean;
          }
        | {
            type: "dataset-error";
            action:
              | "dataset-sessions"
              | "annotate-session"
              | "export-dataset-session";
            message: string;
          }
        | {
            type: "harness-settings-result";
            requestId: number;
            error?: string;
            approvedUrlOrigins?: string[];
          }
        | GitHubUpdate
        | GitHubDiscussionUpdate
        | GitHubCommentUpdate
        | import("./settings").SettingsState
        | import("./system-memory").MemoryUpdate
      >,
    ) => {
      if (event.data.type === "state") {
        render(event.data.state);
      } else if (event.data.type === "execution-configuration-saved") {
        if (
          executionConfigurationState !== "saving" ||
          event.data.requestId !== pendingExecutionSave?.requestId
        )
          return;
        const saved = pendingExecutionSave;
        const label =
          saved.editor === "machine" ? "Machine settings" : "Worker settings";
        pendingExecutionSave = undefined;
        if (settingsState) {
          settingsState = {
            ...settingsState,
            execution: event.data.configuration,
          };
          renderExecutionConfiguration();
          const entry = saved.editor === "machine" ? machineEntry : workerEntry;
          const id = saved.editor === "machine" ? machineFields.id : workerId;
          const newerEditorEdits =
            editorEditVersions[saved.editor] !== saved.editVersion;
          if (!newerEditorEdits) {
            entry.value = saved.operation === "delete" ? "" : saved.id;
            if (saved.editor === "machine") fillMachineForm();
            else fillWorkerForm();
          } else if (id.value.trim() === saved.id) {
            // Reconcile identity without replacing newer field values.
            entry.value = saved.operation === "delete" ? "" : saved.id;
            id.readOnly = saved.operation !== "delete";
          }
        }
        const newerEdits = executionEditVersion !== savingExecutionEditVersion;
        setExecutionConfigurationStatus(
          newerEdits
            ? `${label} saved; newer edits are unsaved.`
            : `${label} saved.`,
          newerEdits ? "dirty" : "saved",
        );
        updateExecutionConfigurationControls();
      } else if (event.data.type === "worker-foundry-models") {
        const current = workerFoundryCatalogues.get(event.data.device);
        if (
          current?.status !== "loading" ||
          current.requestId !== event.data.requestId
        )
          return;
        workerFoundryCatalogues.set(
          event.data.device,
          "error" in event.data
            ? { status: "error", error: event.data.error }
            : { status: "ready", models: event.data.models },
        );
        renderWorkerFoundry();
      } else if (event.data.type === "execution-configuration-error") {
        if (event.data.requestId !== pendingExecutionSave?.requestId) return;
        pendingExecutionSave = undefined;
        setExecutionConfigurationStatus(
          `Could not save machines and workers: ${event.data.message}`,
          "error",
        );
        updateExecutionConfigurationControls();
      } else if (event.data.type === "dataset-sessions") {
        renderDataset(event.data.sessions);
        if (event.data.saved) {
          setDatasetPending(false);
          editingDataset = undefined;
          datasetForm.hidden = true;
        }
      } else if (event.data.type === "dataset-error") {
        if (event.data.action === "annotate-session") setDatasetPending(false);
        showDatasetError(event.data.message);
      } else if (event.data.type === "harness-settings-result") {
        const dirty = pendingHarnessSaves.get(event.data.requestId);
        if (!dirty) return;
        pendingHarnessSaves.delete(event.data.requestId);
        if (event.data.error) {
          harnessSettingsStatus.textContent = `Could not save harness settings: ${event.data.error}`;
        } else {
          if (
            dirty.has("approvedUrlOrigins") &&
            event.data.approvedUrlOrigins !== undefined
          ) {
            approvedUrlOriginsBase = [...event.data.approvedUrlOrigins];
            if (settingsState)
              settingsState = {
                ...settingsState,
                approvedUrlOrigins: approvedUrlOriginsBase,
              };
          }
          for (const [field, revision] of dirty) {
            if (dirtyHarnessFields.get(field) === revision)
              dirtyHarnessFields.delete(field);
          }
          if (!dirtyHarnessFields.has("approvedUrlOrigins"))
            approvedUrlOriginsBase = undefined;
          harnessSettingsStatus.textContent =
            dirtyHarnessFields.size > 0
              ? "Settings saved. Newer edits are still unsaved."
              : "Harness settings saved.";
        }
        updateHarnessSaveButton();
        renderSettings();
      } else if (event.data.type === "copilot-workers") {
        copilotWorkers = event.data.workers;
        renderWorkerTable();
      } else if (event.data.type === "local-models") {
        localModels = event.data.models;
        renderLocalModels();
        updateControls();
      } else if (event.data.type === "choose-assignment") {
        openAssignmentDialog(event.data);
      } else if (event.data.type === "memory") {
        renderMemory(event.data);
      } else if (event.data.type === "settings-state") {
        settingsState = event.data;
        if (
          dirtyHarnessFields.has("approvedUrlOrigins") &&
          !approvedUrlOriginsBase
        )
          approvedUrlOriginsBase = [...event.data.approvedUrlOrigins];
        renderSettings();
        updateHarnessSaveButton();
        renderLocalModels();
      } else if (event.data.type === "github-comment") {
        const update = event.data;
        const draft = commentDrafts.get(
          JSON.stringify([update.id, update.url]),
        );
        if (!draft?.pending || draft.pending.requestId !== update.requestId)
          return;
        if (update.status !== "posting") {
          if (
            update.status === "posted" &&
            update.commentId &&
            typeof update.html === "string"
          ) {
            if (draft.text === draft.pending.body) draft.text = "";
            draft.published.push({ id: update.commentId, html: update.html });
            draft.message = "Comment published on GitHub.";
            draft.error = undefined;
          } else {
            draft.error =
              update.error ??
              "Publication could not be confirmed. Check GitHub before retrying.";
          }
          draft.pending = undefined;
        }
        if (
          selectedDiscussion?.id === update.id &&
          selectedDiscussion.url === update.url
        ) {
          commentBody.value = draft.text;
          appendPublishedComments(draft);
          updateCommentControls();
        }
      } else if (event.data.type === "github-discussion") {
        const update = event.data;
        if (
          selectedDiscussion?.id !== update.id ||
          selectedDiscussion.url !== update.url
        )
          return;
        discussionRefresh.disabled = update.status === "loading";
        discussionError.textContent = update.error ?? "";
        discussionError.hidden = !update.error;
        discussionStatus.textContent =
          update.status === "loading"
            ? "Loading issue or pull request..."
            : update.status === "ready"
              ? "Description and discussion comments. Publish a new comment below."
              : "";
        if (update.status === "ready") {
          if (typeof update.html !== "string") {
            discussionReady = false;
            discussionError.textContent = "No discussion content was returned.";
            discussionError.hidden = false;
          } else {
            discussionReady = true;
            discussionContent.innerHTML = update.html;
            const draft = currentCommentDraft();
            if (draft) appendPublishedComments(draft, true);
          }
        }
        updateCommentControls();
      } else if (event.data.type === "github") {
        const update = event.data;
        const key = JSON.stringify([update.id, update.section]);
        const previous = githubPages.get(key);
        const page =
          update.page && update.append && previous?.page
            ? {
                ...update.page,
                items: [
                  ...new Map(
                    [...previous.page.items, ...update.page.items].map(
                      (item) => [item.id, item],
                    ),
                  ).values(),
                ],
              }
            : (update.page ?? (update.append ? previous?.page : undefined));
        if (page) {
          page.items.sort((a, b) =>
            update.section === "oldest-prs"
              ? Date.parse(a.date) - Date.parse(b.date)
              : Date.parse(b.date) - Date.parse(a.date),
          );
        }
        githubPages.set(key, {
          status: update.status,
          page,
          error: update.error,
        });
        renderGitHub();
      } else if (event.data.type === "error") {
        if (pending && (!event.data.id || event.data.id === pending.id)) {
          drafts.set(draftKey(pending.id, pending.view), pending.text);
          if (pending.images)
            imageDrafts.set(
              imageDraftKey(pending.id, pending.view),
              pending.images,
            );
          if (state?.activeId === pending.id && activeView() === pending.view) {
            question.value = pending.text;
            renderImagePreviews();
          }
          vscode.postMessage({
            type: "draft",
            id: pending.id,
            text: pending.text,
            ...(pending.view !== "copilot" ? { view: pending.view } : {}),
          });
          pending = undefined;
        }
        if (!event.data.id || event.data.id === state?.activeId) {
          showError(event.data.message);
        }
        updateControls();
      }
    },
  );
  vscode.postMessage({ type: "ready" });
})();
