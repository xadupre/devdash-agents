Development
===========

For requirements and launching the extension from source, see
:doc:`getting_started`.

Local checks
------------

.. code-block:: bash

   npm ci
   npm run check
   npm run coverage
   npm run package

``check`` runs Prettier, ESLint, TypeScript compilation and the unit tests.
``coverage`` prints a text summary and writes ``lcov.info`` under
``build/coverage/typescript``. Coverage includes unexercised extension code;
unit coverage is not evidence that the interactive VS Code UI has been tested.
None of these commands sends a model request.

On macOS, the remote-operation tests use a local shell to stand in for the
remote machine and need its GNU utilities:

.. code-block:: bash

   brew install coreutils grep
   export PATH="$(brew --prefix coreutils)/libexec/gnubin:$(brew --prefix grep)/libexec/gnubin:$PATH"

``npm run smoke`` sends three real requests through the authenticated local CLI
and checks the result, Markdown renderer and a file read in a temporary Git
repository, including live tool execution/result events. It stops the CLI,
resumes the same session in a new process and verifies the earlier context.
It uses your Copilot allowance.
Override the executable with ``ARRANGED_AGENTS_CLI_PATH`` if needed.

Use **Test DevDash Agents activation** in the Run and Debug view for an F5
activation/tab-opening check. A successful run writes host versions and the loaded extension
path to ``dist/scripts/extension-host-smoke-result.json``. It tests the development
extension, not VSIX installation.

Native local inference worker
-----------------------------

The optional C++17 worker uses the ONNX Runtime GenAI **v0.19.0 C API** and
a compatible prebuilt ONNX Runtime SDK (ORT API 26 or newer; CI uses v1.31.1).
Use the CPU archives for a CPU build. For a GPU build, use
``onnxruntime-genai-0.19.0-linux-x64-cuda`` with
``onnxruntime-linux-x64-gpu_cuda13-1.31.1`` and CUDA 13 with cuDNN 9. Keep the GenAI and ORT shared libraries from a compatible distribution
together; do not mix CPU and CUDA variants from different installations.
Install CMake 3.20+, a C++ compiler, Python 3 for process tests, and the
``nlohmann_json`` development package (for example ``nlohmann-json3-dev`` on Ubuntu).

On Linux x64, the first **Add** > **Local** runs ``native/setup-worker.sh``
when no worker is found. It downloads
the pinned prebuilt SDKs (CUDA variant when ``nvidia-smi`` finds a GPU, CPU
otherwise; ``ARRANGED_WORKER_VARIANT=cpu|gpu`` overrides it) and a pinned
``nlohmann_json``, verifies their SHA-256 checksums, and builds
``build/native``. Only the worker is compiled, never ONNX Runtime.

To build manually, from the repository root, with absolute SDK paths:

.. code-block:: bash

   cmake -S native -B build/native \
     -DGENAI_ROOT=/absolute/path/to/genai-sdk \
     -DONNXRUNTIME_ROOT=/absolute/path/to/onnxruntime-sdk
   cmake --build build/native --parallel $(nproc)
   ctest --test-dir build/native --output-on-failure

Native C++ sources follow the repository ``.clang-format`` (Google style,
110 columns). CI checks them with clang-format 22.1.8; format before committing:

