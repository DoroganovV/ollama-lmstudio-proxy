import express, { type Request, type Response as ExpressResponse } from 'express';

type JsonRecord = Record<string, unknown>;

type LmModel = {
  id: string;
  object?: string;
  owned_by?: string;
};

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const startedAt = Date.now();

  console.log(`[req] ${req.method} ${req.originalUrl}`);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const logLine = `[res] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`;

    if (res.statusCode >= 400) {
      console.error(logLine);
    } else {
      console.log(logLine);
    }
  });

  next();
});

const PORT = Number(process.env.PORT ?? 11434);
const LM_STUDIO_BASE_URL = (process.env.LM_STUDIO_BASE_URL ?? 'http://localhost:11435').replace(/\/$/, '');
const CHAT_PATHS = (process.env.LM_STUDIO_CHAT_PATHS ?? '/v1/chat/completions,/api/v0/chat/completions')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);
const MODELS_PATHS = (process.env.LM_STUDIO_MODELS_PATHS ?? '/v1/models,/api/v0/models')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);
const EMBEDDINGS_PATHS = (process.env.LM_STUDIO_EMBEDDINGS_PATHS ?? '/v1/embeddings')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);
const LM_STUDIO_API_KEY = process.env.LM_STUDIO_API_KEY?.trim() || undefined;

