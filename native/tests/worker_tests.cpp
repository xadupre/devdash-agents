#include <algorithm>
#include <chrono>
#include <iostream>
#include <map>
#include <sstream>

#include "provider_policy.h"
#include "worker.h"

using namespace devdash;
using namespace std::chrono_literals;
namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
template <typename F>
void expectError(F action, const std::string& code) {
  try {
    action();
  } catch (const Error& e) {
    require(e.code == code, "Wrong error code");
    return;
  }
  throw std::runtime_error("Expected an error");
}
void validation() {
  const std::vector<std::string> invalid{
      "null",
      "[]",
      "{}",
      R"({"id":7,"method":"discover"})",
      R"({"id":"","method":"discover"})",
      R"({"id":"x","method":false})",
      R"({"id":"x","method":"discover","extra":1})",
      R"({"id":"x","method":"load","provider":"cpu"})",
      R"({"id":"x","method":"load","modelPath":"m","provider":"cpu","deviceId":-1})",
      R"({"id":"x","method":"load","modelPath":"m","provider":"cpu","deviceId":1.5})",
      R"({"id":"x","method":"load","modelPath":"m","provider":"cpu","deviceId":true})",
      R"({"id":"x","method":"load","modelPath":"m","provider":"cpu","deviceId":18446744073709551615})",
      R"({"id":"x","method":"generate","prompt":"p","maxLength":0})",
      R"({"id":"x","method":"generate","prompt":"p","maxLength":131073})",
      R"({"id":"x","method":"generate","prompt":"p","maxLength":"20"})",
      R"({"id":"x","method":"generate","prompt":""})",
      R"({"id":"x","method":"generate","prompt":"a\u0000b"})",
      R"({"id":"x","method":"generate"})",
      R"({"id":"x","method":"generate","prompt":"p","messages":[]})",
      R"({"id":"x","method":"generate","messages":"p"})",
      R"({"id":"x","method":"generate","messages":[]})",
      R"({"id":"x","method":"reduceContext","messages":[],"mode":"unknown"})",
      R"({"id":"x","method":"reduceContext","messages":[]})",
      R"({"id":"x","method":"reduceContext","prompt":"p","mode":"sliding"})",
      R"({"id":"x","method":"generate","messages":[null]})",
      R"({"id":"x","method":"generate","messages":[{"role":"user"}]})",
      R"({"id":"x","method":"generate","messages":[{"role":"tool","content":"p"}]})",
      R"({"id":"x","method":"generate","messages":[{"role":false,"content":"p"}]})",
      R"({"id":"x","method":"generate","messages":[{"role":"user","content":false}]})",
      R"({"id":"x","method":"generate","messages":[{"role":"user","content":"p","extra":1}]})",
      R"({"id":"x","method":"generate","messages":[{"role":"user","content":"a\u0000b"}]})",
      R"({"id":"x","method":"cancel"})",
      R"({"id":"x","method":"generate","prompt":"p","session":""})",
      R"({"id":"x","method":"generate","prompt":"p","session":7})",
      R"({"id":"x","method":"release","session":"a\u0000b"})",
      R"({"id":"x","method":"release","prompt":"p"})",
      R"({"id":"x","method":"discover","id":"y"})"};
  for (const auto& frame : invalid) expectError([&] { parseRequest(frame); }, "invalid_request");
  expectError([] { parseRequest("{"); }, "invalid_json");
  expectError([] { parseRequest(R"({"id":"x","method":"unknown"})"); }, "invalid_method");
  expectError([] { parseRequest(R"({"id":"x","method":"load","modelPath":"m","provider":"dml"})"); },
              "unsupported_provider");
  expectError([] { parseRequest(std::string(maxLineBytes + 1, ' ')); }, "invalid_request");
  auto nested = std::string(40, '[') + "0" + std::string(40, ']');
  expectError([&] { parseRequest(nested); }, "invalid_request");
  require(
      parseRequest(R"({"id":"x","method":"generate","prompt":"p","maxLength":131072})").maxLength == 131072,
      "Bounded maxLength must be accepted");
  const auto chat = parseRequest(
      R"({"id":"chat","method":"generate","messages":[{"role":"system","content":"s"},{"role":"user","content":"u"},{"role":"assistant","content":""}],"maxLength":42})");
  require(chat.messages && chat.messages->size() == 3 && chat.prompt.empty() && chat.maxLength == 42,
          "Strict chat request must be accepted without raw prompt substitution");
  require(chat.session.empty(), "An absent session must select the default session");
  const auto reduction = parseRequest(
      R"({"id":"x","method":"reduceContext","messages":[],"mode":"compress","session":"repo","maxLength":42})");
  require(reduction.messages && reduction.messages->empty() && reduction.mode == "compress" &&
              reduction.session == "repo" && reduction.maxLength == 42,
          "Reduction must accept empty history and retain its options");
  require(parseRequest(R"({"id":"x","method":"generate","prompt":"p","session":"repo"})").session == "repo",
          "A generation must keep its session");
  require(parseRequest(R"({"id":"x","method":"release","session":"repo"})").session == "repo",
          "A release must name its session");
  expectError(
      [] { parseRequest(R"({"id":"x","method":"release","session":")" + std::string(129, 's') + "\"}"); },
      "invalid_request");
  Json completedHistory = {{{"role", "system"}, {"content", "rules"}}};
  for (int i = 0; i < 128; ++i) {
    completedHistory.push_back({{"role", "user"}, {"content", "p"}});
    completedHistory.push_back({{"role", "assistant"}, {"content", "a"}});
  }
  Json excessive = {{"id", "large"}, {"method", "generate"}, {"messages", completedHistory}};
  expectError([&] { parseRequest(excessive.dump()); }, "invalid_request");
  excessive["method"] = "reduceContext";
  for (const auto* mode : {"sliding", "compress"}) {
    excessive["mode"] = mode;
    require(parseRequest(excessive.dump()).messages->size() == 257,
            "Reduction must accept the completed reply after a maximum-size prompt");
  }
  excessive["messages"].push_back({{"role", "assistant"}, {"content", "reply"}});
  expectError([&] { parseRequest(excessive.dump()); }, "invalid_request");
  excessive["messages"] = {{{"role", "user"}, {"content", std::string(512 * 1024 + 1, 'x')}}};
  expectError([&] { parseRequest(excessive.dump()); }, "invalid_request");
}
void policy() {
  Discovery all{{{"cpu", 0, "CPU"}, {"npu", 7, "NPU"}, {"cuda", 0, "GPU0"}, {"cuda", 2, "GPU2"}}, {}};
  require(selectDevice(all, "auto", {}).provider == "cuda", "Auto must prefer CUDA");
  require(selectDevice(all, "cuda", 2).deviceId == 2, "Explicit GPU ordinal must be honored");
  expectError([&] { selectDevice(all, "cuda", 1); }, "provider_unavailable");
  expectError([&] { selectDevice(all, "cpu", 2); }, "provider_unavailable");
  Discovery npu{{{"cpu", 0, "CPU"}, {"npu", 7, "NPU"}}, {"cuda"}};
  require(selectDevice(npu, "auto", {}).provider == "npu", "Auto must prefer NPU over CPU");
  Discovery cpu{{{"cpu", 0, "CPU"}}, {"cuda", "npu"}};
  require(selectDevice(cpu, "auto", {}).provider == "cpu", "Auto CPU selection");
  expectError([&] { selectDevice(cpu, "cuda", {}); }, "provider_unavailable");
  expectError([&] { selectDevice(Discovery{}, "auto", {}); }, "provider_unavailable");
  const ProviderOptions qnn{{"backend_path", "/sdk/libQnnHtp.so"}, {"device_id", "3"}};
  require(verifiedQnnNpu("QNNExecutionProvider", true, qnn, "NPU")->deviceId == 3,
          "Verified QNN hardware must retain backend ordinal");
  require(!verifiedQnnNpu("QNNExecutionProvider", false, qnn, "NPU"),
          "Compiled QNN without NPU hardware must not be advertised");
  require(!verifiedQnnNpu("CPUExecutionProvider", true, qnn, "NPU"), "Wrong EP is not QNN");
  require(!verifiedQnnNpu("QNNExecutionProvider", true, {}, "NPU"),
          "Missing backend probe must not claim NPU");
  for (const auto* backend : {"libQnnCpu.so", "QnnCpu.dll", "libQnnHtp.so.guessed"})
    require(
        !verifiedQnnNpu("QNNExecutionProvider", true, {{"backend_path", backend}, {"device_id", "0"}}, "NPU"),
        "Non-HTP or guessed backends must not claim an NPU");
  for (const auto* id : {"", "-1", "x", "0junk", "99999999999999999999999"})
    require(!verifiedQnnNpu("QNNExecutionProvider", true, {{"backend_path", "QnnHtp.dll"}, {"device_id", id}},
                            "NPU"),
            "Unmapped QNN hardware must not claim a usable ordinal");
}
void prefix() {
  for (const auto* prefill : {"<think>", "<think>\n"})
    require(assistantPrefill(std::string("<|im_start|>user\nquestion<|im_end|>\n") +
                             "<|im_start|>assistant\n" + prefill) == prefill,
            "ChatML thinking prefill must reach the response parser");
  for (const auto* prefill : {"<|start|>assistant", "<|start|>assistant<|meta_sep|>analysis",
                              "<|start|>assistant<|meta_sep|>analysis<|im_sep|>",
                              "<|start|>assistant<|channel|>analysis<|message|>"})
    require(assistantPrefill(std::string("<|start|>user<|message|>question<|end|>") + prefill) == prefill,
            "Harmony header prefill must reach the response parser");
  for (const auto* prompt : {"<|im_start|>assistant\n", "<|im_start|>assistant\n<think></think>",
                             "<|im_start|>assistant\n<think>\n\n</think>\n\n",
                             "<|start|>assistant<|channel|>analysis<|message|>old reasoning",
                             "<|im_start|>user\n<|start|>assistant<|im_end|>\n<|im_start|>assistant\n",
                             "<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\nExplain "
                             "<|start|>assistant in Harmony.<|eot_id|><|start_header_id|>assistant"
                             "<|end_header_id|>\n\n",
                             "plain prompt"})
    require(assistantPrefill(prompt).empty(), "Completed reasoning and raw prompts have no prefill");
  const std::vector<std::int32_t> cached{1, 2, 3, 4};
  const auto keep = [&](std::vector<std::int32_t> prompt) {
    return reusablePrefix(cached.data(), cached.size(), prompt.data(), prompt.size());
  };
  require(keep({1, 2, 3, 4, 5, 6}) == 4, "A grown prompt must reuse the whole cache");
  require(keep({1, 2, 9, 4, 5}) == 2, "Reuse must stop at the first divergent token");
  require(keep({1, 2, 3, 4}) == 3, "An identical prompt must leave one token to append");
  require(keep({1, 2}) == 1, "A shorter prompt must leave one token to append");
  require(keep({9}) == 0 && keep({}) == 0, "Unrelated or empty prompts reuse nothing");
  require(reusablePrefix(nullptr, 0, cached.data(), cached.size()) == 0, "An empty cache reuses nothing");
}
void contextPolicy() {
  const auto count = [](const Json& messages) {
    std::size_t tokens = 4;
    for (const auto& m : messages) tokens += m["content"].get<std::string>().size() + 2;
    return tokens;
  };
  Json messages = {{{"role", "system"}, {"content", "rules"}},
                   {{"role", "user"}, {"content", "old history is long"}},
                   {{"role", "assistant"}, {"content", "recent"}}};
  const auto result = fitContext(messages, count(messages) / 2, count);
  require(result[0] == messages[0], "Sliding must preserve system instructions");
  require(result.back()["role"] == "assistant" && result.back()["content"] == "ecent",
          "Sliding must prefer recent history while keeping a valid user/assistant exchange");
  require(count(result) <= count(messages) / 2, "Budget must include template and system overhead");
  const Json emptyUser = {{{"role", "user"}, {"content", "123456789"}},
                          {{"role", "assistant"}, {"content", "x"}}};
  const auto retainedReply = fitContext(emptyUser, count(emptyUser) / 2, count);
  require(retainedReply[0]["content"] == "" && retainedReply[1] == emptyUser[1] && count(retainedReply) == 9,
          "An empty user suffix must preserve the unchanged assistant reply when it fits");
  Json longMessage = {{{"role", "user"}, {"content", "old prefix and recent suffix"}}};
  const auto suffix = fitContext(longMessage, 14, count);
  require(suffix.size() == 2 && suffix[0]["content"] == "suffix" && suffix.back()["role"] == "assistant",
          "Sliding must retain a suffix of a large message");
  expectError([&] { fitContext(messages, 5, count); }, "insufficient_context");
  require(fitContext(Json::array(), 4, count).empty(), "Empty histories must not loop");
  Json unicode = {{{"role", "user"}, {"content", "discard café🙂"}}};
  const auto utf8 = fitContext(unicode, 12, count);
  require(utf8[0]["content"] == "é🙂" || utf8[0]["content"] == "🙂",
          "Truncation must retain valid UTF-8 suffix boundaries");
  require(stripSummaryReasoning(" \n<think>private</think>\n<think>more</think> facts") == "facts",
          "Leading reasoning blocks must never enter replacement history");
  expectError([] { stripSummaryReasoning("<think>unfinished"); }, "generation_failed");
  expectError([] { stripSummaryReasoning("<thi"); }, "generation_failed");
  expectError([] { stripSummaryReasoning("<think>only reasoning</think>"); }, "insufficient_context");
  const Json systems = {{{"role", "system"}, {"content", "rules"}}};
  std::size_t calls = 0;
  const auto summaryCount = [&](const Json& history) {
    ++calls;
    return count(history);
  };
  const auto summary = fitSummary(systems, std::string(100000, 'x'), 50, summaryCount);
  require(summary[0] == systems[0] && summary[1]["role"] == "user" && count(summary) <= 50,
          "Summary budget must preserve systems and include user/template overhead");
  require(calls < 25, "Large summaries must be fitted with logarithmically many tokenizations");
  const auto utf8Summary = fitSummary(Json::array(), "é🙂abc", 31, count);
  require(utf8Summary[0]["content"] == "Context summary: é🙂",
          "Summary prefix trimming must preserve UTF-8 boundaries");
  expectError([&] { fitSummary(systems, "facts", 5, count); }, "insufficient_context");
  const auto strictCount = [&](const Json& history) {
    std::string expected = "user";
    for (const auto& message : history) {
      if (message["role"] == "system") continue;
      if (message["role"] != expected)
        throw Error("chat_template_failed", "Roles must alternate starting with user");
      expected = expected == "user" ? "assistant" : "user";
    }
    return count(history);
  };
  Json strictHistory = systems;
  strictHistory.push_back({{"role", "user"}, {"content", std::string(80, 'a')}});
  strictHistory.push_back({{"role", "assistant"}, {"content", "answer"}});
  strictHistory.push_back({{"role", "user"}, {"content", "recent"}});
  strictHistory.push_back({{"role", "assistant"}, {"content", "reply"}});
  auto strictSliding = fitContext(strictHistory, strictCount(strictHistory) / 2, strictCount);
  require(strictSliding[0] == systems[0] && strictSliding.back()["role"] == "assistant",
          "Sliding must preserve system instructions and end a valid exchange");
  strictSliding.push_back({{"role", "user"}, {"content", "next question"}});
  strictCount(strictSliding);
  auto dropped = fitContext(strictHistory, 30, strictCount);
  require(dropped.size() == 3 && dropped[1]["content"] == "recent",
          "Sliding must drop whole old exchanges without evaluating assistant-first histories");
  dropped.push_back({{"role", "user"}, {"content", "next question"}});
  strictCount(dropped);
  auto strictSummary = fitSummary(systems, "retained facts", 50, strictCount);
  require(strictSummary[0] == systems[0] && strictSummary.back()["role"] == "assistant",
          "Compressed summary must include a completed exchange");
  strictSummary.push_back({{"role", "user"}, {"content", "next question"}});
  strictCount(strictSummary);
  Json longReply = {{{"role", "user"}, {"content", "question"}},
                    {{"role", "assistant"}, {"content", std::string(100, 'a')}}};
  auto shortReply = fitContext(longReply, 25, strictCount);
  require(shortReply[0]["content"] == "" && shortReply[1]["content"].get<std::string>().size() == 17,
          "Sliding must be able to shorten an assistant reply without invalidating its user exchange");
  shortReply.push_back({{"role", "user"}, {"content", "next question"}});
  strictCount(shortReply);
  Json completed = systems;
  for (int i = 0; i < 128; ++i) {
    completed.push_back({{"role", "user"}, {"content", "question"}});
    completed.push_back({{"role", "assistant"}, {"content", "reply"}});
  }
  const auto compact = fitContext(completed, strictCount(completed) / 2, strictCount);
  require(compact.size() <= 255 && compact[0] == systems[0],
          "A maximum completed history must reduce while preserving system instructions");
  auto limited = fitContext(completed, 1, [](const Json&) { return 1; });
  require(limited.size() == 255, "Message limits must apply even when the token budget fits");
  limited.push_back({{"role", "user"}, {"content", "next question"}});
  strictCount(limited);
  require(parseRequest(Json({{"id", "next"}, {"method", "generate"}, {"messages", limited}}).dump())
                  .messages->size() == 256,
          "The reduced history must leave a slot for the next generation");
  Json manySystems = Json::array();
  for (int i = 0; i < 254; ++i) manySystems.push_back(systems[0]);
  expectError([&] { fitSummary(manySystems, "facts", 100000, count); }, "insufficient_context");
}
struct FakeState {
  std::atomic_bool holdLoad{false}, holdGeneration{false}, enteredLoad{false};
  std::atomic_int loads{0}, rawGenerations{0}, chatGenerations{0};
  std::thread::id thread;
};
class FakeBackend : public Backend {
 public:
  explicit FakeBackend(std::shared_ptr<FakeState> state) : state_(std::move(state)) {
    state_->thread = std::this_thread::get_id();
  }
  ~FakeBackend() override {
    // Terminate on a thread-affinity violation, including destructor calls.
    if (state_->thread != std::this_thread::get_id()) std::terminate();
  }
  void affinity() {
    require(state_->thread == std::this_thread::get_id(), "Backend used on multiple threads");
  }
  Discovery discover() override {
    affinity();
    return {{{"cpu", 0, "CPU"}, {"cuda", 2, "GPU2"}}, {"npu"}};
  }
  void unload() override {
    affinity();
    loaded_ = false;
    caches_.clear();
  }
  void load(const std::string& path, const Device&) override {
    affinity();
    ++state_->loads;
    state_->enteredLoad = true;
    while (state_->holdLoad) std::this_thread::sleep_for(1ms);
    if (path == "bad") throw Error("load_failed", "Deliberate model load failure");
    loaded_ = true;
  }
  Generation generate(const std::string& session, const std::string& prompt, int,
                      const std::atomic_bool& cancelled,
                      const std::function<void(const std::string&)>& token) override {
    affinity();
    ++state_->rawGenerations;
    if (!loaded_) throw Error("model_not_loaded", "No model");
    // Characters stand in for tokens: report the prefix kept by this session.
    const std::vector<std::int32_t> next(prompt.begin(), prompt.end());
    auto& cache = caches_[session];
    Generation result;
    result.cachedTokens = reusablePrefix(cache.data(), cache.size(), next.data(), next.size());
    cache = next;
    token("first");
    ++result.generatedTokens;
    while (state_->holdGeneration && !cancelled) std::this_thread::sleep_for(1ms);
    if (!cancelled) {
      token("last");
      ++result.generatedTokens;
    }
    result.cacheTokens = cache.size() + result.generatedTokens;
    result.contextTokens = result.cacheTokens;
    return result;
  }
  Generation generateChat(const std::string& session, const Json& messages, int maxLength,
                          const std::atomic_bool& cancelled,
                          const std::function<void(const std::string&)>& token) override {
    affinity();
    ++state_->chatGenerations;
    if (messages[0]["content"] == "missing template")
      throw Error("chat_template_failed", "Empty chat template.");
    require(messages[0]["role"] == "user", "Chat messages were not preserved");
    std::string formatted;
    for (const auto& message : messages) formatted += message["content"].get<std::string>() + "|";
    return generate(session, formatted, maxLength, cancelled, token);
  }
  void release(const std::string& session) override {
    affinity();
    caches_.erase(session);
  }
  ContextReduction reduceContext(const std::string& session, const Json& messages, const std::string& mode,
                                 int maxLength, const std::atomic_bool& cancelled) override {
    affinity();
    require(loaded_, "Reduction must use the loaded model");
    require(mode == "sliding" && maxLength == 42 && session == "reduce-session",
            "Reduction arguments must reach the backend unchanged");
    while (state_->holdGeneration && !cancelled) std::this_thread::sleep_for(1ms);
    if (cancelled) throw Error("cancelled", "Reduction cancelled");
    return {messages, 7, 11};
  }

