#pragma once
#include "worker.h"

namespace arranged {
// An explicit path is only for the isolated ABI-probe tests. Protocol requests
// cannot change the driver library or bypass the installed-EP check.
std::vector<Device> discoverCudaDevices(const char* testDriver = nullptr, const char* testRuntime = nullptr);
}  // namespace arranged
