// backend/server.js  (ESM, self-contained)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { OAuth2Client } from 'google-auth-library';
import { Pool } from 'pg';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// simple health
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------- DATABASE (optional) ---------- */
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });
  console.log('[DB] Pool configured');
} else {
  console.log('[DB] DATABASE_URL not set - running without DB (ask will use empty notes)');
}

/* ---------- AUTH ---------- */
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const oauthClient = new OAuth2Client(CLIENT_ID);

// POST /auth/google/exchange
app.post('/auth/google/exchange', async (req, res) => {
  try {
    const { code, redirectUri } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Missing code' });

    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.error('[AUTH] Missing GOOGLE_OAUTH_CLIENT_ID/CLIENT_SECRET');
      return res.status(500).json({ error: 'Server misconfigured (oauth client)' });
    }

    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    // ... wcześniej
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    // DO NOT append redirect_uri for Android serverAuthCode exchange


    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const tokenText = await tokenResp.text();
    if (!tokenResp.ok) {
      console.error('[AUTH] token exchange failed', tokenResp.status, tokenText);
      return res.status(502).json({ error: 'Token exchange failed', status: tokenResp.status, body: tokenText });
    }

    const tokenJson = JSON.parse(tokenText);
    const idToken = tokenJson.id_token;
    const accessToken = tokenJson.access_token;

    if (!idToken) {
      console.error('[AUTH] no id_token in token response', tokenJson);
      return res.status(502).json({ error: 'No id_token in token response', raw: tokenJson });
    }

    // Verify id_token with Google
    const ticket = await oauthClient.verifyIdToken({ idToken, audience: CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload) {
      console.error('[AUTH] verifyIdToken returned empty payload');
      return res.status(502).json({ error: 'Invalid id_token' });
    }

    const userId = payload.sub;
    const email = payload.email;
    console.log('[AUTH] exchange ok for', userId, email);
    return res.json({ success: true, user: { userId, email }, token: idToken, accessToken });
  } catch (e) {
    console.error('[AUTH] /google/exchange error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// GET /auth/me
app.get('/auth/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || req.headers.Authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization' });
    }
    const idToken = auth.slice(7);
    const ticket = await oauthClient.verifyIdToken({ idToken, audience: CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) return res.status(401).json({ error: 'Invalid token' });
    return res.json({ success: true, user: { userId: payload.sub, email: payload.email } });
  } catch (e) {
    console.error('[AUTH] /me error', e);
    return res.status(401).json({ error: 'Unauthorized' });
  }
});

// POST /auth/logout
app.post('/auth/logout', async (req, res) => {
  // If you store sessions server-side, destroy them here.
  res.json({ success: true });
});

/* ---------- ASK (Gemini) ---------- */
function buildContext(notes, limitChars = 12000) {
  const joined = (notes || []).map(n => `# ${n.title ?? ''}\n${n.body ?? ''}`).join('\n\n---\n\n');
  return joined.length > limitChars ? joined.slice(0, limitChars) : joined;
}
function stripSources(text) {
  return (text || '').replace(/^\s*SOURCES:.*$/gim, '').trim();
}

app.post('/api/ask', async (req, res) => {
  try {
    const { question, mode = 'general-with-notes' } = req.body || {};
    if (!question || !question.toString().trim()) return res.status(400).json({ error: 'Missing question' });

    // get userId - ideally you have middleware setting req.user. Here we try fallback to body
    const userId = req.user?.userId || req.body.userId || null;
    if (!userId) return res.status(401).json({ error: 'No user' });

    console.log('[ASK] incoming', { userId, qlen: question.length });

    let notes = [];
    if (pool) {
      const { rows } = await pool.query(
        `SELECT title, body FROM notes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
        [userId]
      );
      notes = rows;
    } else {
      // no DB - use empty array
      notes = [];
    }

    const context = buildContext(notes);
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[ASK] Missing GEMINI_API_KEY');
      return res.status(500).json({ error: 'Server misconfigured (no GEMINI_API_KEY)' });
    }

    const prompt = mode === 'notes-only'
      ? `USE ONLY the following notes of the user. DO NOT use external knowledge.\nQuestion: ${question}\n\nNOTES:\n${context}\n\nIf there is not enough information in the notes, reply exactly: "No information in notes". Keep the answer short.`
      : `You are a helpful assistant. You may use general knowledge and you have access to the following private notes as context.\nQuestion: ${question}\n\nNotes:\n${context}\n\nAnswer concisely. If you use the notes, indicate that you are referencing them.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: Number(process.env.GEMINI_TEMPERATURE ?? 0.2), maxOutputTokens: Number(process.env.GEMINI_MAX_TOKENS ?? 1024) } };

    const t0 = Date.now();
    const upstream = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const elapsed = Date.now() - t0;
    const raw = await upstream.text();
    console.log('[ASK] Gemini status=', upstream.status, 'time_ms=', elapsed, 'raw_len=', raw?.length ?? 0);

    if (!upstream.ok) {
      console.error('[ASK] Gemini upstream error', upstream.status, raw.slice(0, 2000));
      return res.status(502).json({ error: 'Gemini upstream error', status: upstream.status, body: raw });
    }

    let data;
    try { data = JSON.parse(raw); } catch (e) {
      console.error('[ASK] Gemini parse error', e, raw.slice(0, 2000));
      return res.status(502).json({ error: 'Invalid Gemini response', raw });
    }

    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = stripSources(answer);
    console.log('[ASK] ok -> answer_len=', cleaned.length);
    return res.json({ answer: cleaned });
  } catch (e) {
    console.error('[ASK] unexpected', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------- TEST GEMINI ---------- */
app.get('/internal/test-gemini', async (req, res) => {
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'no GEMINI_API_KEY set' });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = { contents: [{ parts: [{ text: 'Say hello in one short sentence.' }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 64 } };

    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const raw = await r.text();
    console.log('[TEST-GEMINI] status=', r.status, 'len=', raw?.length ?? 0);
    console.log('[TEST-GEMINI] body=', raw.slice(0, 4000));
    if (!r.ok) return res.status(502).json({ status: r.status, body: raw });
    let data;
    try { data = JSON.parse(raw); } catch (e) { return res.status(502).json({ error: 'invalid-json', raw }); }
    return res.json({ ok: true, status: r.status, candidates: data?.candidates ?? null });
  } catch (e) {
    console.error('[TEST-GEMINI] error', e);
    return res.status(500).json({ error: 'internal', message: String(e) });
  }
});

/* ---------- 404 ---------- */
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.originalUrl }));

/* ---------- START ---------- */
const port = Number(process.env.PORT || 8080);
app.listen(port, '0.0.0.0', () => console.log(`API listening on http://0.0.0.0:${port}`));
