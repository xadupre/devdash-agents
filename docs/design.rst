Design
======

Request flow
------------

``src/extension.ts`` registers ``arrangedAgents.open`` and the legacy
``arrangedAgents.ask`` alias. It opens a singleton editor webview and forwards
validated messages to the application model. Development launches open the
tab automatically, without starting Copilot.

``src/repositories.ts`` discovers one level of Git directories beneath the
launch root. ``src/application.ts`` tracks per-repository Copilot and optional
local session slots, the selected view, status and independent transcripts and
drafts, merging streamed text by message/reasoning/tool identifiers while
keeping background repositories and subagents separate.
Incoming repository IDs must belong to this discovered
list; browser-provided paths cannot start arbitrary sessions.

``src/conversation.ts`` creates one lazy SDK client/session per explicitly opened repository.
It registers the event handler before session creation, enables streaming,
reuses the same session for subsequent messages, isolates repository working
directories and bounds startup/response operations. A saved SDK session ID is
resumed instead of creating a fresh session. Resume disables transcript repair
and continuation of pending work. Closing the application forces cleanup of all
clients and waits for interrupted application operations to settle.

``src/local-model-host.ts`` shares one local worker per resolved model directory.
The host serializes load, generation, cache release and placement changes while
assigning a distinct native worker session ID to each repository's local slot.
Moving a model between devices or to DISK stops the worker and discards every KV
cache; no model/cache content is persisted. Reopening loads only after an
explicit user action.

While work is running, Parallel ON creates an independent client/session using
the same repository configuration and normal permission controls. A bounded,
80,000-character snapshot of the visible transcript supplies reference context;
streamed events use a separate event map and a visible request label. Permissions
and user-input requests are scoped to their owning operation, so one completion
cannot dismiss another request's controls. The main and parallel agents share
files and can therefore produce conflicting edits.

Parallel OFF appends to a repository-local FIFO queue. The queue drains through
the main session only after both main and parallel work settle, without blocking
other repositories. Cancellation, removal, session management and shutdown reject
queued messages and stop parallel work. Parallel errors do not fail the main
session. Parallel histories and SDK IDs are archived for normal persistence and
deletion; queues are not resumed automatically.

Streaming transcript notifications are coalesced into 30 ms updates before
copying state to the webview. Lifecycle, draft, permission and question updates
publish immediately and flush pending streaming updates. The host caches rendered
HTML for unchanged message content and roles. The webview retains unchanged
message cards and repository controls instead of rebuilding them for each token;
changed messages keep expanded evidence, and session changes reset the DOM cache.

``src/storage.ts`` validates versioned snapshots and writes them atomically to
private, per-parent JSON files in ``~/.cache/arranged-agents/conversations/``.
The extension saves periodically and flushes on tab disposal/deactivation.
Snapshots contain transcripts, per-view drafts, active repository/view and SDK
session IDs, not browser-rendered HTML or local model/cache data. Only discovered
repositories can resume; loading history never spawns a CLI or local worker.

``src/postmortem.ts`` analyses a stable snapshot of the full selected conversation.
Messages, including technical details, are split into numbered fragments and packed
into sequential batches of at most 48,000 serialized characters. Separate tool-free
model requests use a JSON response schema; host validation requires an ordered,
complete partition of every input fragment. Valid leading rows of an incomplete
answer are kept and only the uncovered fragments are requested again; three
consecutive answers without valid coverage fail the analysis. Rows reference original message ranges
and retain objectives, production, artifacts, validation and errors. The model's
interpretation is not an independent verification of those artifacts.

PostMortem operations have their own cancellation controller, block mutation of the
selected snapshot and leave the main SDK session intact. Reports are optional fields
on the existing version-1 saved conversation, including archives. Raw sources are
not duplicated in storage: a canonical SHA-256 fingerprint and source count identify
the analysed prefix. JSON export validates this fingerprint and includes the full
source records. UI source blocks are expanded lazily; unchanged reports are not
rebuilt on conversation-stream updates. Analysis creates no background polling.

``src/session-export.ts`` serializes a snapshot of the selected conversation
without a model request. Its first field is local HEAD, and its final field is
the current branch's submitted PR diff from ``gh``, or the tracked working-tree
diff against HEAD when no PR exists. PR metadata records its head and base, and
the export fails if either changes while its diff is being fetched.

``src/github.ts`` reads activity using ``gh`` from the selected repository's cwd
and reads local commits using ``git``. GraphQL pages fetch recent discussions,
then exhaust comment/review connections to compute accurate viewer flags;
four discussions are processed concurrently. Comments merges commenter and
reviewer searches, including closed discussions, and filters external comments
against the viewer's latest response. Commands have bounded output, cancellation
and deadlines, run without a shell or interactive authentication, and abort sibling
work on failure.

