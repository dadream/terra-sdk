#include <vic/math/SS.h>
#include <vic/math/differential_evolution_minimizer.hpp>
#include <vic/math/nelder_mead_minimizer.hpp>
#include <vic/math/scalar_functor.hpp>
#include <vic/math/scalar_functor_solver.hpp>
#include <vic/math/scatter_search_minimizer.hpp>
#include <vic/xml/document.hpp>

#include <cmath>
#include <iostream>
#include <sstream>
#include <string>

namespace {

bool almost_equal(double lhs, double rhs, double epsilon = 1e-9) {
  return std::fabs(lhs - rhs) <= epsilon;
}

double quadratic_objective(void*, double* x) {
  const double dx = x[0] - 2.0;
  const double dy = x[1] + 1.0;
  return dx * dx + dy * dy;
}

int fail(const std::string& message);

class sum_functor : public vic::math::scalar_functor<double, double> {
public:
  sum_functor() : vic::math::scalar_functor<double, double>(2) {}

  double operator()(const double* x) const {
    return x[0] + x[1];
  }
};

class bounded_quadratic_functor
    : public vic::math::scalar_functor<double, double> {
public:
  bounded_quadratic_functor() : vic::math::scalar_functor<double, double>(2) {}

  double operator()(const double* x) const {
    const double dx = x[0] - 1.0;
    const double dy = x[1] + 2.0;
    return dx * dx + dy * dy;
  }
};

int check_scalar_functor_solver(sum_functor& fn) {
  vic::math::scalar_functor_solver<double, double> solver;
  if (solver.arg_dimension() != 0 || solver.step_count() != 0 ||
      solver.max_step_count() != 1 || solver.objective_function() != 0) {
    return fail("vic::math::scalar_functor_solver default state changed");
  }

  solver.set_objective_function(&fn);
  const double args[2] = {5.0, -2.0};
  if (solver.objective_function() != &fn || solver.arg_dimension() != 2 ||
      !almost_equal(solver.fn(args), 3.0)) {
    return fail("vic::math::scalar_functor_solver objective binding failed");
  }

  solver.set_max_step_count(2);
  solver.restart();
  if (solver.step_count() != 0 || !almost_equal(solver.best_value(), 0.0) ||
      solver.stop_solving()) {
    return fail("vic::math::scalar_functor_solver restart contract changed");
  }

  solver.solve_step();
  if (solver.step_count() != 1 || solver.stop_solving()) {
    return fail("vic::math::scalar_functor_solver single step changed");
  }

  solver.solve();
  if (solver.step_count() != 3 || !solver.stop_solving()) {
    return fail("vic::math::scalar_functor_solver solve stop contract changed");
  }

  return 0;
}

int check_scatter_search_minimizer() {
  bounded_quadratic_functor objective;
  vic::math::scatter_search_minimizer<double, double> minimizer;
  minimizer.set_objective_function(&objective);

  if (minimizer.diversity_set_count() != 10 ||
      minimizer.quality_set_count() != 10 ||
      minimizer.reference_set_count() != 20 ||
      minimizer.diversificator_set_count() != 100 ||
      minimizer.max_step_count() != 20 ||
      !minimizer.is_local_optimization_enabled()) {
    return fail("vic::math::scatter_search_minimizer defaults changed");
  }

  minimizer.set_diversity_set_count(3);
  minimizer.set_quality_set_count(2);
  minimizer.set_diversificator_set_count(12);
  minimizer.set_is_local_optimization_enabled(false);
  minimizer.set_max_step_count(1);
  if (minimizer.diversity_set_count() != 3 ||
      minimizer.quality_set_count() != 2 ||
      minimizer.reference_set_count() != 5 ||
      minimizer.diversificator_set_count() != 12 ||
      minimizer.is_local_optimization_enabled()) {
    return fail("vic::math::scatter_search_minimizer configuration failed");
  }

  const double arg_min[2] = {-4.0, -4.0};
  const double arg_max[2] = {4.0, 4.0};
  minimizer.set_arg_bounds(arg_min, arg_max);
  minimizer.solve_step();

  const double* best_arg = minimizer.best_argument();
  const double best_value = minimizer.best_value();
  if (minimizer.step_count() != 1 ||
      best_arg[0] < arg_min[0] || best_arg[0] > arg_max[0] ||
      best_arg[1] < arg_min[1] || best_arg[1] > arg_max[1] ||
      !(best_value >= 0.0 && best_value <= 1000.0) ||
      !almost_equal(best_value, objective(best_arg), 1e-6)) {
    return fail("vic::math::scatter_search_minimizer bounded step failed");
  }

  return 0;
}

int check_nelder_mead_minimizer() {
  bounded_quadratic_functor objective;
  vic::math::nelder_mead_minimizer<double, double> minimizer;
  minimizer.set_objective_function(&objective);
  minimizer.set_max_step_count(2);

  const double start[2] = {0.0, 0.0};
  minimizer.set_starting_guess(start);
  minimizer.solve_step();

  const double* best_arg = minimizer.best_argument();
  const double best_value = minimizer.best_value();
  if (minimizer.step_count() != 1 ||
      !std::isfinite(best_arg[0]) || !std::isfinite(best_arg[1]) ||
      !std::isfinite(best_value) || best_value < 0.0 ||
      best_value > 20.0 ||
      !almost_equal(best_value, objective(best_arg), 1e-6)) {
    return fail("vic::math::nelder_mead_minimizer single step failed");
  }

  return 0;
}

int check_differential_evolution_minimizer() {
  bounded_quadratic_functor objective;
  vic::math::differential_evolution_minimizer<double, double> minimizer;
  minimizer.set_objective_function(&objective);

  if (minimizer.mutation_strategy() !=
          vic::math::differential_evolution_minimizer<double, double>::
              stRand1Exp ||
      !almost_equal(minimizer.mutation_scale(), 0.8) ||
      !almost_equal(minimizer.crossover_probability(), 0.9) ||
      minimizer.population_count() != 8 ||
      !minimizer.are_bound_constrains_enabled()) {
    return fail("vic::math::differential_evolution_minimizer defaults changed");
  }

  minimizer.set_mutation_strategy(
      vic::math::differential_evolution_minimizer<double, double>::stRand1Bin);
  minimizer.set_mutation_scale(0.5);
  minimizer.set_crossover_probability(1.0);
  minimizer.set_population_count(3);
  minimizer.set_max_step_count(1);
  if (minimizer.mutation_strategy() !=
          vic::math::differential_evolution_minimizer<double, double>::
              stRand1Bin ||
      !almost_equal(minimizer.mutation_scale(), 0.5) ||
      !almost_equal(minimizer.crossover_probability(), 1.0) ||
      minimizer.population_count() != 8) {
    return fail("vic::math::differential_evolution_minimizer configuration failed");
  }

  const double arg_min[2] = {-4.0, -4.0};
  const double arg_max[2] = {4.0, 4.0};
  minimizer.set_arg_bounds(arg_min, arg_max);
  minimizer.solve_step();

  const double* best_arg = minimizer.best_argument();
  const double best_value = minimizer.best_value();
  if (minimizer.step_count() != 1 ||
      best_arg[0] < arg_min[0] || best_arg[0] > arg_max[0] ||
      best_arg[1] < arg_min[1] || best_arg[1] > arg_max[1] ||
      !std::isfinite(best_value) || best_value < 0.0 ||
      best_value > 1000.0 ||
      !almost_equal(best_value, objective(best_arg), 1e-6)) {
    return fail(
        "vic::math::differential_evolution_minimizer bounded step failed");
  }

  vic::math::differential_evolution_minimizer<double, double> rand2_minimizer;
  rand2_minimizer.set_objective_function(&objective);
  rand2_minimizer.set_mutation_strategy(
      vic::math::differential_evolution_minimizer<double, double>::stRand2Bin);
  rand2_minimizer.set_crossover_probability(1.0);
  rand2_minimizer.set_max_step_count(1);
  rand2_minimizer.set_arg_bounds(arg_min, arg_max);
  rand2_minimizer.solve_step();

  const double* rand2_best_arg = rand2_minimizer.best_argument();
  const double rand2_best_value = rand2_minimizer.best_value();
  if (rand2_minimizer.step_count() != 1 ||
      rand2_best_arg[0] < arg_min[0] || rand2_best_arg[0] > arg_max[0] ||
      rand2_best_arg[1] < arg_min[1] || rand2_best_arg[1] > arg_max[1] ||
      !std::isfinite(rand2_best_value) || rand2_best_value < 0.0 ||
      rand2_best_value > 1000.0 ||
      !almost_equal(rand2_best_value, objective(rand2_best_arg), 1e-6)) {
    return fail(
        "vic::math::differential_evolution_minimizer Rand2 step failed");
  }

  return 0;
}

int fail(const std::string& message) {
  std::cerr << "SDK smoke failed: " << message << std::endl;
  return 1;
}

int check_math() {
  double args[2] = {2.0, -1.0};
  SS* problem = SSnew(0, quadratic_objective, 2, 1, 1, 2, 0);
  if (!problem) {
    return fail("SSnew returned null");
  }

  const double value = problem->evaluate(problem->userdata, args);
  const float random_value = SSrandNum(problem);
  SSdelete(problem);

  if (std::fabs(value) > 1e-12) {
    return fail("vic_math objective callback returned unexpected value");
  }
  if (!(random_value >= 0.0f && random_value <= 1.0f)) {
    return fail("vic_math random generator returned value outside [0, 1]");
  }

  sum_functor fn;
  const double sum_args[2] = {3.0, 4.0};
  if (fn.arg_dimension() != 2 || std::fabs(fn(sum_args) - 7.0) > 1e-12) {
    return fail("vic::math::scalar_functor contract changed");
  }

  if (int status = check_scalar_functor_solver(fn)) {
    return status;
  }
  if (int status = check_scatter_search_minimizer()) {
    return status;
  }
  if (int status = check_nelder_mead_minimizer()) {
    return status;
  }
  if (int status = check_differential_evolution_minimizer()) {
    return status;
  }

  return 0;
}

int check_xml() {
  std::istringstream input(
      "<root version=\"7\" origin=\"1.5 -2.25 3.75\" iv=\"1 2 3\" "
      "fv=\"0.5 1.5 2.5\" dv=\"10.25 -3.5\">"
      "<child value=\"42\" scale=\"2.5\">99</child>"
      "<sibling flag=\"8\">3.25</sibling>"
      "</root>");
  vic::xml::document doc;
  doc.parse(input);
  if (doc.error()) {
    return fail(std::string("vic_xml parse error: ") + doc.error_msg());
  }

  vic::xml::node_iterator root = doc.first_root("root");
  if (root.is_null() || root.tag() != "root") {
    return fail("vic_xml root lookup failed");
  }
  if (root.attributei("version") != 7) {
    return fail("vic_xml integer attribute conversion failed");
  }
  if (!root.has_attribute("origin") || root.has_attribute("missing")) {
    return fail("vic_xml attribute presence check failed");
  }
  if (root.attribute("missing", "fallback") != "fallback" ||
      root.attributei("missing_i", "17") != 17 ||
      !almost_equal(root.attributed("missing_d", "4.5"), 4.5) ||
      !almost_equal(root.attributef("missing_f", "1.25"), 1.25)) {
    return fail("vic_xml default attribute conversion failed");
  }

  const vic::xml::node_iterator::point3d_t origin =
      root.attributep("origin");
  if (!almost_equal(origin.c[0], 1.5) ||
      !almost_equal(origin.c[1], -2.25) ||
      !almost_equal(origin.c[2], 3.75)) {
    return fail("vic_xml point attribute conversion failed");
  }

  int iv[3] = {0, 0, 0};
  float fv[3] = {0.0f, 0.0f, 0.0f};
  double dv[2] = {0.0, 0.0};
  root.attributeiv("iv", iv, 3);
  root.attributefv("fv", fv, 3);
  root.attributedv("dv", dv, 2);
  if (iv[0] != 1 || iv[1] != 2 || iv[2] != 3 ||
      !almost_equal(fv[0], 0.5) || !almost_equal(fv[1], 1.5) ||
      !almost_equal(fv[2], 2.5) || !almost_equal(dv[0], 10.25) ||
      !almost_equal(dv[1], -3.5)) {
    return fail("vic_xml vector attribute conversion failed");
  }

  vic::xml::node_iterator child = root.down();
  if (child.is_null() || child.tag() != "child") {
    return fail("vic_xml child traversal failed");
  }
  if (child.attributei("value") != 42) {
    return fail("vic_xml child attribute conversion failed");
  }
  if (!almost_equal(child.attributed("scale"), 2.5)) {
    return fail("vic_xml child double attribute conversion failed");
  }

  vic::xml::node_iterator text = child.down();
  if (text.is_null() || !text.is_text_node() || text.texti() != 99) {
    return fail("vic_xml text node conversion failed");
  }

  vic::xml::node_iterator sibling = child.next();
  if (sibling.is_null() || sibling.tag() != "sibling" ||
      sibling.attributei("flag") != 8) {
    return fail("vic_xml sibling traversal failed");
  }
  if (sibling.up().is_null() || sibling.up().tag() != "root") {
    return fail("vic_xml parent traversal failed");
  }
  if (sibling.down().is_null() ||
      !almost_equal(sibling.down().textd(), 3.25)) {
    return fail("vic_xml floating text conversion failed");
  }
  if (!doc.first_root("missing").is_null()) {
    return fail("vic_xml missing root lookup failed");
  }

  child.attribute("missing");
  if (!child.error() || child.error_msg().empty()) {
    return fail("vic_xml missing attribute did not set node error");
  }
  child.clear_error();
  if (child.error()) {
    return fail("vic_xml node error reset failed");
  }

  std::istringstream invalid_input("<root><broken></root>");
  vic::xml::document invalid_doc;
  invalid_doc.parse(invalid_input);
  if (!invalid_doc.error() || invalid_doc.error_msg().empty()) {
    return fail("vic_xml invalid document did not report parse error");
  }

  return 0;
}

}  // namespace

int main() {
  if (int status = check_math()) {
    return status;
  }
  if (int status = check_xml()) {
    return status;
  }
  std::cout << "SDK smoke passed: vic_base_math and vic_base_xml" << std::endl;
  return 0;
}
