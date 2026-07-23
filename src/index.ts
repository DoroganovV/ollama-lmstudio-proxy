import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 11434);
const lmStudioBaseUrl = process.env.LM_STUDIO_BASE_URL ?? 'http://127.0.0.1:1234';

createApp({ lmStudioBaseUrl }).listen(port, () => {
  process.stdout.write(`ollama-lmstudio-proxy listening on :${port}\n`);
});
