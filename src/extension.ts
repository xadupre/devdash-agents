import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import {
  AgentApplication,
  parseApplicationMessage,
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
  localFoundryModels,
  type FoundryCatalog,
  type FoundryDevice,
} from "./foundry";
import { reconcileApprovedUrlOrigins } from "./settings";
import { LocalConversation } from "./local-conversation";
import {
  findLocalModelHost,
  LocalModelHost,
  type LocalPlacement,
} from "./local-model-host";
import { MemoryMonitor } from "./system-memory";
import {
  inspectRemoteModel,
  parseRemoteMachines,
  remoteInvocation,
  remoteRepositoryPath,
  type RemoteMachine,
} from "./remote";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let activePanel: vscode.WebviewPanel | undefined;
let closeActiveApplication: (() => Promise<void>) | undefined;
let opening: Promise<void> | undefined;
let deactivating = false;
const closing = new Set<Promise<void>>();
const DEVICE_DISCOVERY_TIMEOUT_MS = 120_000;

export function activate(context: vscode.ExtensionContext): void {
  deactivating = false;
  const output = vscode.window.createOutputChannel("Arranged Agents");
  let savingConfiguration: Promise<void> = Promise.resolve();
  const report = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    return message;
  };
  const openApplication = async (): Promise<void> => {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Trust the workspace before running Arranged Agents.",
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
        "Arranged Agents requires a local directory in the extension host.",
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
        `Arranged Agents could not save its history: ${report(error)}`,
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
      (repository, requestId, view) =>
        new CopilotConversation({
          cliPath: configuration().get<string>("cliPath", "copilot"),
          model: currentModel(),
          workingDirectory: repository.path,
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
      void panel.webview.postMessage({
        type: "local-models",
        models: [...localHosts].map(([id, host]) => ({
          ...host.snapshot(),
          id,
        })),
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
      "Arranged Agents",
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
    const publishMemory = (): void => {
      if (!panel?.visible || stopping) return;
      void memoryMonitor.sample().then(
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
        cliPath: settings.get<string>("cliPath", "copilot"),
        localWorkerPath: settings.get<string>(
          "localWorkerPath",
          DEFAULT_WORKER,
        ),
        requestTimeoutMinutes: settings.get<number>(
          "requestTimeoutMinutes",
          60,
        ),
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
    const prepareWorker = async (): Promise<string> => {
      const configuredWorker = vscode.workspace
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
              await installEngine(
                setupScript,
                [],
                AbortSignal.any([controller.signal, lifetime.signal]),
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
    }
    const workerLaunch = async (
      remote: RemoteMachine | undefined,
    ): Promise<WorkerLaunch> => {
      if (!remote)
        return { machine: "", executable: await prepareWorker(), args: [] };
      return {
        machine: remote.name,
        ...remoteInvocation(remote, [remote.workerPath]),
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
      const existing = findLocalModelHost(
        [...localHosts.values()].filter(
          (host) => (hostMachines.get(host) ?? "") === launch.machine,
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
      );
      localHosts.set(hostId, host);
      hostMachines.set(host, launch.machine);
      initialPlacements.set(host, { provider, deviceId });
      return host;
    };
    const resolveLocalPlacement = async (
      launch: WorkerLaunch,
      provider: LocalProvider,
      deviceId: number,
    ): Promise<{ provider: LocalProvider; deviceId: number }> => {
      if (provider !== "auto" && deviceId >= 0) return { provider, deviceId };
      const discovery = startWorker(launch, requestTimeout());
      try {
        const devices = await discovery.discover(
          AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(DEVICE_DISCOVERY_TIMEOUT_MS),
          ]),
        );
        const device = resolveLocalDevice(devices, provider, deviceId);
        return { provider: device.provider, deviceId: device.deviceId };
      } finally {
        await discovery.stop();
      }
    };
    const createLocalSessionSetup = (
      id: string,
      repositoryPath: string,
    ): LocalSessionSetup => {
      const remote = configuredRemoteMachine();
      const configuredPath = remote
        ? remote.modelPath
        : vscode.workspace
            .getConfiguration("devdashAgents")
            .get<string>("localModelPath", "");
      if (!configuredPath)
        throw new Error(
          "Choose a local model in Settings before opening a local session.",
        );
      const toolRepositoryPath = remote
        ? remoteRepositoryPath(remote, repositoryPath)
        : repositoryPath;
      const { provider, deviceId } = configuredLocalDevice();
      let modelPath!: string;
      let modelInfo!: LocalModelInfo;
      let launch!: WorkerLaunch;
      let placement: { provider: LocalProvider; deviceId: number } = {
        provider,
        deviceId,
      };
      return {
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
              ...(remote ? { remote } : {}),
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
          if (remote) {
            const inspected = await inspectRemoteModel(remote, lifetime.signal);
            modelPath = inspected.directory;
            modelInfo = {
              ...inspected.info,
              name: `${inspected.info.name} @ ${remote.name}`,
            };
            launch = await workerLaunch(remote);
          } else {
            modelPath = await prepareModel(configuredPath, provider);
            launch = await workerLaunch(undefined);
            const cached = localModelInfo.get(modelPath);
            modelInfo = cached ?? (await inspectLocalModel(modelPath));
            localModelInfo.set(modelPath, modelInfo);
          }
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
      const key = JSON.stringify([source, targetProvider]);
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
            return await prepareLocalModel(
              source,
              join(context.globalStorageUri.fsPath, "models"),
              {
                provider: targetProvider,
                signal: AbortSignal.any([controller.signal, lifetime.signal]),
              },
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
            "approvedUrlOrigins",
            "remoteMachines",
            "remoteMachine",
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
              await host.place(message.placement, localHosts.values());
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
            case "postmortem":
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
                        cliPath: configuration().get<string>(
                          "cliPath",
                          "copilot",
                        ),
                        model: currentModel(),
                        workingDirectory: source.repository.path,
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
              if (repository.backend === "local") {
                const setup = createLocalSessionSetup(
                  message.id,
                  repository.path,
                );
                await application.openLocalSession(
                  message.id,
                  setup.create,
                  setup.prepare,
                );
              } else {
                await application.restart(message.id);
              }
              break;
            }
            case "open-session":
              await application.openSession(message.id);
              break;
            case "select-session":
              application.selectSession(message.id, message.view);
              break;
            case "add-session": {
              const picked = await vscode.window.showQuickPick(
                [
                  {
                    label: "Copilot",
                    description: "Add an independent Copilot session",
                    backend: "copilot" as const,
                  },
                  {
                    label: "Local",
                    description:
                      "Use the model and device selected in Settings",
                    backend: "local" as const,
                  },
                ],
                {
                  title: "Add session",
                  placeHolder: "Choose the session type",
                },
              );
              if (!picked) break;
              if (picked.backend === "copilot")
                await application.addCopilotSession(message.id);
              else {
                const repository = application
                  .getState()
                  .repositories.find((entry) => entry.id === message.id);
                if (!repository) throw new Error("Unknown repository.");
                const setup = createLocalSessionSetup(
                  message.id,
                  repository.path,
                );
                await application.openLocalSession(
                  message.id,
                  setup.create,
                  setup.prepare,
                  true,
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
              const setup = createLocalSessionSetup(
                message.id,
                repository.path,
              );
              await application.openLocalSession(
                message.id,
                setup.create,
                setup.prepare,
                message.type === "new-local-session",
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
              const sessions = await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: "Loading Copilot sessions...",
                },
                () =>
                  listCopilotSessions({
                    cliPath: configuration().get<string>("cliPath", "copilot"),
                    workingDirectory: repository.path,
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
                .resumeSession(message.id, picked.sessionId)
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
              const operation =
                repository.backend === "local"
                  ? application.newSession(
                      message.id,
                      createLocalSessionSetup(message.id, repository.path),
                    )
                  : application.newSession(message.id);
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
      await vscode.window.showErrorMessage(`Arranged Agents: ${report(error)}`);
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
