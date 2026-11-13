# Arranged Agents

<img src="media/icon.png" alt="Arranged Agents icon" width="128" height="128">

[![Tests](https://github.com/xadupre/arranged-agents/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/xadupre/arranged-agents/actions/workflows/tests.yml)
[![Code coverage](https://codecov.io/gh/xadupre/arranged-agents/branch/main/graph/badge.svg)](https://codecov.io/gh/xadupre/arranged-agents)

A two-panel application inside a VS Code editor tab, using your **locally
installed GitHub Copilot CLI**:

- **Left:** the selected repository's Copilot conversation, rendered as HTML
  with Markdown and mathematical equations.
- **Right:** switch between **Repositories**, **Activity** (issues, PRs, comments
  and commits) and **Log**. Repositories lists direct child directories containing
  a `.git` directory or file.
  Each repository has its own session, started only when you click it.

## Screenshots

These screenshots show the application webview with illustrative demo data,
not a live Copilot conversation or GitHub activity.

![Two-panel workspace with a Copilot conversation and a shared sidebar for repositories, activity and logs](docs/images/workspace.png)

_Repository activity, Markdown conversations and independent sessions in one tab._

![PostMortem report with validation results, source references and JSON export](docs/images/postmortem.png)

_PostMortem turns a recorded conversation into an evidence-linked report._

## Requirements

- VS Code 1.105 or newer.
- Node.js 22.13 or newer for development.
- GitHub Copilot CLI installed and authenticated: run `copilot login`.
- Git and GitHub CLI installed; run `gh auth login` for the activity sidebar.
- A GitHub account with access to Copilot. Requests use your Copilot allowance.

The CLI runs locally, but model requests still go to GitHub Copilot: this is not
an offline model. No separate API key is required.

For local inference instead, **Open local session** uses an optional native
ONNX Runtime GenAI worker and your own model, with streamed chat and cancellation.
See [native build and protocol](docs/development.rst) and
[local sessions](docs/features/sessions.rst). Copilot and local sessions can
remain open side by side. Local sessions share a loaded model across
repositories while keeping separate KV caches. The Sessions panel moves the
model between devices or unloads it; DISK unloads without saving model or cache
data. Local prompts do not fall back to Copilot.

Release VSIX assets include a ready-to-run native worker: **Linux x64** and
**Windows x64**, each with **CPU** or **CUDA** variants, and **macOS Apple Silicon**
with CPU. Choose the variant matching the extension host, not necessarily your
desktop OS. CUDA requires a compatible NVIDIA driver, CUDA 13 and cuDNN 9;
CPU packages need none of these. Models remain user-provided. NPU runtimes stay
external, configured with `arrangedAgents.localWorkerPath`.
See [installation and platform requirements](docs/getting_started.rst).

## Quick start

From a Bash terminal in this checkout, run:

```bash
./start.sh
```

Like onnx-light-viewer, `start.sh` installs missing dependencies, compiles, and opens a new VS Code
development window. It chooses the desktop `code` executable, not the restricted
remote CLI, and removes the remote IPC hook. Other installed extensions are
disabled in that window. The **Arranged Agents** tab opens automatically.
The launcher uses the source checkout's parent directory, regardless of the
terminal's current directory. To choose another parent containing your repositories:

```bash
./start.sh /path/to/repositories
```

The launcher prints each stage with elapsed time and uses incremental compilation
to speed up subsequent launches. Use `START_VERBOSE=1 ./start.sh` to enable
command tracing. Native engine builds show verbose CMake output.
Run `./start.sh --help` for usage and examples. VS Code's `code` command must be
on `PATH`. After editing the application, close the development window and run
`./start.sh` again.
The source checkout is used for compilation, not as the implicit repository root.
No Copilot process or session starts until a repository is clicked.

Alternatively run `npm ci` and open this directory in VS Code,
then select **Run Arranged Agents** and press **F5**. In the development window,
the application opens automatically and scans the first workspace folder.
For an installed VSIX, run **Arranged Agents: Open** from the Command Palette.
The old **Ask Copilot** command is an alias for opening the application.

Select a repository on the right, click **Open Copilot session**, wait for **Session open - ready**, and send messages
in the chat with **Enter** or **Send**. **Shift+Enter** inserts a new line.
**↑ Prompt** / **↓ Prompt** above the conversation jump between your prompts.
The **Parallel ON/OFF** button beside **Send** defaults to **ON**. While Copilot
is working, ON starts an independent request immediately with a bounded snapshot
of the visible conversation. OFF queues the message for the main agent after
current requests finish, in submission order. Parallel requests can run tools
and edit the same repository files, subject to the usual permissions; concurrent
edits can conflict. Their messages and commands carry a **Parallel** label.
**Cancel** stops all requests and discards queued messages for that repository.
Switching repositories only changes the view; it never starts or resumes Copilot.
It preserves their independent conversations and drafts. **Close session** above
the conversation stops Copilot without deleting its history. **Refresh** rescans the parent directory without restarting existing
sessions. Closing the tab stops Copilot and saves the histories, drafts and session
IDs locally. Reopening restores the last selected repository and its transcript;
select a repository and click **Open Copilot session** to resume its saved Copilot context. Nothing restarts in the
background, and interrupted requests are never sent again automatically.

History is saved per repository parent as private, unencrypted JSON in
`~/.cache/arranged-agents/conversations/` on the extension host, outside your
repositories. Cache cleanup can remove these files; they are not a backup.
Resume also requires the CLI's own saved session to remain available. If it is
missing or invalid, an error is shown; **New session** explicitly starts fresh
while retaining the displayed history, without replaying it to the model.

Activity icons indicate session startup and requests in progress, including in
background repositories. Drag the panel divider to resize it, or focus the
divider and use the left/right arrow keys.

A small counter beside the session status shows generated output tokens reported
by Copilot, including subagents and parallel requests. It updates after each model
call, survives reopening the conversation, and resets for a new session. Older
conversations without a saved count start at zero; earlier usage is not estimated.

The right panel's **Activity** view follows the selected repository with five buttons:
**Issues**, **Reviews** (pull requests), **Commits**, **Comments** and **Mentions**.
Your issues/PRs have a distinct background; **Replied** marks your participation
and **After you** indicates a comment or submitted review after your latest response.
**Comments** shows your comments/reviews plus subsequent responses, including closed
discussions. **Commits** lists the latest 30 commits on the current local branch.
**Mentions** shows direct `@username` pings in issue/PR descriptions, comments,
submitted reviews and inline review comments, including closed discussions,
with no later comment or submitted review from you in that discussion.
Your own pings and team mentions are excluded. Search indexing may delay results;
an empty page can still have **Load more** results.
Click titles or comment timestamps to open their GitHub page in your browser.
GitHub feeds require an installed, authenticated `gh` CLI (`gh auth login`).
Use **Refresh** for new activity and **Load more** for older discussions.

The default transcript is concise: your messages, Copilot's responses and readable
command/tool summaries with their running/completed/failed status. Errors remain
visible. Use the checkboxes to add **Reasoning**, **Output** or **Session / events
(JSON)**, or hide **Messages** and **Commands / tools**, without stopping execution
or deleting history. Streaming tool-input fragments are grouped as technical events,
not shown as individual commands. Raw metadata and timestamps are hidden until
**Session / events (JSON)** is checked; expand **Event details** to inspect metadata.
HTTP/HTTPS links, including plain URLs in tool output, open in your browser.

Click **Export session JSON** beside **Message to Copilot** to save a snapshot
without running a model. The JSON starts with the repository's current HEAD
commit and ends with the submitted PR's diff, if the current branch has a PR.
Otherwise, it contains the staged and unstaged changes to tracked files against
HEAD (not untracked files). Repositories with remotes require an authenticated
`gh` CLI for PR lookup.
All recorded messages, including hidden events and attachments, the unsent
draft, known models and any annotation are included. Referenced GitHub issues
and PRs are resolved during export. Review the export for sensitive information
before sharing it.

The **Dataset** tab lists recorded current and archived sessions across
repositories, including parallel and local sessions. Annotate any session as
success, failure or abandon (the latter two require a reason), and export it
from the table. Model information from older recordings may be unavailable.

After work finishes, **PostMortem** in the selected repository's context menu
can still generate an evidence-linked report using separate tool-free model
requests and your normal Copilot allowance.

Right-click a repository (or press Shift+F10) to manage its sessions:

- **Open Copilot session** starts or resumes Copilot explicitly.
  **Resume session...** picks an existing local Copilot session of the
  repository, including ones started from the Copilot CLI, and resumes it.
- **Close session** stops Copilot but keeps its history and resumable context.
- **New session** archives the previous conversation and opens a fresh one.
- **PostMortem** analyses the selected repository's completed conversation.
- **Delete latest session** deletes the latest conversation and restores the
  previous saved one without starting Copilot.
- **Delete all sessions for this repository** deletes only this repository's
  conversations managed by Arranged Agents, never other repositories' sessions.

Deletion requires a quiet inline confirmation and removes both application history
and the corresponding Copilot sessions through the official SDK API. Repository
files are not deleted. If deletion fails, remaining histories are retained and
the error is displayed. Old saved histories remain compatible.

Copilot can inspect the selected repository, use its instructions and run tools
such as Git or `gh` for pull requests. Permission requests appear directly in
the conversation panel with **Allow once** and **Reject**, without modal popups,
notification sounds or automatic approval. Each request identifies its repository,
including background sessions, and remains visible regardless of display filters.
Approvals show readable descriptions, full commands, paths and proposed changes
rather than JSON. Copilot's questions appear as inline choice buttons and, when
allowed, a free-text answer box. Enter submits; Shift+Enter adds a line.
Cancelling or closing rejects pending requests and questions.
GitHub operations use the CLI's existing authentication.

Equations use `$x^2$` inline or `$$E=mc^2$$` on their own line. KaTeX renders
native MathML without loading external fonts or scripts.

Click **Settings** at the top right to show the settings panel, which chooses
the Copilot model, the local model and the local device, and links to the Arranged Agents settings page in
VS Code. `arrangedAgents.requestTimeoutMinutes` defaults to **60 minutes** and
limits total operation time, including tools and permission waits. Changes apply
to subsequent operations, even in existing sessions.

If VS Code cannot find `copilot`, set `arrangedAgents.cliPath` to its absolute
executable path. The Copilot model is chosen in the **Settings** panel; it
switches open sessions from their next message and applies to future sessions.
In Remote SSH, WSL, or a dev container, the CLI must be installed and authenticated
on the machine hosting the workspace extension.

## Documentation and automation

Sphinx documentation: [getting started](docs/getting_started.rst),
[features and safeguards](docs/features.rst), [source guide](docs/design.rst),
and [development, coverage, releases and documentation build](docs/development.rst).

## Development

```bash
npm ci
npm run check
npm run package
```

`check` runs formatting, lint, compilation and unit tests without model requests.
Use `npm run coverage` for coverage reports. Install the generated `.vsix` with
VS Code's **Extensions: Install from VSIX** command.

`npm run smoke` tests the real CLI and session resume; it requires an authenticated
Copilot CLI and uses your allowance. Automated tests do not replace interactive
VS Code checks.

See the [development guide](docs/development.rst) for activation and manual
validation, documentation builds, screenshots, CI and release instructions.

## Scope and safeguards

- Repository discovery is one level deep, without following directory symlinks.
- Each clicked repository gets a separate CLI client/session and working directory.
  Switching tabs or repositories does not merge their conversation histories.
- No automatic workspace attachments or editor selections. Copilot can read
  repository files and send relevant context through its normal tools.
- Built-in agent tools, configuration/instruction discovery, skills and host Git
  context are enabled. Requested tool permissions require explicit confirmation;
  no blanket approval is granted. Repository file hooks and cross-session store
  integration remain disabled.
- Only the application's own nonce-authorized script runs. Model HTML is escaped,
  images are blocked and math cannot load external resources. Only HTTP/HTTPS
  links can open externally; executable and local-file URL schemes are blocked.
- The two-minute deadline applies to session startup and each response.
  **Cancel** stops that repository's session without affecting other repositories;
  click **Open Copilot session** to start a fresh session. Earlier messages remain visible but
  are not replayed to the new session.
- Workspace Trust is required. The executable path is a machine-scoped setting.
- Closing the application or deactivating the extension stops all of its CLI
  processes, including requests still starting, then flushes the saved history.
  An interrupted-operation notice is retained. Resuming does not automatically
  continue pending commands or permission requests.
- Local application history is not encrypted or synced. Do not rely on it as a
  backup; simultaneous windows using the same parent share one snapshot, with
  the last saved window taking precedence.
- The SDK uses the installed CLI, not an embedded Copilot runtime. Normal CLI
  session persistence and service-side data policies still apply.

The SDK version is matched to Copilot CLI 1.0.104. Older CLI versions may require
an update. Transitive dependency overrides avoid known advisories in the SDK's
Zod dependency and a high-severity advisory in newer versions of the packager's
Azure authentication dependency. Keep the Azure Identity 4.13.0 override for now:
removing it selected 4.14.0 with a vulnerable MSAL Node 6.0.1
([GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5)).
Revisit this pin when upstream resolves that chain; the retained UUID advisory
([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq))
affects buffer handling in v3/v5/v6 UUID APIs. It does not affect the extension's
production dependencies.
The math plugin's KaTeX dependency is also overridden to a patched 0.19 release;
untrusted TeX commands remain disabled.

This is an unofficial project, not a GitHub product. A project license has not
yet been selected.
