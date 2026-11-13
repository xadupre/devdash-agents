import type {
  PermissionHandler,
  PermissionRequest,
} from "@github/copilot-sdk" with { "resolution-mode": "import" };
import { describePermission } from "./presentation";

type PermissionPrompt = Parameters<PermissionHandler>[1]["promptRequest"];
type Description = ReturnType<typeof describePermission> & {
  approvalLabel?: string;
};

export function urlOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function requiresUser(value: PermissionRequest | PermissionPrompt): boolean {
  return Boolean(
    value &&
    (("managedApprovalRequired" in value && value.managedApprovalRequired) ||
      ("requestSandboxBypass" in value && value.requestSandboxBypass) ||
      ("warning" in value && value.warning)),
  );
}

function approvedUrl(url: string, origins: readonly string[]): boolean {
  const origin = urlOrigin(url);
  return (
    origin !== undefined &&
    (origins.includes(origin) ||
      [
        "https://github.com",
        "https://raw.githubusercontent.com",
        "https://api.github.com",
      ].includes(origin))
  );
}

function readOnlyShell(
  request: Extract<PermissionRequest, { kind: "shell" }>,
): boolean {
  // Use the runtime's shell parser, not command-name or text heuristics.
  return (
    request.commands.length > 0 &&
    request.commands.every((command) => command.readOnly === true) &&
    !request.hasWriteFileRedirection
  );
}

