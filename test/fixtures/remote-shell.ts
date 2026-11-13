import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// Stands in for `ssh host -- command`: the words after -- form one remote shell command.
const separator = process.argv.indexOf("--");
const record = process.argv.indexOf("--record");
if (record > 0) writeFileSync(process.argv[record + 1]!, "connected");
const command = process.argv.slice(separator + 1).join(" ");
const child = spawn("sh", ["-c", command], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
