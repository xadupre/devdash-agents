import { spawn } from "node:child_process";

// Stands in for `ssh host -- command`: the words after -- form one remote shell command.
const separator = process.argv.indexOf("--");
const command = process.argv.slice(separator + 1).join(" ");
const child = spawn("sh", ["-c", command], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