``src/github-panel.ts`` isolates asynchronous sidebar requests from Copilot,
cancels superseded/removed work and drains requests on closure. Responses carry
repository and section IDs; the browser caches them independently, rejects stale
display routing and does not rebuild the sidebar for every chat-stream delta.
The host validates repository IDs and opens HTTP/HTTPS links through VS Code.
GitHub feed data is not persisted in conversation snapshots.

Repository context-menu actions serialize lifecycle changes per repository,
settle interrupted operations and preserve closed session IDs. New sessions
archive the prior transcript, draft and SDK ID in the same versioned snapshot;
older snapshots without archives remain valid. Deletion stops the live client
first and uses ``getSessionMetadata`` / ``deleteSession`` on a temporary SDK
client for only this repository's recorded IDs. Local records are removed after
successful SDK deletion; partial failures retain remaining records. Deleting the
latest session restores the previous archive lazily. Session-management actions
also flush the snapshot, and conversation generations invalidate browser draft caches.
Local and Copilot histories are archived independently; transferring a transcript
copies a bounded excerpt into the other slot's draft and never submits it.

``src/prompt.ts`` validates size limits and builds the prompt without attaching
files or adding workspace context.

``src/copilot.ts`` shares executable resolution, client construction and
repository-aware agent settings. It preserves native system instructions and
enables tools and repository discovery. The extension confirms requested
permissions through inline webview controls without modal dialogs or notifications.
``AgentApplication`` owns pending decisions, routes them by unique request ID and
rejects them on cancellation, failure, repository removal or closure. Decisions are
not persisted or automatically replayed. The SDK's user-input handler follows the
same lifecycle for inline choices and typed answers. ``src/presentation.ts``
formats tool and permission descriptions without exposing JSON by default.
The original one-shot helper is retained; the application
and CLI smoke test use the persistent conversation implementation.

``src/images.ts`` validates bounded raster image attachments, which are sent as
SDK blobs and retained in saved messages. Structured tool-result images are
shown alongside escaped output text. ``src/render.ts`` escapes HTML, permits
HTTPS and validated embedded raster images under the webview CSP, and renders equations
using KaTeX's MathML output. ``src/webview.ts`` is the type-checked browser script;
it updates the two panels and activity indicators, handles the accessible panel
divider, keyboard submission and category filters, keeps drafts and posts commands
to the extension. HTTP/HTTPS links are detected in Markdown and escaped plain
tool output; ``src/links.ts`` shares URL validation between rendering and the
extension's external-browser message handler.
Legacy module detection keeps this script free of CommonJS ``exports`` at runtime.
``media/app.css`` defines the two-panel layout.

Validation entry points
-----------------------

* ``test/prompt.test.ts`` checks question limits and approved-selection handling.
* ``test/render.test.ts`` checks Markdown, MathML, safe links and escaped tool output.
* ``test/repositories.test.ts`` checks direct-child discovery and Git worktrees.
* ``test/application.test.ts`` exercises the real SDK/CLI fixture through the
  application model, including live events, lazy startup, session reuse, navigation and cleanup.
  It also checks disk-backed close/reopen, SDK context resumption and missing-session recovery.
  Repository-menu cases cover archived histories, SDK deletion, repository isolation,
  partial deletion failure/retry and shutdown during management.
* ``test/storage.test.ts`` checks private atomic saves, root isolation,
  corrupt snapshots and write-error recovery using the real filesystem.
* ``test/github.test.ts`` checks pagination, viewer flags, review/inline comment
  handling, cancellation, failures and real local Git commit/link extraction.
* ``test/webview.test.ts`` runs the compiled UI in a real DOM implementation,
  checking panel resizing, activity, Enter/Shift+Enter, links, category filters,
  equations, saved drafts and repository-specific errors.
  It also checks keyboard/context menus, inline deletion confirmation and draft resets.
* ``test/copilot.test.ts`` runs the real SDK against
  ``test/fixtures/copilot.ts``, a local stdio protocol fixture. It checks startup,
  permission callbacks, failure propagation, deadlines, cancellation and child-process termination.
* ``scripts/smoke.ts`` sends three real model requests from a temporary Git
  repository, including reading a unique marker file through the CLI's tools.
  It also checks that tool execution/result events arrive, then stops the CLI,
  resumes the same session and verifies earlier context without rereading the file.
  Finally it stops the session and deletes its own temporary history through the SDK.
  It requires the user's authenticated CLI.
* ``scripts/extension-host-smoke.ts`` checks activation, commands and an open app tab
  in a real VS Code extension host when launched through the dedicated F5 config.

The runtime SDK and Markdown renderer are production dependencies. TypeScript,
formatting, linting, coverage and VSIX packaging are development tools.
