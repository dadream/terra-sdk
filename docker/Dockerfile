FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
ENV XDG_RUNTIME_DIR=/tmp/runtime-docker

RUN echo 'Acquire::Languages "none";' > /etc/apt/apt.conf.d/99translations

RUN sed -i -e 's|http://archive.ubuntu.com/ubuntu/|http://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' \
           -e 's|http://security.ubuntu.com/ubuntu/|http://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' \
           /etc/apt/sources.list

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake git wget sudo vim \
    libgl1-mesa-dev libglu1-mesa-dev freeglut3-dev mesa-utils \
    qt5-default libqt5opengl5-dev \
    x11-apps xauth \
    libdb-dev libdb++-dev \
    libtinyxml-dev \
    openmpi-bin libopenmpi-dev \
    gdal-bin libgdal-dev \
    proj-bin libproj-dev \
    shapelib libshp-dev \
    libgle3-dev glew-utils libglew-dev \
    curl libcurl4-openssl-dev \
    apache2 apache2-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

ARG UID=1000
ARG GID=1000

RUN groupadd -g ${GID} nav3d \
    && useradd -u ${UID} -g nav3d -m nav3d \
    && usermod -aG sudo nav3d \
    && echo '%nav3d ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers \
    && install -d -m 0700 -o nav3d -g nav3d /tmp/runtime-docker

USER nav3d
WORKDIR /wksp
CMD ["/bin/bash"]
