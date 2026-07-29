FROM ubuntu:20.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates libdb5.3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY terra_terrain_service /app/terra_terrain_service
COPY entrypoint.sh /app/entrypoint.sh
COPY service.args /app/service.args
RUN chmod 0755 /app/terra_terrain_service /app/entrypoint.sh

ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
