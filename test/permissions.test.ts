import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PermissionHandler,
  PermissionRequest,
} from "@github/copilot-sdk" with { "resolution-mode": "import" };
import {
  automaticallyApprove,
  permissionHandler,
  urlOrigin,
} from "../src/permissions";

const invocation = { sessionId: "test-session" };
const read: PermissionRequest = {
  kind: "read",
  path: "/outside/repository/README.md",
  intention: "Read a file",
};
const shell: Extract<PermissionRequest, { kind: "shell" }> = {
  kind: "shell",
  fullCommandText: "git status --short",
  intention: "Inspect repository",
  commands: [{ identifier: "git status", readOnly: true }],
  canOfferSessionApproval: true,
  hasWriteFileRedirection: false,
  possiblePaths: [],
  possibleUrls: [],
};
function url(value: string): Extract<PermissionRequest, { kind: "url" }> {
  return { kind: "url", url: value, intention: "Read a remote file" };
}
function automatic(request: PermissionRequest, origins: string[] = []) {
  return automaticallyApprove(request, undefined, origins);
}

test("local reads and HTTPS GitHub file reads are automatically approved", () => {
  assert.equal(automatic(read), true);
  for (const address of [
    "https://github.com/owner/repo/blob/main/README.md",
    "https://raw.githubusercontent.com/owner/repo/main/README.md",
    "https://api.github.com/repos/owner/repo/contents/README.md",
  ]) {
    assert.equal(automatic(url(address)), true, address);
  }
});

test("URL consent is scoped to the exact HTTP origin, not a prefix or hostname suffix", () => {
  assert.equal(
    urlOrigin("https://Example.com:443/a?q=1#heading"),
    "https://example.com",
  );
  assert.equal(
    urlOrigin("http://localhost:8000/path"),
    "http://localhost:8000",
  );
  const origins = ["https://example.com"];
  assert.equal(automatic(url("https://example.com/other"), origins), true);
  for (const address of [
    "http://example.com",
    "https://example.com:8443",
    "https://sub.example.com",
    "https://example.com.evil.test",
    "https://github.com.evil.test/file",
    "https://github.com@evil.test/file",
    "http://github.com/file",
    "https://github.com:8443/file",
    "https://user@example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a URL",
  ]) {
    assert.equal(automatic(url(address), origins), false, address);
  }
  for (const address of [
    "file:///tmp/file",
    "ftp://example.com",
    "https://user@example.com",
    "invalid",
  ]) {
    assert.equal(urlOrigin(address), undefined);
  }
  assert.equal(
    automatic(
      { ...url("https://other.test"), redirectedFrom: "https://example.com" },
      origins,
    ),
    false,
  );
});

test("shell approval uses all runtime-parsed commands and URL destinations", () => {
  for (const command of [
    "rg pattern src",
    "grep -R pattern .",
    "git diff",
    "gh pr view 21",
    "cat README.md | head -n 10",
  ]) {
    assert.equal(
      automatic({
        ...shell,
        fullCommandText: command,
        commands: [{ identifier: command.split(" ")[0]!, readOnly: true }],
      }),
      true,
      command,
    );
  }
  assert.equal(
    automatic({
      ...shell,
      possibleUrls: [{ url: "https://example.com/data" }],
    }),
    false,
  );
  assert.equal(
    automatic({
      ...shell,
      fullCommandText: "git status && git commit -am update",
      commands: [
        { identifier: "git", readOnly: true },
        { identifier: "git commit", readOnly: false },
      ],
    }),
    false,
  );
  assert.equal(
    automatic(
      {
        ...shell,
        possibleUrls: [{ url: "https://example.com/data" }],
      },
      ["https://example.com"],
    ),
    true,
  );
  assert.equal(
    automatic({
      ...shell,
      possibleUrls: [
        { url: "https://raw.githubusercontent.com/owner/repo/main/file" },
      ],
    }),
    true,
  );
  assert.equal(automatic({ ...shell, commands: [] }), false);
  assert.equal(
    automatic({
      ...shell,
      hasWriteFileRedirection: true,
      possiblePaths: ["/outside/file"],
    }),
    false,
  );
  for (const command of [
    "git commit",
    "git push",
    "gh pr merge",
    "rm",
    "bash",
    "python",
  ]) {
    assert.equal(
      automatic({
        ...shell,
        fullCommandText: `git status && ${command}`,
        commands: [
          { identifier: "git status", readOnly: true },
          { identifier: command, readOnly: false },
        ],
      }),
      false,
      command,
    );
  }
});