 private:
  std::shared_ptr<FakeState> state_;
  bool loaded_ = false;
  std::map<std::string, std::vector<std::int32_t>> caches_;
};
struct Harness {
  std::shared_ptr<FakeState> state = std::make_shared<FakeState>();
  std::mutex mutex;
  std::condition_variable cv;
  std::vector<Json> messages;
  Worker worker{[this] { return std::make_unique<FakeBackend>(state); },
                [this](const Json& j) {
                  std::lock_guard lock(mutex);
                  messages.push_back(j);
                  cv.notify_all();
                }};
  void send(const Json& frame) { worker.submit(frame.dump()); }
  Json wait(const std::string& id, const std::string& type) {
    std::unique_lock lock(mutex);
    const auto find = [&] {
      return std::find_if(messages.begin(), messages.end(),
                          [&](const Json& j) { return j["id"] == id && j["type"] == type; });
    };
    require(cv.wait_for(lock, 5s, [&] { return find() != messages.end(); }),
            "Timed out waiting for response");
    return *find();
  }
  void load(const std::string& id, const std::string& path = "model") {
    send({{"id", id}, {"method", "load"}, {"provider", "cpu"}, {"modelPath", path}});
  }
};
void concurrency() {
  Harness h;
  h.load("load");
  h.wait("load", "loaded");
  h.send({{"id", "chat"}, {"method", "generate"}, {"messages", {{{"role", "user"}, {"content", "hello"}}}}});
  require(h.wait("chat", "done")["cancelled"] == false && h.state->chatGenerations == 1,
          "Chat requests must dispatch to the model chat-template backend");
  const int rawBefore = h.state->rawGenerations;
  h.send({{"id", "missingtemplate"},
          {"method", "generate"},
          {"messages", {{{"role", "user"}, {"content", "missing template"}}}}});
  require(h.wait("missingtemplate", "error")["code"] == "chat_template_failed" &&
              h.state->rawGenerations == rawBefore,
          "Chat-template failure must not fall back to raw generation");
  h.state->holdGeneration = true;
  h.send({{"id", "g"}, {"method", "generate"}, {"prompt", "formatted prompt"}});
  h.wait("g", "token");
  h.send({{"id", "busy"}, {"method", "discover"}});
  require(h.wait("busy", "error")["code"] == "busy", "Concurrent work must be rejected");
  h.send({{"id", "wrong"}, {"method", "cancel"}, {"targetId", "other"}});
  h.wait("wrong", "cancelled");
  {
    std::lock_guard lock(h.mutex);
    require(std::none_of(h.messages.begin(), h.messages.end(),
                         [](const Json& j) { return j["id"] == "g" && j["type"] == "done"; }),
            "Wrong target cancelled generation");
  }
  h.send({{"id", "cancel"}, {"method", "cancel"}, {"targetId", "g"}});
  h.wait("cancel", "cancelled");
  require(h.wait("g", "done")["cancelled"] == true, "Target generation must be cancelled");
  h.state->holdGeneration = false;
  h.send({{"id", "next"}, {"method", "generate"}, {"prompt", "p"}});
  require(h.wait("next", "done")["cancelled"] == false, "Cancellation must not leak into next request");

  h.state->holdLoad = true;
  h.state->enteredLoad = false;
  h.load("slow");
  const auto deadline = std::chrono::steady_clock::now() + 5s;
  while (!h.state->enteredLoad && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(1ms);
  require(h.state->enteredLoad, "Load did not begin");
  h.send({{"id", "during"}, {"method", "cancel"}, {"targetId", "slow"}});
  h.wait("during", "cancelled");
  h.send({{"id", "loadbusy"}, {"method", "generate"}, {"prompt", "p"}});
  require(h.wait("loadbusy", "error")["code"] == "busy", "Loading must remain busy");
  h.state->holdLoad = false;
  h.wait("slow", "loaded");
  h.load("bad", "bad");
  require(h.wait("bad", "error")["code"] == "load_failed", "Load failures must propagate");
  require(h.state->loads == 3, "Load failure must not trigger retries or fallback");
  h.send({{"id", "afterbad"}, {"method", "generate"}, {"prompt", "p"}});
  require(h.wait("afterbad", "error")["code"] == "model_not_loaded",
          "Old model must not survive failed load");
  h.load("reload");
  h.wait("reload", "loaded");
  h.send({{"id", "missing"}, {"method", "load"}, {"modelPath", "model"}, {"provider", "npu"}});
  require(h.wait("missing", "error")["code"] == "provider_unavailable", "Unavailable explicit EP");
  h.send({{"id", "aftermissing"}, {"method", "generate"}, {"prompt", "p"}});
  require(h.wait("aftermissing", "error")["code"] == "model_not_loaded",
          "Unavailable provider must invalidate old model");
  h.load("lastload");
  h.wait("lastload", "loaded");
  h.state->holdGeneration = true;
  h.send({{"id", "stoppinggen"}, {"method", "generate"}, {"prompt", "p"}});
  h.wait("stoppinggen", "token");
  h.send({{"id", "stop"}, {"method", "stop"}});
  require(h.wait("stoppinggen", "done")["cancelled"] == true, "Stop must cancel generation");
  h.wait("stop", "stopped");
  h.worker.finish();
  require(h.state->thread != std::this_thread::get_id(), "Backend must not run on reader thread");
}
void sessionCache() {
  Harness h;
  h.load("load");
  h.wait("load", "loaded");
  const auto chat = [&](const std::string& id, const Json& messages, const std::string& session = "") {
    Json frame = {{"id", id}, {"method", "generate"}, {"messages", messages}};
    if (!session.empty()) frame["session"] = session;
    h.send(frame);
    return h.wait(id, "done");
  };
  Json messages = {{{"role", "user"}, {"content", "hello"}}};
  const auto first = chat("first", messages);
  require(first["cachedTokens"] == 0, "A new session starts with an empty cache");
  require(first["generatedTokens"] == 2 && first["cacheTokens"] == 8,
          "Completion must report generated and cached sequence tokens");
  require(first["contextTokens"] == 8, "Completion must report logical context tokens");
  messages.push_back({{"role", "assistant"}, {"content", "hi"}});
  messages.push_back({{"role", "user"}, {"content", "again"}});
  require(chat("second", messages)["cachedTokens"] == 6, "A follow-up turn must reuse the session cache");
  h.load("reload");
  h.wait("reload", "loaded");
  require(chat("third", messages)["cachedTokens"] == 0, "Loading a model must start a new cache");
  h.send({{"id", "raw"}, {"method", "generate"}, {"prompt", "hello|hi|other"}});
  require(h.wait("raw", "done")["cachedTokens"] == 9, "Divergent prompts must keep only the shared prefix");

  const Json other = {{{"role", "user"}, {"content", "other"}}};
  require(chat("a1", messages, "a")["cachedTokens"] == 0 && chat("b1", other, "b")["cachedTokens"] == 0,
          "Named sessions must not share the default session cache");
  require(chat("a2", messages, "a")["cachedTokens"] == 14 && chat("b2", other, "b")["cachedTokens"] == 5,
          "Interleaved sessions must each keep their own cache");
  h.send({{"id", "release"}, {"method", "release"}, {"session", "a"}});
  h.wait("release", "released");
  h.send({{"id", "again"}, {"method", "release"}, {"session", "a"}});
  h.wait("again", "released");
  require(chat("a3", messages, "a")["cachedTokens"] == 0, "A released session must start a new cache");
  require(chat("b3", other, "b")["cachedTokens"] == 5, "Releasing a session must keep the others");
  h.load("clear");
  h.wait("clear", "loaded");
  require(chat("b4", other, "b")["cachedTokens"] == 0, "Loading a model must drop every session cache");
  h.worker.finish();
}
void framing() {
  Harness h;
  std::ostringstream input;
  input << std::string(maxLineBytes + 100, 'x') << "\n{bad}\n"
        << R"({"id":"valid","method":"cancel","targetId":"absent"})" << '\n'
        << R"({"id":"end","method":"stop"})" << '\n';
  std::istringstream stream(input.str());
  h.worker.run(stream);
  h.wait("valid", "cancelled");
  h.wait("end", "stopped");
  require(h.messages.size() == 4, "Framing must recover after oversized and malformed input");
  require(h.messages[0]["id"].is_null(), "Oversized frame has no trusted ID");
  require(h.messages[1]["code"] == "invalid_json", "Malformed JSON error");
}
void reductionProtocol() {
  Harness h;
  h.load("load");
  h.wait("load", "loaded");
  const Json messages = {{{"role", "user"}, {"content", "history"}}};
  const auto reduce = [&](const std::string& id) {
    h.send({{"id", id},
            {"method", "reduceContext"},
            {"messages", messages},
            {"mode", "sliding"},
            {"session", "reduce-session"},
            {"maxLength", 42}});
  };
  reduce("reduce");
  const auto result = h.wait("reduce", "reduced");
  require(result["messages"] == messages && result["cacheTokens"] == 7,
          "Reduction must return authoritative replacement history and cache count");
  require(result["contextTokens"] == 11, "Reduction must report logical context separately from cache");
  require(h.state->rawGenerations == 0 && h.state->chatGenerations == 0,
          "Reduction must not request or stream a normal reply");
  h.state->holdGeneration = true;
  reduce("abort");
  h.send({{"id", "busy"}, {"method", "discover"}});
  require(h.wait("busy", "error")["code"] == "busy", "Reduction must serialize backend work");
  h.send({{"id", "cancel"}, {"method", "cancel"}, {"targetId", "abort"}});
  h.wait("cancel", "cancelled");
  require(h.wait("abort", "error")["code"] == "cancelled", "Reduction must be cancellable");
  h.worker.finish();
}
}  // namespace
int main() {
  try {
    validation();
    policy();
    prefix();
    contextPolicy();
    reductionProtocol();
    concurrency();
    sessionCache();
    framing();
    std::cout
        << "Protocol, provider policy, prompt cache, concurrency, cancellation, and framing tests passed\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
