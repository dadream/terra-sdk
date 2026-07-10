include(GNUInstallDirs)

set(CMAKE_INSTALL_BINDIR "bin" CACHE PATH "Executable install directory" FORCE)
set(CMAKE_INSTALL_LIBDIR "lib64" CACHE PATH "Library install directory" FORCE)
set(CMAKE_INSTALL_INCLUDEDIR "include" CACHE PATH "Header install directory" FORCE)
set(CMAKE_INSTALL_DATADIR "share" CACHE PATH "Shared data install directory" FORCE)

message(STATUS "install bindir: ${CMAKE_INSTALL_BINDIR}")
message(STATUS "install libdir: ${CMAKE_INSTALL_LIBDIR}")
message(STATUS "install includedir: ${CMAKE_INSTALL_INCLUDEDIR}")
message(STATUS "install datadir: ${CMAKE_INSTALL_DATADIR}")
