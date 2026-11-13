#include <iostream>

#include "cuda_discovery.h"

extern "C" int testCurrentRuntimeDevice();
extern "C" void testConfigureRuntime(int original, int unavailable);

int main(int argc, char** argv) {
  if (argc != 2) return 1;
  const auto devices = devdash::discoverCudaDevices(argv[1], argv[1]);
  if (devices.size() != 2 || devices[0].deviceId != 0 || devices[1].deviceId != 2 ||
      devices[0].name != "CUDA device 0" || devices[1].name != "CUDA device 2" ||
      devices[0].provider != "cuda" || testCurrentRuntimeDevice() != 2 ||
      !devdash::discoverCudaDevices("/__devdash_missing_cuda_driver__", argv[1]).empty() ||
      !devdash::discoverCudaDevices(argv[1], "/__devdash_missing_cuda_runtime__").empty()) {
    std::cerr << "CUDA probe did not preserve runtime-visible ordinals/current device\n";
    return 1;
  }
  // A default ordinal returned by cudaGetDevice is not proof that its context
  // can be initialized. A usable ordinal 2 must still be discoverable.
  testConfigureRuntime(0, (1 << 0) | (1 << 1));
  const auto onlyTwo = devdash::discoverCudaDevices(argv[1], argv[1]);
  if (onlyTwo.size() != 1 || onlyTwo[0].deviceId != 2 || testCurrentRuntimeDevice() != 2) {
    std::cerr << "An unusable default device prevented discovery of available device 2\n";
    return 1;
  }
  testConfigureRuntime(0, (1 << 0) | (1 << 1) | (1 << 2));
  if (!devdash::discoverCudaDevices(argv[1], argv[1]).empty()) {
    std::cerr << "An entirely unusable runtime must not claim any devices\n";
    return 1;
  }
  testConfigureRuntime(2, 1 << 1);
  std::cout << "Runtime-visible CUDA enumeration, device restoration, and missing library tests passed\n";
}
