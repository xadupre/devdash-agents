import { spawn } from "node:child_process";
import { remoteInvocation } from "./remote";

export function remoteCopilotInvocation(
  command: string,
  directory: string,
  cliPath: string,
  args: string[],
): { executable: string; args: string[] } {
  return remoteInvocation({ command }, [
    "sh",
    "-c",
    'cd -- "$1" || exit; shift; exec "$@"',
    "sh",
    directory,
    cliPath,
    ...args,
  ]);
}

if (require.main === module) {
  const [command, directory, cliPath, ...args] = process.argv.slice(2);
  if (!command || !directory || !cliPath)
    throw new Error("Missing remote Copilot launch configuration.");
  const invocation = remoteCopilotInvocation(command, directory, cliPath, args);
  const child = spawn(invocation.executable, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      console.error(error.message);
      stop("SIGTERM");
    }
  });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("close", (code) => {
    process.stdin.destroy();
    process.exitCode = code ?? 1;
  });
  const stop = (signal: NodeJS.Signals): void => {
    if (!child.pid || child.exitCode !== null) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      stop(signal);
      setTimeout(() => stop("SIGKILL"), 500).unref();
    });
}
