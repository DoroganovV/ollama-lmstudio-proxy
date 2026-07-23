import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('ollama-lmstudio-proxy', () => {
  it('maps /api/tags from LM Studio models', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'llama-3.1' }] }));
    const app = createApp({ lmStudioBaseUrl: 'http://lmstudio', fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await request(app).get('/api/tags');

    expect(response.status).toBe(200);
    expect(response.body.models).toHaveLength(1);
    expect(response.body.models[0].name).toBe('llama-3.1');
  });

  it('maps /api/generate request/response', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'model-a', prompt: 'Say hi', stream: false });

      return jsonResponse({ choices: [{ text: 'Hello!', finish_reason: 'stop' }] });
    });
    const app = createApp({ lmStudioBaseUrl: 'http://lmstudio', fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await request(app).post('/api/generate').send({ model: 'model-a', prompt: 'Say hi' });

    expect(response.status).toBe(200);
    expect(response.body.response).toBe('Hello!');
    expect(response.body.done).toBe(true);
  });

  it('maps /api/chat request/response', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'model-b', stream: false });
      expect(body.messages).toHaveLength(1);

      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' }]
      });
    });
    const app = createApp({ lmStudioBaseUrl: 'http://lmstudio', fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await request(app)
      .post('/api/chat')
      .send({ model: 'model-b', messages: [{ role: 'user', content: 'Hello' }] });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('Hi there');
  });

  it('maps /api/embeddings response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    const app = createApp({ lmStudioBaseUrl: 'http://lmstudio', fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await request(app)
      .post('/api/embeddings')
      .send({ model: 'embed-model', prompt: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body.embedding).toEqual([0.1, 0.2, 0.3]);
  });
});
