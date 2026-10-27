#ifndef TERRA_C_API_MESH_SOURCE_HPP
#define TERRA_C_API_MESH_SOURCE_HPP
#include <terra/c_api/terra.h>
#include <terra/frame/surface_source.hpp>
namespace terra {
namespace c_api_detail {
// plan_id0: resident resource. Nonzero: current prepared plan only. The returned
// reader owns real loans; adoption must still validate the original plan/view.
bool borrow_surface_source(const terra_context* context, std::uint32_t plan_id,
                          std::uint32_t resource_id, frame::surface_source& output,
                          imagery::node_key* anchor=nullptr);
}
}
#endif
