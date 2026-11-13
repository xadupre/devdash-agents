#include "cuda_discovery.h"
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#define CUDA_CALL __stdcall
#else
#include <dlfcn.h>
#define CUDA_CALL
#endif

namespace arranged {
namespace {
class Library {
 public:
  explicit Library(const char* name, bool systemDriver = false, bool loadedOnly = false) {
#ifdef _WIN32
    if (loadedOnly)
      GetModuleHandleExA(0, name, &library_);
    else
      library_ = LoadLibraryExA(
          name, nullptr, systemDriver ? LOAD_LIBRARY_SEARCH_SYSTEM32 : LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
#else
    (void)systemDriver;
    library_ = dlopen(name, RTLD_NOW | RTLD_LOCAL | (loadedOnly ? RTLD_NOLOAD : 0));
#endif
  }
  ~Library() {
#ifdef _WIN32
    if (library_) FreeLibrary(library_);
#else
    if (library_) dlclose(library_);
#endif
  }
  template <typename T>
  T symbol(const char* name) const {
#ifdef _WIN32
    return library_ ? reinterpret_cast<T>(GetProcAddress(library_, name)) : nullptr;
#else
    return library_ ? reinterpret_cast<T>(dlsym(library_, name)) : nullptr;
#endif
  }
  const void* identity() const { return library_; }

 private:
#ifdef _WIN32
  HMODULE library_ = nullptr;
#else
  void* library_ = nullptr;
#endif
};
std::unique_ptr<Library> runtimeLibrary(const char* testRuntime) {
  if (testRuntime) return std::make_unique<Library>(testRuntime);
#ifdef _WIN32
  const char* names[] = {"cudart64_13.dll", "cudart64_12.dll", "cudart64_110.dll"};
#elif defined(__linux__)
  const char* names[] = {"libcudart.so.13", "libcudart.so.12", "libcudart.so.11.0", "libcudart.so"};
#else
  return nullptr;
#endif
#if defined(_WIN32) || defined(__linux__)
  // The backend first asks ORT for its current GPU, loading ORT's matching CUDA
  // runtime. Never choose an unrelated installed SDK; multiple loaded runtime
  // versions are ambiguous, so conservatively report CUDA unavailable.
  std::unique_ptr<Library> matching;
  for (const auto* name : names) {
    auto library = std::make_unique<Library>(name, false, true);
    if (library->symbol<int(CUDA_CALL*)(int*)>("cudaGetDeviceCount")) {
      if (matching && matching->identity() != library->identity()) return nullptr;
      matching = std::move(library);
    }
  }
  return matching;
#endif
}
}  // namespace
std::vector<Device> discoverCudaDevices(const char* testDriver, const char* testRuntime) {
#ifdef _WIN32
  const char* driverName = "nvcuda.dll";
#else
  const char* driverName = "libcuda.so.1";
#endif
  Library driver(testDriver ? testDriver : driverName, testDriver == nullptr);
  const auto init = driver.symbol<int(CUDA_CALL*)(unsigned int)>("cuInit");
  if (!init || init(0) != 0) return {};
  const auto runtime = runtimeLibrary(testRuntime);
  if (!runtime) return {};
  // ORT device_id and OgaSetCurrentGpuDeviceId use the CUDA *runtime* namespace.
  // Driver ordinals cannot safely identify runtime-visible devices when
  // CUDA_VISIBLE_DEVICES reorders/filters devices or MIG instances are exposed.
  // Use only stable scalar runtime ABIs, not cudaDeviceProp's versioned layout.
  const auto count = runtime->symbol<int(CUDA_CALL*)(int*)>("cudaGetDeviceCount");
  const auto get = runtime->symbol<int(CUDA_CALL*)(int*)>("cudaGetDevice");
  const auto set = runtime->symbol<int(CUDA_CALL*)(int)>("cudaSetDevice");
  if (!count || !get || !set) return {};
  int total = 0;
  if (count(&total) != 0 || total <= 0 || total > 1024) return {};
  int original = -1;
  if (get(&original) != 0 || original < 0 || original >= total) return {};
  // cudaGetDevice may return the default ordinal before any context exists.
  // That ordinal can be unusable (e.g. exclusive mode); it must not prevent
  // discovering a different usable GPU. Restore only a usable original device.
  const bool originalUsable = set(original) == 0;
  struct Restore {
    int(CUDA_CALL* set)(int);
    int original;
    bool active = true;
    ~Restore() {
      if (active) set(original);
    }
  } restore{set, original, originalUsable};
  std::vector<Device> result;
  for (int ordinal = 0; ordinal < total; ++ordinal) {
    if (set(ordinal) == 0) result.push_back({"cuda", ordinal, "CUDA device " + std::to_string(ordinal)});
  }
  if (originalUsable && set(original) != 0)
    throw Error("runtime_unavailable", "CUDA discovery could not restore the previous runtime device");
  restore.active = false;
  return result;
}
}  // namespace arranged