function shellCommands(text: string): string[][] | undefined {
  // Only extend the runtime classification for literal commands, never shell
  // expansion, redirection or executable substitutions.
  if (/[$`\\]/.test(text)) return undefined;
  text = text.trim();
  const token =
    /[ \t\r]+|&&|\|\||[;|\n]|(?:[^\s"';&|<>()[\]{}*?~]+|"[^"]*"|'[^']*')+/gy;
  const commands: string[][] = [[]];
  let end = 0;
  for (const match of text.matchAll(token)) {
    if (match.index !== end) return undefined;
    end = match.index + match[0].length;
    if (/^[ \t\r]+$/.test(match[0])) continue;
    if (/^(?:&&|\|\||[;|\n])$/.test(match[0])) {
      if (match[0] === "\n" && !commands.at(-1)!.length) continue;
      if (!commands.at(-1)!.length) return undefined;
      commands.push([]);
    } else {
      commands.at(-1)!.push(match[0].replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
    }
  }
  return end === text.length && commands.at(-1)!.length ? commands : undefined;
}

function safeGitConfig(setting: string): boolean {
  const match = /^([^=]+)(?:=(.*))?$/.exec(setting);
  const key = match?.[1]?.toLowerCase() ?? "";
  const value = match?.[2] ?? "true";
  const boolean = /^(?:true|false|yes|no|on|off|0|1)?$/i.test(value);
  if (
    /^advice\.[a-z][a-z0-9-]*$/.test(key) ||
    [
      "core.quotepath",
      "core.preloadindex",
      "core.trustctime",
      "core.ignorecase",
      "core.filemode",
      "fetch.prune",
      "fetch.prunetags",
    ].includes(key)
  ) {
    return boolean;
  }
  if (/^color\.[a-z][a-z0-9.-]*$/.test(key)) {
    return boolean || /^(?:auto|always|never)$/i.test(value);
  }
  if (key === "diff.renames") return boolean || value === "copies";
  if (key === "status.showuntrackedfiles") {
    return ["no", "normal", "all"].includes(value);
  }
  if (key === "core.hookspath") return value === "/dev/null";
  if (key === "core.pager") return value === "";
  if (key === "core.fsmonitor" || /^pager\.[a-z][a-z0-9-]*$/.test(key)) {
    return /^(?:false|no|off|0)?$/i.test(value);
  }
  return false;
}

function routineCommand(words: readonly string[]): boolean {
  const [executable, ...args] = words;
  if (executable === "cd") {
    return args.length <= 1 || (args.length === 2 && args[0] === "--");
  }
  if (executable?.startsWith("PYTHONPATH=")) {
    return (
      /^(?:python(?:3(?:\.\d+)?)?|pytest(?:-3)?)$/.test(args[0] ?? "") &&
      routineCommand(args)
    );
  }
  if (executable === "git") {
    while (args.length) {
      if (args[0] === "--no-pager" || args[0] === "--no-optional-locks") {
        args.shift();
      } else if (args[0] === "-C" && args[1]) {
        args.splice(0, 2);
      } else if (args[0] === "-c" && args[1]) {
        if (!safeGitConfig(args[1])) return false;
        args.splice(0, 2);
      } else if (args[0]?.startsWith("-c") && args[0].length > 2) {
        if (!safeGitConfig(args[0].slice(2))) return false;
        args.shift();
      } else {
        break;
      }
    }
    return (
      ([
        "diff",
        "fetch",
        "status",
        "log",
        "show",
        "rev-parse",
        "ls-files",
        "ls-tree",
        "describe",
        "show-ref",
      ].includes(args[0] ?? "") ||
        (args[0] === "worktree" &&
          ["list", "add", "move", "remove", "prune", "repair"].includes(
            args[1] ?? "",
          ))) &&
      !args.some((arg) => {
        const option = arg.split("=")[0]!;
        return (
          option.startsWith("--") &&
          option.length > 2 &&
          [
            "--output",
            "--ext-diff",
            "--textconv",
            "--upload-pack",
            "--exec",
          ].some((blocked) => blocked.startsWith(option))
        );
      })
    );
  }
  if (executable === "gh") {
    return (
      ((["issue", "pr"].includes(args[0] ?? "") &&
        ["list", "view", "status"].includes(args[1] ?? "")) ||
        (args[0] === "pr" && ["diff", "checks"].includes(args[1] ?? "")) ||
        (args[0] === "repo" && args[1] === "view") ||
        (args[0] === "search" &&
          ["issues", "prs", "commits", "repos", "code"].includes(
            args[1] ?? "",
          ))) &&
      !args.some((arg) => ["--web", "-w"].includes(arg))
    );
  }
  if (["npm", "pnpm", "yarn"].includes(executable ?? "")) {
    const script = args[0] === "run" ? args[1] : args[0];
    return /^test(?::[\w-]+)?$/.test(script ?? "");
  }
  if (/^python(?:3(?:\.\d+)?)?$/.test(executable ?? "")) {
    return args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "");
  }
  return (
    ["pytest", "pytest-3"].includes(executable ?? "") ||
    (executable === "node" && args[0] === "--test") ||
    (executable === "ctest" && !args.some((arg) => /^-(?:S|SP|P)/.test(arg))) ||
    (["cargo", "go", "dotnet", "mvn", "gradle", "make"].includes(
      executable ?? "",
    ) &&
      args[0] === "test")
  );
}

function routineShell(
  request: Extract<PermissionRequest, { kind: "shell" }>,
): boolean {
  if (request.hasWriteFileRedirection || !request.commands.length) {
    return false;
  }
  const commands = shellCommands(request.fullCommandText);
  if (!commands) return false;
  const classifications = new Map<string, boolean>();
  let identifierWords = 0;
  for (const command of request.commands) {
    classifications.set(
      command.identifier,
      command.readOnly && classifications.get(command.identifier) !== false,
    );
    identifierWords = Math.max(
      identifierWords,
      command.identifier.split(" ").length,
    );
  }
  return commands.every((words) => {
    if (routineCommand(words)) return true;
    let identifier = "";
    let readOnly = false;
    for (const word of words.slice(0, identifierWords)) {
      identifier = identifier ? `${identifier} ${word}` : word;
      const classification = classifications.get(identifier);
      if (classification === false) return false;
      if (classification === true) readOnly = true;
    }
    return readOnly;
  });
}

export function automaticallyApprove(
  request: PermissionRequest,
  prompt: PermissionPrompt,
  origins: readonly string[],
): boolean {
  if (requiresUser(request) || requiresUser(prompt)) return false;
  switch (request.kind) {
    case "read":
      return true;
    case "url":
      return approvedUrl(request.url, origins);
    case "shell":
      return (
        (readOnlyShell(request) || routineShell(request)) &&
        request.possibleUrls.every(({ url }) => approvedUrl(url, origins))
      );
    case "mcp":
      return (
        ["github", "github-mcp", "github-mcp-server"].includes(
          request.serverName,
        ) && request.readOnly === true
      );
    default:
      return false;
  }
}

export function permissionHandler(options: {
  isActive: () => boolean;
  approvedOrigins: () => readonly string[];
  rememberOrigin: (origin: string) => Promise<void>;
  ask: (description: Description) => Promise<boolean>;
}): PermissionHandler {
  return async (request, invocation) => {
    const reject = {
      kind: "reject" as const,
      feedback: "The application is closed, untrusted, or approval was denied.",
    };
    if (!options.isActive()) return reject;
    if (
      automaticallyApprove(
        request,
        invocation.promptRequest,
        options.approvedOrigins(),
      )
    ) {
      return { kind: "approve-once" };
    }
    const urls =
      request.kind === "url"
        ? [request.url]
        : request.kind === "shell" && readOnlyShell(request)
          ? request.possibleUrls.map(({ url }) => url)
          : [];
    const origins =
      !requiresUser(request) &&
      !requiresUser(invocation.promptRequest) &&
      urls.every((url) => urlOrigin(url) !== undefined)
        ? [
            ...new Set(
              urls
                .filter((url) => !approvedUrl(url, options.approvedOrigins()))
                .map((url) => urlOrigin(url)!),
            ),
          ]
        : [];
    const description = describePermission(request, invocation.promptRequest);
    const approved = await options.ask({
      ...description,
      ...(origins.length
        ? { approvalLabel: `Allow ${origins.join(", ")} and remember` }
        : {}),
    });
    if (!approved || !options.isActive()) return reject;
    for (const origin of origins) {
      if (!options.isActive()) return reject;
      await options.rememberOrigin(origin);
    }
    return options.isActive() ? { kind: "approve-once" } : reject;
  };
}
