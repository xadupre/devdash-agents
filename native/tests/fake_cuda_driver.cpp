#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#define CALL __stdcall
#else
#define EXPORT __attribute__((visibility("default")))
#define CALL
#endif
// Tiny test doubles of scalar CUDA ABIs, not third-party code. The deliberately
// different driver/runtime counts catch accidental use of the driver namespace.
namespace {
int currentDevice = 2;
int unavailableMask = 1 << 1;
}  // namespace
extern "C" {
EXPORT int CALL cuInit(unsigned int flags) { return flags == 0 ? 0 : 1; }
EXPORT int CALL cuDeviceGetCount(int* count) {
  *count = 7;
  return 0;
}
EXPORT int CALL cudaGetDeviceCount(int* count) {
  *count = 3;
  return 0;
}
EXPORT int CALL cudaGetDevice(int* device) {
  *device = currentDevice;
  return 0;
}
EXPORT int CALL cudaSetDevice(int device) {
  if (device < 0 || device > 2 || (unavailableMask & (1 << device))) return 1;
  currentDevice = device;
  return 0;
}
EXPORT int testCurrentRuntimeDevice() { return currentDevice; }
EXPORT void testConfigureRuntime(int original, int unavailable) {
  currentDevice = original;
  unavailableMask = unavailable;
}
}
