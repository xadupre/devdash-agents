Settings
========

Select **Settings** at the top right of the conversation, or the **Settings**
tab of the right panel, to show the settings panel. A repository session does
not need to be running. **All settings in VS Code...** opens the complete
DevDash Agents settings page in VS Code. The panel is the only place in the
application where machines, workers, models and devices are configured.

Machines and single-model workers
---------------------------------

**Machines** and **Workers** are saved together in
``devdashAgents.execution``. The first save initializes this configuration from
the legacy defaults; those defaults remain available in the collapsible
**Legacy defaults and Foundry catalogue browser** section.

Keep exactly one machine with identifier ``local`` and an empty connection
command. The form initially edits that machine; select **Add a remote machine**
to configure another one. Every machine defines its absolute **Repositories
directory** and **Models storage directory**, plus its native worker and Copilot
CLI executables.
Other entries use a noninteractive connection command such as ``ssh user@host``
or ``az ssh vm ...`` accepting ``--`` followed by a quoted remote command.
Remote hosts require a POSIX shell and GNU utilities; local hosts also support
Windows. Machine identifiers must be unique, but multiple entries may connect
to the same physical host and use different directories.

Save operations finish one at a time; the form reports success or any error
next to the machine or worker settings.

Each worker chooses one machine, exactly one model source, and **CPU** or
**CUDA** with a device index. Model sources are:

* **Copilot model ID**: uses the authenticated Copilot CLI on that machine.
* **ONNX/GenAI file or directory**: files must have their complete GenAI
  configuration, weights and tokenizer in the same model directory.
* **Transformers checkpoint file or directory**: must have ``config.json``,
  weights and tokenizer alongside it.
* **Hugging Face model ID**: downloads and exports a supported checkpoint.
* **Foundry catalogue model ID**: downloads the complete GenAI package. The
  catalogue browser below supplies IDs; its capacity filtering describes the
  extension host, not a remote worker.

Relative file/checkpoint paths are resolved under the worker machine's models
directory. GenAI models load directly; checkpoint and Hub exports use the
model builder installed on the worker machine, targeting its selected provider.
Exports and downloads are kept in that machine's models storage. For remote
Foundry workers the package is staged on the extension host, then streamed to
remote storage using ``tar`` without buffering the model in memory. An isolated
ONNX weights file without configuration, and GGUF models, are not supported.

**Add** in the session toolbar selects a worker, then the machine on which
repository files and commands execute. A native inference worker may run on
another machine. Copilot CLI must run directly on the selected execution
machine, where it must already be installed and authenticated. Repositories
must already exist at ``<repositories directory>/<repository folder name>``;
the application does not clone or synchronize them.

Each session saves a snapshot of its worker and machines, also for parallel
requests, history exports and reopening. Editing or deleting a configuration
entry cannot silently redirect existing sessions or switch their model.
Snapshots include connection commands in unencrypted history; do not embed
credentials in these commands.
**New** preserves the assignment; **Add** chooses another worker or machine.
Sessions assigned to the same worker share its loaded model with separate KV
caches; distinct worker identifiers use separate native processes, even when
their model and physical machine are identical.

Harness settings
----------------

The **Harness settings** form exposes the usual runtime settings for Copilot
and local sessions: **Copilot CLI executable** (``devdashAgents.cliPath``),
**Local worker executable** (``devdashAgents.localWorkerPath``), **Request
timeout (minutes)** (``devdashAgents.requestTimeoutMinutes``), and **Approved
URL origins** (``devdashAgents.approvedUrlOrigins``). Click **Save harness
settings** to persist them in the usual VS Code configuration; changes made in
VS Code also appear in the panel.

Executable paths here are legacy defaults; configured workers use the executable
paths saved in their machine assignment. Use only trusted executables; neither path is
executed through a shell. The timeout must be a whole number from 1 to 35791.
URL approvals are HTTP or HTTPS origins, one per line, without paths or
credentials. They apply across repositories; remove an origin to require
approval again. HTTPS GitHub file reads remain automatically approved.

