Getting started
===============

Requirements
------------

* VS Code 1.105 or newer.
* Node.js 22.13 or newer and npm for development.
* An installed GitHub Copilot CLI, authenticated with ``copilot login``.
* Git and an authenticated GitHub CLI (``gh auth login``) for repository activity.
* A GitHub account with Copilot access. Model requests use your allowance.

The integration has been verified with Copilot CLI 1.0.105. The SDK was matched
to CLI 1.0.104; older versions may need an update.

Install a native VSIX
---------------------

GitHub releases provide separate VSIX assets containing the worker and compatible
ONNX Runtime GenAI/ORT shared libraries. Install one with **Extensions: Install
from VSIX...**, or ``code --install-extension /path/to/asset.vsix``:

.. list-table::
   :header-rows: 1

   * - Extension host
     - CPU asset suffix
     - CUDA asset suffix
   * - Linux x64
     - ``linux-x64-cpu.vsix``
     - ``linux-x64-cuda.vsix``
   * - Windows x64
     - ``win32-x64-cpu.vsix``
     - ``win32-x64-cuda.vsix``
   * - macOS Apple Silicon
     - ``darwin-arm64-cpu.vsix``
     - Not supported

CPU and CUDA are alternative installations of the same extension, not two
extensions to install together. Choose the extension host's OS and architecture:
WSL and Linux SSH/dev-container hosts need the Linux package even from Windows
or macOS. Packages do not require a compiler, CMake, Python or SDK downloads
when opening a local session. Model weights are not included.

Linux packages are built on Ubuntu 22.04 and require glibc 2.35+ and compatible
libstdc++; Alpine/musl is not supported. Windows requires the Microsoft Visual C++
2015-2022 x64 Redistributable. macOS packages target Apple Silicon and macOS 15+.
CUDA packages additionally require an NVIDIA GPU and compatible driver, CUDA 13
and cuDNN 9 on the extension host. These NVIDIA dependencies are not bundled.
CPU variants need no CUDA installation. Unsupported providers fail explicitly.

NPU support remains external: configure ``devdashAgents.localWorkerPath`` with
a trusted worker implementing the :doc:`native protocol <development>` and
install its vendor runtime separately. There is no bundled NPU, Intel macOS,
Linux arm64 or Windows arm64 variant with the pinned SDKs.

Launch from source
------------------

From a Bash terminal in this checkout, run:

.. code-block:: bash

   ./start.sh

The launcher installs missing project dependencies, compiles the extension,
and opens a new VS Code development window. Other installed extensions are
disabled in that window. The **Arranged Agents** editor tab opens automatically.
Without a directory argument, the source checkout's parent directory is used as
the repository parent, regardless of the terminal's current directory.
To choose a different parent directory containing your repositories:

.. code-block:: bash

   ./start.sh /path/to/repositories

Run ``./start.sh --help`` for usage and examples; it does not install dependencies
or launch VS Code. Additional VS Code options can follow the directory, for example
``./start.sh /path/to/repositories --wait``.
The source checkout is still used for compilation. Each stage is printed with
elapsed time; incremental compilation speeds up subsequent launches.
Use ``START_VERBOSE=1 ./start.sh`` to enable command tracing.
Native engine builds show verbose CMake output.
No Copilot process is started by opening the tab.
Close the development window and rerun the script after editing the code.

The launcher chooses a desktop ``code`` executable rather than the restricted
``remote-cli`` executable. In WSL, make the Windows VS Code ``bin`` directory
available on ``PATH``. If only a remote CLI is available, use VS Code's
**Run Arranged Agents** launch configuration with F5 instead.

Choose a repository and chat
----------------------------

Trust the workspace. The right panel lists only immediate subdirectories with
a ``.git`` directory or file, including Git worktrees. It does not scan recursively
or follow directory symlinks. The right panel's **Github** view shows the
selected repository's activity.

Select a repository, then click **Add** and choose **Copilot** or **Local**.
The **Session** dropdown switches between this repository's open sessions.
Selecting another repository never opens a session automatically.
**Resume** lists the repository's saved Copilot sessions,
including ones started from the Copilot CLI, and resumes the chosen one; a
session started outside Arranged Agents keeps its model context but its earlier
messages are not shown. **New** closes and archives the selected conversation and
starts a fresh one.
When **Session open - ready** appears,
enter a message in the central panel and press **Enter** or click **Send**, for example:

