// backend/server.js  (ESM)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';

import authRouter from './routes/auth.js';
import askRouter from './routes/ask.js';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// Health
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Mount routers
app.use('/auth', authRouter);   // -> /auth/google/exchange, /auth/me, /auth/logout
app.use('/api', askRouter);     // -> /api/ask

// Test endpoint for Gemini connectivity (useful to debug on Render)
app.get('/internal/test-gemini', async (req, res) => {
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'no GEMINI_API_KEY set' });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{ parts: [{ text: 'Say hello in one short sentence.' }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 64 }
    };

    // Use global fetch (Node 18+). If Node <18, install node-fetch and adjust.
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const raw = await r.text();
    console.log('[TEST-GEMINI] status=', r.status, 'len=', raw?.length ?? 0);
    console.log('[TEST-GEMINI] body=', raw.slice(0, 4000)); // trim very long output for logs

    if (!r.ok) return res.status(502).json({ status: r.status, body: raw });
    let data;
    try { data = JSON.parse(raw); } catch (e) { return res.status(502).json({ error: 'invalid-json', raw }); }
    return res.json({ ok: true, status: r.status, candidates: data?.candidates ?? null });
  } catch (e) {
    console.error('[TEST-GEMINI] error', e);
    return res.status(500).json({ error: 'internal', message: String(e) });
  }
});

// default 404
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.originalUrl }));

const port = Number(process.env.PORT || 8080);
app.listen(port, '0.0.0.0', () => console.log(`API listening on http://0.0.0.0:${port}`));
