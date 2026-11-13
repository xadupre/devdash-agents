import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import {
  AgentApplication,
  parseApplicationMessage,
  type CopilotWorkerSnapshot,
  type LocalSessionSetup,
} from "./application";
import { CopilotConversation } from "./conversation";
import {
  ConversationRenderer,
  renderApplication,
  renderGitHubDiscussion,
  renderGitHubComment,
} from "./render";
import { ApplicationStorage } from "./storage";
import { permissionHandler } from "./permissions";
import { GitHubPanel } from "./github-panel";
import {
  askCopilot,
  listCopilotModels,
  listCopilotSessions,
  requestTimeoutMs,
  type CopilotOptions,
} from "./copilot";
import { generatePostMortem, postMortemResponseSchema } from "./postmortem";
import { exportSessionJson } from "./session-export";
import { inspectLocalModel, type LocalModelInfo } from "./local-model";
import { isTransformersModelId, prepareLocalModel } from "./local-model-source";
import {
  DEFAULT_WORKER,
  findWorkerOnPath,
  installEngine,
  isLocalProvider,
  LocalWorker,
  resolveLocalDevice,
  resolveWorkerExecutable,
  type LocalDevice,
  type LocalProvider,
} from "./local-worker";
import type { SettingsLoadStatus, SettingsState } from "./settings";
import {
  downloadFoundryModel,
  listFoundryModels as listFoundryCatalogue,
  localFoundryModels,
  type FoundryCatalog,
  type FoundryDevice,
} from "./foundry";
import {
  MAX_WORKER_IDLE_MINUTES,
  reconcileApprovedUrlOrigins,
} from "./settings";
import { LocalConversation } from "./local-conversation";
import {
  findLocalModelHost,
  LocalModelHost,
  type LocalPlacement,
} from "./local-model-host";
import {
  MemoryMonitor,
  remoteMemory,
  type MemoryUpdate,
} from "./system-memory";
import { ensureRemoteWorker } from "./remote-worker";
import {
  inspectRemoteModel,
  parseRemoteMachines,
  remoteInvocation,
  remoteRepositoryPath,
  type RemoteMachine,
} from "./remote";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import {
  assignSession,
  machineModelSource,
  machineRepositoryPath,
  parseExecutionConfiguration,
  type ExecutionConfiguration,
  type MachineConfiguration,
  type SessionAssignment,
} from "./execution";
import { prepareRemoteModel, uploadRemoteModel } from "./remote-model-source";

let activePanel: vscode.WebviewPanel | undefined;
let closeActiveApplication: (() => Promise<void>) | undefined;
let opening: Promise<void> | undefined;
let deactivating = false;
const closing = new Set<Promise<void>>();
const DEVICE_DISCOVERY_TIMEOUT_MS = 120_000;

