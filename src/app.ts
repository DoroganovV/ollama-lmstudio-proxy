import express, { type Request, type Response } from 'express';
import type { OllamaChatRequest, OllamaEmbeddingsRequest, OllamaGenerateRequest } from './types.js';

interface AppConfig {
  lmStudioBaseUrl: string;
  fetchImpl?: typeof fetch;
}

function withDefaultHeaders(headers: HeadersInit = {}): HeadersInit {
  return { 'content-type': 'application/json', ...headers };
}

function parsePromptOptions(prompt: string, options?: Record<string, unknown>): string {
  const system = typeof options?.system === 'string' ? `${options.system}\n\n` : '';
  return `${system}${prompt}`;
}

export function createApp(config: AppConfig) {
  const app = express();
  const doFetch = config.fetchImpl ?? fetch;

  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/tags', async (_req, res, next) => {
    try {
      const upstream = await doFetch(`${config.lmStudioBaseUrl}/v1/models`);
      const body = await upstream.json() as { data?: Array<{ id: string }> };

      res.json({
        models: (body.data ?? []).map((model) => ({
          name: model.id,
          model: model.id,
          modified_at: new Date(0).toISOString(),
          size: 0,
          digest: '',
          details: {
            format: 'gguf',
            family: 'unknown',
            parameter_size: 'unknown',
            quantization_level: 'unknown'
          }
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/generate', async (req: Request<unknown, unknown, OllamaGenerateRequest>, res, next) => {
    try {
      const { model, prompt } = req.body;
      const upstream = await doFetch(`${config.lmStudioBaseUrl}/v1/completions`, {
        method: 'POST',
        headers: withDefaultHeaders(),
        body: JSON.stringify({
          model,
          prompt: parsePromptOptions(prompt, req.body.options),
          stream: false
        })
      });

      const body = await upstream.json() as { choices?: Array<{ text?: string; finish_reason?: string }> };
      const choice = body.choices?.[0] ?? {};
      const done = choice.finish_reason != null;

      res.json({
        model,
        created_at: new Date().toISOString(),
        response: choice.text ?? '',
        done,
        done_reason: choice.finish_reason ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/chat', async (req: Request<unknown, unknown, OllamaChatRequest>, res: Response, next) => {
    try {
      const { model, messages } = req.body;
      const upstream = await doFetch(`${config.lmStudioBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: withDefaultHeaders(),
        body: JSON.stringify({
          model,
          messages,
          stream: false
        })
      });

      const body = await upstream.json() as {
        choices?: Array<{
          message?: { role?: string; content?: string };
          finish_reason?: string;
        }>;
      };
      const choice = body.choices?.[0] ?? {};

      res.json({
        model,
        created_at: new Date().toISOString(),
        message: {
          role: choice.message?.role ?? 'assistant',
          content: choice.message?.content ?? ''
        },
        done_reason: choice.finish_reason ?? null,
        done: choice.finish_reason != null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/embeddings', async (req: Request<unknown, unknown, OllamaEmbeddingsRequest>, res, next) => {
    try {
      const upstream = await doFetch(`${config.lmStudioBaseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: withDefaultHeaders(),
        body: JSON.stringify({
          model: req.body.model,
          input: req.body.prompt
        })
      });

      const body = await upstream.json() as { data?: Array<{ embedding?: number[] }> };
      res.json({ embedding: body.data?.[0]?.embedding ?? [] });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : 'Unexpected proxy error';
    res.status(502).json({ error: message });
  });

  return app;
}
