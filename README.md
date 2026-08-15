# Ollama -> LM Studio Proxy

Proxy service that accepts Ollama-compatible API requests on port `11434` and forwards them to LM Studio.

## Supported Ollama endpoints

- `GET /api/version`
- `GET /api/tags`
- `GET /api/ps`
- `POST /api/show`
- `POST /api/generate`
- `POST /api/chat`
- `POST /api/embed`
- `POST /api/create` (emulated: LM Studio does not support building models from a Modelfile; always reports success)
- `POST /api/copy` (emulated: verifies the source model exists in LM Studio, then reports success)
- `POST /api/pull` (emulated: LM Studio manages its own model downloads; always reports success)
- `POST /api/push` (emulated: LM Studio has no push/registry API; always reports success)
- `DELETE /api/delete` (emulated: verifies the model exists in LM Studio, then reports success; does not actually delete anything in LM Studio)

## Environment variables

- `PORT` (default: `11434`)
- `LM_STUDIO_BASE_URL` (default: `http://localhost:11435`)
- `LM_STUDIO_CHAT_PATHS` (default: `/v1/chat/completions,/api/v0/chat/completions`)
- `LM_STUDIO_MODELS_PATHS` (default: `/v1/models,/api/v0/models`)
- `LM_STUDIO_EMBEDDINGS_PATHS` (default: `/v1/embeddings`)
- `LM_STUDIO_API_KEY` (optional; if set, sent as `Authorization: Bearer <key>` on every LM Studio request)

## Files

- `ollama-lmstudio-proxy/` - Express server source (`package.json`, `tsconfig.json`, `src/server.ts`).
- `docker-compose.yml` - standalone Compose file for running this service on its own.

## Run locally

```bash
cd ollama-lmstudio-proxy
npm install
npm run start
```

## Running (docker-compose)

```bash
docker compose up -d
```

Already wired up in [`docker-compose.yml`](docker-compose.yml) as the `ollama-lmstudio-proxy`
service, listening on port `11434`.
