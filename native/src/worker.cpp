#include "worker.h"

#include <algorithm>
#include <limits>
#include <regex>
#include <set>

namespace devdash {
namespace {
std::string text(const Json& j, const char* key, std::size_t bound) {
  if (!j.contains(key) || !j[key].is_string())
    throw Error("invalid_request", std::string(key) + " must be a string");
  auto value = j[key].get<std::string>();
  if (value.empty() || value.size() > bound || value.find('\0') != std::string::npos)
    throw Error("invalid_request", std::string(key) + " is empty, oversized, or contains NUL");
  return value;
}
int integer(const Json& value, int low, int high, const char* key) {
  if (!value.is_number_integer() ||
      (value.is_number_unsigned() && value.get<std::uint64_t>() > static_cast<std::uint64_t>(high)))
    throw Error("invalid_request", std::string(key) + " must be a bounded integer");
  const auto number = value.get<std::int64_t>();
  if (number < low || number > high)
    throw Error("invalid_request", std::string(key) + " is outside the permitted range");
  return static_cast<int>(number);
}
Json requestId(const std::string& line) {
  // Only used to attach an ID to validation errors; never trust a malformed frame.
  try {
    auto j = Json::parse(line, [](int depth, Json::parse_event_t, Json&) {
      if (depth > 32) throw Error("invalid_request", "JSON nesting exceeds 32");
      return true;
    });
    if (j.is_object() && j.contains("id") && j["id"].is_string()) {
      auto id = j["id"].get<std::string>();
      if (!id.empty() && id.size() <= 128 && id.find('\0') == std::string::npos) return id;
    }
  } catch (...) {
  }
  return nullptr;
}
}  // namespace

std::string assistantPrefill(const std::string& prompt) {
  const std::string harmony = "<|start|>assistant";
  const std::string chatml = "<|im_start|>assistant\n";
  const auto chatmlStart = prompt.rfind(chatml);
  auto start = prompt.rfind(harmony);
  if (start != std::string::npos && (chatmlStart == std::string::npos || start > chatmlStart)) {
    const auto suffix = prompt.substr(start);
    static const std::regex header(
        R"(^<\|start\|>assistant( to=([a-zA-Z_][a-zA-Z_0-9.]*))?(<\|(meta_sep|channel)\|>(analysis|final|commentary)( to=([a-zA-Z_][a-zA-Z_0-9.]*))?)?(<\|(meta_start|constrain)\|>json)?(<\|(im_sep|message)\|>)?$)");
    if (suffix.size() <= 256 && std::regex_match(suffix, header)) return suffix;
  }
  start = chatmlStart;
  if (start != std::string::npos) {
    const auto suffix = prompt.substr(start + chatml.size());
    if (suffix == "<think>" || suffix == "<think>\n") return suffix;
  }
  return "";
}

Request parseRequest(const std::string& line) {
  if (line.size() > maxLineBytes) throw Error("invalid_request", "Request exceeds 1 MiB");
  Json j;
  try {
    std::vector<std::set<std::string>> keys;
    j = Json::parse(line, [&](int depth, Json::parse_event_t event, Json& value) {
      if (depth > 32) throw Error("invalid_request", "JSON nesting exceeds 32");
      if (event == Json::parse_event_t::object_start) keys.emplace_back();
      if (event == Json::parse_event_t::key && !keys.back().insert(value.get<std::string>()).second)
        throw Error("invalid_request", "Duplicate JSON field");
      if (event == Json::parse_event_t::object_end) keys.pop_back();
      return true;
    });
  } catch (const Json::exception&) {
    throw Error("invalid_json", "Expected one valid UTF-8 JSON object per line");
  }
  if (!j.is_object()) throw Error("invalid_request", "Request must be an object");
  Request r;
  r.id = text(j, "id", 128);
  r.method = text(j, "method", 16);
  std::set<std::string> allowed{"id", "method"};
  if (r.method == "load") {
    allowed.insert({"modelPath", "provider", "deviceId"});
    r.modelPath = text(j, "modelPath", 4096);
    r.provider = text(j, "provider", 16);
    if (r.provider != "auto" && r.provider != "cpu" && r.provider != "cuda" && r.provider != "npu")
      throw Error("unsupported_provider", "provider must be auto, cuda, npu, or cpu");
    if (j.contains("deviceId"))
      r.deviceId = integer(j["deviceId"], 0, std::numeric_limits<int>::max(), "deviceId");
  } else if (r.method == "generate" || r.method == "reduceContext") {
    allowed.insert({"prompt", "messages", "maxLength", "session"});
    if (r.method == "reduceContext") {
      allowed.erase("prompt");
      allowed.insert("mode");
      r.mode = text(j, "mode", 8);
      if (r.mode != "sliding" && r.mode != "compress")
        throw Error("invalid_request", "mode must be sliding or compress");
      if (!j.contains("messages")) throw Error("invalid_request", "reduceContext requires messages");
    }
    if (j.contains("session")) r.session = text(j, "session", 128);
    if (j.contains("prompt") == j.contains("messages"))
      throw Error("invalid_request", "generate requires exactly one of prompt or messages");
    if (j.contains("prompt")) {
      r.prompt = text(j, "prompt", 512 * 1024);
    } else {
      const auto& messages = j["messages"];
      const auto limit = r.method == "reduceContext" ? maxChatMessages + 1 : maxChatMessages;
      if (!messages.is_array() || (messages.empty() && r.method == "generate") || messages.size() > limit)
        throw Error("invalid_request", "messages exceed the request's message limit");
      std::size_t contentBytes = 0;
      for (const auto& message : messages) {
        if (!message.is_object() || message.size() != 2 || !message.contains("role") ||
            !message.contains("content") || !message["content"].is_string())
          throw Error("invalid_request", "Each message must contain only role and string content");
        const auto role = text(message, "role", 9);
        if (role != "system" && role != "user" && role != "assistant")
          throw Error("invalid_request", "Message role must be system, user, or assistant");
        const auto& content = message["content"].get_ref<const std::string&>();
        contentBytes += content.size();
        if (contentBytes > 512 * 1024 || content.find('\0') != std::string::npos)
          throw Error("invalid_request", "Message contents exceed 512 KiB or contain NUL");
      }
      r.messages = messages;
    }
    if (j.contains("maxLength")) r.maxLength = integer(j["maxLength"], 2, maxGenerationLength, "maxLength");
  } else if (r.method == "cancel") {
    allowed.insert("targetId");
    r.targetId = text(j, "targetId", 128);
  } else if (r.method == "release") {
    allowed.insert("session");
    if (j.contains("session")) r.session = text(j, "session", 128);
  } else if (r.method != "discover" && r.method != "stop") {
    throw Error("invalid_method", "Unknown method");
  }
  for (const auto& item : j.items())
    if (!allowed.count(item.key())) throw Error("invalid_request", "Unknown field: " + item.key());
  return r;
}

std::size_t reusablePrefix(const std::int32_t* cached, std::size_t cachedCount, const std::int32_t* prompt,
                           std::size_t promptCount) {
  const auto limit = std::min(cachedCount, promptCount ? promptCount - 1 : 0);
  std::size_t length = 0;
  while (length < limit && cached[length] == prompt[length]) ++length;
  return length;
}
Json fitContext(Json messages, std::size_t budget, const std::function<std::size_t(const Json&)>& count) {
  const auto last =
      std::find_if(messages.rbegin(), messages.rend(), [](const Json& m) { return m["role"] != "system"; });
  if (last != messages.rend() && (*last)["role"] == "user")
    messages.push_back({{"role", "assistant"}, {"content", ""}});
  // Leave one message slot for the next user turn.
  while (messages.size() > maxReducedMessages || count(messages) > budget) {
    auto oldest =
        std::find_if(messages.begin(), messages.end(), [](const Json& m) { return m["role"] != "system"; });
    if (oldest == messages.end())
      throw Error("insufficient_context",
                  "System instructions and chat template exceed the reduction budget");
    const auto index = static_cast<std::size_t>(oldest - messages.begin());
    Json without = messages;
    const auto reply = std::find_if(without.begin() + index + 1, without.end(),
                                    [](const Json& m) { return m["role"] != "system"; });
    const auto replyIndex = static_cast<std::size_t>(reply - without.begin());
    if (reply != without.end() && (*reply)["role"] == "assistant") without.erase(reply);
    without.erase(without.begin() + index);
    // Test a shortened user in its original exchange. Deleting only that user
    // would make strict alternating-role templates reject an assistant-first
    // intermediate history before we could discover a fitting suffix.
    for (const auto trimIndex : {index, replyIndex}) {
      if (messages.size() > maxReducedMessages) break;
      if (trimIndex >= messages.size()) continue;
      const auto content = messages[trimIndex]["content"].get<std::string>();
      messages[trimIndex]["content"] = "";
      if (content.empty() || count(messages) > budget) continue;
      std::vector<std::size_t> offsets;
      for (std::size_t i = 0; i < content.size(); ++i)
        if ((static_cast<unsigned char>(content[i]) & 0xc0) != 0x80) offsets.push_back(i);
      offsets.push_back(content.size());
      std::size_t low = 1, high = offsets.size();
      while (low < high) {
        const auto middle = low + (high - low) / 2;
        messages[trimIndex]["content"] = content.substr(offsets[middle]);
        if (count(messages) <= budget)
          high = middle;
        else
          low = middle + 1;
      }
      if (low < offsets.size()) {
        messages[trimIndex]["content"] = content.substr(offsets[low]);
        const bool hasExchangeContent =
            !messages[index]["content"].get_ref<const std::string&>().empty() ||
            (replyIndex < messages.size() &&
             !messages[replyIndex]["content"].get_ref<const std::string&>().empty());
        if (hasExchangeContent && count(messages) <= budget) return messages;
      }
    }
    if (std::none_of(without.begin(), without.end(), [](const Json& m) { return m["role"] != "system"; }))
      throw Error("insufficient_context", "No complete conversation exchange fits the reduction budget");
    messages = std::move(without);
  }
  return messages;
}
std::string stripSummaryReasoning(std::string summary) {
  for (;;) {
    const auto first = summary.find_first_not_of(" \r\n\t");
    if (first == std::string::npos)
      throw Error("insufficient_context", "The model produced no context summary");
    summary.erase(0, first);
    if (summary.compare(0, 7, "<think>") != 0) {
      if (summary.size() < 7 && std::string("<think>").compare(0, summary.size(), summary) == 0)
        throw Error("generation_failed", "The context summary ended inside a reasoning marker");
      return summary;
    }
    const auto end = summary.find("</think>", 7);
    if (end == std::string::npos)
      throw Error("generation_failed", "The context summary ended before closing its <think> block");
    summary.erase(0, end + 8);
  }
}
Json fitSummary(const Json& systems, std::string summary, std::size_t budget,
                const std::function<std::size_t(const Json&)>& count) {
  if (systems.size() > maxReducedMessages - 2)
    throw Error("insufficient_context", "System instructions leave no room for a summary and next turn");
  summary = stripSummaryReasoning(std::move(summary));
  Json result = systems;
  result.push_back({{"role", "user"}, {"content", "Context summary: " + summary}});
  const auto summaryIndex = result.size() - 1;
  // Structural boundary only: no reply is decoded. The next real user turn
  // must not be adjacent to the user-role summary in alternating templates.
  result.push_back({{"role", "assistant"}, {"content", ""}});
  if (count(result) <= budget) return result;
  std::vector<std::size_t> offsets{0};
  for (std::size_t i = 1; i < summary.size(); ++i)
    if ((static_cast<unsigned char>(summary[i]) & 0xc0) != 0x80) offsets.push_back(i);
  offsets.push_back(summary.size());
  std::size_t low = 0, high = offsets.size() - 1;
  while (low < high) {
    const auto middle = low + (high - low + 1) / 2;
    result[summaryIndex]["content"] = "Context summary: " + summary.substr(0, offsets[middle]);
    if (count(result) <= budget)
      low = middle;
    else
      high = middle - 1;
  }
  result[summaryIndex]["content"] = "Context summary: " + summary.substr(0, offsets[low]);
  // Tokenization is not strictly monotonic under prefix changes. Always verify
  // the chosen candidate; never persist an over-budget or empty summary.
  if (!offsets[low] || count(result) > budget)
    throw Error("insufficient_context", "The summary cannot fit the reduction budget");
  return result;
}
Device selectDevice(const Discovery& discovery, const std::string& provider, std::optional<int> id) {
  std::vector<std::string> order{provider};
  if (provider == "auto") order = {"cuda", "npu", "cpu"};
  for (const auto& candidate : order)
    for (const auto& device : discovery.devices)
      if (device.provider == candidate && (!id || device.deviceId == *id)) return device;
  throw Error("provider_unavailable", "Requested provider/device is not available; no fallback attempted");
}

Worker::Worker(Factory factory, Output output)
    : factory_(std::move(factory)), output_(std::move(output)), thread_(&Worker::loop, this) {}
Worker::~Worker() { finish(); }
void Worker::emit(const Json& value) {
  std::lock_guard lock(outputMutex_);
  output_(value);
}
void Worker::error(const Json& id, const std::string& code, const std::string& message) {
  emit({{"id", id}, {"type", "error"}, {"code", code}, {"message", message}});
}
void Worker::submit(const std::string& line) {
  Request r;
  try {
    r = parseRequest(line);
  } catch (const Error& e) {
    error(line.size() <= maxLineBytes ? requestId(line) : Json(nullptr), e.code, e.what());
    return;
  } catch (const std::exception& e) {
    error(nullptr, "invalid_request", e.what());
    return;
  }
  std::lock_guard lock(stateMutex_);
  if (stopping_) {
    error(r.id, "stopping", "Worker is stopping");
  } else if (r.method == "cancel") {
    if (busy_ && (activeMethod_ == "generate" || activeMethod_ == "reduceContext") && activeId_ == r.targetId)
      cancelled_.store(true);
    // An idempotent acknowledgment, not a claim that the target existed.
    emit({{"id", r.id}, {"type", "cancelled"}});
  } else if (r.method == "stop") {
    stopping_ = true;
    stopId_ = r.id;
    cancelled_.store(true);
    wake_.notify_one();
  } else if (busy_) {
    error(r.id, "busy", "Another discover/load/generate/release request is in progress");
  } else {
    busy_ = true;
    activeId_ = r.id;
    activeMethod_ = r.method;
    cancelled_.store(false);
    pending_ = std::move(r);
    wake_.notify_one();
  }
}
void Worker::run(std::istream& input) {
  std::string line;
  bool oversized = false;
  char c;
  while (input.get(c)) {
    if (c == '\n') {
      if (oversized)
        error(nullptr, "invalid_request", "Request exceeds 1 MiB");
      else
        submit(line);
      line.clear();
      oversized = false;
      std::lock_guard lock(stateMutex_);
      if (stopping_) break;
    } else if (!oversized) {
      if (line.size() == maxLineBytes) {
        oversized = true;
        line.clear();
      } else {
        line.push_back(c);
      }
    }
  }
  // Accept an EOF-terminated final frame, but never allocate unbounded lines.
  if (oversized)
    error(nullptr, "invalid_request", "Request exceeds 1 MiB");
  else if (!line.empty())
    submit(line);
  finish();
}
void Worker::finish() {
  {
    std::lock_guard lock(stateMutex_);
    if (joined_) return;
    stopping_ = true;
    cancelled_.store(true);
    wake_.notify_one();
  }
  if (thread_.joinable()) thread_.join();
  joined_ = true;
}
void Worker::loop() {
  std::unique_ptr<Backend> backend;
  for (;;) {
    Request r;
    {
      std::unique_lock lock(stateMutex_);
      wake_.wait(lock, [&] { return stopping_ || pending_.has_value(); });
      if (!pending_) break;
      r = std::move(*pending_);
      pending_.reset();
    }
    Json terminal;
    try {
      if (!backend) backend = factory_();
      if (r.method == "discover") {
        const auto discovery = backend->discover();
        Json providers = Json::array();
        for (const auto& d : discovery.devices)
          providers.push_back({{"provider", d.provider}, {"deviceId", d.deviceId}, {"name", d.name}});
        terminal = {{"id", r.id},
                    {"type", "providers"},
                    {"providers", providers},
                    {"unsupportedProviders", discovery.unsupported}};
      } else if (r.method == "load") {
        // A failed load must not leave the previous model silently available.
        backend->unload();
        auto device = selectDevice(backend->discover(), r.provider, r.deviceId);
        backend->load(r.modelPath, device);
        terminal = {
            {"id", r.id}, {"type", "loaded"}, {"provider", device.provider}, {"deviceId", device.deviceId}};
      } else if (r.method == "release") {
        backend->release(r.session);
        terminal = {{"id", r.id}, {"type", "released"}};
      } else if (r.method == "reduceContext") {
        const auto result = backend->reduceContext(r.session, *r.messages, r.mode, r.maxLength, cancelled_);
        terminal = {{"id", r.id},
                    {"type", "reduced"},
                    {"messages", result.messages},
                    {"contextTokens", result.contextTokens},
                    {"cacheTokens", result.cacheTokens}};
      } else {
        const auto token = [&](const std::string& chunk) {
          if (!cancelled_.load()) emit({{"id", r.id}, {"type", "token"}, {"text", chunk}});
        };
        const auto result =
            r.messages ? backend->generateChat(r.session, *r.messages, r.maxLength, cancelled_, token)
                       : backend->generate(r.session, r.prompt, r.maxLength, cancelled_, token);
        terminal = {{"id", r.id},
                    {"type", "done"},
                    {"cachedTokens", result.cachedTokens},
                    {"generatedTokens", result.generatedTokens},
                    {"contextTokens", result.contextTokens},
                    {"cacheTokens", result.cacheTokens}};
      }
    } catch (const Error& e) {
      terminal = {{"id", r.id}, {"type", "error"}, {"code", e.code}, {"message", e.what()}};
    } catch (const std::exception& e) {
      terminal = {{"id", r.id},
                  {"type", "error"},
                  {"code", r.method == "load" ? "load_failed" : "runtime_error"},
                  {"message", e.what()}};
    } catch (...) {
      terminal = {{"id", r.id},
                  {"type", "error"},
                  {"code", "runtime_error"},
                  {"message", "Unknown native runtime failure"}};
    }
    {
      std::lock_guard lock(stateMutex_);
      if (terminal["type"] == "done") terminal["cancelled"] = cancelled_.load();
      busy_ = false;
      activeId_.clear();
      activeMethod_.clear();
      emit(terminal);
      if (stopping_) break;
    }
  }
  backend.reset();
  std::optional<std::string> stop;
  {
    std::lock_guard lock(stateMutex_);
    stop = stopId_;
  }
  if (stop) emit({{"id", *stop}, {"type", "stopped"}});
}
}  // namespace devdash
