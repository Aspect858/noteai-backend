// server.js
import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { Pool } from 'pg';

dotenv.config();

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.send('OK'); }
  catch (e) { console.error(e); res.status(500).send('DB error'); }
});

app.post('/api/notes', async (req, res) => {
  const { userId, title, body } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const { rows } = await pool.query(
    'INSERT INTO notes(user_id, title, body) VALUES ($1,$2,$3) RETURNING *',
    [userId, title ?? null, body ?? null]
  );
  res.json(rows[0]);
});

app.get('/api/notes', async (req, res) => {
  const { userId, q } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const { rows } = await pool.query(
    `SELECT * FROM notes
     WHERE user_id = $1
       AND ($2::text IS NULL OR title ILIKE '%'||$2||'%' OR body ILIKE '%'||$2||'%')
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId, q || null]
  );
  res.json(rows);
});

app.post('/api/ask', async (req, res) => {
  const { userId, question } = req.body;
  if (!userId || !question) return res.status(400).json({ error: 'userId & question required' });

  const { rows: notes } = await pool.query(
    'SELECT title, body FROM notes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5',
    [userId]
  );
  const context = notes.map(n => `- ${n.title ?? ''}\n${n.body ?? ''}`).join('\n');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const r = await fetch(`${url}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: `Pytanie: ${question}\n\nKontekst notatek:\n${context}` }] }
      ]
    })
  });

  const data = await r.json();
  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  res.json({ answer });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`✅ API listening on :${port}`));
