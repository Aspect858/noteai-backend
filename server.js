// backend/server.js  (ES module)
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

/* ---------- SIMPLE HEALTH ---------- */
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------- OPTIONAL DATABASE ---------- */
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

/* ---------- AUTH (Google token exchange) ---------- */
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const oauthClient = CLIENT_ID ? new OAuth2Client(CLIENT_ID) : null;

app.post('/auth/google/exchange', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Missing code' });

    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.error('[AUTH] Missing GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET');
      return res.status(500).json({ error: 'Server misconfigured (oauth client)' });
    }

    // Build form params once (avoid duplicate declarations)
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const tokenParams = new URLSearchParams();
    tokenParams.append('code', code);
    tokenParams.append('client_id', CLIENT_ID);
    tokenParams.append('client_secret', CLIENT_SECRET);
    tokenParams.append('grant_type', 'authorization_code');
    // IMPORTANT: Do NOT append redirect_uri for Android serverAuthCode flows

    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    const tokenText = await tokenResp.text();
    console.log('[AUTH] token exchange resp status=', tokenResp.status, 'body=', tokenText.slice(0, 2000));

    if (!tokenResp.ok) {
      // Return Google body for debugging
      return res.status(502).json({ error: 'Token exchange failed', status: tokenResp.status, body: tokenText });
    }

    const tokenJson = JSON.parse(tokenText);
    const idToken = tokenJson.id_token;
    const accessToken = tokenJson.access_token;

    if (!idToken) {
      console.error('[AUTH] no id_token in token response', tokenJson);
      return res.status(502).json({ error: 'No id_token in token response', raw: tokenJson });
    }

    // Verify id_token server-side
    try {
      if (!oauthClient) throw new Error('OAuth client not configured');
      const ticket = await oauthClient.verifyIdToken({ idToken, audience: CLIENT_ID });
      const payload = ticket.getPayload();
      if (!payload) {
        console.error('[AUTH] verifyIdToken returned empty payload');
        return res.status(502).json({ error: 'Invalid id_token' });
      }

      const userId = payload.sub;
      const email = payload.email;
      console.log('[AUTH] exchange ok for', userId, email);

      // TODO: create session / save user into DB
      return res.json({ success: true, user: { userId, email }, token: idToken, accessToken });
    } catch (verifyErr) {
      console.error('[AUTH] verifyIdToken error', verifyErr);
      return res.status(502).json({ error: 'id_token_verify_failed', message: String(verifyErr) });
    }
  } catch (err) {
    console.error('[AUTH] /google/exchange error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------- AUTH CHECK ---------- */
app.get('/auth/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || req.headers.Authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization' });
    const idToken = auth.slice(7);
    if (!CLIENT_ID) return res.status(500).json({ error: 'Server misconfigured (oauth client)' });
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken, audience: CLIENT_ID });
      const payload = ticket.getPayload();
      if (!payload || !payload.sub) return res.status(401).json({ error: 'Invalid token' });
      return res.json({ success: true, user: { userId: payload.sub, email: payload.email } });
    } catch (e) {
      console.error('[AUTH] /me verify error', e);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch (e) {
    console.error('[AUTH] /me error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------- LOGOUT ---------- */
app.post('/auth/logout', async (req, res) => {
  res.json({ success: true });
});

/* ---------- ASK (Gemini) ---------- */
function buildContext(notes = [], limitChars = 12000) {
  const joined = notes.map(n => `# ${n.title ?? ''}\n${n.body ?? ''}`).join('\n\n---\n\n');
  return joined.length > limitChars ? joined.slice(0, limitChars) : joined;
}
function stripSources(text = '') {
  return text.replace(/^\s*SOURCES:.*$/gim, '').trim();
}

app.post('/api/ask', async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ error: 'Missing question' });

    // get userId - ideally via middleware that sets req.user
    const userId = req.user?.userId || req.body.userId || null;
    if (!userId) return res.status(401).json({ error: 'No user' });

    console.log('[ASK] incoming', { userId, qlen: String(question).length });

    let notes = [];
    if (pool) {
      const { rows } = await pool.query(
        `SELECT title, body FROM notes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
        [userId]
      );
      notes = rows;
    }

    const context = buildContext(notes, 10000);
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[ASK] Missing GEMINI_API_KEY');
      return res.status(500).json({ error: 'Server misconfigured (no GEMINI_API_KEY)' });
    }

    // Tunable tokens & temperature
    const maxTokens = Number(process.env.GEMINI_MAX_TOKENS ?? 256);
    const temperature = Number(process.env.GEMINI_TEMPERATURE ?? 0.2);

    const prompt = `You are a helpful assistant that may use private notes. Question: ${question}\n\nNotes:\n${context}\n\nAnswer concisely.`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    };

    // Abortable fetch with timeout
    const controller = new AbortController();
    const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 60_000); // default 60s
    const to = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const t0 = Date.now();
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
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
      if (e.name === 'AbortError') {
        console.error('[ASK] Gemini request aborted (timeout)');
        return res.status(504).json({ error: 'Gemini timeout' });
      } else {
        console.error('[ASK] Gemini fetch error', e);
        return res.status(500).json({ error: 'internal', message: String(e) });
      }
    } finally {
      clearTimeout(to);
    }

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