test("only read-only GitHub MCP tools bypass confirmation; writes and unknown tools do not", () => {
  const mcp: Extract<PermissionRequest, { kind: "mcp" }> = {
    kind: "mcp",
    serverName: "github",
    toolName: "get_file_contents",
    toolTitle: "Read file",
    readOnly: true,
  };
  for (const serverName of ["github", "github-mcp", "github-mcp-server"]) {
    assert.equal(automatic({ ...mcp, serverName }), true);
  }
  assert.equal(automatic({ ...mcp, readOnly: false }), false);
  assert.equal(automatic({ ...mcp, serverName: "other" }), false);
  assert.equal(
    automatic({
      kind: "write",
      fileName: "/repo/file",
      intention: "Edit file",
      canOfferSessionApproval: true,
      diff: "+new content",
    }),
    false,
  );
});

test("Git/GitHub queries and test runners do not need a readOnly classification", async () => {
  const handler = permissionHandler({
    isActive: () => true,
    approvedOrigins: () => [],
    rememberOrigin: async () => assert.fail("No URL consent to persist"),
    ask: async () => assert.fail("Routine commands must not prompt"),
  });
  for (const command of [
    "git diff",
    "git --no-pager diff --stat",
    'git -C "/repo with spaces" diff -- src',
    "git status",
    "git status --short",
    "git fetch",
    "git fetch origin main",
    "git fetch --all --prune",
    "git fetch origin && git status --short",
    "git -c core.quotepath=false status",
    "git -c color.ui=never diff",
    "git -ccolor.ui=false diff",
    'git -C "/repo with spaces" -c color.ui=always --no-pager diff',
    "git -c advice.detachedHead=false -C /repo -c core.quotePath=true status",
    "git -c color.ui diff",
    "git -c core.pager= log -5",
    "git -c pager.diff=false diff",
    "git -c core.fsmonitor=false status",
    "git worktree list --porcelain",
    "git worktree add -b feature ../feature main",
    "git worktree move ../feature ../renamed",
    "git worktree remove ../feature",
    "git worktree prune",
    "git worktree repair ../feature",
    "git -c core.hooksPath=/dev/null worktree add ../feature main",
    "git worktree add ../feature && git -C ../feature status",
    "git log -5 --oneline",
    "gh issue list --repo owner/repo",
    "gh issue view 42 --comments",
    "gh pr diff 42",
    "gh pr checks 42",
    "gh search issues 'test failure' --repo owner/repo",
    "npm test -- --runInBand",
    "npm run test:unit",
    "pnpm test",
    "yarn run test:integration",
    "node --test dist/test/permissions.test.js",
    "pytest -q test/",
    "python -m pytest -q",
    "python3 -m unittest discover",
    "PYTHONPATH=src python3.12 -m pytest test/",
    "ctest --test-dir build --output-on-failure",
    "cargo test --workspace",
    "go test ./...",
    "dotnet test",
    "mvn test",
    "gradle test",
    "make test",
    "git diff && npm test",
    'cd "/repo with spaces" && git diff && npm test',
    "git diff; gh issue list",
    "\n git diff\n",
    "git diff;\n\nnpm test",
    "npm test || npm run test:unit",
    "git diff -- 'file;with|punctuation'",
    "git diff -- '*.ts'",
  ]) {
    assert.deepEqual(
      await handler(
        {
          ...shell,
          fullCommandText: command,
          commands: [{ identifier: command.split(" ")[0]!, readOnly: false }],
        },
        invocation,
      ),
      { kind: "approve-once" },
      command,
    );
  }
  assert.equal(
    automatic({
      ...shell,
      fullCommandText: "git diff | head -n 10",
      commands: [
        { identifier: "git", readOnly: false },
        { identifier: "head", readOnly: true },
      ],
    }),
    true,
  );
});

