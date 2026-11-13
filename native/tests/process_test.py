"""Exercise the actual executable, optionally including real model inference."""
import json
import os
import queue
import subprocess
import sys
import threading


def main():
    executable, mode = sys.argv[1:]
    process = subprocess.Popen(
        [executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8",
    )
    output = queue.Queue()
    diagnostics = []

    def read_output():
        for line in process.stdout:
            output.put(json.loads(line))
        output.put(None)

    def read_errors():
        diagnostics.extend(process.stderr)

    reader = threading.Thread(target=read_output, daemon=True)
    errors = threading.Thread(target=read_errors, daemon=True)
    reader.start()
    errors.start()

    def send(frame):
        process.stdin.write(json.dumps(frame) + "\n")
        process.stdin.flush()

    def receive(identifier, *kinds, timeout=10):
        response = output.get(timeout=timeout)
        assert response is not None, "".join(diagnostics)
        assert response["id"] == identifier and response["type"] in kinds, response
        return response

    try:
        process.stdin.write("{bad}\n")
        process.stdin.flush()
        assert receive(None, "error")["code"] == "invalid_json"
        send({"id": "invalid", "method": "generate", "prompt": "x", "maxLength": True})
        assert receive("invalid", "error")["code"] == "invalid_request"
        send({"id": "both", "method": "generate", "prompt": "x",
              "messages": [{"role": "user", "content": "hello"}]})
        assert receive("both", "error")["code"] == "invalid_request"
        send({"id": "role", "method": "generate", "messages": [{"role": "tool", "content": "x"}]})
        assert receive("role", "error")["code"] == "invalid_request"
        send({"id": "deep", "method": "discover", "extra": [[[[0]]]]})
        assert receive("deep", "error")["code"] == "invalid_request"
        send({"id": "d", "method": "discover"})
        if mode == "runtime":
            discovery = receive("d", "providers")
            providers = discovery["providers"]
            assert any(d["provider"] == "cpu" and d["deviceId"] == 0 for d in providers), discovery
            for device in providers:
                assert device["provider"] in ("cpu", "cuda", "npu"), device
                assert isinstance(device["deviceId"], int) and device["deviceId"] >= 0, device
                assert isinstance(device["name"], str) and device["name"], device
            present = {d["provider"] for d in providers}
            assert set(discovery["unsupportedProviders"]) == {"cpu", "cuda", "npu"} - present
            send({"id": "g", "method": "generate", "prompt": "formatted prompt"})
            assert receive("g", "error")["code"] == "model_not_loaded"
            send({"id": "chat", "method": "generate", "messages": [{"role": "user", "content": "hi"}]})
            assert receive("chat", "error")["code"] == "model_not_loaded"
            send({"id": "l", "method": "load", "provider": "cpu",
                  "modelPath": "/__devdash_nonexistent_model__"})
            assert receive("l", "error")["code"] == "load_failed"
            send({"id": "auto", "method": "load", "provider": "auto",
                  "modelPath": "/__devdash_nonexistent_model__"})
            assert receive("auto", "error")["code"] == "load_failed"
            if "npu" not in present:
                send({"id": "n", "method": "load", "provider": "npu", "modelPath": "unused"})
                assert receive("n", "error")["code"] == "provider_unavailable"
            send({"id": "device", "method": "load", "provider": "cpu", "deviceId": 1,
                  "modelPath": "unused"})
            assert receive("device", "error")["code"] == "provider_unavailable"
            send({"id": "after", "method": "generate", "prompt": "p"})
            assert receive("after", "error")["code"] == "model_not_loaded"
            if "ARRANGED_TEST_MODEL_DIR" in os.environ:
                provider = os.environ.get("ARRANGED_TEST_PROVIDER", "cpu")
                assert provider in present, discovery
                send({"id": "valid", "method": "load", "provider": provider,
                      "modelPath": os.environ["ARRANGED_TEST_MODEL_DIR"]})
                loaded = receive("valid", "loaded", timeout=300)
                assert any(d["provider"] == loaded["provider"] == provider
                           and d["deviceId"] == loaded["deviceId"] for d in providers), loaded
                send({"id": "infer", "method": "generate", "prompt": "a", "maxLength": 8})
                chunks = []
                while True:
                    event = receive("infer", "token", "done", timeout=120)
                    if event["type"] == "done":
                        assert event["cancelled"] is False, event
                        assert event["cachedTokens"] == 0, "A new session must start uncached"
                        break
                    assert isinstance(event["text"], str) and event["text"], event
                    chunks.append(event["text"])
                assert chunks, f"{provider} model produced no tokens"

                def complete(identifier, prompt, session, max_length=16):
                    send({"id": identifier, "method": "generate", "prompt": prompt,
                          "maxLength": max_length, "session": session})
                    while True:
                        event = receive(identifier, "token", "done", "error", timeout=120)
                        if event["type"] == "error":
                            return event
                        if event["type"] == "done":
                            assert event["cancelled"] is False, event
                            assert event["generatedTokens"] > 0, event
                            assert event["cachedTokens"] < event["cacheTokens"] <= max_length, event
                            return event

                def release(identifier, session=None):
                    frame = {"id": identifier, "method": "release"}
                    if session is not None:
                        frame["session"] = session
                    send(frame)
                    receive(identifier, "released")

                # Prompts diverge inside the first prompt, so reuse never
                # depends on how many tokens the random model generated. The
                # fixture's model only embeds the first 1000 tokenizer IDs.
                assert complete("one-a", "a b c", "one")["cachedTokens"] == 0
                assert complete("two-a", "x y a", "two")["cachedTokens"] == 0
                assert complete("one-b", "a b d", "one")["cachedTokens"] > 0, \
                    "Each session must keep its own KV cache"
                release("release-one", "one")
                assert complete("one-c", "a b d", "one")["cachedTokens"] == 0, \
                    "A released session must start uncached"
                assert complete("two-b", "x y b", "two")["cachedTokens"] > 0, \
                    "Releasing a session must keep the others"
                for session in ("one", "two", None):
                    release(f"clear-{session}", session)
                for index in range(32):
                    complete(f"cap-{index}", "a", f"cap-{index}", 4)
                assert complete("cap-over", "a", "cap-over", 4)["code"] == "too_many_sessions"
                release("cap-release", "cap-0")
                assert complete("cap-after", "a", "cap-over", 4)["cachedTokens"] == 0
                for session in [f"cap-{index}" for index in range(1, 32)] + ["cap-over"]:
                    release(f"release-{session}", session)
                send({"id": "chat-model", "method": "generate", "maxLength": 256,
                      "messages": [{"role": "user", "content": "hi"}]})
                if os.environ.get("ARRANGED_TEST_MODEL_HAS_CHAT_TEMPLATE") == "1":
                    def converse(identifier, messages, session=None, max_length=256):
                        frame = {"id": identifier, "method": "generate", "maxLength": max_length,
                                 "messages": messages}
                        if session is not None:
                            frame["session"] = session
                        send(frame)
                        chunks = []
                        while True:
                            event = receive(identifier, "token", "done", timeout=120)
                            if event["type"] == "done":
                                return "".join(chunks), event["cachedTokens"]
                            chunks.append(event["text"])

                    def prompt_tokens(identifier, messages, max_length):
                        send({"id": identifier, "method": "generate", "maxLength": max_length,
                              "messages": messages, "session": identifier})
                        while True:
                            event = receive(identifier, "token", "done", timeout=120)
                            if event["type"] == "done":
                                assert event["cancelled"] is False, event
                                assert event["generatedTokens"] > 0, event
                                return event["cacheTokens"] - event["generatedTokens"]

                    def reduce(identifier, mode, messages, session, max_length):
                        send({"id": identifier, "method": "reduceContext", "maxLength": max_length,
                              "messages": messages, "mode": mode, "session": session})
                        # A token event here would mean reduction accidentally streamed a reply.
                        result = receive(identifier, "reduced", "error", timeout=300)
                        assert result["type"] == "reduced", result
                        return result

                    def assert_role_order(messages):
                        expected = "user"
                        for message in messages:
                            if message["role"] == "system":
                                continue
                            assert message["role"] == expected, messages
                            expected = "assistant" if expected == "user" else "user"
                        assert expected == "user", messages

                    chat = []
                    while True:
                        event = receive("chat-model", "token", "done", timeout=120)
                        if event["type"] == "done":
                            break
                        chat.append(event["text"])
                    assert chat, f"{provider} chat produced no tokens"
                    history = [{"role": "user", "content": "hi"},
                               {"role": "assistant", "content": "".join(chat)[:16]},
                               {"role": "user", "content": "thanks"}]
                    _, cached = converse("follow-up", history)
                    assert cached > 0, "A follow-up turn must reuse the session KV cache"

                    systems = [
                        {"role": "system", "content": "a b c"},
                        {"role": "system", "content": "x y z"},
                    ]
                    context = systems + [
                        {"role": "user", "content": "a b c " * 8},
                        {"role": "assistant", "content": "x y z " * 6},
                        {"role": "user", "content": "b c x " * 6},
                        {"role": "assistant", "content": "y z a"},
                    ]
                    isolated_history = systems + [
                        {"role": "user", "content": "x y a"},
                        {"role": "assistant", "content": "b c z"},
                    ]
                    max_length = 512
                    _, isolated_cache = converse(
                        "isolation-before-large", isolated_history, "untouched", max_length)
                    assert isolated_cache == 0, "A new independent session must start uncached"
                    for reduction_mode in ("sliding", "compress"):
                        budget_id = f"{reduction_mode}-budget"
                        original_tokens = prompt_tokens(budget_id, context, max_length)
                        assert original_tokens > 0
                        reduced = reduce(f"{reduction_mode}-reduce", reduction_mode,
                                         context, f"{reduction_mode}-session", max_length)
                        replacement = reduced["messages"]
                        assert reduced["cacheTokens"] <= original_tokens // 2, (
                            reduction_mode, original_tokens, reduced)
                        assert reduced["cacheTokens"] > 0, reduced
                        assert [message for message in replacement if message["role"] == "system"] == systems
                        assert len(replacement) <= 255, (
                            "Reduced history must leave room for the next user message", replacement)
                        assert_role_order(replacement)
                        follow_up = replacement + [{"role": "user", "content": "Continue with the unresolved note."}]
                        _, reused = converse(f"{reduction_mode}-follow-up", follow_up,
                                             f"{reduction_mode}-session", max_length)
                        assert reused > 0, (
                            f"{reduction_mode} follow-up must reuse its returned history cache")
                        _, isolated_cache = converse(
                            f"isolation-after-{reduction_mode}", isolated_history, "untouched",
                            max_length)
                        assert isolated_cache > 0, (
                            f"{reduction_mode} reduction must not clear another session's cache")
                else:
                    assert receive("chat-model", "error", timeout=120)["code"] == "chat_template_failed"
            else:
                print("Model inference skipped: ARRANGED_TEST_MODEL_DIR is not set")
        else:
            assert receive("d", "error")["code"] == "runtime_unavailable"
            for reduction_mode in ("sliding", "compress"):
                send({"id": reduction_mode, "method": "reduceContext", "messages": [],
                      "mode": reduction_mode, "session": "local-session"})
                assert receive(reduction_mode, "error")["code"] == "runtime_unavailable"
        send({"id": "c", "method": "cancel", "targetId": "absent"})
        receive("c", "cancelled")
        send({"id": "s", "method": "stop"})
        receive("s", "stopped")
        process.stdin.close()
        assert process.wait(timeout=10) == 0, "".join(diagnostics)
        reader.join(timeout=2)
        assert output.get(timeout=2) is None, "Unexpected extra stdout"
        print(f"Actual {mode} worker subprocess protocol checks passed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


if __name__ == "__main__":
    main()
