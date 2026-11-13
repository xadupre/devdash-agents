#include "provider_policy.h"

#include <charconv>

namespace devdash {
std::optional<Device> verifiedQnnNpu(const std::string& epName, bool hardwareIsNpu,
                                     const ProviderOptions& options, const std::string& name) {
  if (epName != "QNNExecutionProvider" || !hardwareIsNpu) return {};
  const auto backend = options.find("backend_path");
  const auto id = options.find("device_id");
  if (backend == options.end() || id == options.end() || id->second.empty()) return {};
  const auto separator = backend->second.find_last_of("/\\");
  const auto filename = backend->second.substr(separator == std::string::npos ? 0 : separator + 1);
  if (filename != "libQnnHtp.so" && filename != "QnnHtp.dll") return {};
  int ordinal = -1;
  const auto parsed = std::from_chars(id->second.data(), id->second.data() + id->second.size(), ordinal);
  if (parsed.ec != std::errc{} || parsed.ptr != id->second.data() + id->second.size() || ordinal < 0)
    return {};
  return Device{"npu", ordinal, name.empty() ? "Qualcomm QNN HTP NPU" : name};
}
}  // namespace devdash
