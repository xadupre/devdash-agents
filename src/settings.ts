import type { FoundryCatalog, FoundryDevice } from "./foundry";
import type { LocalDevice, LocalProvider } from "./local-worker";
import { requestTimeoutMs } from "./copilot";
import { urlOrigin } from "./permissions";
import type { RemoteMachine } from "./remote";
import type { ExecutionConfiguration } from "./execution";

export type SettingsLoadStatus = "idle" | "loading" | "ready" | "error";

export interface HarnessSettings {
  cliPath: string;
  localWorkerPath: string;
  requestTimeoutMinutes: number;
  /** Minutes without activity before a local model worker stops; 0 disables. */
  workerIdleMinutes: number;
  approvedUrlOrigins: string[];
}

export const MAX_WORKER_IDLE_MINUTES = 10080;

export function parseHarnessSettings(value: unknown): HarnessSettings {
  if (!value || typeof value !== "object")
    throw new Error("Invalid harness settings.");
  const {
    cliPath,
    localWorkerPath,
    requestTimeoutMinutes,
    workerIdleMinutes,
    approvedUrlOrigins,
  } = value as HarnessSettings;
  for (const path of [cliPath, localWorkerPath]) {
    if (
      typeof path !== "string" ||
      !path.trim() ||
      path.length > 4096 ||
      [...path].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Invalid harness executable path.");
  }
  if (typeof requestTimeoutMinutes !== "number")
    throw new Error("Invalid harness request timeout.");
  requestTimeoutMs(requestTimeoutMinutes);
  if (
    typeof workerIdleMinutes !== "number" ||
    !Number.isSafeInteger(workerIdleMinutes) ||
    workerIdleMinutes < 0 ||
    workerIdleMinutes > MAX_WORKER_IDLE_MINUTES
  )
    throw new Error(
      `Set the worker idle timeout to a whole number of minutes between 0 and ${MAX_WORKER_IDLE_MINUTES}.`,
    );
  if (
    !Array.isArray(approvedUrlOrigins) ||
    approvedUrlOrigins.some(
      (origin) => typeof origin !== "string" || urlOrigin(origin) !== origin,
    )
  )
    throw new Error(
      "Use HTTP or HTTPS URL origins without paths or credentials.",
    );
  return {
    cliPath,
    localWorkerPath,
    requestTimeoutMinutes,
    workerIdleMinutes,
    approvedUrlOrigins: [...new Set(approvedUrlOrigins)],
  };
}

export function parseHarnessSettingsPatch(
  value: unknown,
): Partial<HarnessSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid harness settings.");
  const parsed = parseHarnessSettings({
    cliPath: "copilot",
    localWorkerPath: "devdash-genai-worker",
    requestTimeoutMinutes: 60,
    workerIdleMinutes: 30,
    approvedUrlOrigins: [],
    ...value,
  });
  const patch: Partial<HarnessSettings> = {};
  if (Object.hasOwn(value, "cliPath")) patch.cliPath = parsed.cliPath;
  if (Object.hasOwn(value, "localWorkerPath"))
    patch.localWorkerPath = parsed.localWorkerPath;
  if (Object.hasOwn(value, "requestTimeoutMinutes"))
    patch.requestTimeoutMinutes = parsed.requestTimeoutMinutes;
  if (Object.hasOwn(value, "workerIdleMinutes"))
    patch.workerIdleMinutes = parsed.workerIdleMinutes;
  if (Object.hasOwn(value, "approvedUrlOrigins"))
    patch.approvedUrlOrigins = parsed.approvedUrlOrigins;
  if (!Object.keys(patch).length)
    throw new Error("No harness settings were provided.");
  return patch;
}

export function reconcileApprovedUrlOrigins(
  current: string[],
  previous: string[],
  desired: string[],
): string[] {
  const previousSet = new Set(previous);
  const desiredSet = new Set(desired);
  const merged = [
    ...new Set(
      current.filter(
        (origin) => !previousSet.has(origin) || desiredSet.has(origin),
      ),
    ),
  ];
  const mergedSet = new Set(merged);
  for (const origin of desired) {
    if (!previousSet.has(origin) && !mergedSet.has(origin)) {
      merged.push(origin);
      mergedSet.add(origin);
    }
  }
  return merged;
}

/** Settings shown in the webview settings panel. */
export interface SettingsState extends HarnessSettings {
  type: "settings-state";
  execution?: ExecutionConfiguration;
  copilotModel: string;
  copilotModels?: { id: string; name: string }[];
  copilotModelsStatus: SettingsLoadStatus;
  copilotModelsError?: string;
  localModelPath: string;
  /** Machines reachable through a connection command such as `az ssh vm`. */
  remoteMachines: RemoteMachine[];
  /** Machine running local workers and tools; empty for this computer. */
  remoteMachine: string;
  localProvider: LocalProvider;
  localDeviceId: number;
  localDevices?: LocalDevice[];
  localDevicesStatus: SettingsLoadStatus;
  localDevicesError?: string;
  foundryDevice: FoundryDevice;
  foundryCatalog?: FoundryCatalog;
  foundryStatus: SettingsLoadStatus;
  foundryError?: string;
  /** Present while a Foundry Local package is being downloaded. */
  foundryDownload?: {
    id: string;
    name: string;
    received: number;
    total: number;
  };
}

export const MAX_MODEL_ID_LENGTH = 200;

export function isCopilotModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_MODEL_ID_LENGTH &&
    value === value.trim() &&
    /^[\x21-\x7e]*$/.test(value)
  );
}
