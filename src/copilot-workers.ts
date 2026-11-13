import { createHash } from "node:crypto";
import type {
  ApplicationState,
  CopilotWorkerSnapshot,
  SessionView,
} from "./application";

export class CopilotWorkerMonitor {
  private readonly idleSince = new Map<string, number>();

  snapshots(state: ApplicationState, timeout: number): CopilotWorkerSnapshot[] {
    const now = Date.now();
    const rows = new Map<
      string,
      CopilotWorkerSnapshot & { idleSince: number }
    >();
    const seen = new Set<string>();
    for (const repository of state.repositories)
      for (const slot of repository.sessions ?? []) {
        if (slot.backend !== "copilot" || !slot.open) continue;
        const sessionKey = JSON.stringify([repository.id, slot.view]);
        seen.add(sessionKey);
        const busy = slot.status !== "ready" && slot.status !== "error";
        if (busy) this.idleSince.delete(sessionKey);
        else if (!this.idleSince.has(sessionKey))
          this.idleSince.set(sessionKey, now);
        const assignment = slot.assignment;
        const binding = JSON.stringify(assignment ?? null);
        const row = rows.get(binding) ?? {
          groupId: createHash("sha256").update(binding).digest("hex"),
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
          this.idleSince.get(sessionKey) ?? now,
        );
        rows.set(binding, row);
      }
    for (const key of this.idleSince.keys())
      if (!seen.has(key)) this.idleSince.delete(key);
    return [...rows.values()].map(({ idleSince, ...row }) => ({
      ...row,
      ...(!row.busy && timeout ? { idleStopAt: idleSince + timeout } : {}),
    }));
  }
}

export async function stopCopilotWorker(
  groupId: string,
  idleOnly: boolean,
  snapshots: () => CopilotWorkerSnapshot[],
  close: (repositoryId: string, view: SessionView) => Promise<void>,
  onStop: (row: CopilotWorkerSnapshot) => void,
): Promise<void> {
  const initial = snapshots().find((row) => row.groupId === groupId);
  if (!initial) throw new Error("The Copilot worker is no longer running.");
  const eligible = (row: CopilotWorkerSnapshot): boolean =>
    !row.busy &&
    (!idleOnly ||
      (row.idleStopAt !== undefined && row.idleStopAt <= Date.now()));
  if (!eligible(initial)) {
    if (!idleOnly && initial.busy)
      throw new Error(
        "Wait for the Copilot worker's running requests to finish.",
      );
    return;
  }
  onStop(initial);
  for (const session of initial.sessions) {
    const current = snapshots().find((row) => row.groupId === groupId);
    if (!current || !eligible(current)) return;
    if (
      current.sessions.some(
        (entry) =>
          entry.repositoryId === session.repositoryId &&
          entry.view === session.view,
      )
    )
      await close(session.repositoryId, session.view);
  }
}
