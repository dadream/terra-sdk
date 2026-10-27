// Test-only inspection of the real C API implementation. This replaces its
// translation unit in the diagnostic target; no production export is added.
#include "../../../sdk/src/c_api/terra.cpp"

extern "C" std::uint32_t test_mesh_residency(const terra_context* context,
    std::uint32_t after, std::uint32_t capacity, std::uint32_t* rows) {
  if (!context || !rows || capacity > 64U) return UINT32_MAX;
  std::uint32_t count = 0U;
  const auto occurrences = [](const std::vector<std::shared_ptr<terra_mesh_resource>>& values,
                              const terra_mesh_resource* resource) {
    return static_cast<std::uint32_t>(std::count_if(values.begin(), values.end(),
        [resource](const std::shared_ptr<terra_mesh_resource>& value) { return value.get() == resource; }));
  };
  for (auto it = context->mesh_registry.upper_bound(after);
       it != context->mesh_registry.end() && count < capacity; ++it) {
    const auto resource = it->second.lock();
    if (!resource) continue;
    const auto key = to_key(resource->mesh.patch);
    const terra_surface_key surface{key, resource->mesh.fragment};
    const auto cached = context->surface_cache.find(surface);
    const bool owns_cache = cached != context->surface_cache.end() && cached->second.resource == resource;
    const auto loan = context->mesh_loans.find(resource->id);
    auto* row = rows + count++ * 20U;
    row[0] = resource->id; row[1] = key.level;
    row[2] = static_cast<std::uint32_t>(key.i); row[3] = static_cast<std::uint32_t>(key.j);
    row[4] = static_cast<std::uint32_t>(key.k); row[5] = resource->mesh.fragment;
    row[6] = static_cast<std::uint32_t>(resource->mesh.positions_xyz.capacity() * sizeof(float));
    row[7] = static_cast<std::uint32_t>(resource->texture_id);
    row[8] = static_cast<std::uint32_t>(resource->texture_id >> 32U);
    row[9] = static_cast<std::uint32_t>(resource->texture_uv->values.capacity() * sizeof(float));
    row[10] = static_cast<std::uint32_t>(resource.use_count() - 1U);
    row[11] = owns_cache ? 1U : 0U;
    row[12] = occurrences(context->output.frame_surfaces, resource.get());
    row[13] = occurrences(context->presented_surfaces, resource.get());
    row[14] = context->prepared_mesh ? occurrences(context->prepared_mesh->output.frame_surfaces, resource.get()) : 0U;
    row[15] = loan == context->mesh_loans.end() ? 0U : loan->second.second;
    row[16] = owns_cache ? static_cast<std::uint32_t>(cached->second.last_used_sequence) : 0U;
    row[17] = static_cast<std::uint32_t>(context->sequence);
    row[18] = static_cast<std::uint32_t>(resource->texture_uv.use_count());
    row[19] = 0U;
    if (context->prepared_mesh) for (const auto& input : context->prepared_mesh->replacement_inputs)
      if (input.resource == resource) ++row[19];
  }
  return count;
}