export function activate(context: vscode.ExtensionContext): void {
  deactivating = false;
  const output = vscode.window.createOutputChannel("DevDash Agents");
  let savingConfiguration: Promise<void> = Promise.resolve();
  const report = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    return message;
  };
  const openApplication = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Trust the workspace before running DevDash Agents.",
      );
      return;
    }
    if (activePanel) {
      activePanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    await Promise.all([...closing]);
    const root =
      vscode.workspace.workspaceFolders?.[0]?.uri ??
      (
        await vscode.window.showOpenDialog({
          title: "Choose the parent directory containing your Git repositories",
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
        })
      )?.[0];
    if (!root || deactivating) {
      return;
    }
    if (root.scheme !== "file") {
      throw new Error(
        "DevDash Agents requires a local directory in the extension host.",
      );
    }
    const configuration = (): vscode.WorkspaceConfiguration =>
      vscode.workspace.getConfiguration("devdashAgents");
    const currentModel = (): string =>
      vscode.workspace
        .getConfiguration("devdashAgents")
        .get<string>("model", "")
        .trim();
    const requestTimeout = (): number =>
      requestTimeoutMs(
        vscode.workspace
          .getConfiguration("devdashAgents")
          .get("requestTimeoutMinutes"),
      );
    const workerIdleMinutes = (): number => {
      const minutes = vscode.workspace
        .getConfiguration("devdashAgents")
        .get<number>("workerIdleMinutes", 30);
      return Number.isSafeInteger(minutes) &&
        minutes >= 0 &&
        minutes <= MAX_WORKER_IDLE_MINUTES
        ? minutes
        : 30;
    };
    const executionConfiguration = (): ExecutionConfiguration => {
      const settings = configuration();
      const configured = settings.get<unknown>("execution");
      if (configured !== undefined && configured !== null)
        return parseExecutionConfiguration(configured);
      const remotes = parseRemoteMachines(
        settings.get<unknown>("remoteMachines", []),
      );
      const machines: MachineConfiguration[] = [
        {
          id: "local",
          name: "This computer",
          command: "",
          repositoriesPath: root.fsPath,
          modelsPath: join(context.globalStorageUri.fsPath, "models"),
          workerPath: settings.get<string>("localWorkerPath", DEFAULT_WORKER),
          cliPath: settings.get<string>("cliPath", "copilot"),
        },
        ...remotes.map((machine, index) => ({
          id: `remote-${index}`,
          name: machine.name,
          command: machine.command,
          repositoriesPath: machine.repositoriesPath,
          modelsPath: posix.dirname(machine.modelPath),
          workerPath: machine.workerPath,
          cliPath: "copilot",
        })),
      ];
      const workers: ExecutionConfiguration["workers"] = machines.map(
        (machine) => ({
          id: `copilot-${machine.id}`,
          name: `Copilot @ ${machine.name}`,
          backend: "copilot",
          machineId: machine.id,
          model: { kind: "copilot", source: currentModel() },
          provider: "cpu",
          deviceId: 0,
        }),
      );
      const localSource = settings.get<string>("localModelPath", "");
      for (const [index, machine] of machines.entries()) {
        const source =
          index === 0 ? localSource : remotes[index - 1]!.modelPath;
        if (!source) continue;
        workers.push({
          id: `model-${machine.id}`,
          name: `Model @ ${machine.name}`,
          backend: "local",
          machineId: machine.id,
          model: {
            kind: isTransformersModelId(source) ? "model-id" : "checkpoint",
            source,
          },
          provider:
            settings.get<string>("localProvider") === "cuda" ? "cuda" : "cpu",
          deviceId: Math.max(0, settings.get<number>("localDeviceId", 0)),
        });
      }
      return parseExecutionConfiguration({ machines, workers });
    };
    const asRemote = (
      machine: MachineConfiguration,
      modelPath = machine.modelsPath,
    ): RemoteMachine | undefined =>
      machine.command
        ? {
            name: machine.id,
            command: machine.command,
            workerPath: machine.workerPath,
            modelPath,
            repositoriesPath: machine.repositoriesPath,
          }
        : undefined;
    const assignmentRequests = new Map<
      string,
      (
        choice:
          | {
              workerId: string;
              workerMachineId: string;
              executionMachineId: string;
            }
          | undefined,
      ) => void
    >();
    /** Asks the webview's session dialog for a worker, worker machine and harness machine. */
    const chooseAssignment = async (
      backend: "copilot" | "local" | undefined,
      repositoryId: string,
    ): Promise<SessionAssignment | undefined> => {
      const config = executionConfiguration();
      if (
        !config.workers.some((worker) => !backend || worker.backend === backend)
      )
        throw new Error(
          `Add a ${backend === "local" ? "local model " : backend === "copilot" ? "Copilot " : ""}worker in Settings > Workers before opening a session.`,
        );
      if (!panel) return undefined;
      const requestId = randomUUID();
      const choice = await new Promise<
        Parameters<NonNullable<ReturnType<typeof assignmentRequests.get>>>[0]
      >((resolve) => {
        assignmentRequests.set(requestId, resolve);
        void panel?.webview.postMessage({
          type: "choose-assignment",
          requestId,
          repositoryId,
          ...(backend ? { backend } : {}),
        });
      });
      assignmentRequests.delete(requestId);
      if (!choice) return undefined;
      return assignSession(
        executionConfiguration(),
        choice.workerId,
        choice.executionMachineId,
        choice.workerMachineId,
      );
    };
    const copilotOptions = (
      repositoryPath: string,
      assignment?: SessionAssignment,
    ): Pick<
      CopilotOptions,
      "cliPath" | "model" | "workingDirectory" | "remote"
    > => {
      const machine = assignment?.executionMachine;
      return {
        cliPath:
          machine?.cliPath ?? configuration().get<string>("cliPath", "copilot"),
        model: assignment?.worker.model.source ?? currentModel(),
        workingDirectory:
          machine && !machine.command
            ? machineRepositoryPath(machine, repositoryPath)
            : repositoryPath,
        ...(machine?.command
          ? {
              remote: {
                command: machine.command,
                workingDirectory: machineRepositoryPath(
                  machine,
                  repositoryPath,
                ),
              },
            }
          : {}),
      };
    };
    const storage = new ApplicationStorage(homedir(), root.fsPath);
    const saved = await storage.load();
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    const renderer = new ConversationRenderer();
    let stopping = false;
    const localHosts = new Map<string, LocalModelHost>();
    const initialPlacements = new WeakMap<LocalModelHost, LocalPlacement>();
    // Hosts are shared only between sessions targeting the same machine.
    const hostMachines = new WeakMap<LocalModelHost, string>();
    const hostWorkers = new WeakMap<LocalModelHost, string>();
    const localModelInfo = new Map<
      string,
      Awaited<ReturnType<typeof inspectLocalModel>>
    >();
    const lifetime = new AbortController();
    let stopped: Promise<void> | undefined;
    const github = new GitHubPanel((update) => {
      if (panel) void panel.webview.postMessage(update);
    }, report);
    const saveFailure = (error: unknown): void => {
      void vscode.window.showErrorMessage(
        `DevDash Agents could not save its history: ${report(error)}`,
      );
    };
    const scheduleSave = (): void => {
      if (!saveTimer && !stopping) {
        saveTimer = setTimeout(() => {
          saveTimer = undefined;
          void storage.save(application.getSnapshot()).catch(saveFailure);
        }, 300);
      }
    };
    const schedulePublish = (): void => {
      if (!publishTimer && !stopping) {
        publishTimer = setTimeout(publish, 30);
      }
    };
    const application: AgentApplication = new AgentApplication(
      root.fsPath,
      (repository, requestId, view, assignment) =>
        new CopilotConversation({
          ...copilotOptions(repository.path, assignment),
          get timeoutMs() {
            return requestTimeout();
          },
          onPermissionRequest: permissionHandler({
            isActive: () =>
              vscode.workspace.isTrusted && Boolean(panel) && !stopping,
            approvedOrigins: () =>
              vscode.workspace
                .getConfiguration("devdashAgents")
                .get<string[]>("approvedUrlOrigins", []),
            rememberOrigin: (origin) => {
              const save = async (): Promise<void> => {
                const settings =
                  vscode.workspace.getConfiguration("devdashAgents");
                const origins = settings.get<string[]>(
                  "approvedUrlOrigins",
                  [],
                );
                await settings.update(
                  "approvedUrlOrigins",
                  [...new Set([...origins, origin])],
                  vscode.ConfigurationTarget.Global,
                );
              };
              savingConfiguration = savingConfiguration.then(save, save);
              return savingConfiguration;
            },
            ask: (description) =>
              application.requestPermission(
                repository.id,
                description,
                requestId,
                view ?? false,
              ),
          }),
          onUserInputRequest: (request) => {
            if (!vscode.workspace.isTrusted || !panel) {
              throw new Error("The application is closed or untrusted.");
            }
            return application.askQuestion(
              repository.id,
              request,
              requestId,
              view ?? false,
            );
          },
        }),
      (streaming) => {
        if (streaming) schedulePublish();
        else publish();
        scheduleSave();
      },
      saved,
    );
    const close = (): Promise<void> =>
      (stopped ??= (async () => {
        stopping = true;
        lifetime.abort();
        clearTimeout(saveTimer);
        clearTimeout(publishTimer);
        try {
          await Promise.all([application.dispose(), github.dispose()]);
        } finally {
          await storage.save(application.getSnapshot());
        }
      })());
    let panel: vscode.WebviewPanel | undefined;
    // Copilot CLI processes have no host object; idleness is derived from session state.
    const copilotIdleSince = new Map<string, number>();
    const copilotWorkers = (
      state = application.getState(),
    ): CopilotWorkerSnapshot[] => {
      const now = Date.now();
      const timeout = workerIdleMinutes() * 60_000;
      const rows = new Map<
        string,
        CopilotWorkerSnapshot & { idleSince: number }
      >();
      const seen = new Set<string>();
      for (const repository of state.repositories)
        for (const slot of repository.sessions ?? []) {
          if (slot.backend !== "copilot" || !slot.open) continue;
          const key = `${repository.id}\n${slot.view}`;
          seen.add(key);
          const busy = slot.status !== "ready" && slot.status !== "error";
          if (busy) copilotIdleSince.delete(key);
          else if (!copilotIdleSince.has(key)) copilotIdleSince.set(key, now);
          const assignment = slot.assignment;
          const workerId = assignment?.worker.id ?? "";
          const row = rows.get(workerId) ?? {
            workerId,
            workerName: assignment?.worker.name ?? "Copilot (no worker)",
            machineName: assignment?.workerMachine.name ?? "This computer",
            model:
              slot.model ?? (assignment?.worker.model.source || "CLI default"),
            sessions: [],
            busy: false,
            idleSince: 0,
          };
          row.sessions.push({ repositoryId: repository.id, view: slot.view });
          row.busy ||= busy;
          row.idleSince = Math.max(
            row.idleSince,
            copilotIdleSince.get(key) ?? now,
          );
          rows.set(workerId, row);
        }
      for (const key of copilotIdleSince.keys())
        if (!seen.has(key)) copilotIdleSince.delete(key);
      return [...rows.values()].map(({ idleSince, ...row }) => ({
        ...row,
        ...(!row.busy && timeout ? { idleStopAt: idleSince + timeout } : {}),
      }));
    };
    const stopCopilotWorker = async (
      workerId: string,
      idleOnly = false,
    ): Promise<void> => {
      const row = copilotWorkers().find((entry) => entry.workerId === workerId);
      if (!row) throw new Error("The Copilot worker is no longer running.");
      if (row.busy)
        throw new Error(
          "Wait for the Copilot worker's running requests to finish.",
        );
      if (
        idleOnly &&
        (row.idleStopAt === undefined || row.idleStopAt > Date.now())
      )
        return;
      logEvent(
        `${row.workerName} @ ${row.machineName}`,
        idleOnly
          ? `Idle for ${workerIdleMinutes()} min; closing ${row.sessions.length} Copilot session(s) to free memory.`
          : `Stop requested; closing ${row.sessions.length} Copilot session(s).`,
      );
      for (const session of row.sessions)
        await application.closeSession(session.repositoryId, session.view);
    };
    const copilotIdleTimer = setInterval(() => {
      if (stopping) return;
      for (const row of copilotWorkers())
        if (row.idleStopAt !== undefined && row.idleStopAt <= Date.now())
          void stopCopilotWorker(row.workerId, true).catch(() => {});
    }, 30_000);
    copilotIdleTimer.unref?.();
    lifetime.signal.addEventListener("abort", () =>
      clearInterval(copilotIdleTimer),
    );
    const publish = (): void => {
      clearTimeout(publishTimer);
      publishTimer = undefined;
      if (!panel || stopping) {
        return;
      }
      const state = application.getState();
      void panel.webview.postMessage({
        type: "state",
        state: {
          ...state,
          messages: renderer.render(
            state.activeId
              ? `${state.activeId}:${state.repositories.find((repo) => repo.id === state.activeId)?.view ?? "copilot"}`
              : undefined,
            state.messages,
          ),
        },
      });
      const config = localHosts.size ? executionConfiguration() : undefined;
      void panel.webview.postMessage({
        type: "local-models",
        models: [...localHosts].map(([id, host]) => {
          const worker = config?.workers.find(
            (entry) => entry.id === hostWorkers.get(host),
          );
          const machine = hostMachines.get(host) ?? "";
          return {
            ...host.snapshot(),
            id,
            ...(worker ? { workerName: worker.name } : {}),
            machineName: machine
              ? (config?.machines.find((entry) => entry.id === machine)?.name ??
                machine)
              : "This computer",
          };
        }),
      });
      void panel.webview.postMessage({
        type: "copilot-workers",
        workers: copilotWorkers(state),
      });
    };
    await application.refresh();
    if (deactivating) {
      await close();
      return;
    }
    const media = vscode.Uri.joinPath(context.extensionUri, "media");
    const scripts = vscode.Uri.joinPath(context.extensionUri, "dist", "src");
    panel = vscode.window.createWebviewPanel(
      "devdashAgents.application",
      "DevDash Agents",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [media, scripts],
        retainContextWhenHidden: true,
      },
    );
    activePanel = panel;
    closeActiveApplication = close;
    const currentPanel = panel;
    const memoryMonitor = new MemoryMonitor();
    const remoteMemorySamples = new Map<
      string,
      { at: number; sample: Promise<MemoryUpdate> }
    >();
    const sampleMemory = (): Promise<MemoryUpdate> => {
      const assignment = application.activeAssignment();
      const machine = assignment?.workerMachine;
      const deviceId =
        assignment?.worker.provider === "cuda"
          ? assignment.worker.deviceId
          : undefined;
      const withDevice = (update: MemoryUpdate): MemoryUpdate =>
        deviceId === undefined ? update : { ...update, deviceId };
      if (!machine?.command) return memoryMonitor.sample().then(withDevice);
      // Each sample opens a connection, so remote machines are sampled less often.
      const cached = remoteMemorySamples.get(machine.command);
      if (cached && Date.now() - cached.at < 30_000)
        return cached.sample.then(withDevice);
      const sample = remoteMemory(
        { command: machine.command, name: machine.name },
        lifetime.signal,
      );
      remoteMemorySamples.set(machine.command, { at: Date.now(), sample });
      return sample.then(withDevice);
    };
    const publishMemory = (): void => {
      if (!panel?.visible || stopping) return;
      void sampleMemory().then(
        (update) => panel && void panel.webview.postMessage(update),
        () => undefined,
      );
    };
    const memoryTimer = setInterval(publishMemory, 5000);
    const visibilitySubscription = panel.onDidChangeViewState(publishMemory);
    const configuredRemoteMachines = (): RemoteMachine[] => {
      try {
        return parseRemoteMachines(
          vscode.workspace
            .getConfiguration("devdashAgents")
            .get<unknown>("remoteMachines", []),
        );
      } catch {
        return [];
      }
    };
    const configuredRemoteMachineName = (): string => {
      const name = vscode.workspace
        .getConfiguration("devdashAgents")
        .get<unknown>("remoteMachine", "");
      return typeof name === "string" ? name : "";
    };
    /** Undefined runs on this computer; an unknown selected name is an error. */
    const configuredRemoteMachine = (): RemoteMachine | undefined => {
      const name = configuredRemoteMachineName();
      if (!name) return undefined;
      const machine = configuredRemoteMachines().find(
        (entry) => entry.name === name,
      );
      if (!machine)
        throw new Error(
          `The execution machine ${name} is not configured. Choose another machine in Settings.`,
        );
      return machine;
    };
    const configuredLocalDevice = (): {
      provider: LocalProvider;
      deviceId: number;
    } => {
      const settings = vscode.workspace.getConfiguration("devdashAgents");
      const provider = settings.get<unknown>("localProvider", "auto");
      const deviceId = settings.get<unknown>("localDeviceId", -1);
      if (!isLocalProvider(provider)) return { provider: "auto", deviceId: -1 };
      return {
        provider,
        deviceId:
          provider !== "auto" &&
          typeof deviceId === "number" &&
          Number.isSafeInteger(deviceId) &&
          deviceId >= 0
            ? deviceId
            : -1,
      };
    };
    let localDevices: LocalDevice[] | undefined;
    let localDevicesStatus: SettingsLoadStatus = "idle";
    let localDevicesError: string | undefined;
    let localDiscovery: Promise<void> | undefined;
    let copilotModels: { id: string; name: string }[] | undefined;
    let copilotModelsStatus: SettingsLoadStatus = "idle";
    let copilotModelsError: string | undefined;
    let copilotModelsLoading: Promise<void> | undefined;
    const configuredProvider = configuredLocalDevice().provider;
    let foundryDevice: FoundryDevice =
      configuredProvider === "cuda"
        ? "gpu"
        : configuredProvider === "npu"
          ? "npu"
          : "cpu";
    let foundryCatalog: FoundryCatalog | undefined;
    let foundryStatus: SettingsLoadStatus = "idle";
    let foundryError: string | undefined;
    let foundryListing: AbortController | undefined;
    let foundryDownload:
      | (NonNullable<SettingsState["foundryDownload"]> & {
          controller: AbortController;
        })
      | undefined;
    const publishSettings = (): void => {
      if (!panel || stopping) return;
      const { provider, deviceId } = configuredLocalDevice();
      const settings = vscode.workspace.getConfiguration("devdashAgents");
      const update: SettingsState = {
        type: "settings-state",
        execution: executionConfiguration(),
        cliPath: settings.get<string>("cliPath", "copilot"),
        localWorkerPath: settings.get<string>(
          "localWorkerPath",
          DEFAULT_WORKER,
        ),
        requestTimeoutMinutes: settings.get<number>(
          "requestTimeoutMinutes",
          60,
        ),
        workerIdleMinutes: workerIdleMinutes(),
        approvedUrlOrigins: settings.get<string[]>("approvedUrlOrigins", []),
        copilotModel: currentModel(),
        copilotModels,
        copilotModelsStatus,
        copilotModelsError,
        localModelPath: vscode.workspace
          .getConfiguration("devdashAgents")
          .get<string>("localModelPath", ""),
        remoteMachines: configuredRemoteMachines(),
        remoteMachine: configuredRemoteMachineName(),
        localProvider: provider,
        localDeviceId: deviceId,
        localDevices,
        localDevicesStatus,
        localDevicesError,
        foundryDevice,
        foundryCatalog,
        foundryStatus,
        foundryError,
        foundryDownload: foundryDownload && {
          id: foundryDownload.id,
          name: foundryDownload.name,
          received: foundryDownload.received,
          total: foundryDownload.total,
        },
      };
      void panel.webview.postMessage(update);
    };
    const loadCopilotModels = (): Promise<void> =>
      (copilotModelsLoading ??= (async () => {
        copilotModelsStatus = "loading";
        copilotModelsError = undefined;
        publishSettings();
        try {
          copilotModels = await listCopilotModels({
            cliPath: vscode.workspace
              .getConfiguration("devdashAgents")
              .get<string>("cliPath", "copilot"),
            workingDirectory: root.fsPath,
            timeoutMs: requestTimeout(),
          });
          copilotModelsStatus = "ready";
        } catch (error) {
          copilotModelsStatus = "error";
          copilotModelsError = report(error);
        } finally {
          copilotModelsLoading = undefined;
          publishSettings();
        }
      })());
    const logEvent = (
      source: string,
      message: string,
      level: "info" | "error" = "info",
    ): void => {
      output.appendLine(`[${source}] ${message}`);
      application.logEvent(source, message, level);
    };
    /** Logs the start, duration and outcome of a long-running step. */
    const logStep = async <T>(
      source: string,
      label: string,
      run: () => Promise<T>,
    ): Promise<T> => {
      const started = Date.now();
      logEvent(source, `${label}...`);
      try {
        const result = await run();
        logEvent(
          source,
          `${label}: done in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
        );
        return result;
      } catch (error) {
        logEvent(
          source,
          `${label}: failed after ${((Date.now() - started) / 1000).toFixed(1)} s: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        throw error;
      }
    };
    const prepareWorker = async (override?: string): Promise<string> => {
      const configuredWorker =
        override ??
        vscode.workspace
          .getConfiguration("devdashAgents")
          .get<string>("localWorkerPath", DEFAULT_WORKER);
      let executable = resolveWorkerExecutable(
        configuredWorker,
        context.extensionPath,
      );
      if (executable === DEFAULT_WORKER && process.platform === "linux")
        executable = findWorkerOnPath() ?? executable;
      const setupScript = join(
        context.extensionPath,
        "native",
        "setup-worker.sh",
      );
      if (
        executable === DEFAULT_WORKER &&
        process.platform === "linux" &&
        existsSync(setupScript)
      ) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title:
              "Installing local models (first time only, about 2 minutes)...",
            cancellable: true,
          },
          async (_progress, token) => {
            const controller = new AbortController();
            const subscription = token.onCancellationRequested(() =>
              controller.abort(),
            );
            try {
              await logStep(
                "this computer",
                "Installing the local model engine",
                () =>
                  installEngine(
                    setupScript,
                    [],
                    AbortSignal.any([controller.signal, lifetime.signal]),
                  ),
              );
            } finally {
              subscription.dispose();
            }
          },
        );
        executable = resolveWorkerExecutable(
          configuredWorker,
          context.extensionPath,
        );
      }
      return executable;
    };
    interface WorkerLaunch {
      /** Empty for this computer, otherwise the remote machine name. */
      machine: string;
      executable: string;
      args: string[];
      workerId?: string;
    }
    const remoteWorkers = new Map<string, Promise<string>>();
    const workerLaunch = async (
      remote: RemoteMachine | undefined,
    ): Promise<WorkerLaunch> => {
      if (!remote)
        return { machine: "", executable: await prepareWorker(), args: [] };
      const key = JSON.stringify([remote.command, remote.workerPath]);
      let executable = remoteWorkers.get(key);
      if (!executable) {
        executable = Promise.resolve(
          vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Native worker on ${remote.name}`,
              cancellable: true,
            },
            async (progress, token) => {
              const controller = new AbortController();
              const subscription = token.onCancellationRequested(() =>
                controller.abort(),
              );
              try {
                progress.report({ message: "looking for the worker..." });
                return await logStep(
                  remote.name,
                  "Looking for the native worker",
                  () =>
                    ensureRemoteWorker(remote, {
                      nativeDirectory: join(context.extensionPath, "native"),
                      signal: AbortSignal.any([
                        controller.signal,
                        lifetime.signal,
                      ]),
                      onInstall: () => {
                        logEvent(
                          remote.name,
                          "Native worker not found; building it on the remote machine (first use, several minutes)...",
                        );
                        progress.report({
                          message:
                            "building it on the remote machine (first use, several minutes)...",
                        });
                      },
                    }),
                );
              } finally {
                subscription.dispose();
              }
            },
          ),
        );
        remoteWorkers.set(key, executable);
        executable.catch(() => {
          if (remoteWorkers.get(key) === executable) remoteWorkers.delete(key);
        });
      }
      return {
        machine: remote.name,
        ...remoteInvocation(remote, [await executable]),
      };
    };
    const startWorker = (
      launch: WorkerLaunch,
      timeoutMs?: number,
      onClose?: (error: Error) => void,
    ): LocalWorker =>
      new LocalWorker(
        launch.executable,
        launch.args,
        timeoutMs,
        onClose,
        launch.machine !== "",
      );
    const getLocalModelHost = (
      modelPath: string,
      launch: WorkerLaunch,
      provider: LocalProvider,
      deviceId: number,
      modelInfo: LocalModelInfo,
    ): LocalModelHost => {
      const desired = { provider, deviceId };
      if (launch.workerId) {
        const shared = [...localHosts.values()].find(
          (host) => hostWorkers.get(host) === launch.workerId,
        );
        if (shared) return shared;
      }
      const existing = findLocalModelHost(
        [...localHosts.values()].filter(
          (host) =>
            (hostMachines.get(host) ?? "") === launch.machine &&
            (hostWorkers.get(host) ?? "") === (launch.workerId ?? ""),
        ),
        modelPath,
        desired,
        (host) => initialPlacements.get(host),
      );
      if (existing) return existing;
      const hostId = randomUUID();
      const host = new LocalModelHost(
        modelPath,
        desired,
        (onClose) => startWorker(launch, requestTimeout(), onClose),
        publish,
        () => {
          if (localHosts.get(hostId) === host) localHosts.delete(hostId);
          publish();
        },
        {
          name: modelInfo.name,
          contextLength: modelInfo.contextLength,
          sizeBytes: modelInfo.sizeBytes,
          bytesPerToken: modelInfo.bytesPerToken,
          sharedBuffer: modelInfo.sharedBuffer,
        },
        () => workerIdleMinutes() * 60_000,
        (message, level) => logEvent(modelInfo.name, message, level),
      );
      localHosts.set(hostId, host);
      hostMachines.set(host, launch.machine);
      if (launch.workerId) hostWorkers.set(host, launch.workerId);
      initialPlacements.set(host, { provider, deviceId });
      return host;
    };
    const resolveLocalPlacement = async (
      launch: WorkerLaunch,
      provider: LocalProvider,
      deviceId: number,
    ): Promise<{ provider: LocalProvider; deviceId: number }> => {
      if (provider !== "auto" && deviceId >= 0) return { provider, deviceId };
      return logStep(
        launch.machine || "this computer",
        "Discovering CPU and CUDA devices",
        async () => {
          const discovery = startWorker(launch, requestTimeout());
          try {
            const devices = await discovery.discover(
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(DEVICE_DISCOVERY_TIMEOUT_MS),
              ]),
            );
            const device = resolveLocalDevice(devices, provider, deviceId);
            logEvent(
              launch.machine || "this computer",
              `Selected ${device.provider.toUpperCase()} ${device.deviceId} (${device.name}).`,
            );
            return { provider: device.provider, deviceId: device.deviceId };
          } finally {
            await discovery.stop();
          }
        },
      );
    };
    const preparedWorkerSources = new Map<string, Promise<string>>();
    const prepareWorkerSource = (
      assignment: SessionAssignment,
    ): Promise<string> => {
      const { worker, workerMachine } = assignment;
      const key = JSON.stringify([worker, workerMachine]);
      const existing = preparedWorkerSources.get(key);
      if (existing) return existing;
      const prepare = async (): Promise<string> => {
        const source = worker.name;
        if (worker.model.kind === "foundry") {
          let reported = -1;
          const downloaded = await logStep(
            source,
            `Getting Foundry model ${worker.model.source} on this computer`,
            () =>
              downloadFoundryModel(
                worker.model.source,
                workerMachine.command
                  ? context.globalStorageUri.fsPath
                  : workerMachine.modelsPath,
                { signal: lifetime.signal },
                ({ received, total }) => {
                  if (!(total > 0)) return;
                  const percent = Math.floor((received / total) * 10) * 10;
                  if (percent <= reported) return;
                  reported = percent;
                  logEvent(
                    source,
                    `Downloaded ${percent}% of ${(total / 1024 ** 3).toFixed(1)} GB.`,
                  );
                },
              ),
          );
          return workerMachine.command
            ? logStep(
                source,
                `Copying the model to ${workerMachine.name}`,
                () =>
                  uploadRemoteModel(
                    workerMachine,
                    downloaded,
                    worker.model.source,
                    lifetime.signal,
                  ),
              )
            : downloaded;
        }
        const model =
          worker.model.kind === "model-id"
            ? worker.model.source
            : machineModelSource(workerMachine, worker.model.source);
        return workerMachine.command
          ? logStep(
              source,
              `Preparing model ${model} on ${workerMachine.name}`,
              () =>
                prepareRemoteModel(
                  workerMachine,
                  worker,
                  model,
                  lifetime.signal,
                ),
            )
          : Promise.resolve(model);
      };
      const result = prepare().catch((error) => {
        if (preparedWorkerSources.get(key) === result)
          preparedWorkerSources.delete(key);
        throw error;
      });
      preparedWorkerSources.set(key, result);
      return result;
    };
    const createLocalSessionSetup = (
      id: string,
      repositoryPath: string,
      assignment?: SessionAssignment,
    ): LocalSessionSetup => {
      const remote = assignment
        ? asRemote(assignment.workerMachine)
        : configuredRemoteMachine();
      const configuredPath = assignment
        ? assignment.worker.model.source
        : remote
          ? remote.modelPath
          : vscode.workspace
              .getConfiguration("devdashAgents")
              .get<string>("localModelPath", "");
      if (!configuredPath)
        throw new Error(
          "Choose a local model in Settings before opening a local session.",
        );
      const toolRemote = assignment
        ? asRemote(assignment.executionMachine)
        : remote;
      const toolRepositoryPath = assignment
        ? machineRepositoryPath(assignment.executionMachine, repositoryPath)
        : remote
          ? remoteRepositoryPath(remote, repositoryPath)
          : repositoryPath;
      const { provider, deviceId } =
        assignment?.worker ?? configuredLocalDevice();
      let modelPath!: string;
      let modelInfo!: LocalModelInfo;
      let launch!: WorkerLaunch;
      let placement: { provider: LocalProvider; deviceId: number } = {
        provider,
        deviceId,
      };
      return {
        assignment,
        create: (localSessionId) => {
          if (!localSessionId)
            throw new Error("Missing local session identity.");
          const host = getLocalModelHost(
            modelPath,
            launch,
            placement.provider,
            placement.deviceId,
            modelInfo,
          );
          return new LocalConversation(
            host.attach(id, localSessionId),
            modelPath,
            placement.provider,
            placement.deviceId >= 0 ? placement.deviceId : undefined,
            {
              repositoryPath: toolRepositoryPath,
              ...(toolRemote ? { remote: toolRemote } : {}),
              canEdit: () =>
                application.canEditLocalSession(id, localSessionId),
              requestPermission: (description) =>
                application.requestPermission(
                  id,
                  description,
                  undefined,
                  `local:${localSessionId}`,
                ),
            },
            modelInfo,
          );
        },
        prepare: async () => {
          const selectedPath = assignment
            ? await prepareWorkerSource(assignment)
            : configuredPath;
          if (remote) {
            const inspected = await logStep(
              remote.name,
              `Inspecting model ${selectedPath}`,
              () =>
                inspectRemoteModel(
                  { ...remote, modelPath: selectedPath },
                  lifetime.signal,
                ),
            );
            modelPath = inspected.directory;
            modelInfo = {
              ...inspected.info,
              name: `${inspected.info.name} @ ${remote.name}`,
            };
            launch = await workerLaunch(remote);
          } else {
            modelPath = await prepareModel(
              selectedPath,
              provider,
              false,
              assignment?.workerMachine.modelsPath,
            );
            launch = assignment
              ? {
                  machine: "",
                  executable: await prepareWorker(
                    assignment.workerMachine.workerPath,
                  ),
                  args: [],
                }
              : await workerLaunch(undefined);
            const cached = localModelInfo.get(modelPath);
            modelInfo = cached ?? (await inspectLocalModel(modelPath));
            localModelInfo.set(modelPath, modelInfo);
          }
          if (assignment)
            launch.workerId = JSON.stringify([
              assignment.worker,
              assignment.workerMachine,
            ]);
          if (stopping || !panel)
            throw new Error("The application is closing.");
          placement = await resolveLocalPlacement(launch, provider, deviceId);
          getLocalModelHost(
            modelPath,
            launch,
            placement.provider,
            placement.deviceId,
            modelInfo,
          );
        },
      };
    };
    const preparedModels = new Map<string, Promise<string>>();
    const prepareModel = async (
      source: string,
      provider = configuredLocalDevice().provider,
      refresh = false,
      storageDirectory = join(context.globalStorageUri.fsPath, "models"),
    ): Promise<string> => {
      const targetProvider =
        provider === "auto" &&
        !existsSync(join(source, "genai_config.json")) &&
        (isTransformersModelId(source) || existsSync(source))
          ? (
              await resolveLocalPlacement(
                await workerLaunch(undefined),
                provider,
                configuredLocalDevice().deviceId,
              )
            ).provider
          : provider;
      const key = JSON.stringify([source, targetProvider, storageDirectory]);
      const existing = preparedModels.get(key);
      if (existing && !refresh) return existing;
      const preparing = vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Preparing local model: ${source}`,
          cancellable: true,
        },
        async (_progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() =>
            controller.abort(),
          );
          try {
            return await logStep(
              "this computer",
              `Preparing local model ${source} for ${targetProvider.toUpperCase()}`,
              () =>
                prepareLocalModel(source, storageDirectory, {
                  provider: targetProvider,
                  signal: AbortSignal.any([controller.signal, lifetime.signal]),
                }),
            );
          } finally {
            subscription.dispose();
          }
        },
      );
      const result = Promise.resolve(preparing).catch((error) => {
        if (preparedModels.get(key) === result) preparedModels.delete(key);
        throw error;
      });
      preparedModels.set(key, result);
      return result;
    };
    let localModelSelectionGeneration = 0;
    let savingLocalModelSelection: Promise<void> = Promise.resolve();
    const saveLocalModelSelection = (
      generation: number,
      modelPath: string,
    ): Promise<void> => {
      const save = async (): Promise<void> => {
        if (generation !== localModelSelectionGeneration) return;
        await vscode.workspace
          .getConfiguration("devdashAgents")
          .update(
            "localModelPath",
            modelPath,
            vscode.ConfigurationTarget.Global,
          );
      };
      savingLocalModelSelection = savingLocalModelSelection.then(save, save);
      return savingLocalModelSelection;
    };
    const discoverLocalDevices = (): Promise<void> =>
      (localDiscovery ??= (async () => {
        localDevicesStatus = "loading";
        localDevicesError = undefined;
        publishSettings();
        try {
          const discovery = startWorker(
            await workerLaunch(configuredRemoteMachine()),
          );
          try {
            const devices = await discovery.discover(
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(DEVICE_DISCOVERY_TIMEOUT_MS),
              ]),
            );
            if (!devices.length)
              throw new Error(
                "Local models cannot run: no usable CPU or GPU was found.",
              );
            localDevices = devices;
            localDevicesStatus = "ready";
          } finally {
            await discovery.stop();
          }
        } catch (error) {
          localDevicesStatus = "error";
          localDevicesError = report(error);
        } finally {
          localDiscovery = undefined;
          publishSettings();
        }
      })());
    const listFoundryModels = async (device: FoundryDevice): Promise<void> => {
      foundryListing?.abort();
      const controller = new AbortController();
      foundryListing = controller;
      foundryDevice = device;
      foundryCatalog = undefined;
      foundryStatus = "loading";
      foundryError = undefined;
      publishSettings();
      try {
        const catalog = await localFoundryModels(device, {
          signal: AbortSignal.any([controller.signal, lifetime.signal]),
        });
        if (foundryListing !== controller) return;
        foundryCatalog = catalog;
        foundryStatus = "ready";
      } catch (error) {
        if (foundryListing !== controller) return;
        foundryStatus = "error";
        foundryError = controller.signal.aborted
          ? "Listing cancelled."
          : report(error);
      } finally {
        if (foundryListing === controller) {
          foundryListing = undefined;
          publishSettings();
        }
      }
    };
    const downloadFoundry = async (id: string): Promise<void> => {
      if (foundryDownload)
        throw new Error("A Foundry Local download is already running.");
      const model = foundryCatalog?.models.find((entry) => entry.id === id);
      if (!model)
        throw new Error("List Foundry Local models before downloading one.");
      const selectionGeneration = ++localModelSelectionGeneration;
      const controller = new AbortController();
      foundryDownload = {
        controller,
        id,
        name: model.name,
        received: 0,
        total: model.size,
      };
      foundryError = undefined;
      publishSettings();
      try {
        const directory = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Foundry Local: downloading ${model.name}`,
            cancellable: true,
          },
          async (progress, token) => {
            const subscription = token.onCancellationRequested(() =>
              controller.abort(),
            );
            let reported = 0;
            try {
              return await downloadFoundryModel(
                id,
                context.globalStorageUri.fsPath,
                {
                  signal: AbortSignal.any([controller.signal, lifetime.signal]),
                },
                ({ received, total }) => {
                  const percent = total
                    ? Math.min(100, (received / total) * 100)
                    : 0;
                  progress.report({
                    message: `${Math.floor(percent)}%`,
                    increment: percent - reported,
                  });
                  reported = percent;
                  if (foundryDownload?.controller === controller) {
                    foundryDownload.received = received;
                    foundryDownload.total = total;
                    publishSettings();
                  }
                },
              );
            } finally {
              subscription.dispose();
            }
          },
        );
        await saveLocalModelSelection(selectionGeneration, directory);
      } catch (error) {
        foundryError = controller.signal.aborted
          ? "Download cancelled."
          : report(error);
      } finally {
        foundryDownload = undefined;
        publishSettings();
      }
    };
    const configurationSubscription = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (
          [
            "model",
            "localModelPath",
            "localProvider",
            "localDeviceId",
            "cliPath",
            "localWorkerPath",
            "requestTimeoutMinutes",
            "workerIdleMinutes",
            "approvedUrlOrigins",
            "remoteMachines",
            "remoteMachine",
            "execution",
          ].some((key) => event.affectsConfiguration(`devdashAgents.${key}`))
        ) {
          if (
            event.affectsConfiguration("devdashAgents.remoteMachines") ||
            event.affectsConfiguration("devdashAgents.remoteMachine")
          ) {
            // Detected devices belong to the previous execution machine.
            localDevices = undefined;
            localDevicesStatus = "idle";
            localDevicesError = undefined;
          }
          publishSettings();
        }
      },
    );
    const messageSubscription = panel.webview.onDidReceiveMessage(
      async (value: unknown) => {
        let repositoryId: string | undefined;
        let harnessSettingsRequestId: number | undefined;
        let executionConfigurationRequestId: string | undefined;
        const datasetAction =
          value !== null &&
          typeof value === "object" &&
          "type" in value &&
          (value.type === "dataset-sessions" ||
            value.type === "annotate-session" ||
            value.type === "export-dataset-session")
            ? value.type
            : undefined;
        let commentRequest:
          { id: string; url: string; requestId: string } | undefined;
        if (
          value !== null &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "harness-settings" &&
          "requestId" in value &&
          typeof value.requestId === "number" &&
          Number.isSafeInteger(value.requestId) &&
          value.requestId > 0
        )
          harnessSettingsRequestId = value.requestId;
        if (
          value !== null &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "execution-configuration" &&
          "requestId" in value &&
          typeof value.requestId === "string" &&
          value.requestId.length > 0 &&
          value.requestId.length <= 100
        )
          executionConfigurationRequestId = value.requestId;
        try {
          const message = parseApplicationMessage(value);
          if (message.type === "github-comment") commentRequest = message;
          if (!vscode.workspace.isTrusted) {
            throw new Error(
              "Trust the workspace before starting Copilot sessions.",
            );
          }
          if ("id" in message) {
            repositoryId = message.id;
          }
          switch (message.type) {
            case "ready":
              publish();
              publishSettings();
              publishMemory();
              break;
            case "dataset-sessions":
              await panel?.webview.postMessage({
                type: "dataset-sessions",
                sessions: application.getDatasetSessions(),
              });
              break;
            case "annotate-session":
              application.annotateSession(
                message.id,
                message.recordId,
                message.annotation,
              );
              await storage.save(application.getSnapshot());
              await panel?.webview.postMessage({
                type: "dataset-sessions",
                sessions: application.getDatasetSessions(),
                saved: true,
              });
              break;
            case "local-devices":
              await discoverLocalDevices();
              break;
            case "copilot-models":
              await loadCopilotModels();
              break;
            case "foundry-models":
              await listFoundryModels(message.device);
              break;
            case "worker-foundry-models": {
              // Unfiltered: the worker machine may be remote, so local memory is irrelevant.
              let result:
                | { models: { id: string; name: string; size: number }[] }
                | { error: string };
              try {
                const { models } = await listFoundryCatalogue(message.device, {
                  signal: lifetime.signal,
                });
                result = {
                  models: models.map(({ id, name, size }) => ({
                    id,
                    name,
                    size,
                  })),
                };
              } catch (error) {
                result = { error: report(error) };
              }
              await panel?.webview.postMessage({
                type: "worker-foundry-models",
                requestId: message.requestId,
                device: message.device,
                ...result,
              });
              break;
            }
            case "foundry-download":
              await downloadFoundry(message.id);
              break;
            case "foundry-cancel":
              foundryListing?.abort();
              foundryDownload?.controller.abort();
              break;
            case "harness-settings": {
              const save = async (): Promise<void> => {
                const settings =
                  vscode.workspace.getConfiguration("devdashAgents");
                const updates = { ...message.settings };
                if (
                  updates.approvedUrlOrigins !== undefined &&
                  message.baseApprovedUrlOrigins !== undefined
                ) {
                  updates.approvedUrlOrigins = reconcileApprovedUrlOrigins(
                    settings.get<string[]>("approvedUrlOrigins", []),
                    message.baseApprovedUrlOrigins,
                    updates.approvedUrlOrigins,
                  );
                }
                try {
                  for (const [key, value] of Object.entries(updates)) {
                    await settings.update(
                      key,
                      value,
                      vscode.ConfigurationTarget.Global,
                    );
                    if (settings.inspect(key)?.workspaceValue !== undefined)
                      await settings.update(
                        key,
                        value,
                        vscode.ConfigurationTarget.Workspace,
                      );
                  }
                } finally {
                  publishSettings();
                }
                await panel?.webview.postMessage({
                  type: "harness-settings-result",
                  requestId: message.requestId,
                  approvedUrlOrigins: settings.get<string[]>(
                    "approvedUrlOrigins",
                    [],
                  ),
                });
              };
              savingConfiguration = savingConfiguration.then(save, save);
              await savingConfiguration;
              break;
            }
            case "copilot-model": {
              const settings =
                vscode.workspace.getConfiguration("devdashAgents");
              try {
                await settings.update(
                  "model",
                  message.model,
                  vscode.ConfigurationTarget.Global,
                );
                if (settings.inspect("model")?.workspaceValue !== undefined)
                  await settings.update(
                    "model",
                    message.model,
                    vscode.ConfigurationTarget.Workspace,
                  );
              } finally {
                publishSettings();
              }
              if (!message.model) break;
              for (const repository of application.getState().repositories) {
                if (
                  application.getAssignment(repository.id) ||
                  repository.backend === "local" ||
                  !["ready", "busy"].includes(repository.status)
                )
                  continue;
                try {
                  await application.changeModel(repository.id, message.model);
                } catch (error) {
                  report(error);
                }
              }
              break;
            }
            case "local-model": {
              const settings =
                vscode.workspace.getConfiguration("devdashAgents");
              const configuredPath = settings.get<string>("localModelPath", "");
              const kind = await vscode.window.showQuickPick(
                [
                  "Local model or checkpoint directory",
                  "Transformers model ID",
                ],
                { title: "Choose a local model source" },
              );
              if (!kind) break;
              let source: string | undefined;
              if (kind === "Transformers model ID") {
                source = await vscode.window.showInputBox({
                  title: "Prepare a Hugging Face Transformers model",
                  prompt:
                    "Model ID (model or owner/model). Downloads and exports a supported checkpoint to ONNX GenAI INT4. Use only trusted models.",
                  placeHolder: "Qwen/Qwen3-0.6B",
                  validateInput: (value) =>
                    isTransformersModelId(value)
                      ? undefined
                      : "Enter a Hugging Face model ID (model or owner/model).",
                });
              } else {
                const selected = await vscode.window.showOpenDialog({
                  title: "Choose a GenAI model or Transformers checkpoint",
                  openLabel: "Use local model",
                  canSelectFiles: false,
                  canSelectFolders: true,
                  canSelectMany: false,
                  defaultUri:
                    configuredPath && !isTransformersModelId(configuredPath)
                      ? vscode.Uri.file(configuredPath)
                      : undefined,
                });
                source = selected?.[0]?.fsPath;
              }
              if (!source) break;
              const selectionGeneration = ++localModelSelectionGeneration;
              try {
                await saveLocalModelSelection(
                  selectionGeneration,
                  await prepareModel(
                    source,
                    configuredLocalDevice().provider,
                    true,
                  ),
                );
              } finally {
                publishSettings();
              }
              break;
            }
            case "remote-machines": {
              const settings =
                vscode.workspace.getConfiguration("devdashAgents");
              try {
                for (const [key, value] of [
                  ["remoteMachines", message.machines],
                  ["remoteMachine", message.selected],
                ] as const)
                  await settings.update(
                    key,
                    value,
                    vscode.ConfigurationTarget.Global,
                  );
              } finally {
                publishSettings();
              }
              break;
            }
            case "execution-configuration": {
              const save = async (): Promise<void> => {
                const settings = configuration();
                await settings.update(
                  "execution",
                  message.configuration,
                  vscode.ConfigurationTarget.Global,
                );
                if (settings.inspect("execution")?.workspaceValue !== undefined)
                  await settings.update(
                    "execution",
                    message.configuration,
                    vscode.ConfigurationTarget.Workspace,
                  );
                publishSettings();
              };
              savingConfiguration = savingConfiguration.then(save, save);
              await savingConfiguration;
              const saved = executionConfiguration();
              if (
                JSON.stringify(saved) !== JSON.stringify(message.configuration)
              )
                throw new Error(
                  "Machine and worker settings are overridden by another VS Code configuration scope.",
                );
              await panel?.webview.postMessage({
                type: "execution-configuration-saved",
                requestId: message.requestId,
                configuration: saved,
              });
              break;
            }
            case "local-device": {
              const settings =
                vscode.workspace.getConfiguration("devdashAgents");
              try {
                await settings.update(
                  "localProvider",
                  message.provider,
                  vscode.ConfigurationTarget.Global,
                );
                await settings.update(
                  "localDeviceId",
                  message.deviceId,
                  vscode.ConfigurationTarget.Global,
                );
              } finally {
                publishSettings();
              }
              break;
            }
            case "reduce-context":
              await application.reduceContext(
                message.id,
                message.mode,
                message.view,
              );
              break;
            case "stop-copilot-worker":
              await stopCopilotWorker(message.workerId);
              break;
            case "stop-local-worker": {
              const host = localHosts.get(message.hostId);
              if (!host) throw new Error("The worker is no longer running.");
              logEvent(
                host.snapshot().name ?? host.modelPath,
                "Stop requested.",
              );
              await host.stop();
              break;
            }
            case "local-placement": {
              const matches = [...localHosts.values()].filter(
                (entry) => entry.modelPath === message.modelPath,
              );
              if (!message.hostId && matches.length > 1)
                throw new Error(
                  "Choose a specific local model instance before changing its placement.",
                );
              const host = message.hostId
                ? localHosts.get(message.hostId)
                : matches[0];
              if (!host || host.modelPath !== message.modelPath)
                throw new Error("The local model is not currently open.");
              await host.place(
                message.placement,
                [...localHosts.values()].filter(
                  (peer) =>
                    hostMachines.get(peer) === hostMachines.get(host) &&
                    hostWorkers.get(peer) === hostWorkers.get(host),
                ),
              );
              if (message.placement.provider !== "disk")
                initialPlacements.set(host, message.placement);
              break;
            }
            case "settings":
              await vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "@ext:xadupre.devdash-agents",
              );
              break;
            case "refresh":
              await application.refresh();
              github.retain(
                new Set(
                  application
                    .getState()
                    .repositories.map((repository) => repository.id),
                ),
              );
              break;
            case "github":
            case "github-discussion":
            case "github-comment": {
              const repository = application
                .getState()
                .repositories.find((entry) => entry.id === message.id);
              if (!repository)
                throw new Error("Unknown repository for GitHub activity.");
              if (message.type === "github-comment") {
                await github.postComment(
                  repository,
                  message.url,
                  message.body,
                  message.requestId,
                  (update) => {
                    const { comment, ...status } = update;
                    if (panel)
                      void panel.webview.postMessage({
                        ...status,
                        commentId: comment?.id,
                        html: comment
                          ? renderGitHubComment(comment)
                          : undefined,
                      });
                  },
                );
              } else if (message.type === "github-discussion") {
                await github.loadDiscussion(
                  repository,
                  message.url,
                  (update) => {
                    const { discussion, ...status } = update;
                    if (panel)
                      void panel.webview.postMessage({
                        ...status,
                        html: discussion
                          ? renderGitHubDiscussion(discussion)
                          : undefined,
                      });
                  },
                );
              } else {
                await github.load(repository, message.section, message.cursor);
              }
              break;
            }
            case "select":
              await application.select(message.id);
              break;
            case "close-github-discussion":
              github.cancelDiscussion(message.id);
              break;
            case "send":
              if (
                (message.view ??
                  application
                    .getState()
                    .repositories.find((entry) => entry.id === message.id)
                    ?.view) === "local" &&
                [...localHosts.values()].some(
                  (host) =>
                    host.snapshot().status === "disk" &&
                    host
                      .snapshot()
                      .sessions.some(
                        (session) => session.repositoryId === message.id,
                      ),
                )
              )
                throw new Error(
                  "The local model is on DISK. Choose CUDA or CPU in the Sessions panel before sending.",
                );
              await application.send(
                message.id,
                message.question,
                message.parallel,
                message.images,
                message.view ?? "copilot",
              );
              break;
            case "postmortem": {
              const assignment = application.getAssignment(message.id);
              if (
                application
                  .getState()
                  .repositories.find((entry) => entry.id === message.id)
                  ?.backend === "local"
              ) {
                throw new Error(
                  "PostMortem uses Copilot and is disabled for local sessions.",
                );
              }
              await application.createPostMortem(
                message.id,
                (source, signal, onProgress) =>
                  generatePostMortem(
                    source,
                    (prompt, signal) =>
                      askCopilot(prompt, {
                        ...copilotOptions(source.repository.path, assignment),
                        signal,
                        timeoutMs: requestTimeout(),
                        analysisOnly: true,
                        responseSchema: postMortemResponseSchema,
                      }),
                    signal,
                    onProgress,
                  ),
              );
              await storage.save(application.getSnapshot());
              break;
            }
            case "export-postmortem": {
              const json = application.exportPostMortem(message.id);
              const destination = await vscode.window.showSaveDialog({
                title: "Export PostMortem",
                saveLabel: "Export JSON",
                filters: { JSON: ["json"] },
                defaultUri: vscode.Uri.file(
                  join(root.fsPath, "postmortem.json"),
                ),
              });
              if (destination)
                await vscode.workspace.fs.writeFile(
                  destination,
                  Buffer.from(json, "utf8"),
                );
              break;
            }
            case "export-session":
            case "export-dataset-session": {
              const source =
                message.type === "export-dataset-session"
                  ? application.getDatasetSessionExport(
                      message.id,
                      message.recordId,
                    )
                  : application.getSessionExport(message.id);
              const destination = await vscode.window.showSaveDialog({
                title: "Export session",
                saveLabel: "Export JSON",
                filters: { JSON: ["json"] },
                defaultUri: vscode.Uri.file(join(root.fsPath, "session.json")),
              });
              if (!destination) break;
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: "Exporting session and repository diff...",
                },
                async () => {
                  let warning: string | undefined;
                  const json = await exportSessionJson(
                    source,
                    AbortSignal.timeout(120_000),
                    undefined,
                    (message) => {
                      warning = message;
                    },
                  );
                  await vscode.workspace.fs.writeFile(
                    destination,
                    Buffer.from(json, "utf8"),
                  );
                  if (warning) await vscode.window.showWarningMessage(warning);
                },
              );
              break;
            }
            case "cancel":
              application.cancel(message.id, message.view ?? "copilot");
              break;
            case "draft":
              application.setDraft(
                message.id,
                message.text,
                message.view ?? "copilot",
              );
              break;
            case "permission":
              application.respondToPermission(message.id, message.approve);
              break;
            case "answer":
              application.answerQuestion(message.id, message.answer);
              break;
            case "restart": {
              const repository = application
                .getState()
                .repositories.find((entry) => entry.id === message.id);
              if (!repository) throw new Error("Unknown repository.");
              const assignment =
                application.getAssignment(message.id) ??
                (await chooseAssignment(
                  repository.backend ?? "copilot",
                  message.id,
                ));
              if (!assignment) break;
              if (repository.backend === "local") {
                const setup = createLocalSessionSetup(
                  message.id,
                  repository.path,
                  assignment,
                );
                await application.openLocalSession(
                  message.id,
                  setup.create,
                  setup.prepare,
                  false,
                  assignment,
                );
              } else {
                await application.restart(message.id, assignment);
              }
              break;
            }
            case "open-session": {
              const existing = application.getAssignment(message.id, "copilot");
              const assignment =
                existing ?? (await chooseAssignment("copilot", message.id));
              if (!assignment) break;
              await application.openSession(
                message.id,
                existing ? undefined : assignment,
              );
              break;
            }
            case "assignment-choice":
              assignmentRequests.get(message.requestId)?.(message.choice);
              break;
            case "select-session":
              application.selectSession(message.id, message.view);
              publishMemory();
              break;
            case "add-session": {
              const assignment = await chooseAssignment(undefined, message.id);
              if (!assignment) break;
              if (assignment.worker.backend === "copilot")
                await application.addCopilotSession(message.id, assignment);
              else {
                const repository = application
                  .getState()
                  .repositories.find((entry) => entry.id === message.id);
                if (!repository) throw new Error("Unknown repository.");
                const setup = createLocalSessionSetup(
                  message.id,
                  repository.path,
                  assignment,
                );
                await application.openLocalSession(
                  message.id,
                  setup.create,
                  setup.prepare,
                  true,
                  assignment,
                );
              }
              break;
            }
            case "select-local-session":
              application.selectLocalSession(
                message.id,
                message.localSessionId,
              );
              break;
            case "new-local-session":
            case "open-local-session": {
              const repository = application
                .getState()
                .repositories.find((entry) => entry.id === message.id);
              if (!repository) throw new Error("Unknown repository.");
              if (
                message.type === "open-local-session" &&
                repository.localSession &&
                ["ready", "busy", "starting"].includes(
                  repository.localSession.status,
                )
              ) {
                await application.openLocalSession(message.id, () => {
                  throw new Error(
                    "The existing local session is already open.",
                  );
                });
                break;
              }
              const existing =
                message.type === "open-local-session" && repository.localSession
                  ? application.getAssignment(message.id, "local")
                  : undefined;
              const assignment =
                existing ?? (await chooseAssignment("local", message.id));
              if (!assignment) break;
              const setup = createLocalSessionSetup(
                message.id,
                repository.path,
                assignment,
              );
              await application.openLocalSession(
                message.id,
                setup.create,
                setup.prepare,
                message.type === "new-local-session",
                setup.assignment,
              );
              break;
            }
            case "transfer-session":
              application.transferSession(message.id, message.view);
              break;
            case "resume-session": {
              const repository = application
                .getState()
                .repositories.find((entry) => entry.id === message.id);
              if (!repository) throw new Error("Unknown repository.");
              const current = application.getAssignment(
                message.id,
                message.view,
              );
              const assignment =
                current?.worker.backend === "copilot"
                  ? current
                  : await chooseAssignment("copilot", message.id);
              if (!assignment) break;
              const sessions = await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: "Loading Copilot sessions...",
                },
                () =>
                  listCopilotSessions({
                    ...copilotOptions(repository.path, assignment),
                    timeoutMs: requestTimeout(),
                  }),
              );
              if (!sessions.length) {
                void vscode.window.showInformationMessage(
                  `No existing Copilot session was found for ${repository.name}. Use New session to start one.`,
                );
                break;
              }
              const picked = await vscode.window.showQuickPick(
                sessions.map((session) => ({
                  label: session.summary || session.sessionId,
                  description: [
                    session.modifiedTime.toLocaleString(),
                    session.branch,
                  ]
                    .filter(Boolean)
                    .join(" - "),
                  detail: session.summary ? session.sessionId : undefined,
                  sessionId: session.sessionId,
                })),
                {
                  title: `Resume Copilot session - ${repository.name}`,
                  placeHolder: "Choose a session to resume",
                  matchOnDescription: true,
                  matchOnDetail: true,
                },
              );
              if (!picked) break;
              if (message.view)
                application.selectSession(message.id, message.view);
              await application
                .resumeSession(message.id, picked.sessionId, assignment)
                .finally(() => storage.save(application.getSnapshot()));
              break;
            }
            case "close-session":
              await application
                .closeSession(message.id, message.view)
                .finally(() => storage.save(application.getSnapshot()));
              break;
            case "new-session": {
              if (message.view)
                application.selectSession(message.id, message.view);
              const repository = application
                .getState()
                .repositories.find((entry) => entry.id === message.id);
              if (!repository) throw new Error("Unknown repository.");
              const assignment =
                application.getAssignment(message.id) ??
                (await chooseAssignment(
                  repository.backend ?? "copilot",
                  message.id,
                ));
              if (!assignment) break;
              const operation =
                repository.backend === "local"
                  ? application.newSession(
                      message.id,
                      createLocalSessionSetup(
                        message.id,
                        repository.path,
                        assignment,
                      ),
                    )
                  : application.newSession(message.id, undefined, assignment);
              await operation.finally(() =>
                storage.save(application.getSnapshot()),
              );
              break;
            }
            case "delete-last-session":
            case "delete-all-sessions":
              await application
                .deleteSessions(
                  message.id,
                  message.type === "delete-all-sessions",
                )
                .finally(() => storage.save(application.getSnapshot()));
              break;
            case "openExternal":
              if (
                !(await vscode.env.openExternal(vscode.Uri.parse(message.url)))
              ) {
                throw new Error(`Could not open link: ${message.url}`);
              }
              break;
          }
        } catch (error) {
          const message = report(error);
          if (panel && harnessSettingsRequestId !== undefined) {
            await panel.webview.postMessage({
              type: "harness-settings-result",
              requestId: harnessSettingsRequestId,
              error: message,
            });
          } else if (
            panel &&
            value !== null &&
            typeof value === "object" &&
            "type" in value &&
            value.type === "execution-configuration"
          ) {
            await panel.webview.postMessage({
              type: "execution-configuration-error",
              requestId: executionConfigurationRequestId,
              message,
            });
          } else if (panel && datasetAction) {
            await panel.webview.postMessage({
              type: "dataset-error",
              action: datasetAction,
              message,
            });
          } else if (panel && commentRequest) {
            await panel.webview.postMessage({
              type: "github-comment",
              id: commentRequest.id,
              url: commentRequest.url,
              requestId: commentRequest.requestId,
              status: "error",
              error: message,
            });
          } else if (panel) {
            const state = application.getState();
            await panel.webview.postMessage({
              type: "error",
              id: state.repositories.some(
                (repository) => repository.id === repositoryId,
              )
                ? repositoryId
                : undefined,
              message:
                state.activeId === repositoryId && state.error
                  ? state.error
                  : message,
            });
          }
        }
      },
    );
    panel.onDidDispose(() => {
      panel = undefined;
      for (const resolve of assignmentRequests.values()) resolve(undefined);
      clearInterval(memoryTimer);
      visibilitySubscription.dispose();
      messageSubscription.dispose();
      configurationSubscription.dispose();
      if (activePanel === currentPanel) {
        activePanel = undefined;
        closeActiveApplication = undefined;
      }
      const stop = close();
      closing.add(stop);
      void stop.then(
        () => closing.delete(stop),
        (error: unknown) => {
          closing.delete(stop);
          saveFailure(error);
        },
      );
    });
    panel.webview.html = renderApplication({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(scripts, "webview.js"))
        .toString(),
      styleUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(media, "app.css"))
        .toString(),
    });
  };
  const open = async (): Promise<void> => {
    try {
      opening ??= openApplication().finally(() => {
        opening = undefined;
      });
      await opening;
    } catch (error) {
      await vscode.window.showErrorMessage(`DevDash Agents: ${report(error)}`);
    }
  };
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("devdashAgents.open", open),
    vscode.commands.registerCommand("devdashAgents.ask", open),
    { dispose: () => activePanel?.dispose() },
  );
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    void open();
  }
}

export async function deactivate(): Promise<void> {
  deactivating = true;
  await Promise.all([
    ...closing,
    ...(closeActiveApplication ? [closeActiveApplication()] : []),
  ]);
}
