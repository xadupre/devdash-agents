import type {
  PermissionHandler,
  PermissionRequest,
} from "@github/copilot-sdk" with { "resolution-mode": "import" };

function label(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatFields(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(formatFields).join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, field]) => `${label(key)}: ${formatFields(field)}`)
      .join("\n");
  }
  return String(value);
}

export function describeTool(name: string, args: unknown): string {
  if (
    args &&
    typeof args === "object" &&
    "command" in args &&
    typeof args.command === "string"
  ) {
    return args.command;
  }
  return formatFields(args) || name;
}

export function describePermission(
  request: PermissionRequest,
  prompt?: Parameters<PermissionHandler>[1]["promptRequest"],
): { kind: string; summary: string; content: string; details: string } {
  const data = prompt ?? request;
  const summaries: Record<string, string> = {
    shell: "Run this command?",
    commands: "Run this command?",
    read: "Read this file or directory?",
    write: "Apply these file changes?",
    url: "Access this URL?",
  };
  let content: string;
  switch (data.kind) {
    case "commands":
    case "shell":
      content = data.fullCommandText;
      break;
    case "read":
      content = data.path;
      break;
    case "write":
      content = [data.fileName, data.diff || data.newFileContents]
        .filter((part) => part !== undefined)
        .join("\n\n");
      break;
    default:
      content = formatFields(data);
  }
  if (
    "intention" in data &&
    typeof data.intention === "string" &&
    data.intention
  ) {
    content = `${data.intention}\n\n${content}`;
  }
  if ("warning" in data && typeof data.warning === "string" && data.warning) {
    content += `\n\nWarning: ${data.warning}`;
  }
  if ("requestSandboxBypass" in request && request.requestSandboxBypass) {
    content +=
      "\n\nWarning: this operation requests access outside the sandbox.";
    if (request.requestSandboxBypassReason) {
      content += `\n${request.requestSandboxBypassReason}`;
    }
  }
  return {
    kind: request.kind,
    summary: summaries[data.kind] ?? `Allow ${label(data.kind).toLowerCase()}?`,
    content,
    details: JSON.stringify({ request, prompt }, null, 2),
  };
}
