FROM ubuntu:20.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js ./

ENV HOST=0.0.0.0
ENV PORT=8080
ENV CACHE_ROOT=/mnt/terra-cache

EXPOSE 8080
CMD ["node", "server.js"]
