#ifndef TERRA_BENCHMARK_HEADLESS_IMAGERY_HPP
#define TERRA_BENCHMARK_HEADLESS_IMAGERY_HPP

#include <terra/frame/camera.hpp>
#include <terra/frame/surface_source.hpp>
#include <functional>
#include <memory>
#include <string>

namespace cbdam { class grid_diamond_graph_incore; }
namespace terra_benchmark {

// Target demand only: no transport, decoder, GPU or production admission.
struct imagery_configuration {
  terra::frame::surface_source_parameters surface;
  unsigned tile_size = 256U, maximum_level = 16U;
  int width = 960, height = 640;
  double pixels = 1.25;
};
using mesh_reader = std::function<std::shared_ptr<const terra::frame::patch_surface_mesh>(std::size_t)>;

class imagery_driver {
 public:
  imagery_driver(const imagery_configuration& configuration,
                 cbdam::grid_diamond_graph_incore* desktop = nullptr);
  ~imagery_driver();
  std::string run(const terra::frame::camera_snapshot& camera,
                  std::size_t fragments, const mesh_reader& read);
 private:
  struct state;
  std::unique_ptr<state> state_;
};
} // namespace terra_benchmark
#endif
