#include "imagery.hpp"
#include "../support/terrain_replay.hpp"

#include <terra/frame/imagery.hpp>
#include <terra/frame/surface_measurement.hpp>
#include <terra/imagery/adapter.hpp>
#include <vic/cbdam/base/grid_texture_quadtree.hpp>

#include <ctime>

namespace terra_benchmark {
namespace {
using namespace terra;
using frame::imagery_controller;
using imagery::node_key;
constexpr std::size_t safety_bytes = 512U * 1024U * 1024U;
double cpu() { return 1000.0 * std::clock() / CLOCKS_PER_SEC; }
std::string node_id(const node_key& n) {
  return std::to_string(n.level)+"/"+std::to_string(n.row)+"/"+std::to_string(n.column);
}
void strings(std::ostream& out, const std::set<std::string>& values) {
  out << '[';
  bool first = true;
  for (const auto& value : values) { if (!first) out << ','; first = false; out << std::quoted(value); }
  out << ']';
}
core::bounds2d cell(const node_key& source, const node_key& tile) {
  const double scale = std::ldexp(1.0,tile.level-source.level);
  const double u = tile.column/scale-source.column, v = tile.row/scale-source.row;
  return {{{u,v}},{{u+1.0/scale,v+1.0/scale}}};
}
bool overlap(const core::bounds2d& a, const core::bounds2d& b) {
  return a.minimum[0]<b.maximum[0] && a.maximum[0]>b.minimum[0] &&
      a.minimum[1]<b.maximum[1] && a.maximum[1]>b.minimum[1];
}
bool intersects_hull(const std::vector<core::vector2d>& hull, const core::bounds2d& box) {
  for (std::size_t i=0U;i<hull.size();++i) {
    const auto& a=hull[i]; const auto& b=hull[(i+1U)%hull.size()];
    const double dx=b[0]-a[0],dy=b[1]-a[1];
    const double u=dy>0.0?box.minimum[0]:box.maximum[0];
    const double v=dx>0.0?box.maximum[1]:box.minimum[1];
    if (dx*(v-a[1])-dy*(u-a[0])<=0.0) return false;
  }
  return true;
}
using polygon=std::vector<core::vector2d>;
polygon clip_polygon(const polygon& input,const core::vector2d& a,const core::vector2d& b) {
  polygon output;
  const auto distance=[&](const core::vector2d& p) {
    return (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
  };
  for (std::size_t i=0U;i<input.size();++i) {
    const auto& p=input[i]; const auto& q=input[(i+1U)%input.size()];
    const double dp=distance(p),dq=distance(q);
    if (dp>=0.0) output.push_back(p);
    if ((dp<0.0)!=(dq<0.0)) {
      const double t=dp/(dp-dq);
      output.push_back({{p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])}});
    }
  }
  return output;
}
polygon rectangle(const core::bounds2d& b) {
  return {b.minimum,{{b.maximum[0],b.minimum[1]}},b.maximum,{{b.minimum[0],b.maximum[1]}}};
}
polygon intersect_polygon(polygon p,const polygon& clip) {
  for (std::size_t i=0U;i<clip.size() && !p.empty();++i)
    p=clip_polygon(p,clip[i],clip[(i+1U)%clip.size()]);
  return p;
}
double area(const polygon& p) {
  double result=0.0;
  for (std::size_t i=1U;i+1U<p.size();++i)
    result+=(p[i][0]-p[0][0])*(p[i+1U][1]-p[0][1])-
        (p[i][1]-p[0][1])*(p[i+1U][0]-p[0][0]);
  return result/2.0;
}

// Valid prebuilt CPU RGBA image, copied into the original desktop cache.
// Copies are timed separately; no image is claimed to be downloaded.
class fixture_fetcher : public cbdam::geoimage_quad_fetcher {
  std::unique_ptr<value_t> image_;
 public:
  std::size_t copies=0U;
  double copy_cpu=0.0;
  explicit fixture_fetcher(unsigned width) : geoimage_quad_fetcher("headless-image-fixture",
      "EPSG:4326",cbdam::aabox2d_t(cbdam::point2d_t(-180,-90),cbdam::point2d_t(180,90)),width) {
    vic::img::gl_image<> image(4,width,width);
    image.fill(127,127,127,255);
    image_.reset(new value_t(image));
  }
  void connect() override { is_connected_=true; }
  status_data_pair_t fetch(const key_t&, const cbdam::aabox2d_t&) override {
    const double start=cpu();
    auto* value=new value_t(*image_);
    copy_cpu+=cpu()-start; ++copies;
    return {DONE,value};
  }
  status_data_pair_t synchronous_fetch(const key_t& k,const cbdam::aabox2d_t& b,int) override {
    return fetch(k,b);
  }
  void prefetch(const key_t&,const cbdam::aabox2d_t&) override {}
  void receive() override {}
};
class observed_tree : public cbdam::grid_texture_quadtree {
 public:
  std::vector<node_key> leaves() const {
    std::vector<node_key> result;
    for (const auto* level : diamond_map_by_level_) for (const auto& entry : *level)
      if (entry.second.is_leaf()) {
        require(entry.second.reference_counted_image()!=nullptr,"desktop imagery leaf lacks fixture");
        const auto& lxy=entry.second.level_xy_id();
        const node_key tile(lxy[0],(2<<lxy[0])-1-lxy[2],lxy[1]);
        const auto& d=entry.first;
        core::grid_diamond converted({{d.corner(0)[0],d.corner(0)[1],d.corner(0)[2]}},
            {{d.corner(1)[0],d.corner(1)[1],d.corner(1)[2]}},
            {{d.corner(2)[0],d.corner(2)[1],d.corner(2)[2]}},
            {{d.corner(3)[0],d.corner(3)[1],d.corner(3)[2]}});
        require(node_id(tile)==node_id(imagery::terrain_anchor(converted,2U*lxy[0],0U,true)),
                "desktop/unified imagery coordinates differ");
        result.push_back(tile);
      }
    return result;
  }
  std::pair<std::size_t,std::size_t> pending() const {
    std::pair<std::size_t,std::size_t> result{};
    for (auto it=refinement_heap_.begin();it!=refinement_heap_.end();++it)
      if (it->first.priority()>0.0) ++result.first;
    for (auto it=coarsening_heap_.begin();it!=coarsening_heap_.end();++it)
      if (it->first.priority()<0.0) ++result.second;
    return result;
  }
  std::size_t neutral_coarsen_candidates() const {
    std::size_t count=0U;
    for (auto it=coarsening_heap_.begin();it!=coarsening_heap_.end();++it)
      if (it->first.priority()==0.0) ++count;
    return count;
  }
};
struct measured_surface {
  node_key source;
  std::shared_ptr<const frame::imagery_surface_input> input;
};
}