.. code-block:: text

   Explain AbortController in three points and give a TypeScript example.

Right-aligned on the line above the message box, the panel shows the session's model
(the Copilot model, or the local model name with its device, for example
``qwen3-0.6b-generic-cpu-dq44 (local, CPU 0)``) and the free memory in GB:
available CPU RAM and, when ``nvidia-smi`` is available, free memory on each
CUDA GPU. Memory is refreshed every 5 seconds while the panel is visible; hover
it to see the totals. A long model name is shortened with an ellipsis so the
line never wraps; hover it to see the full name.

The **Parallel ON/OFF** button beside **Send** defaults to ON. You can keep typing
and sending while an operation runs. ON starts a separate Copilot session
immediately, with up to 80,000 characters from the visible conversation as reference
context; its messages, tools and approvals have a **Parallel** label. It can run
commands and modify files with the normal permission controls. Both agents share
the working directory, so edits to the same files can conflict.

OFF queues messages for the main agent, in submission order, after both the main
request and any parallel requests finish. Queued entries are marked in the transcript.
Changing the button affects future submissions only. When nothing is running,
either mode uses the main session normally. Parallel answers are visible and saved
but are not automatically injected into the main agent's model history; file changes
remain shared. Completed parallel sessions are archived and covered by the repository's
session-deletion controls.

**Cancel**, closing the session or application, and removing the repository stop
parallel requests too. Queued messages are marked as not sent and are never replayed
automatically. A parallel failure is displayed without stopping the main request.

Use **Shift+Enter** for a new line. By default, the transcript shows messages and
concise command/tool summaries, including completion status. Errors stay visible.
Check **Reasoning**, **Output** or **Session / events (JSON)** to add details;
uncheck **Messages** or **Commands / tools** to hide them. These filters do not
change execution or delete history. Technical streaming fragments are grouped
instead of filling the conversation with individual events.
**Session / events (JSON)** also reveals timestamps and expandable **Event details**.
The **↑ Prompt** and **↓ Prompt** buttons beside the filters scroll to the
previous or next visible prompt in the conversation.

Permission requests show descriptions, full commands, paths or proposed changes,
not raw JSON. Copilot's questions have clickable choices and, when allowed, a text
answer box. Use Enter to reply or Shift+Enter for another line. Pending questions
remain visible even when transcript categories are hidden.

The center renders Markdown headings, lists, tables and code blocks as HTML.
It also renders inline ``$x^2$`` and display ``$$E=mc^2$$`` equations using native
MathML. No remote math assets are loaded. HTTP/HTTPS links, including plain URLs
in tool output, open in the external browser.

Select transcript text and use **Ctrl+C** (**Cmd+C** on macOS) to copy it.
Paste into the message or answer box with **Ctrl+V** (**Cmd+V** on macOS).
The standard right-click menu also provides copy/paste actions. Text selections
are preserved while responses stream.

Switching repositories preserves each conversation and its unfinished draft.
The first box on the right, **Active sessions**, groups open sessions and those
starting or being updated. **Other repositories** lists the rest, without duplicates.
Repositories move between boxes automatically when their session opens or closes.
Open sessions have a green-tinted background and a solid indicator in the repository
list. During startup or work, a blue tint and spinner show activity, even for
background repositories. Selection keeps its own border, independently of session
status. Closed, saved sessions are not marked as open.
**Refresh** rescans the parent directory while keeping sessions that still exist.
**Cancel** ends all running operations and discards the queue for the selected
session. **Close** above the conversation stops only the selected session while preserving
its history and draft. If it was interrupted, click **New** to
start a new one. Earlier messages are kept on screen as
reference, not replayed to the restarted session.

Closing the application tab or VS Code stops the CLI processes and saves the
histories, drafts, selected repository and session IDs. Reopening with the same
parent restores the transcript and draft without launching Copilot. Select a
repository and click **Resume** to resume its existing Copilot model context.

If a Copilot process disconnects during startup or a live request, the application
tries up to three automatic restarts, waiting 250, 500 and 1,000 milliseconds
between attempts, within the normal request timeout. Recovery notices stay visible
even when technical events are hidden. The saved SDK session is resumed rather
than replaced; partial answers remain visible, unfinished tools are marked as
interrupted, and obsolete permission/question prompts are cleared. Parallel agents
recover independently, and queued requests wait until recovery finishes.

