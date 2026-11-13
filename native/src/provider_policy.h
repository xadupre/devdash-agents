#pragma once
#include <map>

#include "worker.h"

namespace arranged {
using ProviderOptions = std::map<std::string, std::string>;
// EP metadata alone, guessed device ordinals, and QNN CPU backends are not
// evidence of an NPU. Accept only hardware discovery plus an explicit HTP
// backend and its backend-specific device ordinal.
std::optional<Device> verifiedQnnNpu(const std::string& epName, bool hardwareIsNpu, const ProviderOptions&,
                                     const std::string& name);
}  // namespace arranged
