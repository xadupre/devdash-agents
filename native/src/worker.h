#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <istream>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace devdash {
using Json = nlohmann::json;
constexpr std::size_t maxLineBytes = 1024 * 1024;
constexpr std::size_t maxChatMessages = 256;
constexpr std::size_t maxReducedMessages = maxChatMessages - 1;
constexpr int maxGenerationLength = 131072;
// Upper bound on concurrently cached sessions, each holding its own KV cache.
constexpr std::size_t maxSessions = 32;

struct Error : std::runtime_error {
  std::string code;
  Error(std::string code, const std::string& message) : std::runtime_error(message), code(std::move(code)) {}
};
struct Device {
  std::string provider;
  int deviceId;
  std::string name;
};
struct Discovery {
  std::vector<Device> devices;
  std::vector<std::string> unsupported;
};
struct Request {
  // An absent session selects the default session "".
  std::string id, method, modelPath, provider, prompt, targetId, session, mode;
  std::optional<Json> messages;
  std::optional<int> deviceId;
  int maxLength = 2048;  // Total sequence length, including the already-formatted prompt.
};
struct Generation {
  std::size_t cachedTokens = 0;     // Prompt tokens served from the session's KV cache.
  std::size_t generatedTokens = 0;  // Tokens produced by this request.
  std::size_t cacheTokens = 0;      // Tokens held by the session's KV cache afterwards.
};
struct ContextReduction {
  Json messages;
  std::size_t cacheTokens = 0;
};
// Drops whole exchanges or trims their oldest content at UTF-8 boundaries.
// The counter includes the model's template and all system messages.
Json fitContext(Json messages, std::size_t budget, const std::function<std::size_t(const Json&)>& count);
std::string stripSummaryReasoning(std::string summary);
Json fitSummary(const Json& systems, std::string summary, std::size_t budget,
                const std::function<std::size_t(const Json&)>& count);
Request parseRequest(const std::string& line);
std::string assistantPrefill(const std::string& prompt);
// Number of leading prompt tokens whose KV cache can be kept from the
// generator's current sequence. At least one prompt token is always left to
// append, so the next token is computed from fresh logits.
std::size_t reusablePrefix(const std::int32_t* cached, std::size_t cachedCount, const std::int32_t* prompt,
                           std::size_t promptCount);
Device selectDevice(const Discovery&, const std::string& provider, std::optional<int> deviceId);

class Backend {
 public:
  virtual ~Backend() = default;
  virtual Discovery discover() = 0;
  virtual void unload() = 0;
  virtual void load(const std::string& modelPath, const Device&) = 0;
  // Sessions share the loaded model, but each keeps its own KV cache across
  // requests until it is released; unload/load drops every session cache.
  virtual Generation generate(const std::string& session, const std::string& prompt, int maxLength,
                              const std::atomic_bool& cancelled,
                              const std::function<void(const std::string&)>& token) = 0;
  virtual Generation generateChat(const std::string& session, const Json& messages, int maxLength,
                                  const std::atomic_bool& cancelled,
                                  const std::function<void(const std::string&)>& token) = 0;
  virtual void release(const std::string& session) = 0;
  virtual ContextReduction reduceContext(const std::string&, const Json&, const std::string&, int,
                                         const std::atomic_bool&) {
    throw Error("unsupported", "Context reduction is unsupported by this backend");
  }
};
std::unique_ptr<Backend> makeBackend();

// One newline-delimited JSON request/response per line. Only the worker thread
// touches Backend (including construction/destruction); stdin stays responsive
// to cancel/stop during model loading and decoding. There is no work backlog.
class Worker {
 public:
  using Factory = std::function<std::unique_ptr<Backend>()>;
  using Output = std::function<void(const Json&)>;
  Worker(Factory, Output);
  ~Worker();
  void run(std::istream&);
  void submit(const std::string&);
  void finish();

 private:
  void loop();
  void emit(const Json&);
  void error(const Json& id, const std::string& code, const std::string& message);
  Factory factory_;
  Output output_;
  std::mutex stateMutex_, outputMutex_;
  std::condition_variable wake_;
  std::optional<Request> pending_;
  std::string activeId_, activeMethod_;
  std::optional<std::string> stopId_;
  bool busy_ = false, stopping_ = false, joined_ = false;
  std::atomic_bool cancelled_{false};
  std::thread thread_;
};
}  // namespace devdash
