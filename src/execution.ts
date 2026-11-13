import { isAbsolute, basename, join, posix, relative } from "node:path";
import { isTransformersModelId } from "./local-model-source";
import { isCopilotModelId } from "./settings";
import { isFoundryModelId } from "./foundry";
import { splitCommandLine } from "./remote";

export interface MachineConfiguration {
  id: string;
  name: string;
  /** Empty only for the extension host. Multiple entries may use the same command. */
  command: string;
  repositoriesPath: string;
  modelsPath: string;
  workerPath: string;
  cliPath: string;
}

export interface WorkerConfiguration {
  id: string;
  name: string;
  machineId: string;
  backend: "copilot" | "local";
  model: {
    kind: "copilot" | "file" | "checkpoint" | "model-id" | "foundry";
    source: string;
  };
  provider: "cpu" | "cuda";
  deviceId: number;
}

export interface ExecutionConfiguration {
  machines: MachineConfiguration[];
  workers: WorkerConfiguration[];
}

/** Snapshot: editing Settings must not silently retarget an existing session. */
export interface SessionAssignment {
  worker: WorkerConfiguration;
  workerMachine: MachineConfiguration;
  executionMachine: MachineConfiguration;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid execution configuration.");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value) ||
    value !== value.trim() ||
    value.length > 4096 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(`Invalid ${label}.`);
  return value;
}

function identifier(value: unknown): string {
  const id = text(value, "identifier");
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error("Invalid identifier.");
  return id;
}

export function parseMachine(value: unknown): MachineConfiguration {
  const entry = record(value);
  const id = identifier(entry.id);
  const command = text(entry.command, "connection command", true);
  if ((id === "local") !== (command === ""))
    throw new Error(
      "Only the local machine can have an empty connection command.",
    );
  if (command && !splitCommandLine(command)[0])
    throw new Error("Invalid connection command.");
  const repositoriesPath = text(
    entry.repositoriesPath,
    "repositories directory",
  );
  const modelsPath = text(entry.modelsPath, "models directory");
  for (const path of [repositoriesPath, modelsPath])
    if (!(command ? posix.isAbsolute(path) : isAbsolute(path)))
      throw new Error("Machine directories must be absolute.");
  return {
    id,
    name: text(entry.name, "machine name"),
    command,
    repositoriesPath,
    modelsPath,
    workerPath: text(entry.workerPath, "worker executable"),
    cliPath: text(entry.cliPath, "Copilot executable"),
  };
}

export function parseWorker(value: unknown): WorkerConfiguration {
  const entry = record(value);
  const label = `worker ${JSON.stringify(
    typeof entry.name === "string" && entry.name
      ? entry.name
      : typeof entry.id === "string"
        ? entry.id
        : "",
  )}`;
  const fail = (message: string): never => {
    throw new Error(`Invalid ${label}: ${message}`);
  };
  const model = record(entry.model);
  const backend = entry.backend;
  const kind = model.kind;
  if (backend !== "copilot" && backend !== "local")
    return fail(`unknown backend ${JSON.stringify(backend)}.`);
  if (
    kind !== "copilot" &&
    kind !== "file" &&
    kind !== "checkpoint" &&
    kind !== "model-id" &&
    kind !== "foundry"
  )
    return fail(`unknown model source type ${JSON.stringify(kind)}.`);
  if ((backend === "copilot") !== (kind === "copilot"))
    return fail("only Copilot workers can use a Copilot model ID.");
  let source: string;
  try {
    source = text(model.source, "model source", backend === "copilot");
  } catch {
    return fail(
      backend === "copilot"
        ? "the Copilot model ID must not have surrounding spaces or control characters."
        : "enter a model path or ID without surrounding spaces or control characters.",
    );
  }
  if (kind === "copilot" && !isCopilotModelId(source))
    return fail(
      `${JSON.stringify(source)} is not a Copilot model ID (printable ASCII without spaces).`,
    );
  if (kind === "model-id" && !isTransformersModelId(source))
    return fail(
      `${JSON.stringify(source)} is not a Hugging Face model ID; expected "name" or "owner/name". Use the checkpoint source for a local path.`,
    );
  if (kind === "foundry" && !isFoundryModelId(source))
    return fail(
      `${JSON.stringify(source)} is not a Foundry catalogue model ID; expected "azureml://registries/<registry>/models/<name>/versions/<n>". Pick a suggestion after listing Foundry models.`,
    );
  if (entry.provider !== "cpu" && entry.provider !== "cuda")
    return fail(
      `device must be CPU or CUDA, not ${JSON.stringify(entry.provider)}.`,
    );
  if (
    typeof entry.deviceId !== "number" ||
    !Number.isSafeInteger(entry.deviceId) ||
    entry.deviceId < 0
  )
    return fail(
      `device index must be a non-negative integer, not ${JSON.stringify(entry.deviceId)}.`,
    );
  return {
    id: identifier(entry.id),
    name: text(entry.name, "worker name"),
    machineId: identifier(entry.machineId),
    backend,
    model: { kind, source },
    provider: entry.provider,
    deviceId: entry.deviceId,
  };
}

