# Operations

## Requirements

- A Linux machine with an NVIDIA GPU, Docker and the NVIDIA Container Toolkit.
- Disk space for the models. A 7B model at Q4 is about 4.5 GB, and a split
  model briefly needs twice that while it is merged.

## First Deploy

```sh
git clone https://github.com/pharo-llm/pharo-cloud && cd pharo-cloud
cp deploy/.env.example deploy/.env
# PHARO_CLOUD_UPSTREAM_API_KEY: openssl rand -hex 32
# PHARO_CLOUD_ADMIN_TOKEN:      openssl rand -hex 32
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f fetch-models vllm gateway
```

`fetch-models` exits once every model in `config/models.json` is in
`/data/models/<id>/model.gguf`. vLLM then loads it (the first time takes a few
minutes), and the gateway reports the engine as healthy.

## Models

`config/models.json`:

```json
{ "id": "pharo-coder", "repo": "your-org/your-model-GGUF",
  "files": ["model-q4_k_m-00001-of-00002.gguf", "model-q4_k_m-00002-of-00002.gguf"],
  "tokenizer": "Qwen/Qwen2.5-Coder-7B-Instruct", "default": true }
```

- `files`: one GGUF file, or every shard of a split one. Shards are merged into
  one `model.gguf` because vLLM loads single-file GGUF.
- `tokenizer`: the original (non-GGUF) repo. vLLM uses its tokenizer, which is
  faster and more exact than the one embedded in the GGUF.
- Private repo: set `HF_TOKEN` in `.env`.
- Clients ask for `id`. In `.env`, `MODEL_ID` and `MODEL_TOKENIZER` choose what
  vLLM serves.

To change model: edit both files, then run
`docker compose … run --rm fetch-models && docker compose … up -d vllm`.

## Limits

Edit `config/plans.json`, then `POST /admin/api/plans/reload` (or restart). To
give one machine more, use its plan menu in the dashboard. Values are tokens
(prompt + completion), and `null` means unlimited.

## TLS

Put the gateway behind a reverse proxy that terminates HTTPS (Caddy, nginx,
Traefik), forward to port 8000, and set `PHARO_CLOUD_TRUST_PROXY=true` so
limits use the client IP from `X-Forwarded-For`. Keep `/admin` restricted,
either by IP at the proxy or by relying on the admin token.

## Scaling

- More throughput on one GPU: raise `MAX_NUM_SEQS` (it costs KV-cache memory).
- A bigger model: `TENSOR_PARALLEL_SIZE=2` (or more) splits it across GPUs.
- More machines or replicas: run more vLLM instances and list them all in
  `PHARO_CLOUD_UPSTREAMS` (comma separated). The gateway balances between them
  and skips any that is down.

## Data And Backups

Everything lives in the `pharo-data` volume:
- `pharo-cloud.db`: SQLite in WAL mode. Back it up with
  `sqlite3 pharo-cloud.db ".backup backup.db"`.
- `gateway.log`: rotates at 20 MB.
- `models/`: can always be downloaded again.

Request rows older than 120 days are pruned automatically.

## Troubleshooting

| Dashboard shows | Look at |
|---|---|
| Engine **Down** | `docker compose logs vllm`: out of GPU memory (lower `MAX_MODEL_LEN` or `GPU_MEMORY_UTILIZATION`), model path, tokenizer download |
| Model **Not downloaded** | `docker compose logs fetch-models`: wrong file name, private repo without `HF_TOKEN`, disk full |
| **Error burst** | *Recent failures* and the gateway log: engine timeouts, or crashes inside vLLM |
| Many **429** in failures | Machines hitting their plan: expected, or raise the limits |
| `nvidia-smi not found` | The gateway container has no GPU visibility: NVIDIA Container Toolkit, `capabilities: [utility]` |
| **Gateway crashed** | The incident holds the stack trace. Docker restarts the gateway |
