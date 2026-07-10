#include <vic/qxml/database.hpp>

#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>

namespace {

struct callback_receiver {
  int calls;
};

int fail(const std::string& message) {
  std::cerr << "SDK smoke failed: " << message << std::endl;
  return 1;
}

void on_database_changed(void* receiver, const vic::qxml::database*) {
  callback_receiver* state = static_cast<callback_receiver*>(receiver);
  ++state->calls;
}

int write_input_xml(const char* path) {
  std::ofstream output(path);
  if (!output) {
    return fail("vic_base_qxml input file creation failed");
  }

  output
      << "<HEAD>"
      << "<METRIC><VALUE units=\"m\">12.5</VALUE></METRIC>"
      << "<FIGLIO sesso=\"M\"><NOME REDDITO=\"123.45\" AUTO=\"6\">"
      << "Carlo</NOME><DESCRIZIONE>Carlo</DESCRIZIONE></FIGLIO>"
      << "<FIGLIO sesso=\"F\"><NOME REDDITO=\"8987656\" AUTO=\"30\">"
      << "Carla</NOME><DESCRIZIONE>Carla</DESCRIZIONE>"
      << "<DESCRIZIONE><NUMERO>123</NUMERO><NUMERO>1234</NUMERO>"
      << "</DESCRIZIONE></FIGLIO>"
      << "</HEAD>";
  return output ? 0 : fail("vic_base_qxml input file write failed");
}

int check_queries(vic::qxml::database& db) {
  if (db.count("FIGLIO") != 2) {
    return fail("vic_base_qxml element count changed");
  }
  if (db.get_qstring("FIGLIO[@sesso='F']/NOME") != "Carla") {
    return fail("vic_base_qxml attribute selector lookup changed");
  }
  // Legacy indexes count all sibling child nodes, not just matching tag names.
  if (db.get_qstring("FIGLIO[1]/NOME/@AUTO") != "6") {
    return fail("vic_base_qxml indexed attribute lookup changed");
  }
  if (db.get_qstring("FIGLIO[last()]/NOME") != "Carla") {
    return fail("vic_base_qxml reverse index lookup changed");
  }
  if (db.get_int("FIGLIO[@sesso='F']/DESCRIZIONE[2]/NUMERO[1]") !=
      1234) {
    return fail("vic_base_qxml nested integer lookup changed");
  }
  if (!db.expected_units("METRIC/VALUE", "m") ||
      std::fabs(db.get_value_with_units("METRIC/VALUE", "m") - 12.5f) >
          1e-6f) {
    return fail("vic_base_qxml units lookup changed");
  }

  return 0;
}

int check_mutation_save_reload(vic::qxml::database& db,
                               const char* saved_path) {
  db.set_string("FIGLIO[@sesso='F']/NOME", "Clara");
  db.set_int("METRIC/COUNT", 7);
  db.set_qstring("METRIC/VALUE/@units", "km");

  if (db.get_qstring("FIGLIO[@sesso='F']/NOME") != "Clara" ||
      db.get_int("METRIC/COUNT") != 7 ||
      !db.expected_units("METRIC/VALUE", "km")) {
    return fail("vic_base_qxml mutation contract changed");
  }

  db.save(saved_path);
  vic::qxml::database reloaded("saved", saved_path);
  if (reloaded.get_qstring("FIGLIO[@sesso='F']/NOME") != "Clara" ||
      reloaded.get_int("METRIC/COUNT") != 7 ||
      !reloaded.expected_units("METRIC/VALUE", "km")) {
    return fail("vic_base_qxml save/reload contract changed");
  }

  return 0;
}

int check_callbacks(vic::qxml::database& db) {
  callback_receiver receiver = {0};
  vic::qxml::database_callback_functor callback(
      "smoke", &receiver, on_database_changed);

  db.register_callback(&callback);
  db.propagate_changes();
  if (receiver.calls != 1) {
    db.unregister_callback(&callback);
    return fail("vic_base_qxml callback propagation changed");
  }

  db.propagate_changes(&receiver);
  if (receiver.calls != 1) {
    db.unregister_callback(&callback);
    return fail("vic_base_qxml callback activator filtering changed");
  }

  db.unregister_callback(&callback);
  db.propagate_changes();
  if (receiver.calls != 1) {
    return fail("vic_base_qxml callback unregister changed");
  }

  return 0;
}

}  // namespace

int main() {
  const char* input_path = "terra_sdk_qxml_smoke.xml";
  const char* saved_path = "terra_sdk_qxml_smoke_saved.xml";

  std::remove(input_path);
  std::remove(saved_path);
  if (int status = write_input_xml(input_path)) {
    return status;
  }

  int status = 0;
  {
    vic::qxml::database db("smoke", input_path);
    if (int query_status = check_queries(db)) {
      status = query_status;
    } else if (int callback_status = check_callbacks(db)) {
      status = callback_status;
    } else if (int mutation_status = check_mutation_save_reload(db,
                                                                saved_path)) {
      status = mutation_status;
    }
  }

  std::remove(input_path);
  std::remove(saved_path);
  if (status) {
    return status;
  }

  std::cout << "SDK smoke passed: vic_base_qxml database adapter" << std::endl;
  return 0;
}
