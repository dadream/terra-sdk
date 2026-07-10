#include <vic/mpi/mpi.hpp>

#include <iostream>
#include <string>

namespace {

int fail(const std::string& message) {
  std::cerr << "MPI SDK smoke failed: " << message << std::endl;
  return 1;
}

}  // namespace

int main(int argc, char** argv) {
  int initialized = 0;
  MPI_Initialized(&initialized);
  if (initialized) {
    return fail("MPI unexpectedly initialized before vic::mpi::initialize");
  }

  vic::mpi::initialize(&argc, &argv);
  MPI_Initialized(&initialized);
  if (!initialized) {
    return fail("vic::mpi::initialize did not initialize MPI");
  }

  const int rank = vic::mpi::process_rank();
  const int count = vic::mpi::process_count();
  const std::string name = vic::mpi::processor_name();
  if (rank < 0 || count < 1 || rank >= count || name.empty()) {
    vic::mpi::finalize();
    return fail("MPI rank/count/processor metadata changed");
  }

  vic::mpi::finalize();
  int finalized = 0;
  MPI_Finalized(&finalized);
  if (!finalized) {
    return fail("vic::mpi::finalize did not finalize MPI");
  }

  std::cout << "SDK smoke passed: vic_base_mpi single-process runtime"
            << std::endl;
  return 0;
}
