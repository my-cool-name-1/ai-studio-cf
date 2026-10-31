// AI Studio — Cloudflare Pages Function (saare /api/* routes)
// Env (Pages Settings > Environment variables): ANTHROPIC_API_KEY, REPLICATE_API_TOKEN,
// ELEVENLABS_API_KEY, ACCESS_KEY (+ optional CHAT_MODEL, IMAGE_MODEL, VIDEO_MODEL, VIDEO_IMAGE_FIELD, VOICE_MODEL)

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Access-key gate (server.js jaisa hi)
  if (env.ACCESS_KEY && request.headers.get('x-access-key') !== env.ACCESS_KEY) {
    return json({ error: 'Galat access key' }, 401);
  }

  const CHAT_MODEL = env.CHAT_MODEL || 'claude-sonnet-4-5';
  const IMAGE_MODEL = env.IMAGE_MODEL || 'black-forest-labs/flux-schnell';
  const VIDEO_MODEL = env.VIDEO_MODEL || 'minimax/video-01';
  const VIDEO_IMAGE_FIELD = env.VIDEO_IMAGE_FIELD || 'first_frame_image';
  const VOICE_MODEL = env.VOICE_MODEL || 'eleven_multilingual_v2';

  const rep = (p, opts = {}) =>
    fetch('https://api.replicate.com/v1' + p, {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + env.REPLICATE_API_TOKEN,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    }).then(r => r.json());

  const shape = p => ({
    id: p.id,
    status: p.status || 'failed',
    error: p.error || p.detail || null,
    url: [].concat(p.output || [])[0] || null,
  });

  try {
    if (request.method === 'POST' && (path === '/api/image' || path === '/api/video')) {
      const body = await request.json().catch(() => ({}));
      const prompt = String(body.prompt || '').slice(0, 2000);
      if (!prompt) return json({ error: 'Prompt likho' }, 400);
      const input = { prompt };
      if (path === '/api/video' && body.image) input[VIDEO_IMAGE_FIELD] = body.image;
      const model = path === '/api/video' ? VIDEO_MODEL : IMAGE_MODEL;
      const p = await rep(`/models/${model}/predictions`, {
        method: 'POST',
        headers: { Prefer: 'wait=30' },
        body: JSON.stringify({ input }),
      });
      return json(shape(p));
    }

    const statusMatch = path.match(/^\/api\/status\/(.+)$/);
    if (request.method === 'GET' && statusMatch) {
      return json(shape(await rep('/predictions/' + encodeURIComponent(statusMatch[1]))));
    }

    if (request.method === 'POST' && path === '/api/chat') {
      const body = await request.json().catch(() => ({}));
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          max_tokens: 2000,
          system: 'Tum ek helpful AI assistant ho. User ki language (Hindi/Hinglish/English) mein jawab do.',
          messages: body.messages,
        }),
      });
      const d = await r.json();
      if (!r.ok) return json({ error: (d.error && d.error.message) || 'API error' }, 500);
      return json({ text: (d.content || []).map(c => c.text || '').join('') });
    }

    if (request.method === 'GET' && path === '/api/voices') {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
      });
      const d = await r.json();
      if (!r.ok) return json({ error: (d.detail && d.detail.message) || 'ElevenLabs error' }, 500);
      return json({ voices: d.voices.map(v => ({ id: v.voice_id, name: v.name })) });
    }

    if (request.method === 'POST' && path === '/api/voice') {
      const body = await request.json().catch(() => ({}));
      const text = String(body.text || '').slice(0, 5000);
      if (!text || !body.voice) return json({ error: 'Text aur voice chuno' }, 400);
      const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(body.voice), {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: VOICE_MODEL }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return json({ error: (d.detail && d.detail.message) || 'ElevenLabs error ' + r.status }, 500);
      }
      return new Response(await r.arrayBuffer(), { headers: { 'Content-Type': 'audio/mpeg' } });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