The original request is not blindly resent. A continuation instruction asks the
agent to inspect recorded results and current repository state before continuing,
and to ask before repeating uncertain external or destructive actions. This is
not an exactly-once execution guarantee: a crash can leave an action's outcome
unknown. After repeated crashes, an explicit error and the original draft remain;
choose **Resume** to retry the saved context or choose **New**.
Authentication/model errors, missing saved sessions, timeouts and user cancellation
are not automatically retried. **Cancel**, closing the application and removing
the repository stop recovery too. There is no background polling; an idle process
disconnection is detected on the next request.

Interrupted requests remain visible with a notice and are not resent
automatically after reopening the application. Pending commands and permission
prompts are not continued on resume. If the CLI's saved session is unavailable,
an error is shown; **New** explicitly starts fresh while archiving the previous
conversation instead of replaying it to the model.

History is stored in private, unencrypted JSON files under
``~/.cache/devdash-agents/conversations/`` on the extension host, outside the
repositories.

Manage sessions with the repository menu
----------------------------------------

Right-click any repository, or focus it and press **Shift+F10**, without needing
to select it first. **Add session...** adds a Copilot or local session. **Close session**
stops only the selected session and preserves its saved history.
**New session** archives the old conversation and starts blank.

**Delete latest session** removes the newest conversation and restores the
previous saved one, if any, without launching Copilot. **Delete all sessions for
this repository** removes this repository's current and archived conversations.
Both require inline confirmation and permanently delete the corresponding
Copilot histories through the SDK, not just the visible transcript. Other
repositories, unrelated CLI sessions and Git files are untouched. A deletion
failure is displayed; remaining histories are kept so you can retry.

Export a session
----------------

Select a repository and click **Export session JSON** beside **Message to
Copilot**. The JSON starts with the local HEAD commit and includes the selected
session's recorded messages, hidden events, attachments and text draft. Its final
field is the submitted PR's diff when one exists for the current branch;
otherwise it contains staged and unstaged tracked-file changes against HEAD.
Untracked files are excluded. Export does not run Copilot, and a session can be
exported while it is still running as a snapshot. PR lookup requires an
authenticated ``gh`` CLI for repositories with remotes.

Use the **Dataset** tab to list and annotate recorded sessions, including
archived and parallel conversations, and export any row. Failure and abandon
marks require a reason. The export includes known models, annotations and
automatically resolved issue or PR references; see :doc:`features/sessions` for
the lookup and context limitations.

The export may contain sensitive data and code; review it before sharing.

Review a completed conversation
-------------------------------

For a task such as implementing a PR through its final commit, select that
repository's conversation, then right-click the repository and choose **PostMortem**
once its main, parallel and queued work has finished. The entire current conversation is analysed,
including information hidden by the transcript filters. Archived conversations
and unrelated GitHub activity are not added. A closed, saved conversation can be
analysed without resuming its main agent.

The report appears below the transcript, with one row per coherent stage such as
analysis, implementation, tests, corrections and delivery. Its columns cover the
objective, production and decisions, files/PR/commit, validations, errors and
corrections, and the numbered source records. Expand **Sources** to inspect the
original requests, answers, commands, results and technical details.
Failed or abandoned attempts are part of the analysis, not discarded.

This is a model-generated interpretation, not an independent Git or test audit.
PR references, commit hashes, file changes and validation results can only be
reported when recorded in the conversation; absent evidence must remain unknown.
No tools run during analysis and repository files are not changed. The analysis
uses your configured Copilot model and allowance. Long transcripts are processed
in bounded sequential batches without truncation; a stage spanning batches may
continue across several rows. **Cancel** cancels the analysis without discarding
the main conversation or a previous report.

**Export JSON** opens a save dialog. The version-1 JSON contains repository/session
metadata, generation time, source count and SHA-256 fingerprint, the table's
``rows``, and all analysed ``sources`` with 1-based ``index`` values. A row's
``firstMessage`` and ``lastMessage`` identify its inclusive evidence range.
The export contains full recorded text, including tool details and potentially
sensitive data; review it before sharing.

Reports are saved and archived with their conversation. If you continue chatting,
the existing report remains a snapshot and shows a notice that new exchanges are
not included. Generate it again after the new work finishes to update the table
and export. Invalid or incomplete model output is shown as an error, never as a
successful partial report. Completed analysis sessions are deleted through the SDK;
an interrupted runtime may retain its normal CLI-side session history.

