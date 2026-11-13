import { randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";
import math from "@vscode/markdown-it-katex";
import { isExternalUrl } from "./links";
import type { ChatMessage } from "./application";
import { MAX_GITHUB_COMMENT_LENGTH, type GitHubDiscussion } from "./github";
import {
  IMAGE_MIME_TYPES,
  isImageDataUrl,
  isImageSource,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  type ImageAttachment,
} from "./images";

const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.use(math, {
  output: "mathml",
  trust: false,
  strict: "error",
  throwOnError: false,
  maxExpand: 1_000,
  maxSize: 20,
  enableFencedBlocks: true,
});
markdown.validateLink = (url) => isExternalUrl(url) || isImageDataUrl(url);
markdown.renderer.rules.link_open = (
  tokens,
  index,
  options,
  _env,
  renderer,
) => {
  const token = tokens[index];
  if (token && !isExternalUrl(token.attrGet("href") ?? "")) {
    token.attrs = token.attrs?.filter(([name]) => name !== "href") ?? null;
  }
  token?.attrSet("target", "_blank");
  token?.attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
function renderImage(src: string, alt: string, title?: string | null): string {
  const escape = markdown.utils.escapeHtml;
  if (!isImageSource(src)) return escape(alt);
  return `<img src="${escape(src)}" alt="${escape(alt)}"${title ? ` title="${escape(title)}"` : ""} loading="lazy" referrerpolicy="no-referrer">`;
}

markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  return renderImage(
    token?.attrGet("src") ?? "",
    token?.content ?? "",
    token?.attrGet("title"),
  );
};

export function renderMarkdown(content: string): string {
  return markdown.render(content);
}

export function renderGitHubComment(
  comment: GitHubDiscussion["comments"][number],
): string {
  const escape = markdown.utils.escapeHtml;
  return `<article class="github-discussion-comment" data-comment-id="${escape(comment.id)}">
    <p>${escape(comment.author)} - <time datetime="${escape(comment.date)}">${escape(comment.date)}</time></p>
    ${renderMarkdown(comment.body)}
    <a href="${escape(comment.url)}" target="_blank" rel="noopener noreferrer">Open comment on GitHub</a>
  </article>`;
}

export function renderGitHubDiscussion(discussion: GitHubDiscussion): string {
  const escape = markdown.utils.escapeHtml;
  const metadata = (entry: { author: string; date: string }): string =>
    `<p>${escape(entry.author)} - <time datetime="${escape(entry.date)}">${escape(entry.date)}</time></p>`;
  return `<article>
    <h1>${escape(discussion.title)}</h1>
    <p>${discussion.kind === "PullRequest" ? "Pull request" : "Issue"} - ${escape(discussion.state)}</p>
    ${metadata(discussion)}
    ${renderMarkdown(discussion.body)}
  </article>
  <h2 class="github-discussion-comments-heading">Comments (${discussion.comments.length})</h2>
  ${discussion.comments.map(renderGitHubComment).join("")}`;
}

export function renderText(content: string): string {
  const escape = markdown.utils.escapeHtml;
  let html = "";
  let offset = 0;
  for (const match of markdown.linkify.match(content) ?? []) {
    html += escape(content.slice(offset, match.index));
    html += isExternalUrl(match.url)
      ? `<a href="${escape(match.url)}" target="_blank" rel="noopener noreferrer">${escape(match.text)}</a>`
      : escape(match.text);
    offset = match.lastIndex;
  }
  return html + escape(content.slice(offset));
}

export class ConversationRenderer {
  private activeId?: string;
  private cached: {
    role: ChatMessage["role"];
    content: string;
    images: ImageAttachment[];
    html: string;
  }[] = [];

  render(
    activeId: string | undefined,
    messages: readonly ChatMessage[],
  ): (ChatMessage & { html: string })[] {
    if (this.activeId !== activeId) {
      this.cached = [];
      this.activeId = activeId;
    }
    const rendered = messages.map((message, index) => {
      const images = message.images ?? [];
      let cached = this.cached[index];
      if (
        !cached ||
        cached.role !== message.role ||
        cached.content !== message.content ||
        cached.images.length !== images.length ||
        cached.images.some(
          (image, index) =>
            image.name !== images[index]?.name ||
            image.dataUrl !== images[index]?.dataUrl,
        )
      ) {
        cached = {
          role: message.role,
          content: message.content,
          images: images.map((image) => ({ ...image })),
          html:
            (message.role === "assistant" || message.role === "reasoning"
              ? renderMarkdown(message.content)
              : renderText(message.content)) +
            (message.images ?? [])
              .slice(0, MAX_IMAGES)
              .map((image) =>
                isImageDataUrl(image.dataUrl)
                  ? renderImage(image.dataUrl, image.name)
                  : "",
              )
              .join(""),
        };
        this.cached[index] = cached;
      }
      return { ...message, html: cached.html };
    });
    this.cached.length = messages.length;
    return rendered;
  }
}

export function renderApplication(resources: {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}): string {
  const nonce = randomUUID();
  const escape = markdown.utils.escapeHtml;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; script-src 'nonce-${nonce}'; style-src ${escape(resources.cspSource)}; base-uri 'none'; form-action 'none';">
<title>DevDash Agents</title>
<link rel="stylesheet" href="${escape(resources.styleUri)}">
</head>
<body>
<main class="application">
  <section id="chat-panel" aria-label="Copilot conversation">
    <section id="github-discussion" aria-label="GitHub issue or pull request" hidden>
      <div class="github-toolbar">
        <button id="github-discussion-back" type="button">Back to conversation</button>
        <button id="github-discussion-refresh" type="button">Refresh</button>
        <button id="github-discussion-external" type="button" aria-label="Open on GitHub" title="Open on GitHub in browser">&#8599;</button>
      </div>
      <p id="github-discussion-status" role="status" tabindex="-1"></p>
      <p id="github-discussion-error" role="alert" hidden></p>
      <div id="github-discussion-content"></div>
      <form id="github-comment-form" hidden>
        <label for="github-comment-body">Comment on this issue or PR</label>
        <textarea id="github-comment-body" rows="3" maxlength="${MAX_GITHUB_COMMENT_LENGTH}" placeholder="Write a Markdown comment..."></textarea>
        <p>Published with your authenticated GitHub CLI account. Nothing is sent to Copilot. Enter adds a newline.</p>
        <p id="github-comment-status" role="status"></p>
        <p id="github-comment-error" role="alert" hidden></p>
        <button id="github-comment-submit" type="submit" disabled>Publish on GitHub</button>
      </form>
    </section>
    <header class="chat-header">
      <div class="chat-heading">
        <h2 id="active-repository">Select a repository on the right</h2>
        <label id="session-selection">Session <select id="session-picker" disabled aria-label="Open session"></select></label>
        <button id="add-session" type="button" disabled title="Add an independent Copilot or local session">Add</button>
        <button id="new-session" type="button" disabled title="Close and replace the selected session with a fresh session of the same type">New</button>
        <button id="close-session" type="button" disabled title="Close the selected session">Close</button>
        <button id="resume-session" type="button" disabled title="Resume a saved Copilot session from this repository">Resume</button>
      </div>
      <div class="chat-tools">
      <fieldset id="information-filters" aria-label="Show information">
        <label><input type="checkbox" value="messages" checked> Messages</label>
        <label><input type="checkbox" value="tools" checked> Commands / tools</label>
        <label><input type="checkbox" value="reasoning"> Reasoning</label>
        <label><input type="checkbox" value="output"> Output</label>
        <label><input type="checkbox" value="system"> Session / events (JSON)</label>
      </fieldset>
      <button id="github-discussion-show" type="button" aria-controls="github-discussion" hidden>Show issue / PR</button>
      <nav id="prompt-navigation" aria-label="Prompt navigation">
        <button id="previous-prompt" type="button" title="Scroll to the previous prompt" disabled>&#8593; Prompt</button>
        <button id="next-prompt" type="button" title="Scroll to the next prompt" disabled>&#8595; Prompt</button>
      </nav>
      </div>
    </header>
    <div id="messages" role="log" aria-label="Conversation" aria-live="polite"></div>
    <section id="postmortem-report" aria-label="Conversation PostMortem" hidden>
      <div class="postmortem-toolbar">
        <h2>PostMortem</h2>
        <button id="export-postmortem" type="button" disabled>Export JSON</button>
      </div>
      <p id="postmortem-status" role="status"></p>
      <p id="postmortem-error" role="alert" hidden></p>
      <div id="postmortem-table"></div>
    </section>
    <div id="interactions">
      <section id="permissions" aria-label="Tool permissions" hidden></section>
      <section id="questions" aria-label="Questions from Copilot" hidden></section>
    </div>
    <p id="error" role="alert" hidden></p>
    <form id="composer">
      <div class="composer-heading">
        <label id="question-label" for="question">Message to Copilot</label>
        <button id="export-session" type="button" disabled title="Export this session and its repository diff as JSON">Export session JSON</button>
        <p class="session-activity" role="status"><span id="activity-icon" class="spinner" aria-hidden="true" hidden></span><span id="session-status">No Copilot session has started.</span><small id="session-tokens" hidden></small></p>
        <p id="composer-info"><span id="session-model" hidden></span><span id="system-memory" hidden></span></p>
      </div>
      <textarea id="question" rows="4" maxlength="20000" placeholder="Select a repository to begin." disabled></textarea>
      <div id="image-previews" aria-label="Attached images" data-mime-types="${IMAGE_MIME_TYPES.join(",")}" data-max-count="${MAX_IMAGES}" data-max-bytes="${MAX_IMAGE_BYTES}"></div>
      <div class="composer-actions">
        <span>Enter to send; Shift+Enter for a new line. Math: $x^2$ or $$E=mc^2$$</span>
        <section id="execution-timing" aria-label="Step timing" hidden></section>
        <button id="cancel" type="button" disabled>Cancel</button>
        <button id="parallel" type="button" aria-pressed="true" title="ON: send independently while work continues (actions allowed). OFF: wait until current work finishes. Parallel actions share the same files.">Parallel ON</button>
        <button id="send" type="submit" disabled>Send</button>
      </div>
    </form>
  </section>
  <div id="right-divider" class="divider" role="separator" aria-label="Resize right panel" aria-orientation="vertical" aria-controls="chat-panel repository-panel" tabindex="0"></div>
  <aside id="repository-panel" aria-label="Repositories, activity and logs">
    <nav id="right-tabs" aria-label="Right panel views">
      <button type="button" data-view="repositories" aria-pressed="true" aria-controls="repository-view">Repositories</button>
      <button type="button" data-view="activity" aria-pressed="false" aria-controls="activity-view">Github</button>
      <button type="button" data-view="trace" aria-pressed="false" aria-controls="trace-view" title="Latest event, reasoning, commands and outputs of the displayed session">Trace</button>
      <button type="button" data-view="sessions" aria-pressed="false" aria-controls="sessions-view">Sessions</button>
      <button type="button" data-view="dataset" aria-pressed="false" aria-controls="dataset-view">Dataset</button>
      <button type="button" data-view="logs" aria-pressed="false" aria-controls="log-view">Log</button>
      <button type="button" data-view="settings" aria-pressed="false" aria-controls="settings-view">Settings</button>
    </nav>
    <div id="repository-view">
    <header><h2>Repositories</h2><button id="refresh" type="button">Refresh</button></header>
    <p id="root"></p>
    <div id="repositories">
      <section class="repository-group" aria-labelledby="started-repositories-title">
        <h3 id="started-repositories-title">Active sessions</h3>
        <div id="started-repositories"></div>
      </section>
      <section class="repository-group" aria-labelledby="other-repositories-title">
        <h3 id="other-repositories-title">Other repositories</h3>
        <div id="other-repositories"></div>
      </section>
    </div>
    <p class="repository-hint">Only direct child directories containing .git are listed. Select one, then click Open Copilot session to start or resume Copilot.</p>
    </div>
    <section id="sessions-view" aria-label="Local model sessions" hidden>
      <h2>Sessions</h2>
      <p class="repository-hint">Local models are shared across repositories. Each session has a separate KV cache. KV size is an estimate; runtime allocator overhead may be higher.</p>
      <div id="local-models"><p>No local model is loaded.</p></div>
    </section>
    <section id="dataset-view" aria-label="Session dataset" hidden>
      <header><h2>Session dataset</h2><button id="dataset-refresh" type="button">Refresh</button></header>
      <p class="repository-hint">All recorded sessions, including archived and parallel sessions. Annotate sessions you want to use as training examples, then export them as JSON.</p>
      <p id="dataset-error" role="alert" hidden></p>
      <div class="dataset-table-container">
        <table id="dataset-table">
          <thead><tr>${["Repository", "Session", "Models", "Issue / PR references", "Annotation"].map((label) => `<th scope="col" aria-sort="none"><button type="button">${label}</button></th>`).join("")}<th scope="col">Actions</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="dataset-empty" hidden>No recorded sessions.</p>
      <form id="dataset-annotation" hidden>
        <h3 id="dataset-annotation-title">Annotate session</h3>
        <label for="dataset-mark">Mark</label>
        <select id="dataset-mark" required>
          <option value="">Choose a mark</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="abandon">Abandon</option>
        </select>
        <label for="dataset-reason">Reason (required for failure or abandon)</label>
        <textarea id="dataset-reason" maxlength="20000" rows="3"></textarea>
        <label for="dataset-comments">Comments</label>
        <textarea id="dataset-comments" maxlength="20000" rows="3"></textarea>
        <div class="settings-row">
          <button id="dataset-save" type="submit">Save annotation</button>
          <button id="dataset-remove" type="button" hidden>Remove annotation</button>
          <button id="dataset-cancel" type="button">Cancel</button>
        </div>
      </form>
    </section>
    <section id="activity-view" aria-label="Repository activity" hidden>
      <nav id="github-tabs" aria-label="Repository activity views">
        <button type="button" data-section="issues" aria-pressed="true">Issues</button>
        <button type="button" data-section="reviews" aria-pressed="false">Reviews</button>
        <button type="button" data-section="oldest-prs" aria-pressed="false" title="The 10 oldest open pull requests by creation date">Oldest PRs</button>
        <button type="button" data-section="commits" aria-pressed="false">Commits</button>
        <button type="button" data-section="comments" aria-pressed="false">Comments</button>
        <button type="button" data-section="mentions" aria-pressed="false" title="Direct mentions you have not answered">Mentions</button>
      </nav>
      <div class="github-toolbar">
        <h2 id="github-heading">Issues</h2>
        <button id="github-refresh" type="button" disabled>Refresh</button>
      </div>
      <p id="github-status" role="status">Select a repository to view its activity.</p>
      <p id="github-notice" class="repository-hint" hidden></p>
      <p id="github-error" role="alert" hidden></p>
      <div id="github-items"></div>
      <button id="github-more" type="button" hidden>Load more</button>
    </section>
    <section id="trace-view" aria-label="Session trace" hidden>
      <h2>Trace</h2>
      <p class="repository-hint">Latest event, reasoning, commands and outputs of the displayed session. Newest commands first.</p>
      <details class="trace-section" open><summary><h3>Latest event</h3></summary><div id="trace-event"></div></details>
      <details class="trace-section" open><summary><h3>Latest reasoning</h3></summary><div id="trace-reasoning"></div></details>
      <details class="trace-section" open><summary><h3>Latest commands</h3></summary><div id="trace-commands"></div></details>
    </section>
    <section id="log-view" aria-label="Application logs" hidden>
      <h2>Log</h2>
      <p class="repository-hint">Model and session events across repositories. Last 200 events; cleared when the application closes.</p>
      <div id="application-logs" role="log" aria-live="polite"></div>
    </section>
    <section id="settings-view" aria-label="Settings" hidden>
      <h2>Settings</h2>
      <section class="settings-group" aria-labelledby="machines-title">
        <h3 id="machines-title">Machines</h3>
        <p class="repository-hint">One local machine and any number of remote entries. Different identifiers may connect to the same host. Paths belong to that machine; remote hosts require a POSIX shell and standard GNU utilities.</p>
        <label for="machine-entry">Edit machine</label>
        <select id="machine-entry"><option value="">Add a remote machine</option></select>
        <form id="machine-configuration">
          <label for="machine-id">Identifier (stable, unique)</label><input id="machine-id" required pattern="[A-Za-z0-9_-]{1,100}" maxlength="100">
          <label for="machine-name">Display name</label><input id="machine-name" required maxlength="100">
          <label for="machine-command">Connection command (empty for local)</label><input id="machine-command" maxlength="4096" placeholder="ssh user@host">
          <label for="machine-repositories">Repositories directory</label><input id="machine-repositories" required maxlength="4096">
          <label for="machine-models">Models storage directory</label><input id="machine-models" required maxlength="4096">
          <label for="machine-worker">Native worker executable</label><input id="machine-worker" required maxlength="4096" value="devdash-genai-worker">
          <label for="machine-copilot">Copilot CLI executable</label><input id="machine-copilot" required maxlength="4096" value="copilot">
          <button type="submit">Save machine</button><button id="delete-machine" type="button" disabled>Delete machine</button>
        </form>
      </section>
      <section class="settings-group" aria-labelledby="workers-title">
        <h3 id="workers-title">Workers</h3>
        <p class="repository-hint">Each worker has exactly one model. Add a session to choose its worker and execution machine independently. Copilot runs on its execution machine. Existing sessions keep their saved assignment when Settings change.</p>
        <label for="worker-entry">Edit worker</label><select id="worker-entry"><option value="">Add a worker</option></select>
        <form id="worker-configuration">
          <label for="worker-id">Identifier (stable, unique)</label><input id="worker-id" required pattern="[A-Za-z0-9_-]{1,100}" maxlength="100">
          <label for="worker-name">Display name</label><input id="worker-name" required maxlength="100">
          <label for="worker-machine">Worker machine</label><select id="worker-machine"></select>
          <label for="worker-kind">Model source</label>
          <select id="worker-kind">
            <option value="copilot">Copilot model ID (empty = CLI default)</option>
            <option value="file">ONNX/GenAI file or directory</option>
            <option value="checkpoint">Transformers checkpoint file or directory</option>
            <option value="model-id">Hugging Face model ID</option>
            <option value="foundry">Foundry catalogue model ID</option>
          </select>
          <label for="worker-source">Path or model ID</label><input id="worker-source" maxlength="4096" list="worker-model-suggestions">
          <datalist id="worker-model-suggestions"></datalist>
          <label for="worker-provider">Device</label><select id="worker-provider"><option value="cpu">CPU</option><option value="cuda">CUDA</option></select>
          <label for="worker-device">Device index</label><input id="worker-device" type="number" min="0" step="1" value="0" required>
          <p class="repository-hint">Relative file/checkpoint paths use the worker machine's models directory. Files need their GenAI or Transformers configuration, weights and tokenizer alongside them; standalone ONNX and GGUF are not supported. Checkpoints and model IDs are exported on the worker machine using Python model-builder dependencies. Foundry packages are downloaded then streamed to remote storage if needed.</p>
          <button type="submit">Save worker</button><button id="delete-worker" type="button" disabled>Delete worker</button>
        </form>
        <p id="execution-configuration-status" role="status"></p>
      </section>
      <form id="harness-settings" class="settings-group" aria-labelledby="harness-settings-title">
        <h3 id="harness-settings-title">Harness settings</h3>
        <label for="cli-path">Copilot CLI executable</label>
        <input id="cli-path" type="text" value="copilot" required maxlength="4096">
        <label for="local-worker-path">Local worker executable</label>
        <input id="local-worker-path" type="text" value="devdash-genai-worker" required maxlength="4096">
        <p class="repository-hint">Use trusted executables only. These paths are legacy defaults, executed directly without a shell. Configured workers use the paths saved in their machine assignment; existing sessions keep that assignment.</p>
        <label for="request-timeout-minutes">Request timeout (minutes)</label>
        <input id="request-timeout-minutes" type="number" value="60" min="1" max="35791" step="1" required>
        <p class="repository-hint">Applies to subsequent Copilot operations, including in existing sessions. Running operations keep their deadline.</p>
        <label for="approved-url-origins">Approved URL origins (one per line)</label>
        <textarea id="approved-url-origins" rows="3" placeholder="https://example.com"></textarea>
        <p class="repository-hint">These HTTP or HTTPS roots may be read without asking again across repositories. Remove a root to require approval again. GitHub file reads remain automatically approved.</p>
        <button id="save-harness-settings" type="submit">Save harness settings</button>
        <p id="harness-settings-status" role="status" aria-live="polite"></p>
      </form>
      <details><summary>Legacy defaults and Foundry catalogue browser</summary>
      <p class="repository-hint">Legacy defaults initialize machines and workers until the new configuration is first saved. Afterwards, edit machines and workers above. The catalogue browser below supplies Foundry IDs for worker model sources.</p>
      <section class="settings-group" aria-labelledby="copilot-model-title">
        <h3 id="copilot-model-title">Copilot model</h3>
        <label for="copilot-model">Model used by Copilot sessions</label>
        <div class="settings-row">
          <select id="copilot-model"><option value="">CLI default</option></select>
          <button id="refresh-copilot-models" type="button" title="List the models available through the Copilot SDK">Refresh models</button>
        </div>
        <p id="copilot-model-status" class="settings-status" role="status"></p>
        <p id="copilot-model-error" class="settings-error" role="alert" hidden></p>
        <p class="repository-hint">Changes unassigned legacy Copilot sessions only. Configured workers and their sessions keep their own model. CLI default applies to unassigned sessions opened afterwards.</p>
      </section>
      <section class="settings-group" aria-labelledby="execution-machine-title">
        <h3 id="execution-machine-title">Execution machine</h3>
        <label for="execution-machine">Machine running local models and their tools</label>
        <div class="settings-row">
          <select id="execution-machine"><option value="">This computer</option></select>
          <button id="remove-remote-machine" type="button" disabled title="Remove the selected remote machine">Remove</button>
        </div>
        <p id="execution-machine-details" class="settings-status"></p>
        <form id="remote-machine-form" aria-labelledby="remote-machine-title">
          <h4 id="remote-machine-title">Add or update a remote machine</h4>
          <label for="remote-machine-name">Name</label>
          <input id="remote-machine-name" type="text" required maxlength="100" placeholder="azure-vm">
          <label for="remote-machine-command">Connection command</label>
          <input id="remote-machine-command" type="text" required maxlength="4096" placeholder="az ssh vm --ip <ip-address> --subscription 00000000-0000-0000-0000-000000000000">
          <label for="remote-worker-path">Remote worker executable</label>
          <input id="remote-worker-path" type="text" required maxlength="4096" value="devdash-genai-worker">
          <label for="remote-model-path">Remote model directory</label>
          <input id="remote-model-path" type="text" required maxlength="4096" pattern="/.*" placeholder="/home/azureuser/models/phi-4-mini">
          <label for="remote-repositories-path">Remote repositories directory</label>
          <input id="remote-repositories-path" type="text" required maxlength="4096" pattern="/.*" placeholder="/home/azureuser/github">
          <button id="save-remote-machine" type="submit">Save and use</button>
        </form>
        <p class="repository-hint">The connection command is run without a shell, followed by <code>--</code> and the remote command; it must forward standard input and output, as <code>az ssh vm</code> and <code>ssh</code> do. Local sessions then start the worker and run their file and command tools on that machine, in the repositories directory under the local repository folder name. Copilot sessions are unchanged. Applies to local sessions opened afterwards.</p>
      </section>
      <section class="settings-group" aria-labelledby="local-model-title">
        <h3 id="local-model-title">Local model</h3>
        <p id="local-model-path" class="settings-path">No local model is selected.</p>
        <button id="choose-local-model" type="button" title="Choose a GenAI directory, a local Transformers checkpoint, or a Hugging Face model ID">Choose local model...</button>
        <p class="repository-hint">GenAI models load directly. Transformers checkpoints and model IDs require Python model-builder dependencies and are exported to ONNX GenAI INT4 before use. Automatic prepares for the runtime-selected provider; select CPU or CUDA explicitly to choose the export target. NPU requires a prebuilt, device-compatible GenAI model.</p>
        <p class="repository-hint">The selected device is used when a local model is first loaded. Move a loaded shared model between devices or unload it in the Sessions panel; changing the preference here affects future model loads.</p>
        <h4 id="foundry-title">Download from Foundry Local</h4>
        <label for="foundry-device">Model target</label>
        <div class="settings-row">
          <select id="foundry-device" aria-describedby="foundry-title">
            <option value="cpu">CPU</option>
            <option value="gpu">GPU (CUDA)</option>
            <option value="npu">NPU (QNN)</option>
          </select>
          <button id="list-foundry-models" type="button" title="List the Foundry Local models this machine can run in local sessions">List models</button>
        </div>
        <label for="foundry-model">Model variant</label>
        <select id="foundry-model" disabled><option value="">List models first</option></select>
        <p id="foundry-model-details" class="settings-status"></p>
        <div class="settings-row">
          <button id="download-foundry-model" type="button" disabled title="Download the complete package and use it as the local model">Download and use</button>
          <button id="cancel-foundry" type="button" hidden>Cancel</button>
        </div>
        <p id="foundry-status" class="settings-status" role="status"></p>
        <p id="foundry-error" class="settings-error" role="alert" hidden></p>
      </section>
      <section class="settings-group" aria-labelledby="local-device-title">
        <h3 id="local-device-title">Local session device</h3>
        <label for="local-device">Device used by local models</label>
        <div class="settings-row">
          <select id="local-device"><option value="auto:-1">Automatic (prefer CUDA)</option></select>
          <button id="detect-local-devices" type="button" title="List the CPUs and GPUs available to the local model engine">Detect devices</button>
        </div>
        <p id="local-device-status" class="settings-status" role="status"></p>
        <p id="local-device-error" class="settings-error" role="alert" hidden></p>
        <p class="repository-hint">This preference is used the next time a shared model is loaded. Move a loaded model between devices or unload it in the Sessions panel.</p>
      </section>
      <button id="open-vscode-settings" type="button" title="Open all DevDash Agents settings in VS Code">All settings in VS Code...</button>
      </details>
    </section>
  </aside>
</main>
<div id="repository-menu" role="menu" aria-label="Repository session actions" hidden></div>
<script nonce="${nonce}" src="${escape(resources.scriptUri)}"></script>
</body>
</html>`;
}

export function renderResult(question: string, answer: string): string {
  const nonce = randomUUID();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<title>DevDash Agents</title>
<style nonce="${nonce}">
body { max-width: 900px; margin: 0 auto; padding: 24px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); line-height: 1.6; overflow-wrap: anywhere; }
header { border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 24px; }
pre { padding: 16px; overflow-x: auto; background: var(--vscode-textCodeBlock-background); }
code { font-family: var(--vscode-editor-font-family); }
table { border-collapse: collapse; }
th, td { padding: 8px; border: 1px solid var(--vscode-panel-border); }
blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border); margin-left: 0; padding-left: 16px; }
img { display: block; max-width: 100%; max-height: 600px; height: auto; object-fit: contain; }
</style>
</head>
<body>
<header><h1>DevDash Agents</h1><p>${markdown.utils.escapeHtml(question)}</p></header>
<main>${renderMarkdown(answer)}</main>
</body>
</html>`;
}
