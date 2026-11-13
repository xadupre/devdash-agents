#include <iostream>

#include "worker.h"

int main() {
  try {
    arranged::Worker worker(arranged::makeBackend, [](const arranged::Json& response) {
      std::cout << response.dump(-1, ' ', false, arranged::Json::error_handler_t::replace) << '\n'
                << std::flush;
    });
    worker.run(std::cin);
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "Native worker failed: " << e.what() << '\n';
    return 1;
  }
}