async function lmFetch(paths: string[], init: RequestInit): Promise<globalThis.Response> {
  const errors: string[] = [];
  const headers = new Headers(init.headers);

  if (LM_STUDIO_API_KEY) {
    headers.set('Authorization', `Bearer ${LM_STUDIO_API_KEY}`);
  }

  const initWithAuth: RequestInit = { ...init, headers };

  for (const path of paths) {
    const url = `${LM_STUDIO_BASE_URL}${path}`;

    try {
      const response = await fetch(url, initWithAuth);
      if (response.ok) {
        console.log(`[lm] ${init.method ?? 'GET'} ${url} -> ${response.status}`);
        return response;
      }

      const bodyText = await response.text();
      const errorLine = `${path} -> HTTP ${response.status}: ${bodyText.slice(0, 400)}`;
      console.error(`[lm] ${init.method ?? 'GET'} ${url} -> ${response.status}: ${bodyText.slice(0, 400)}`);
      errors.push(errorLine);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[lm] ${init.method ?? 'GET'} ${url} -> error: ${message}`);
      errors.push(`${path} -> ${message}`);
    }
  }

  throw new Error(`LM Studio request failed. Tried paths: ${errors.join(' | ')}`);
}

function toMessageArray(prompt: unknown, system: unknown): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  if (typeof system === 'string' && system.trim().length > 0) {
    messages.push({ role: 'system', content: system });
  }

  if (typeof prompt === 'string') {
    messages.push({ role: 'user', content: prompt });
  }

  return messages;
}

async function getModels(): Promise<LmModel[]> {
  const response = await lmFetch(MODELS_PATHS, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  const json = (await response.json()) as JsonRecord;
  const data = Array.isArray(json.data) ? (json.data as unknown[]) : [];
  const models: LmModel[] = [];

  for (const item of data) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as JsonRecord;
    const id = record.id;
    if (typeof id !== 'string') {
      continue;
    }

    models.push({
      id,
      object: typeof record.object === 'string' ? record.object : undefined,
      owned_by: typeof record.owned_by === 'string' ? record.owned_by : undefined
    });
  }

  return models;
}

function extractAssistantText(payload: JsonRecord): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as JsonRecord | undefined;
  if (!first || typeof first !== 'object') {
    return '';
  }

  const message = first.message as JsonRecord | undefined;
  if (message && typeof message.content === 'string') {
    return message.content;
  }

  if (typeof first.text === 'string') {
    return first.text;
  }

  return '';
}

function extractFinishReason(payload: JsonRecord): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as JsonRecord | undefined;
  if (!first || typeof first !== 'object') {
    return 'stop';
  }

  const reason = first.finish_reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : 'stop';
}

async function streamSseAsJson(response: globalThis.Response, onChunk: (payload: JsonRecord) => void): Promise<void> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) {
        break;
      }

      const rawLine = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);

      if (!rawLine.startsWith('data:')) {
        continue;
      }

      const data = rawLine.slice(5).trim();
      if (data === '[DONE]') {
        return;
      }

      try {
        const parsed = JSON.parse(data) as JsonRecord;
        onChunk(parsed);
      } catch {
        continue;
      }
    }
  }
}

function buildModelDetails() {
  return {
    format: 'unknown',
    family: 'unknown',
    families: [] as string[],
    parameter_size: 'unknown',
    quantization_level: 'unknown'
  };
}

app.get('/', (_req, res) => {
  res.json({
    service: 'ollama-lmstudio-proxy',
    status: 'ok',
    lm_studio_base_url: LM_STUDIO_BASE_URL
  });
});

app.get('/api/version', (_req, res) => {
  res.json({ version: '0.1.0' });
});

app.get('/api/tags', async (_req, res) => {
  try {
    const models = await getModels();
    const modifiedAt = new Date().toISOString();

    res.json({
      models: models.map((model) => ({
        name: model.id,
        model: model.id,
        modified_at: modifiedAt,
        size: 0,
        digest: '',
        details: buildModelDetails()
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

app.get('/api/ps', async (_req, res) => {
  try {
    const models = await getModels();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

    res.json({
      models: models.map((model) => ({
        name: model.id,
        model: model.id,
        size: 0,
        digest: '',
        details: buildModelDetails(),
        expires_at: expiresAt,
        size_vram: 0
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

app.post('/api/show', async (req, res) => {
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model : '';

  try {
    const models = await getModels();
    const selected =
      models.find((model) => model.id === requestedModel) ??
      models.find((model) => model.id.startsWith(requestedModel));

    if (!selected) {
      res.status(404).json({ error: `Model not found: ${requestedModel}` });
      return;
    }

    res.json({
      license: '',
      modelfile: `FROM ${selected.id}`,
      parameters: '',
      template: '',
      details: {
        parent_model: '',
        ...buildModelDetails()
      },
      model_info: {},
      capabilities: ['completion', 'chat']
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

app.post('/api/generate', async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
  const stream = req.body?.stream !== false;
  const now = new Date().toISOString();

  const payload = {
    model,
    messages: toMessageArray(req.body?.prompt, req.body?.system),
    temperature: typeof req.body?.options?.temperature === 'number' ? req.body.options.temperature : undefined,
    max_tokens: typeof req.body?.options?.num_predict === 'number' ? req.body.options.num_predict : undefined,
    stream
  };

  try {
    const lmResponse = await lmFetch(CHAT_PATHS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!stream) {
      const json = (await (lmResponse as unknown as globalThis.Response).json()) as JsonRecord;
      const text = extractAssistantText(json);
      const doneReason = extractFinishReason(json);

      res.json({
        model: model ?? 'unknown',
        created_at: now,
        response: text,
        done: true,
        done_reason: doneReason,
        context: []
      });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    await streamSseAsJson(lmResponse as unknown as globalThis.Response, (chunk) => {
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const first = choices[0] as JsonRecord | undefined;
      const delta = first?.delta as JsonRecord | undefined;
      const piece = typeof delta?.content === 'string' ? delta.content : '';

      if (piece.length > 0) {
        const out = {
          model: model ?? 'unknown',
          created_at: now,
          response: piece,
          done: false
        };
        res.write(`${JSON.stringify(out)}\n`);
      }
    });

    res.write(
      `${JSON.stringify({
        model: model ?? 'unknown',
        created_at: now,
        response: '',
        done: true,
        done_reason: 'stop',
        context: []
      })}\n`
    );
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

app.post('/api/chat', async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
  const stream = req.body?.stream !== false;
  const now = new Date().toISOString();

  const inputMessages: unknown[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = inputMessages
    .map((item: unknown) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const role = (item as JsonRecord).role;
      const content = (item as JsonRecord).content;
      if (typeof role !== 'string' || typeof content !== 'string') {
        return null;
      }

      return { role, content };
    })
    .filter((item: { role: string; content: string } | null): item is { role: string; content: string } => item !== null);

  const payload = {
    model,
    messages,
    temperature: typeof req.body?.options?.temperature === 'number' ? req.body.options.temperature : undefined,
    max_tokens: typeof req.body?.options?.num_predict === 'number' ? req.body.options.num_predict : undefined,
    stream
  };

  try {
    const lmResponse = await lmFetch(CHAT_PATHS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!stream) {
      const json = (await (lmResponse as unknown as globalThis.Response).json()) as JsonRecord;
      const text = extractAssistantText(json);
      const doneReason = extractFinishReason(json);

      res.json({
        model: model ?? 'unknown',
        created_at: now,
        message: {
          role: 'assistant',
          content: text
        },
        done: true,
        done_reason: doneReason
      });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    await streamSseAsJson(lmResponse as unknown as globalThis.Response, (chunk) => {
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const first = choices[0] as JsonRecord | undefined;
      const delta = first?.delta as JsonRecord | undefined;
      const piece = typeof delta?.content === 'string' ? delta.content : '';

      if (piece.length > 0) {
        const out = {
          model: model ?? 'unknown',
          created_at: now,
          message: {
            role: 'assistant',
            content: piece
          },
          done: false
        };
        res.write(`${JSON.stringify(out)}\n`);
      }
    });

    res.write(
      `${JSON.stringify({
        model: model ?? 'unknown',
        created_at: now,
        message: {
          role: 'assistant',
          content: ''
        },
        done: true,
        done_reason: 'stop'
      })}\n`
    );
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

app.post('/api/embed', async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
  const input = req.body?.input;
  const inputs = Array.isArray(input) ? input : [input];

  try {
    const lmResponse = await lmFetch(EMBEDDINGS_PATHS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ model, input: inputs })
    });

    const json = (await (lmResponse as unknown as globalThis.Response).json()) as JsonRecord;
    const data = Array.isArray(json.data) ? (json.data as unknown[]) : [];

    const embeddings = data
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const embedding = (item as JsonRecord).embedding;
        return Array.isArray(embedding) ? (embedding as number[]) : null;
      })
      .filter((item): item is number[] => item !== null);

    res.json({
      model: model ?? 'unknown',
      embeddings,
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: inputs.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

app.post('/api/create', (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model : 'unknown';
  const stream = req.body?.stream !== false;

  if (stream) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(`${JSON.stringify({ status: `using existing layer for ${model}` })}\n`);
    res.write(`${JSON.stringify({ status: 'success' })}\n`);
    res.end();
    return;
  }

  res.json({ status: 'success' });
});

app.post('/api/copy', async (req, res) => {
  const source = typeof req.body?.source === 'string' ? req.body.source : '';

  try {
    const models = await getModels();
    const found = models.some((model) => model.id === source);

    if (!found) {
      res.status(404).json({ error: `source model not found: ${source}` });
      return;
    }

    res.status(200).end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

app.post('/api/pull', (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model : 'unknown';
  const stream = req.body?.stream !== false;

  if (stream) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(`${JSON.stringify({ status: `pulling manifest for ${model}` })}\n`);
    res.write(`${JSON.stringify({ status: 'verifying sha256 digest' })}\n`);
    res.write(`${JSON.stringify({ status: 'success' })}\n`);
    res.end();
    return;
  }

  res.json({ status: 'success' });
});

app.post('/api/push', (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model : 'unknown';
  const stream = req.body?.stream !== false;

  if (stream) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(`${JSON.stringify({ status: `pushing ${model}` })}\n`);
    res.write(`${JSON.stringify({ status: 'success' })}\n`);
    res.end();
    return;
  }

  res.json({ status: 'success' });
});

app.delete('/api/delete', async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model : '';

  try {
    const models = await getModels();
    const found = models.some((item) => item.id === model);

    if (!found) {
      res.status(404).json({ error: `model not found: ${model}` });
      return;
    }

    res.status(200).end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

app.use((error: unknown, req: Request, res: ExpressResponse, _next: () => void) => {
  const message = error instanceof Error ? error.message : 'Internal server error';
  console.error(`[err] ${req.method} ${req.originalUrl} -> ${message}`);
  res.status(500).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Ollama proxy listening on :${PORT}`);
  console.log(`LM Studio upstream: ${LM_STUDIO_BASE_URL}`);
});