Browse repository activity
--------------------------

Select **Github** in the right panel for six buttons: **Issues**,
**Reviews** (pull requests), **Oldest PRs**, **Commits**, **Comments** and
**Mentions**. It follows the selected repository.
GitHub reads do not send prompts to Copilot or consume model requests.

**Oldest PRs** shows the 10 oldest open pull requests, by creation date,
oldest first. It excludes closed and merged PRs and does not load participation
history. Use **Refresh** to update this fixed-size list; it has no **Load more**.

Issues and PRs you created have a tinted background and a **Yours** marker.
**Replied** means you commented or submitted a review. **After you** means someone
posted after your latest response in that discussion. The Comments view shows
your own comments/reviews and others' comments after your latest response,
including closed issues and PRs. Inline review replies are included; draft reviews
are not. These are timestamp-based activity flags, not read/unread tracking.
**Mentions** shows direct ``@username`` pings in descriptions, comments, submitted
reviews and inline review comments without a later comment or submitted review
from you in that discussion. Closed issues/PRs are included; your own pings and
team mentions are excluded. Search indexing may delay results. Use **Load more**
even on an empty page to check older discussions.

Click an issue/PR title to read its description and discussion comments in the
main panel without leaving the application. This view preserves the
conversation and draft; **Back to conversation** returns to the chat.
From the chat, **Show issue / PR** switches back to the open discussion without
reloading it.
Use **Refresh** to reload it or the **Open on GitHub** arrow icon for the full
page, including PR diffs and review threads. Each sidebar issue/PR has a separate
external-open icon; clicking the title always stays inside the application.
Comment author/timestamp links open their GitHub permalinks externally.
To add a regular discussion comment to an issue or PR, enter Markdown below the
discussion and click **Publish on GitHub**. It uses your authenticated ``gh``
account; Enter inserts a newline and never sends. Publication errors retain your
draft and are not retried automatically. Check GitHub before retrying an
unconfirmed publication, as it may already have succeeded on the server.
Commits shows the latest 30 commits on the current local branch; click a commit to
open it on GitHub when a GitHub remote is available. Unpushed commits may not exist
there yet.

Use the sidebar's **Refresh** to fetch new activity and **Load more** to paginate
issues, PRs or commented/reviewed discussions. Switching views uses cached results;
there is no automatic background polling. Missing authentication or API failures
appear directly in the sidebar, with Refresh available to retry.

Except for **Oldest PRs**, sidebar lists are newest-first, including after Load
more. Issues and PRs use their last update time; comment groups use their latest displayed response, with
individual comments also newest-first. Commits use their displayed author date.

Configuration and remote workspaces
-----------------------------------

Click **Settings** at the top right of the conversation to show the settings
panel, where the Copilot model, the local model and the local device are
chosen; **All settings in VS Code...**
opens the Arranged Agents settings page in VS Code. No repository session needs
to be started.
VS Code persists the selected user or workspace settings.

``devdashAgents.requestTimeoutMinutes`` sets the maximum total duration of a
Copilot operation, with a default of **60 minutes (one hour)**. It includes model
generation, tool execution, permission/question waits and crash recovery delays;
activity does not reset the deadline. The setting applies to main and parallel
agents and each PostMortem analysis request. Positive whole minutes are required.
Changes affect subsequent operations, including in sessions already open; an
operation in progress retains its original deadline. **Cancel** remains available.

Set ``devdashAgents.cliPath`` to the absolute path of your CLI if it cannot be
found on ``PATH``. This is a machine-scoped setting. Choose the Copilot model, the
local model and its device in the **Settings** panel; the CLI default model is
used until a model is chosen.

For Remote SSH, WSL and dev containers, the CLI must be installed and
authenticated on the machine running the workspace extension.

Install a VSIX
--------------

.. code-block:: bash

   npm ci
   npm run package
   code --install-extension ./devdash-agents-0.1.0.vsix

Alternatively use **Extensions: Install from VSIX** in VS Code. GitHub releases
created by the release workflow attach a VSIX; they do not publish to the
VS Code Marketplace. The project is currently ``UNLICENSED``.

For an installed VSIX, open a parent directory in VS Code and run
**Arranged Agents: Open** from the Command Palette. **Arranged Agents: Ask
Copilot** is retained as an alias. Automatic tab opening is limited to the
development launch.