Legacy Copilot model
--------------------

**Copilot model** lists the models available through the SDK when the panel is
first shown (**Refresh models** lists them again). The choice is saved in
``devdashAgents.model`` and switches open Copilot sessions from their next
message for unassigned legacy sessions only. Assigned sessions always retain
their worker model. **CLI default** applies to sessions opened afterwards.

Local model
-----------

**Choose local model...** accepts a local ONNX Runtime GenAI directory containing
``genai_config.json``, a local Transformers checkpoint directory, or a Hugging
Face Transformers model ID such as ``Qwen/Qwen3-0.6B``. GenAI directories load
directly without Python. A checkpoint directory must contain ``config.json``,
model weights and tokenizer files, as produced by ``save_pretrained``; a lone
weights file is not sufficient.

Transformers sources are exported to ONNX GenAI INT4 using
``python3 -m onnxruntime_genai.models.builder`` (``python`` on Windows).
Install the `GenAI 0.19 model builder and its dependencies
<https://github.com/microsoft/onnxruntime-genai/tree/v0.19.0/src/python/py/models>`_
in that Python environment on the workspace extension host first. Check the
installation with ``python3 -m onnxruntime_genai.models.builder --help``.
Only architectures supported by that builder can be prepared; a usable chat
template is also required for local conversations. Use only trusted checkpoints.
Remote model code is not enabled. Hub downloads use the Python environment's
usual Hugging Face authentication. Downloaded source files and conversion
intermediates use a private temporary cache removed after preparation.

Choose **Local session device** before preparation: **CUDA** exports for CUDA,
**CPU** exports for CPU, and **Automatic** exports for the runtime-selected
provider. If Automatic selects NPU, use an already prepared, device-compatible
GenAI model, for example from Foundry Local. Exporting can require substantial
RAM, disk space and download time. A cancellable notification is shown during
preparation.

Successful exports are kept under ``models/`` in the extension's global storage.
The prepared directory is saved in ``devdashAgents.localModelPath`` and reused
without exporting again when a local model is next loaded. Cancelling or failing
preparation removes the incomplete export and leaves the previous selection
unchanged. Select the original checkpoint again to export updated weights.
Sessions using the same model directory share one loaded model and keep
separate conversation caches.

Foundry Local models
^^^^^^^^^^^^^^^^^^^^

**Download from Foundry Local** fetches a model from Microsoft's public Foundry
Local catalogue directly over HTTPS, without authentication, the Foundry SDK, CLI
or a local service. Choose a **Model target** (CPU, GPU with CUDA, or NPU with
QNN), click **List models**, select a variant and click **Download and use**.
Only text-generation variants (chat, coding, vision-language chat) built for an
execution provider the native worker supports (CPU, CUDA, QNN) are listed; the
status reports how many were left out as unsupported.

The complete package, including external weights and tokenizer files, is
downloaded into ``foundry/`` under the extension's global storage, then the
directory containing ``genai_config.json`` is saved as
``devdashAgents.localModelPath``. Complete cached packages are reused without
downloading again. Progress is shown in the panel and a cancellable
notification; **Cancel** or a failure never leaves an incomplete cache entry and
keeps the previous local model.

**Memory filtering checks capacity, not compatibility.** The catalogue's
estimated execution footprint, distinct from the download size, is compared
with local RAM (capped by process or container limits) for CPU and NPU
variants, and with the largest NVIDIA GPU's VRAM, detected through
``nvidia-smi``, for CUDA variants. Variants exceeding their limit are hidden;
missing estimates or an unavailable VRAM measurement keep a variant visible but
marked unverified. Runtime overhead and generation caches can require more
memory. The download does not change **Local session device**: choose a device
matching the variant's execution provider.

Legacy execution machine
------------------------

**Execution machine** chooses where local sessions run: **This computer** or a
remote machine. Fill **Add or update a remote machine** and click **Save and
use** to add one (or replace the machine with the same name); **Remove**
deletes the selected machine. A remote machine has:

