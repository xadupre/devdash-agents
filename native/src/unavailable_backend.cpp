#include "worker.h"

namespace arranged {
std::unique_ptr<Backend> makeBackend() {
  throw Error("runtime_unavailable", "Worker was built without ONNX Runtime GenAI");
}
}  // namespace arranged