test("routine-command exceptions do not approve unrelated mutations or shell evaluation", () => {
  for (const command of [
    "git commit -am update",
    "git diff --output=/tmp/diff",
    "git diff --output /tmp/diff",
    "git diff --out=/tmp/diff",
    "git diff --ext-diff",
    "git show --textconv HEAD",
    "git -c core.pager=custom diff",
    "git -c core.fsmonitor=custom status",
    "git -c core.hooksPath=/tmp/hooks worktree add ../feature",
    "git -c credential.helper=custom fetch",
    "git -c alias.query=custom query",
    "git -c include.path=/tmp/config status",
    "git -c diff.external=custom diff",
    "git -ccore.pager=custom worktree list",
    "git -c core.quotepath=custom status",
    "git -c color.ui=never -c core.pager=custom diff",
    "git -c color.ui=never push",
    "git -c color.ui=never commit -am update",
    "git -c",
    "git -c color.ui=never",
    "git worktree",
    "git worktree unknown",
    "git worktree list && git push",
    "git fetch --upload-pack=custom origin",
    "git fetch --upload=custom origin",
    "git fetch --exec custom origin",
    "git fetch origin && git push",
    "gh issue create --title bug",
    "gh issue close 42",
    "gh pr merge 42",
    "gh api --method POST repos/owner/repo/issues",
    "gh issue view 42 --web",
    "npm run build",
    "npm run test:unit && rm -rf dist",
    "npm test & rm file",
    "npm test > result.txt",
    "git diff $(touch /tmp/unexpected)",
    "git diff `touch /tmp/unexpected`",
    "git diff ${OPTIONS}",
    "git diff *",
    "git diff file?.ts",
    "git -C ~/repo status",
    'git diff "$OPTIONS"',
    "git diff\\\n&& rm file",
    "bash -c 'npm test'",
    "node -e 'console.log(1)'",
    "python script.py",
    "ctest -S script.cmake",
    "PATH=/untrusted git diff",
    "npm test &&",
    "npm test; (rm file)",
    "git diff 'unterminated",
    "git diff\n\nrm file",
  ]) {
    assert.equal(
      automatic({
        ...shell,
        fullCommandText: command,
        commands: [{ identifier: command.split(" ")[0]!, readOnly: false }],
      }),
      false,
      command,
    );
  }
  assert.equal(
    automatic({
      ...shell,
      fullCommandText: "git diff && git commit -am update",
      commands: [
        { identifier: "git", readOnly: true },
        { identifier: "git", readOnly: false },
      ],
    }),
    false,
  );
  for (const override of [
    { commands: [] },
    { hasWriteFileRedirection: true },
    { managedApprovalRequired: true },
    { requestSandboxBypass: true },
    { warning: "Requires confirmation" },
    { possibleUrls: [{ url: "https://unapproved.test/tests" }] },
  ]) {
    assert.equal(
      automatic({
        ...shell,
        fullCommandText: "npm test",
        commands: [{ identifier: "npm", readOnly: false }],
        ...override,
      }),
      false,
    );
  }
});

test("managed approvals, warnings, and sandbox escalations always require a user", () => {
  for (const request of [
    read,
    shell,
    {
      ...shell,
      fullCommandText: "git fetch",
      commands: [{ identifier: "git", readOnly: false }],
    },
    {
      ...shell,
      fullCommandText:
        "git -c core.hooksPath=/dev/null worktree add ../feature",
      commands: [{ identifier: "git", readOnly: false }],
    },
    url("https://github.com/file"),
  ]) {
    assert.equal(
      automatic({ ...request, managedApprovalRequired: true }),
      false,
    );
    assert.equal(automatic({ ...request, requestSandboxBypass: true }), false);
    assert.equal(
      automaticallyApprove(
        request,
        {
          kind: "url",
          url: "https://github.com/file",
          intention: "Read file",
          managedApprovalRequired: true,
        },
        [],
      ),
      false,
    );
    assert.equal(
      automaticallyApprove(
        request,
        {
          kind: "url",
          url: "https://github.com/file",
          intention: "Read file",
          requestSandboxBypass: true,
        },
        [],
      ),
      false,
    );
  }
  assert.equal(automatic({ ...shell, warning: "Dangerous command" }), false);
});