struct imagery_driver::state {
  imagery_configuration config;
  core::payload_budget workspace{safety_bytes};
  imagery_controller controller;
  imagery::source_descriptor source;
  std::unique_ptr<fixture_fetcher> fetcher;
  std::unique_ptr<cbdam::cylindrical_coordinate_transform> transform;
  std::unique_ptr<cbdam::texture_refiner_grid_diamond_graph> refiner;
  std::unique_ptr<observed_tree> tree;
  double initialization_cpu=0.0;
  std::size_t initialization_copies=0U;
  bool first_run=true;
  explicit state(const imagery_configuration& c,cbdam::grid_diamond_graph_incore* graph) : config(c) {
    const double start=cpu();
    source.id="tianditu-img-c"; source.tile_size=c.tile_size;
    for (unsigned level=0U;level<=c.maximum_level+1U;++level)
      source.matrices.push_back({std::to_string(level+1U),2<<level,1<<level});
    if (graph) {
      fetcher.reset(new fixture_fetcher(c.tile_size));
      transform.reset(new cbdam::cylindrical_coordinate_transform(c.surface.radius));
      refiner.reset(new cbdam::texture_refiner_grid_diamond_graph(graph));
      tree.reset(new observed_tree());
      tree->set_texture_refiner(refiner.get());
      tree->set_decoded_diamond_budget(32U);
      tree->open(fetcher.get(),transform.get(),0U,c.maximum_level);
      require(tree->is_open() && tree->root_count()==8U,"desktop imagery roots unavailable");
      tree->init_heaps();
      initialization_copies=fetcher->copies;
    }
    initialization_cpu=cpu()-start;
  }
  std::string physical_key(const node_key& n) const {
    imagery::texture_binding binding;
    require(imagery::bind_node(imagery::texture_model(),n,source,n.level+1,binding),
            "imagery source binding failed");
    return binding.resource.source+"/"+binding.resource.matrix+"/"+
        std::to_string(binding.resource.row)+"/"+std::to_string(binding.resource.column);
  }
  measured_surface measure(const frame::camera_snapshot& camera,
                            const std::shared_ptr<const frame::patch_surface_mesh>& mesh,
                            std::size_t& operations) {
    require(bool(mesh),"missing imagery surface mesh");
    frame::surface_source input(mesh,nullptr,nullptr,config.surface);
    require(input.valid(),"invalid imagery surface reader");
    frame::surface_model_work build(input,workspace);
    require(build.admit(),"imagery model safety capacity reached");
    frame::surface_model model;
    const auto start=clock_type::now();
    while (!model) {
      const auto progress=build.step(4096U);
      operations+=progress.operations;
      require(elapsed(start)<30000.0,"imagery model watchdog");
      if (progress.status==frame::surface_model_status::complete) model=build.take_model();
      else require(progress.status==frame::surface_model_status::building,"imagery model failed");
    }
    frame::triangle_projection_context projection;
    projection.matrix=camera.projection_view; projection.origin=mesh->origin;
    projection.scale_x=config.width/2.0; projection.scale_y=config.height/2.0;
    projection.cull=true;
    frame::surface_measurement_options options; options.tight=true;
    frame::surface_measurement_work measurement(std::move(model),projection,workspace,options);
    for (;;) {
      const auto progress=measurement.step(4096U);
      operations+=progress.operations;
      require(elapsed(start)<30000.0,"imagery measurement watchdog");
      using status=frame::surface_measurement_status;
      if (progress.status==status::complete) return {mesh->texture_node,measurement.take_input()};
      if (progress.status==status::waiting_for_work) {
        core::payload_budget::credit credit;
        require(workspace.reserve(progress.required_work_bytes,credit) && measurement.admit_work(credit),
                "imagery measurement safety capacity reached");
      } else if (progress.status==status::waiting_for_input) {
        require(measurement.admit_input(controller,mesh->texture_node,safety_bytes),
                "imagery canonical input capacity reached");
      } else require(progress.status==status::measuring || progress.status==status::copying ||
          progress.status==status::normalizing,"imagery measurement failed");
    }
  }
};