.. code-block:: bash

   pip install clang-format==22.1.8
   clang-format -i native/src/*.cpp native/src/*.h native/tests/*.cpp

The extension uses ``build/native/devdash-genai-worker``
(``Release/devdash-genai-worker.exe`` for a Windows multi-configuration build)
automatically; ``devdashAgents.localWorkerPath`` overrides it. Headers belong in each SDK's
``include`` directory and libraries in ``lib``. The dynamic loader must also
find the compatible runtime libraries and accelerator dependencies. On Windows,
put their DLL directories on ``PATH``; on Linux, use the build RPATH or configure
``LD_LIBRARY_PATH``. Native release VSIX assets include the executable and
matching runtime libraries, but no models, SDK headers or build trees.
Load only trusted models and runtime libraries.

Build a distributable native package
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

On the matching OS and architecture, install Python 3.12+, CMake 3.20+ and a
C++17 compiler (Visual Studio Build Tools on Windows, Xcode command-line tools
on macOS). From the repository root, for example on Linux x64:

.. code-block:: bash

   npm ci
   npm run package:native -- --target linux-x64 --variant cpu
   npm run package -- --target linux-x64 --out build/devdash-agents-linux-x64-cpu.vsix
   npm run package:verify -- build/devdash-agents-linux-x64-cpu.vsix

Targets are ``linux-x64``, ``win32-x64`` and ``darwin-arm64``; variants are
``cpu`` and ``cuda`` (CUDA is unavailable on macOS). Cross-compilation is
rejected. The builder verifies SHA-256-pinned GenAI 0.19.0, ORT 1.31.1 and
nlohmann/json archives, reconfigures the single ``build/native`` tree,
builds Release with all available processors and verbose CMake output, and
replaces the ignored ``runtime/`` staging directory. Its manifest records the
target, variant, SDK versions and archive digests. Only matching runtime
libraries, the worker and upstream license/notices enter the native bundle.
macOS binaries receive ad-hoc signatures; Developer ID signing/notarization
is not configured.

The verifier inspects the actual VSIX, rejects accidental models, SDK headers,
build trees and unexpected runtime files, checks its platform metadata, then
extracts and executes the worker in a temporary directory without source SDK
library search paths. It exercises the real subprocess protocol. To include
real model loading and generation, set ``ARRANGED_TEST_MODEL_DIR`` before
verification. For a small, checksum-pinned fixture:

.. code-block:: bash

   python native/tests/fetch_model.py
   ARRANGED_TEST_MODEL_HAS_CHAT_TEMPLATE=1 \
   ARRANGED_TEST_MODEL_DIR="$PWD/build/native-deps/model-chat" \
     npm run package:verify -- build/devdash-agents-linux-x64-cpu.vsix

The verifier always uses CPU, including for CUDA packages, so missing GPUs
cannot hide a broken installation. Test actual CUDA execution separately with
the native ``ctest`` environment variables below. GPU driver/CUDA/cuDNN
prerequisites remain external. NPU workers are external as well.

Without staging a runtime, plain ``npm run package`` still builds a
Copilot-only, universal development VSIX. Native release builds must stage a
runtime first and pass its matching ``--target``. Default worker resolution
prefers a source development build, then the bundled runtime, then ``PATH``;
an explicit ``devdashAgents.localWorkerPath`` always takes precedence.

Policy and protocol tests can run without an SDK or model:

.. code-block:: bash

   cmake -S native -B build/native -DARRANGED_WITH_GENAI=OFF
   cmake --build build/native --parallel $(nproc)
   ctest --test-dir build/native --output-on-failure

This mode explicitly reports ``runtime_unavailable``; it is not an inference
backend. CI runs these native tests and the TypeScript transport/session tests.
When changing between SDK-free and real builds, reconfigure the same build tree
with ``ARRANGED_WITH_GENAI=ON`` and the SDK paths.

With the real SDK, set ``ARRANGED_TEST_MODEL_DIR`` to a GenAI model directory
when running ``ctest`` to also check model loading and generation. Set
``ARRANGED_TEST_MODEL_HAS_CHAT_TEMPLATE=1`` for a model with a chat template.
For the pinned fixture:

.. code-block:: bash

   ARRANGED_TEST_MODEL_DIR="$PWD/build/native-deps/model-chat" \
   ARRANGED_TEST_MODEL_HAS_CHAT_TEMPLATE=1 \
     ctest --test-dir build/native --output-on-failure

The test
uses ``ARRANGED_TEST_PROVIDER`` (``cpu`` by default, or ``cuda``). Chat
requests are expected to fail with ``chat_template_failed`` unless
the template flag is set, in which case they must stream tokens and exercise
both context reduction modes. The pinned test fixture receives a simple test
chat template and tokenizer vocabulary constrained to its 1,000 embedding
entries after its upstream files are checksum-verified. CI builds
the CPU and GPU variants from pinned prebuilt SDKs and runs this check with the
upstream ``tiny-random-gpt2-fp32`` fixture on CPU; hosted runners have no GPU,
so run the CUDA check locally. Under WSL, put ``/usr/lib/wsl/lib`` first in
``LD_LIBRARY_PATH`` when running ``ctest`` if a native Linux ``libcuda.so.1``
hides the WSL driver; the extension does this itself.

Worker protocol
~~~~~~~~~~~~~~~

Stdin and stdout carry UTF-8 JSON objects, one per line (at most 1 MiB per line).
Diagnostics use stderr only. Each request has a string ``id`` and ``method``.
Responses echo ``id`` and have a ``type``. No startup banner is emitted.

* ``discover`` returns ``providers`` with a ``providers`` array of
  ``{provider, deviceId, name}`` devices and ``unsupportedProviders``.
  Selection considers only discovered devices, preferring CUDA, NPU, then CPU.
  The backend supports CUDA and CPU, plus QNN HTP NPUs only when ORT exposes
  verified NPU hardware with backend-specific device options. Otherwise NPU is
  explicitly unsupported. An installed EP name alone is not evidence that
  accelerator hardware exists.
* ``load`` takes ``modelPath``, ``provider`` (``auto``, ``cuda``, ``npu``, ``cpu``),
  and optional ``deviceId``. It returns ``loaded`` with the selected provider
  and device ID. A failed reload leaves no model loaded. Load failures are not
  retried with another provider or model. Changing CUDA devices requires a fresh
  worker because GenAI owns process-global CUDA resources.
* ``generate`` takes ``messages`` (an array of ``{role, content}`` chat messages)
  or a model-formatted raw ``prompt``, and optional ``maxLength`` (total sequence
  length, including input tokens), and optional ``session`` (a non-empty
  per-conversation cache ID up to 128 characters; omitted uses the default
  session). Chat uses the model's default tokenizer
  template; template failures are explicit errors. Responses are zero or more
  ``token`` events with ``text``, followed by ``done`` with ``cancelled`` and
  ``cachedTokens``, ``generatedTokens`` and ``cacheTokens``. The loaded model
  holds up to 32 independent GenAI generators/KV caches, keyed by ``session``.
  Each request rewinds only that session's cache to the longest token prefix it
  shares with the new prompt (keeping at least one prompt token to append), then
  appends the rest; ``cachedTokens`` counts the reused prefix and
  ``cacheTokens`` reports the final sequence length. Changing ``maxLength``, a
  failed generation step, or a model that cannot rewind or continue decoding
  (for example on QNN) starts a fresh cache for that session.
  Chat requests allow 1–256 messages and at most 512 KiB of UTF-8 content.
  ``maxLength`` defaults to 2048 and must be between 2 and 131072; exceeding
  the model's context limit fails rather than silently truncating history.
* ``cancel`` takes the running generation's ``targetId`` and returns
  ``cancelled``; the target still receives its terminal ``done`` event.
* ``release`` takes an optional ``session`` and returns ``released`` after
  freeing that session's KV cache. Releasing an unknown session succeeds.
* ``stop`` cooperatively cancels active work, releases the model, returns
  ``stopped``, and exits. EOF also stops the worker.
* Errors have ``type: "error"``, ``code`` and ``message``. Malformed input without
  a usable request ID uses ``id: null``. Concurrent load/generation requests fail
  explicitly rather than being silently queued.

For example:

.. code-block:: json

   {"id":"1","method":"discover"}
   {"id":"2","method":"load","modelPath":"/models/chat","provider":"auto"}
   {"id":"3","method":"generate","messages":[{"role":"user","content":"Hello"}],"maxLength":2048,"session":"repo-session"}
   {"id":"4","method":"cancel","targetId":"3"}
   {"id":"5","method":"release","session":"repo-session"}
   {"id":"6","method":"stop"}

All GenAI calls run on one inference thread because its C API is not thread
safe. The stdin reader remains available during generation and checks
cancellation between inference steps; an individual runtime call cannot be
interrupted safely. The extension bounds cancellation/shutdown waits and
terminates an unresponsive worker without blocking the UI. Transport failures
reject pending requests and never reroute prompts to Copilot.

Manual validation
-----------------

Install the packaged VSIX, then check:

* Automatic development-tab opening and **DevDash Agents: Open** after VSIX installation.
* Chat on the left; Repositories, Github, Trace, Sessions and Log views in the right panel.
* Pointer/keyboard panel resizing and activity icons during startup and generation.
* Direct-child discovery, lazy startup and context isolation while switching repositories.
* Copilot and local sessions open at once, transfer drafts, shared local model,
  isolated KV cache statistics, device moves, DISK unload and the low-memory warning.
* Repository file access, Git/GitHub queries and permission confirmation/rejection.
* Enter to send, Shift+Enter for new lines, and live command/output visibility.
* Category checkboxes hide/restore history without affecting execution or drafts.
* Markdown, fenced code and inline/display equations, without remote math resources.
* Cancellation, concurrent requests in different repositories, tab closure and deactivation.
* Close/reopen history and draft restoration, lazy resume and interrupted-operation notices.
* Missing CLI session recovery through an explicit **New session**, never a silent reset.
* Visible persistence errors and no automatic rerun of interrupted commands on resume.
* Missing/login-invalid CLI and invalid models, with visible errors and clean restart.
* Blocking in an untrusted workspace, escaped HTML and blocked remote images.
* HTTP/HTTPS links open externally; command, script and local-file links stay blocked.

Building documentation
-----------------------

Python is needed for documentation and native process tests, not the extension runtime:

.. code-block:: bash

   python -m venv .venv
   .venv/bin/python -m pip install -r docs/requirements.txt
   .venv/bin/python -m sphinx -n -W --keep-going -b html docs build/docs/html

On Windows, use ``.venv/Scripts/python.exe`` instead. Open
``build/docs/html/index.html`` after a successful build. Sphinx warnings fail the
build, including broken internal references.

Refreshing feature screenshots
------------------------------

The feature guide uses committed PNG screenshots of the actual application
webview with fixed, fictional repositories, conversations and activity. They do
not require VS Code, GitHub authentication or a Copilot request.

.. code-block:: bash

   npx playwright install chromium
   npm run docs:screenshots

On Linux, Playwright may also require browser system libraries; install them
with ``npx playwright install --with-deps chromium`` if Chromium reports missing
libraries. The generator uses the current renderer, browser script and stylesheet
with a fixed dark theme, viewport, locale and timezone. It writes seven images
to ``docs/images`` and fails on browser script errors or unexpected network
requests. Review the images after UI changes, then rebuild the documentation.
The Sphinx build uses the committed images and does not need a browser.

GitHub Actions
--------------

* **Tests**: formatting, lint, unit tests and high-severity dependency audit on
  Linux, Windows and macOS. Native packaging additionally
  builds Linux/Windows x64 CPU and CUDA variants and macOS arm64 CPU, runs
  native policy/protocol tests and real tiny-model inference, and validates
  each relocated VSIX. Runs for pushes to ``main``, PRs and manual runs.
* **Nightly coverage**: TypeScript coverage artifacts and Codecov uploads.
  Configure Codecov with the ``CODECOV_TOKEN`` repository secret.
* **Weekly documentation**: strict Sphinx builds and HTML artifacts; also runs
  for documentation PRs. Scheduled and manual failures open an issue.
* **Release**: runs the same native package matrix for ``v*`` tags or published
  GitHub releases and attaches all five platform/variant VSIX assets.

Actions are pinned to commits. Only release publication has write access to
repository contents, and only the documentation-failure job can create issues.
No workflow runs the authenticated Copilot smoke test.

For a release, first update ``package.json`` and ``package-lock.json`` to the
intended version, including the ``v``-prefixed version in the settings section
title (``contributes.configuration.title``), commit the change, then tag that commit with the corresponding
``v``-prefixed version and push the tag. A published GitHub release rebuilds and
replaces the asset for its tag. No workflow publishes to the Marketplace.

Dependency and packaging policy
-------------------------------

Keep optional dependencies when running ``npm ci``. Koffi, used by the SDK,
distributes its prebuilt native binaries through optional platform packages.
``--omit=optional`` forces a source build, which fails with the Windows runner's
MSVC toolchain. The SDK's bundled runtime packages are excluded from the VSIX
by ``.vscodeignore`` instead; the application still uses the installed Copilot CLI.

The project has no selected license. ``npm run package`` uses ``--skip-license``
while the package remains ``UNLICENSED``; this is a packaging policy, not a license
grant.

The Zod, Azure Identity and KaTeX overrides in ``package.json`` address dependency
advisories. Before changing them, run ``npm audit`` and
``npm audit --omit=dev``, then rerun the tests.
