#ifndef TERRA_FRAME_HEIGHT_QUERY_HPP
#define TERRA_FRAME_HEIGHT_QUERY_HPP

#include <terra/codec/cbdam_hierarchy.hpp>
#include <terra/core/grid.hpp>
#include <terra/core/types.hpp>

namespace terra {
namespace frame {

// Query coordinates are planar metres or cylindrical longitude/latitude.
// This operates on reconstructed CBDAM heights, never a render mesh or GPU cut.
core::vector3d height_query_grid(double u, double v, bool cylindrical,
                               const core::bounds2d& bounds);
// Exact grid-triangle membership, including the cylinder face plane. On success
// uv holds the clamped barycentrics used by both demand selection and sampling.
bool height_fragment_coordinates(const core::grid_diamond& diamond,
                                 std::size_t fragment,
                                 const core::vector3d& point,
                                 core::vector2d& uv);
bool sample_height_fragment(const core::grid_diamond& diamond,
                            std::size_t fragment,
                            const codec::height_fragment& heights,
                            const core::vector3d& point,
                            double& height);
// Conservative horizontal sample spacing. This is not a vertical error bound.
double height_sample_spacing(const core::grid_diamond& diamond,
                             std::size_t fragment, std::uint32_t dimension,
                             bool cylindrical, const core::bounds2d& bounds,
                             double radius);

}  // namespace frame
}  // namespace terra
#endif