imagery_driver::imagery_driver(const imagery_configuration& c,cbdam::grid_diamond_graph_incore* desktop)
    : state_(new state(c,desktop)) {}
imagery_driver::~imagery_driver()=default;

std::string imagery_driver::run(const frame::camera_snapshot& camera,
    std::size_t fragments,const mesh_reader& read) {
  auto& s=*state_;
  const double start=cpu();
  std::vector<measured_surface> measured;
  std::vector<frame::imagery_surface> inputs;
  std::size_t operations=0U;
  for (std::size_t i=0U;i<fragments;++i) {
    auto surface=s.measure(camera,read(i),operations);
    if (!surface.input) continue;
    frame::imagery_surface input;
    input.draw_index=static_cast<std::uint32_t>(measured.size());
    input.retained_input=surface.input;
    measured.push_back(std::move(surface)); inputs.push_back(std::move(input));
    require(s.controller.allocated_bytes()<safety_bytes,"imagery input safety memory reached");
  }
  const double preparation=cpu()-start;
  std::size_t steps=0U,changes=0U,priorities=0U;
  double schedule=0.0,maximum_call=0.0;
  std::vector<node_key> tiles;
  frame::imagery_cut cut;
  double fixture_cpu=0.0;
  std::size_t copies=0U;
  const auto schedule_start=clock_type::now();
  if (s.tree) {
    const double copy_before=s.fetcher->copy_cpu;
    const auto copies_before=s.fetcher->copies;
    unsigned quiet=0U;
    do {
      const double before=cpu();
      int count=0;
      s.tree->extract_cut(count,steps==0U);
      const double duration=cpu()-before;
      schedule+=duration; maximum_call=std::max(maximum_call,duration);
      ++steps; changes+=static_cast<std::size_t>(count);
      quiet=count==0?quiet+1U:0U;
      require(elapsed(schedule_start)<30000.0 && s.tree->diamond_count()<65536U,
              "desktop imagery scheduling safety limit reached");
      require(s.tree->texture_cache().size()*s.config.tile_size*s.config.tile_size*4U<safety_bytes,
              "desktop imagery fixture safety memory reached");
    } while (quiet<20U);
    require(s.tree->pending()==std::make_pair(std::size_t(0),std::size_t(0)),
            "desktop imagery stalled with executable work");
    tiles=s.tree->leaves();
    fixture_cpu=s.fetcher->copy_cpu-copy_before; copies=s.fetcher->copies-copies_before;
  } else {
    frame::imagery_budget budget;
    budget.requested_pixel_error=s.config.pixels; budget.tile_size=s.config.tile_size;
    budget.maximum_level=s.config.maximum_level;
    // Demand safety limits, NOT production quotas. Nominal level+1 bindings
    // do not enable the production optional coarse root alias.
    budget.maximum_texture_count=65536U; budget.maximum_draw_count=262144U;
    budget.resource_key=[&s](const node_key& n,double){return s.physical_key(n);};
    const double before=cpu();
    require(s.controller.begin(std::move(inputs),budget),"imagery begin failed");
    schedule+=cpu()-before;
    do {
      const double step_start=cpu();
      cut=s.controller.update_step(32U,256U,0.0);
      const double duration=cpu()-step_start;
      schedule+=duration; maximum_call=std::max(maximum_call,duration);
      ++steps; changes+=cut.change_count; priorities+=cut.priority_update_count;
      require(cut.complete,"invalid SDK imagery cut");
      require(elapsed(schedule_start)<30000.0 && s.controller.allocated_bytes()<safety_bytes,
              "SDK imagery scheduling safety limit reached");
    } while (!cut.decisions_complete || cut.rebuilding || cut.output_pending);
    require(!cut.limited_by_texture_budget && !cut.limited_by_draw_budget && !cut.limited_by_partition_budget,
            "imagery demand safety capacity reached");
    require(bool(cut.draws),"SDK imagery output missing");
    std::map<std::string,node_key> unique;
    for (const auto& draw : *cut.draws) unique.emplace(node_id(draw.tile),draw.tile);
    for (const auto& entry : unique) tiles.push_back(entry.second);
  }

  // Shared quality observer using real projection and error evaluation.
  // It does not choose tiles or replace either scheduler.
  const double observation_start=cpu();
  std::set<std::string> all,visible,resources,anchors;
  std::map<std::string,double> errors;
  double maximum=0.0,partition_area=0.0,uncovered_area=0.0;
  std::size_t coverage_regions=0U;
  for (const auto& tile : tiles) { all.insert(node_id(tile)); partition_area+=std::ldexp(1.0,-2*tile.level); }
  require(all.size()==tiles.size(),"duplicate imagery leaf");
  for (const auto& tile : tiles)
    for (auto parent=tile.parent();parent.is_valid();parent=parent.parent())
      require(!all.count(node_id(parent)),"imagery cut contains overlapping ancestors");
  if (s.tree) require(std::abs(partition_area-8.0)<1e-9,"desktop imagery partition has a coverage hole");
  for (const auto& surface : measured) {
    anchors.insert(node_id(surface.source));
    const auto shape=imagery_controller::input_shape(surface.input);
    std::vector<frame::measurement_region> regions(shape.first);
    std::vector<core::vector2d> hull(shape.second);
    std::size_t count=0U;
    for (std::size_t i=0U;i<regions.size();i+=count)
      require(imagery_controller::read_input(surface.input,i,regions.data()+i,
          std::min<std::size_t>(256U,regions.size()-i),count) && count,"cannot read canonical regions");
    for (std::size_t i=0U;i<hull.size();i+=count)
      require(imagery_controller::read_input_hull(surface.input,i,hull.data()+i,
          std::min<std::size_t>(256U,hull.size()-i),count) && count,"cannot read canonical hull");
    std::vector<polygon> domains;
    std::vector<double> covered(regions.size(),0.0);
    for (const auto& row : regions) {
      polygon domain;
      if (row.flags&2U) domain.assign(row.value.triangle.begin(),row.value.triangle.end());
      else domain=rectangle(row.value.uv);
      if (area(domain)<0.0) std::reverse(domain.begin(),domain.end());
      if (hull.size()>=3U) domain=intersect_polygon(std::move(domain),hull);
      domains.push_back(std::move(domain));
    }
    for (const auto& tile : tiles) {
      if (tile.root(true)!=surface.source.root(true)) continue;
      const auto bounds=cell(surface.source,tile);
      if (hull.size()>=3U && !intersects_hull(hull,bounds)) continue;
      double error=0.0;
      for (std::size_t i=0U;i<regions.size();++i) if (overlap(regions[i].value.uv,bounds)) {
        error=std::max(error,frame::imagery_region_error(regions[i],bounds));
        covered[i]+=area(intersect_polygon(domains[i],rectangle(bounds)));
      }
      error=std::ldexp(error,surface.source.level-tile.level)/s.config.tile_size;
      if (error>0.0) {
        require(std::isfinite(error),"nonfinite imagery precision");
        visible.insert(node_id(tile)); resources.insert(s.physical_key(tile));
        maximum=std::max(maximum,error); errors[node_id(tile)]=std::max(errors[node_id(tile)],error);
      }
    }
    for (std::size_t i=0U;i<regions.size();++i) {
      if (regions[i].value.pixels_per_uv<=0.0) continue;
      const double expected=area(domains[i]);
      if (expected<=0.0) continue;
      ++coverage_regions;
      uncovered_area+=std::max(0.0,expected-covered[i]);
      require(std::abs(covered[i]-expected)<=1e-9*std::max(1.0,expected),
              "imagery leaves do not cover a measured region");
    }
  }
  require(!visible.empty(),"imagery observer saw no visible coverage");
  if (!s.tree) require(std::abs(maximum-cut.maximum_pixel_error)<=1e-6*std::max(1.0,maximum),
                      "imagery quality observer disagrees with SDK planner");
  std::size_t level_limited=0U,policy_limited=0U;
  for (const auto& tile : tiles) {
    const auto found=errors.find(node_id(tile));
    if (found==errors.end() || found->second<=s.config.pixels*(1.0+1e-6)) continue;
    if (tile.level==static_cast<int>(s.config.maximum_level)) ++level_limited;
    else ++policy_limited;
  }
  std::ostringstream out;
  out << std::setprecision(17) << "{\"schema\":\"terra.imagery-target.v1\",\"status\":\"ready\","
      << "\"targetMet\":" << (maximum<=s.config.pixels*(1.0+1e-6)?"true":"false")
      << ",\"sourceLimited\":" << (level_limited?"true":"false")
      << ",\"levelLimitedTiles\":" << level_limited << ",\"policyLimitedTiles\":" << policy_limited
      << ",\"nativeLevelLimitFlag\":" << (cut.limited_by_level?"true":"false")
      << ",\"coverageRegions\":" << coverage_regions << ",\"uncoveredUvArea\":" << uncovered_area
      << ",\"initializationCpuMs\":" << (s.first_run?s.initialization_cpu:0.0)
      << ",\"initializationFixtureCopies\":" << (s.first_run?s.initialization_copies:0U)
      << ",\"maximumPixelError\":" << maximum << ",\"requestedPixelError\":" << s.config.pixels
      << ",\"preparationCpuMs\":" << preparation << ",\"preparationOperations\":" << operations
      << ",\"scheduleCpuMs\":" << std::max(0.0,schedule-fixture_cpu)
      << ",\"maximumScheduleCallCpuMs\":" << maximum_call
      << ",\"fixtureCopyCpuMs\":" << fixture_cpu << ",\"fixtureCopies\":" << copies
      << ",\"observationCpuMs\":" << cpu()-observation_start
      << ",\"steps\":" << steps << ",\"changes\":" << changes << ",\"priorityUpdates\":";
  if (s.tree) out << "null"; else out << priorities;
  out << ",\"plannerOwnedBytes\":" << s.controller.allocated_bytes()
      << ",\"plannerPeakBytes\":" << s.controller.peak_allocated_bytes()
      << ",\"preparationPeakBytes\":" << s.workspace.peak_bytes()
      << ",\"desktopFixtureCacheBytes\":" << (s.tree?s.tree->texture_cache().size()*s.config.tile_size*s.config.tile_size*4U:0U)
      << ",\"visibleNominalRgbaBytes\":" << resources.size()*s.config.tile_size*s.config.tile_size*4U
      << ",\"measuredSurfaces\":" << measured.size() << ",\"terrainAnchors\":";
  strings(out,anchors); out << ",\"allKeys\":"; strings(out,all);
  out << ",\"visibleKeys\":"; strings(out,visible);
  out << ",\"physicalKeys\":"; strings(out,resources);
  out << ",\"pixelErrors\":{";
  bool first=true;
  for (const auto& entry : errors) { if (!first) out << ','; first=false; out << std::quoted(entry.first) << ':' << entry.second; }
  out << "},\"neutralCoarsenCandidates\":" << (s.tree?s.tree->neutral_coarsen_candidates():0U) << '}';
  s.first_run=false;
  return out.str();
}
} // namespace terra_benchmark