test("root consent is explicit, persisted, shared by new handlers, and revocable", async () => {
  let origins: string[] = [];
  const questions: Parameters<
    Parameters<typeof permissionHandler>[0]["ask"]
  >[0][] = [];
  const options = {
    isActive: () => true,
    approvedOrigins: () => origins,
    rememberOrigin: async (origin: string) => {
      origins.push(origin);
    },
    ask: async (description: (typeof questions)[number]) => {
      questions.push(description);
      return true;
    },
  };
  const handler = permissionHandler(options);
  assert.deepEqual(await handler(read, invocation), { kind: "approve-once" });
  assert.equal(questions.length, 0);
  assert.deepEqual(await handler(url("https://example.com/a"), invocation), {
    kind: "approve-once",
  });
  assert.equal(
    questions[0]?.approvalLabel,
    "Allow https://example.com and remember",
  );
  assert.deepEqual(origins, ["https://example.com"]);
  const reopened = permissionHandler(options);
  await reopened(url("https://example.com/b"), invocation);
  assert.equal(questions.length, 1);
  origins = [];
  await reopened(url("https://example.com/c"), invocation);
  assert.equal(questions.length, 2);
});

test("rejection, closure and managed approval never persist URL consent", async () => {
  let active = true;
  let accept = false;
  let closeDuringAsk = false;
  let prompts = 0;
  const remembered: string[] = [];
  const handler = permissionHandler({
    isActive: () => active,
    approvedOrigins: () => [],
    rememberOrigin: async (origin) => {
      remembered.push(origin);
    },
    ask: async (description) => {
      prompts++;
      if (closeDuringAsk) active = false;
      if (prompts > 2) assert.equal(description.approvalLabel, undefined);
      return accept;
    },
  });
  assert.equal(
    (await handler(url("https://example.com"), invocation)).kind,
    "reject",
  );
  accept = true;
  closeDuringAsk = true;
  assert.equal(
    (await handler(url("https://example.com"), invocation)).kind,
    "reject",
  );
  assert.equal((await handler(read, invocation)).kind, "reject");
  assert.equal(prompts, 2);
  active = true;
  closeDuringAsk = false;
  await handler(
    { ...url("https://example.com"), managedApprovalRequired: true },
    invocation,
  );
  await handler(
    { ...url("https://example.com"), requestSandboxBypass: true },
    invocation,
  );
  assert.deepEqual(remembered, []);
});

test("safe shell URL reads remember every explicitly approved root, but unsafe commands do not", async () => {
  const origins: string[] = [];
  const labels: (string | undefined)[] = [];
  const handler = permissionHandler({
    isActive: () => true,
    approvedOrigins: () => origins,
    rememberOrigin: async (origin) => {
      origins.push(origin);
    },
    ask: async (description) => {
      labels.push(description.approvalLabel);
      return true;
    },
  });
  const request = {
    ...shell,
    fullCommandText: "curl https://one.test/a https://two.test/b",
    possibleUrls: [
      { url: "https://one.test/a" },
      { url: "https://two.test/b" },
      { url: "https://one.test/c" },
      { url: "https://github.com/owner/repo" },
    ],
  };
  await handler(request, invocation);
  assert.deepEqual(labels, [
    "Allow https://one.test, https://two.test and remember",
  ]);
  assert.deepEqual(origins, ["https://one.test", "https://two.test"]);
  await handler(request, invocation);
  assert.equal(labels.length, 1);
  for (const unsafe of [
    { ...request, hasWriteFileRedirection: true },
    { ...request, commands: [{ identifier: "curl", readOnly: false }] },
    { ...request, requestSandboxBypass: true },
    { ...request, possibleUrls: [{ url: "file:///etc/passwd" }] },
  ]) {
    origins.length = 0;
    await handler(unsafe, invocation);
    assert.equal(labels.at(-1), undefined);
    assert.deepEqual(origins, []);
  }
});

test("failed persistence does not silently grant a remembered approval", async () => {
  const handler: PermissionHandler = permissionHandler({
    isActive: () => true,
    approvedOrigins: () => [],
    rememberOrigin: async () => {
      throw new Error("Cannot save settings");
    },
    ask: async () => true,
  });
  await assert.rejects(
    async () => handler(url("https://example.com"), invocation),
    /Cannot save settings/,
  );
});
