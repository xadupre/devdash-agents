#include <iostream>

#include "worker.h"

int main() {
  try {
    devdash::Worker worker(devdash::makeBackend, [](const devdash::Json& response) {
      std::cout << response.dump(-1, ' ', false, devdash::Json::error_handler_t::replace) << '\n'
                << std::flush;
    });
    worker.run(std::cin);
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "Native worker failed: " << e.what() << '\n';
    return 1;
  }
}
