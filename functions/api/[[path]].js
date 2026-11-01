// AI Studio — Cloudflare Pages Function (saare /api/* routes)
// Env (Pages Settings > Environment variables): ANTHROPIC_API_KEY, REPLICATE_API_TOKEN,
// ELEVENLABS_API_KEY, ACCESS_KEY (+ optional CHAT_MODEL, IMAGE_MODEL, VIDEO_MODEL, VIDEO_IMAGE_FIELD, VOICE_MODEL)
// User apni key header se bhej sakta hai (site ka Key wala hissa) — wo env key se upar rahegi.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const EL = 'https://api.elevenlabs.io/v1';

const b64blob = (b64, mime) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (env.ACCESS_KEY && request.headers.get('x-access-key') !== env.ACCESS_KEY) {
    return json({ error: 'Galat access key' }, 401);
  }

  const elKey = request.headers.get('x-elevenlabs-key') || env.ELEVENLABS_API_KEY;
  const anKey = request.headers.get('x-anthropic-key') || env.ANTHROPIC_API_KEY;
  const rpKey = request.headers.get('x-replicate-key') || env.REPLICATE_API_TOKEN;

  const CHAT_MODEL = env.CHAT_MODEL || 'claude-sonnet-4-5';
  const IMAGE_MODEL = env.IMAGE_MODEL || 'black-forest-labs/flux-schnell';
  const VIDEO_MODEL = env.VIDEO_MODEL || 'minimax/video-01';
  const VIDEO_IMAGE_FIELD = env.VIDEO_IMAGE_FIELD || 'first_frame_image';
  const VOICE_MODEL = env.VOICE_MODEL || 'eleven_multilingual_v2';

  const rep = (p, opts = {}) =>
    fetch('https://api.replicate.com/v1' + p, {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + rpKey,
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

  const elErr = async (r, tag) => {
    const d = await r.json().catch(() => ({}));
    return json({ error: (d.detail && (d.detail.message || d.detail)) || tag + ' ' + r.status }, 500);
  };

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
          'x-api-key': anKey,
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
      const r = await fetch(EL + '/voices', { headers: { 'xi-api-key': elKey } });
      const d = await r.json();
      if (!r.ok) return json({ error: (d.detail && d.detail.message) || 'ElevenLabs error' }, 500);
      return json({ voices: d.voices.map(v => ({ id: v.voice_id, name: v.name })) });
    }

    if (request.method === 'POST' && path === '/api/voice') {
      const body = await request.json().catch(() => ({}));
      const text = String(body.text || '').slice(0, 5000);
      if (!text || !body.voice) return json({ error: 'Text aur voice chuno' }, 400);
      const r = await fetch(EL + '/text-to-speech/' + encodeURIComponent(body.voice), {
        method: 'POST',
        headers: { 'xi-api-key': elKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: VOICE_MODEL }),
      });
      if (!r.ok) return elErr(r, 'ElevenLabs error');
      return new Response(await r.arrayBuffer(), { headers: { 'Content-Type': 'audio/mpeg' } });
    }

    // ---- Dubbing ----
    if (request.method === 'POST' && path === '/api/dub') {
      const body = await request.json().catch(() => ({}));
      const { fileBase64, mime, filename, targetLang, sourceUrl } = body;
      if (!targetLang || (!fileBase64 && !sourceUrl)) return json({ error: 'File ya video ka link do, aur target language chuno' }, 400);
      const form = new FormData();
      if (sourceUrl) form.append('source_url', String(sourceUrl).slice(0, 2000));
      else form.append('file', b64blob(fileBase64, mime), filename || 'input.mp4');
      form.append('target_lang', String(targetLang).slice(0, 8));
      form.append('mode', 'automatic');
      const r = await fetch(EL + '/dubbing', { method: 'POST', headers: { 'xi-api-key': elKey }, body: form });
      if (!r.ok) return elErr(r, 'Dubbing error');
      const d = await r.json();
      return json({ dubbing_id: d.dubbing_id, expected_duration_sec: d.expected_duration_sec || null });
    }

    const dubStatusMatch = path.match(/^\/api\/dub-status\/(.+)$/);
    if (request.method === 'GET' && dubStatusMatch) {
      const r = await fetch(EL + '/dubbing/' + encodeURIComponent(dubStatusMatch[1]), { headers: { 'xi-api-key': elKey } });
      if (!r.ok) return elErr(r, 'Status error');
      const d = await r.json();
      return json({ status: d.status, error: d.error || null });
    }

    const dubAudioMatch = path.match(/^\/api\/dub-audio\/(.+)\/(.+)$/);
    if (request.method === 'GET' && dubAudioMatch) {
      const r = await fetch(EL + '/dubbing/' + encodeURIComponent(dubAudioMatch[1]) + '/audio/' + encodeURIComponent(dubAudioMatch[2]), { headers: { 'xi-api-key': elKey } });
      if (!r.ok) return json({ error: 'Dubbed file nahi mili ' + r.status }, 500);
      return new Response(await r.arrayBuffer(), { headers: { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' } });
    }

    // ---- Voice Clone (SIRF apni awaaz, ijazat ke saath) ----
    if (request.method === 'POST' && path === '/api/clone') {
      const body = await request.json().catch(() => ({}));
      const { name, description, audioBase64, mime, consent } = body;
      if (consent !== true) return json({ error: 'Pehle confirm karo: ye tumhari apni awaaz hai ya ijazat hai' }, 400);
      if (!name || !audioBase64) return json({ error: 'Voice ka naam aur audio sample chahiye' }, 400);
      const form = new FormData();
      form.append('name', String(name).slice(0, 100));
      if (description) form.append('description', String(description).slice(0, 500));
      form.append('files', b64blob(audioBase64, mime), 'sample' + ((mime || '').includes('wav') ? '.wav' : '.mp3'));
      const r = await fetch(EL + '/voices/add', { method: 'POST', headers: { 'xi-api-key': elKey }, body: form });
      if (!r.ok) return elErr(r, 'Clone error');
      const d = await r.json();
      return json({ voice_id: d.voice_id, requires_verification: !!d.requires_verification });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
