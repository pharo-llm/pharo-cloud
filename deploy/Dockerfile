# Pharo Cloud gateway (+ the model fetcher, which needs llama-gguf-split to merge split GGUFs for vLLM).

FROM debian:bookworm-slim AS gguf-split
RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG LLAMA_CPP_REF=master
RUN git clone --depth 1 --branch "${LLAMA_CPP_REF}" https://github.com/ggml-org/llama.cpp /src \
 && cmake -S /src -B /build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF \
 && cmake --build /build --target llama-gguf-split -j"$(nproc)"

FROM node:24-bookworm-slim
COPY --from=gguf-split /build/bin/llama-gguf-split /usr/local/bin/llama-gguf-split
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
COPY config ./config
ENV NODE_ENV=production \
    PHARO_CLOUD_DATA=/data \
    PHARO_CLOUD_MODELS_DIR=/data/models \
    PHARO_CLOUD_MERGE_TOOL=/usr/local/bin/llama-gguf-split \
    PHARO_CLOUD_PORT=8000 \
    NODE_NO_WARNINGS=1
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