- **Connection command**: for example
  ``az ssh vm --ip <ip-address> --subscription <subscription-id>`` or
  ``ssh azureuser@myhost``. It is split into arguments (single and double
  quotes group words) and executed without a local shell, followed by ``--``
  and the remote command quoted for the remote POSIX shell. It must forward
  standard input and output and must not prompt; for ``az ssh vm``, install the
  ``ssh`` Azure CLI extension and sign in with ``az login`` first.
- **Remote worker executable**: the native worker installed on the remote
  machine.
- **Remote model directory**: the absolute remote directory containing
  ``genai_config.json``.
- **Remote repositories directory**: the absolute remote directory containing
  the repositories. The tools of a local session use
  ``<repositories directory>/<local repository folder name>``, which must be a
  clone of the repository.

The machines are saved in ``devdashAgents.remoteMachines`` and the selection in
``devdashAgents.remoteMachine``. The selection applies to local sessions opened
afterwards; Copilot sessions are unchanged. With a remote machine, the worker,
**Detect devices**, and the ``read_file``, ``search_files``, ``edit_file`` and
``run_command`` tools all run on that machine through the connection command,
with the same approvals and repository confinement. Each tool call opens a new
connection. The remote machine needs a POSIX shell with GNU ``realpath``,
``stat``, ``du``, ``grep`` and ``sha256sum``; ``timeout`` is used to bound
commands when available. **Choose model directory...** and Foundry downloads
only configure this computer, and the free memory shown in the **Sessions**
panel is this computer's.

Local session device
--------------------

**Local session device** chooses the device used by local models. **Detect
devices** queries the installed engine (installing it first if needed) and lists
the detected CPUs and GPUs; **Automatic (prefer CUDA)** is always available.
The choice is saved in ``devdashAgents.localProvider`` and
``devdashAgents.localDeviceId``. It selects the device for the next local
model load. Move a loaded shared model between devices, or unload it to DISK,
in the **Sessions** panel; moving or unloading discards all local KV caches.

Request timeout
---------------

``devdashAgents.requestTimeoutMinutes`` sets the total deadline for a Copilot
operation and defaults to 60 minutes. The deadline includes model generation,
tool execution, permission and question waits, and crash-recovery delays.
Activity does not reset it.

The setting applies to main and parallel agents and each PostMortem analysis
request. Changes affect subsequent operations, including operations started from
an existing session. An operation already in progress retains its original
deadline. **Cancel** remains available at any time.

Copilot executable
------------------

Set ``devdashAgents.cliPath`` to the absolute Copilot CLI path when the extension
cannot find ``copilot`` on ``PATH``. This is a machine-scoped setting.

In Remote SSH, WSL and dev containers, the executable must be installed and
authenticated on the machine that runs the workspace extension.

Model
-----

``devdashAgents.model`` is a supported model identifier, chosen with **Copilot
model** in the settings panel. Leaving it empty uses the Copilot CLI default.

Local inference
---------------

``devdashAgents.localWorkerPath`` is the native worker executable. By default,
the worker built in the extension's ``build/native`` directory is used, then
``devdash-genai-worker`` on ``PATH``. It is executed directly, without a shell.
Under WSL, ``/usr/lib/wsl/lib`` is put first in the worker's ``LD_LIBRARY_PATH``
so CUDA finds the WSL GPU driver.
Only configure a trusted executable and model source.
``devdashAgents.localModelPath`` accepts a GenAI directory, a Transformers
checkpoint directory or a Hugging Face model ID. Selecting a source through
**Choose local model...** saves its prepared GenAI directory. If a Transformers
source is entered directly in VS Code configuration, it is prepared when opening
a local session and reused for that application lifetime. Hub IDs download the
specified model during preparation; models are never substituted automatically.
``devdashAgents.localProvider`` selects ``auto``, ``cuda``, ``npu`` or ``cpu``.
``devdashAgents.localDeviceId`` selects a runtime device ID, or ``-1`` for
automatic selection. These settings are machine-scoped.
See :doc:`sessions` for the local-session controls and :doc:`../development`
for the native runtime build requirements.
