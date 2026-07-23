# ollama-lmstudio-proxy

Lightweight Node.js/TypeScript proxy that translates Ollama-compatible API requests into LM Studio requests and back.

## Supported Ollama endpoints

- `GET /api/tags` -> `GET /v1/models`
- `POST /api/generate` -> `POST /v1/completions`
- `POST /api/chat` -> `POST /v1/chat/completions`
- `POST /api/embeddings` -> `POST /v1/embeddings`

## Local run

```bash
npm install
npm run dev
```

Environment variables:

- `PORT` (default: `11434`)
- `LM_STUDIO_BASE_URL` (default: `http://127.0.0.1:1234`)

## Build and run

```bash
npm run build
npm start
```

## Docker

```bash
npm run build
docker build -t ollama-lmstudio-proxy .
docker run --rm -p 11434:11434 -e LM_STUDIO_BASE_URL=http://host.docker.internal:1234 ollama-lmstudio-proxy
```
