import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApplicationMessage } from "../src/application";
import { reconcileApprovedUrlOrigins } from "../src/settings";

const settings = {
  cliPath: "/tools/copilot",
  localWorkerPath: "/tools/local worker",
  requestTimeoutMinutes: 60,
  workerIdleMinutes: 30,
  approvedUrlOrigins: ["https://example.com", "http://localhost:8080"],
};

test("harness settings messages accept existing settings and discard unknown keys", () => {
  assert.deepEqual(
    parseApplicationMessage({
      type: "harness-settings",
      requestId: 1,
      settings: {
        ...settings,
        model: "must-not-be-updated",
        approvedUrlOrigins: [
          ...settings.approvedUrlOrigins,
          "https://example.com",
        ],
      },
      baseApprovedUrlOrigins: settings.approvedUrlOrigins,
    }),
    {
      type: "harness-settings",
      requestId: 1,
      settings,
      baseApprovedUrlOrigins: settings.approvedUrlOrigins,
    },
  );
  for (const [requestTimeoutMinutes, workerIdleMinutes] of [
    [1, 0],
    [35791, 10080],
  ]) {
    const value = {
      ...settings,
      requestTimeoutMinutes,
      workerIdleMinutes,
      approvedUrlOrigins: [],
    };
    assert.deepEqual(
      parseApplicationMessage({
        type: "harness-settings",
        requestId: 1,
        settings: value,
        baseApprovedUrlOrigins: settings.approvedUrlOrigins,
      }),
      {
        type: "harness-settings",
        requestId: 1,
        settings: value,
        baseApprovedUrlOrigins: settings.approvedUrlOrigins,
      },
    );
  }
  assert.deepEqual(
    parseApplicationMessage({
      type: "harness-settings",
      requestId: 2,
      settings: { approvedUrlOrigins: [] },
      baseApprovedUrlOrigins: settings.approvedUrlOrigins,
    }),
    {
      type: "harness-settings",
      requestId: 2,
      settings: { approvedUrlOrigins: [] },
      baseApprovedUrlOrigins: settings.approvedUrlOrigins,
    },
  );
  assert.throws(() =>
    parseApplicationMessage({
      type: "harness-settings",
      requestId: 0,
      settings: { cliPath: "/tools/copilot" },
    }),
  );
  assert.throws(() =>
    parseApplicationMessage({
      type: "harness-settings",
      requestId: 3,
      settings: { model: "not-a-harness-setting" },
    }),
  );
  assert.throws(() =>
    parseApplicationMessage({
      type: "harness-settings",
      requestId: 4,
      settings: { approvedUrlOrigins: [] },
    }),
  );
  assert.throws(() =>
    parseApplicationMessage({
      type: "harness-settings",
      requestId: 5,
      settings: { cliPath: "/tools/copilot" },
      baseApprovedUrlOrigins: settings.approvedUrlOrigins,
    }),
  );
});

test("harness settings messages reject invalid paths, timeouts and URL approvals", () => {
  const invalid = [
    undefined,
    null,
    {},
    ...["", " ", 42, "a\0b", "a\nb", "x".repeat(4097)].flatMap((path) => [
      { ...settings, cliPath: path },
      { ...settings, localWorkerPath: path },
    ]),
    ...[undefined, null, "60", 0, -1, 1.5, 35792, NaN, Infinity].map(
      (requestTimeoutMinutes) => ({ ...settings, requestTimeoutMinutes }),
    ),
    ...[undefined, "30", -1, 1.5, 10081, NaN].map((workerIdleMinutes) => ({
      ...settings,
      workerIdleMinutes,
    })),
    ...[
      null,
      "https://example.com",
      [42],
      ["file:///tmp"],
      ["https://example.com/path"],
      ["https://user@example.com"],
      ["https://example.com?query"],
      ["https://example.com#fragment"],
    ].map((approvedUrlOrigins) => ({ ...settings, approvedUrlOrigins })),
  ];
  for (const value of invalid) {
    assert.throws(() =>
      parseApplicationMessage({
        type: "harness-settings",
        requestId: 1,
        settings: value,
        ...(value && typeof value === "object" && "approvedUrlOrigins" in value
          ? { baseApprovedUrlOrigins: settings.approvedUrlOrigins }
          : {}),
      }),
    );
  }
});

test("stale URL approval edits preserve unrelated additions and revocations", () => {
  assert.deepEqual(
    reconcileApprovedUrlOrigins(
      [
        "https://keep.example",
        "https://remove.example",
        "https://concurrent-revoke.example",
        "https://concurrent-add.example",
      ],
      [
        "https://keep.example",
        "https://remove.example",
        "https://concurrent-revoke.example",
      ],
      ["https://keep.example", "https://add.example"],
    ),
    [
      "https://keep.example",
      "https://concurrent-add.example",
      "https://add.example",
    ],
  );
});
