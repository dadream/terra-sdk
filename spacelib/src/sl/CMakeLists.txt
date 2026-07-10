#+++HDR+++
#======================================================================
#  This file is part of the SL software library.
#
#  Copyright (C) 1993-2010 by Enrico Gobbetti (gobbetti@crs4.it)
#  Copyright (C) 1996-2010 by CRS4 Visual Computing Group, Pula, Italy
#
#  For more information, visit the CRS4 Visual Computing Group 
#  web pages at http://www.crs4.it/vvr/.
#
#  This file may be used under the terms of the GNU General Public
#  License as published by the Free Software Foundation and appearing
#  in the file LICENSE included in the packaging of this file.
#
#  CRS4 reserves all rights not expressly granted herein.
#  
#  This file is provided AS IS with NO WARRANTY OF ANY KIND, 
#  INCLUDING THE WARRANTY OF DESIGN, MERCHANTABILITY AND FITNESS 
#  FOR A PARTICULAR PURPOSE.
#
#======================================================================
#---HDR---#
PROJECT(sl)

SET(${PROJECT_NAME}_SRCS
	argument_parser.cpp
	arithmetic_codec.cpp
	assert.cpp
	benchmarker.cpp
	clock.cpp
	cstdint.cpp
	hash.cpp
	hidwt_array_codec.cpp
	micro_jpgls_array_codec.cpp
	os_file.cpp
	primitive_sampler.cpp
	quantized_array_codec.cpp
	random.cpp
	serializer.cpp
	tester.cpp
	thread.cpp
	time_duration.cpp
	time_monitor.cpp
	triangle_mesh_stripifier.cpp
	utility.cpp
)

SET(${PROJECT_NAME}_HDRS
	affine_map.hpp
	any.hpp
	any_extractor.hpp
	argument_parser.hpp
	arithmetic_codec.hpp
	array_codec.hpp
	assert.hpp
	axis_aligned_box.hpp
	ball.hpp
	benchmarker.hpp
	bitops.hpp
	bounded_scalar.hpp
	bounding_volume.hpp
	buffer_serializer.hpp
	cartesian_frame.hpp
	cast.hpp
	cell_octree.hpp
	cell_vertex_octree.hpp
	cie.hpp
	clock.hpp
	compact_bitio.hpp
	config.hpp
	connectivity.hpp
	convex_hull.hpp
	cstdint.hpp
	cubature_rule.hpp
	dense_array.hpp
	embedded_zerotree_codec.hpp
	encdec.hpp
	external_array.hpp
	ezw_array_codec.hpp
	fastest.hpp
	fem_basis.hpp
	fem_coupling.hpp
	fifo_cache_simulator.hpp
	fixed_ac_int_codec.hpp
	fixed_huffman_rle_codec.hpp
	fixed_rc_int_codec.hpp
	fixed_size_array.hpp
	fixed_size_line.hpp
	fixed_size_line_segment.hpp
	fixed_size_matrix.hpp
	fixed_size_packed_matrix.hpp
	fixed_size_plane.hpp
	fixed_size_point.hpp
	fixed_size_quadric_matrix.hpp
	fixed_size_ray.hpp
	fixed_size_square_matrix.hpp
	fixed_size_tetrahedron.hpp
	fixed_size_vector.hpp
	fixed_unit_real.hpp
	floating_cone.hpp
	float_cast.hpp
	fsb_allocator.hpp
	generative_types.hpp
	geometric_bandelet_array_codec.hpp
	gl_image.hpp
	halton_sequence.hpp
	hash.hpp
	hidwt_array_codec.hpp
	identity_map.hpp
	index.hpp
	indexed.hpp
	indexed_assign.hpp
	indexed_compare.hpp
	indexed_container.hpp
	indexed_functions.hpp
	indexed_io.hpp
	indexed_iterator.hpp
	indexed_manifest_initializer.hpp
	indexed_subscript_remapping.hpp
	index_range.hpp
	integer.hpp
	interpolation.hpp
	interval.hpp
	iterator.hpp
	kdtree.hpp
	kd_tree.hpp
	keyed_heap.hpp
	linear_map.hpp
	linear_map_factory.hpp
	lsq_absolute_orientation.hpp
	manifest_array_initializer.hpp
	math.hpp
	memory_pool.hpp
	micro_jpgls_array_codec.hpp
	minimal_area_triangulator.hpp
	normal_compressor.hpp
	numeric_array_iterator.hpp
	numeric_traits.hpp
	octree_base.hpp
	octree_indexing.hpp
	operators.hpp
	oriented_box.hpp
	os_file.hpp
	plhaar.hpp
	polygon.hpp
	primitive_sampler.hpp
	projective_map.hpp
	quantized_array_codec.hpp
	quaternion.hpp
	random.hpp
	randomized_kd_tree.hpp
	range_codec.hpp
	ransac_absolute_orientation.hpp
	rigid_body_map.hpp
	serializer.hpp
	sgistl.hpp
	shaft.hpp
	smart_pointer.hpp
	sort.hpp
	sorted_vector_set.hpp
	sparse_array.hpp
	std_serializer.hpp
	stl_container_selector.hpp
	stlext_unordered_containers.hpp
	tester.hpp
	thread.hpp
	time_duration.hpp
	time_monitor.hpp
	time_point.hpp
	triangle_mesh.hpp
	triangle_mesh_distance_sampler.hpp
	triangle_mesh_edge_collapser.hpp
	triangle_mesh_interior_culler.hpp
	triangle_mesh_refiner.hpp
	triangle_mesh_smoother.hpp
	triangle_mesh_stripifier.hpp
	triangle_mesh_uniform_remesher.hpp
	triangle_mesh_utilities.hpp
	triangle_mesh_vertex_clusterer.hpp
	triple.hpp
	type_traits.hpp
	uniform_grid_container.hpp
	utility.hpp
	vector_set.hpp
	wavelet_array_codec.hpp
	wavelet_transform.hpp
	xpr.hpp
)

SET(${PROJECT_NAME}_CONFIG 
	"${SL_GENERATED_INCLUDE_DIR}/sl/config/config.h"
)

ADD_LIBRARY(${PROJECT_NAME} STATIC ${${PROJECT_NAME}_SRCS})
TARGET_INCLUDE_DIRECTORIES(${PROJECT_NAME} PUBLIC
  "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/..>"
  "$<BUILD_INTERFACE:${SL_GENERATED_INCLUDE_DIR}>"
  "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>"
)

IF(HAVE_WIN32_THREADS) 
  MESSAGE("-- ${PROJECT_NAME} lib using win32 threads")
ELSE(HAVE_WIN32_THREADS) 
  IF(HAVE_POSIX_THREADS) 
    TARGET_LINK_LIBRARIES(${PROJECT_NAME} ${CMAKE_THREAD_LIBS_INIT})
    MESSAGE("-- ${PROJECT_NAME} lib with POSIX threads using thread library from ${CMAKE_THREAD_LIBS_INIT}")
  ELSE(HAVE_POSIX_THREADS)
    MESSAGE("-- ${PROJECT_NAME} libs without threads")
  ENDIF(HAVE_POSIX_THREADS)
ENDIF(HAVE_WIN32_THREADS)

# -- Install

INSTALL(FILES ${${PROJECT_NAME}_HDRS} DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/sl)
INSTALL(FILES ${${PROJECT_NAME}_CONFIG} DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/sl/config)

INSTALL(TARGETS ${PROJECT_NAME}
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
)