export function parseExecutionConfiguration(
  value: unknown,
): ExecutionConfiguration {
  const entry = record(value);
  if (
    !Array.isArray(entry.machines) ||
    !entry.machines.length ||
    entry.machines.length > 64 ||
    !Array.isArray(entry.workers) ||
    entry.workers.length > 128
  )
    throw new Error(
      "Configure one local machine and at most 63 remote machines and 128 workers.",
    );
  const machines = entry.machines.map(parseMachine);
  const workers = entry.workers.map(parseWorker);
  if (
    machines.filter((machine) => machine.id === "local").length !== 1 ||
    new Set(machines.map((machine) => machine.id)).size !== machines.length ||
    new Set(workers.map((worker) => worker.id)).size !== workers.length
  )
    throw new Error(
      "Machine and worker identifiers must be unique; keep one local machine.",
    );
  for (const worker of workers)
    if (!machines.some((machine) => machine.id === worker.machineId))
      throw new Error(`Unknown machine for worker ${worker.name}.`);
  return { machines, workers };
}

export function assignSession(
  configuration: ExecutionConfiguration,
  workerId: string,
  executionMachineId: string,
  workerMachineId?: string,
): SessionAssignment {
  const { machines, workers } = parseExecutionConfiguration(configuration);
  const configured = workers.find((entry) => entry.id === workerId);
  const executionMachine = machines.find(
    (entry) => entry.id === executionMachineId,
  );
  // Copilot always runs where the session's files and commands are.
  const machineId =
    configured?.backend === "copilot"
      ? executionMachineId
      : (workerMachineId ?? configured?.machineId);
  const workerMachine = machines.find((entry) => entry.id === machineId);
  if (!configured || !workerMachine || !executionMachine)
    throw new Error(
      "Choose a configured worker, worker machine and harness machine.",
    );
  return {
    worker: { ...configured, machineId: workerMachine.id },
    workerMachine,
    executionMachine,
  };
}

export function parseSessionAssignment(value: unknown): SessionAssignment {
  const entry = record(value);
  const worker = parseWorker(entry.worker);
  const workerMachine = parseMachine(entry.workerMachine);
  const executionMachine = parseMachine(entry.executionMachine);
  if (
    worker.machineId !== workerMachine.id ||
    (workerMachine.id === executionMachine.id &&
      JSON.stringify(workerMachine) !== JSON.stringify(executionMachine)) ||
    (worker.backend === "copilot" && workerMachine.id !== executionMachine.id)
  )
    throw new Error("Inconsistent session assignment.");
  return { worker, workerMachine, executionMachine };
}

export function machineRepositoryPath(
  machine: MachineConfiguration,
  localPath: string,
): string {
  return (machine.command ? posix : { join }).join(
    machine.repositoriesPath,
    basename(localPath),
  );
}

export function machineModelSource(
  machine: MachineConfiguration,
  source: string,
): string {
  const paths = machine.command ? posix : { isAbsolute, join };
  if (paths.isAbsolute(source)) return source;
  const result = paths.join(machine.modelsPath, source);
  const within = machine.command
    ? posix.relative(machine.modelsPath, result)
    : relative(machine.modelsPath, result);
  if (within === ".." || within.startsWith("../") || within.startsWith("..\\"))
    throw new Error(
      "Model paths must stay inside the machine's models directory.",
    );
  return result;
}
