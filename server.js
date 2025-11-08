// server.js — kompletna wersja dla Render + Neon + Gemini
// Node 18+ (fetch jest wbudowany), ESM (package.json: "type": "module")

import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
app.use(cors());
app.use(express.json());

// --- DB (Neon) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // wymagane przez Neon
});

// --- ENV ---
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Helpers ---
function clamp(text, max = 12000) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "\n...[truncated]" : text;
}

async function buildNotesContext(userId) {
  // DOPASUJ do swojej schemy jeśli masz inne nazwy kolumn
  // Zakładam: notes(user_id TEXT, title TEXT, body TEXT, created_at TIMESTAMPTZ)
  const q = `
    SELECT title, body
    FROM notes
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 200
  `;
  const { rows } = await pool.query(q, [userId]);
  if (!rows.length) return "(Użytkownik nie ma jeszcze notatek)";
  const joined = rows
    .map((n) => `# ${n.title ?? "(bez tytułu)"}\n${n.body ?? ""}`)
    .join("\n\n");
  return clamp(joined, 12000);
}

// --- Healthcheck ---
app.get("/health", (_req, res) => res.json({ ok: true }));

// =========================
//   NOTES API (prosty CRUD)
// =========================

// LIST
// GET /api/notes?userId=USER
app.get("/api/notes", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const q = `
      SELECT id, user_id, title, body, created_at, updated_at
      FROM notes
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 500
    `;
    const { rows } = await pool.query(q, [userId]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error", details: e.message });
  }
});

// CREATE
// POST /api/notes  { userId, title, body }
app.post("/api/notes", async (req, res) => {
  try {
    const { userId, title, body } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });

    const q = `
      INSERT INTO notes (user_id, title, body, created_at, updated_at)
      VALUES ($1, $2, $3, now(), now())
      RETURNING id, user_id, title, body, created_at, updated_at
    `;
    const { rows } = await pool.query(q, [userId, title ?? null, body ?? null]);
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error", details: e.message });
  }
});

// UPDATE
// PUT /api/notes/:id  { title?, body? }
app.put("/api/notes/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { title, body } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    const q = `
      UPDATE notes
      SET title = COALESCE($2, title),
          body  = COALESCE($3, body),
          updated_at = now()
      WHERE id = $1
      RETURNING id, user_id, title, body, created_at, updated_at
    `;
    const { rows } = await pool.query(q, [id, title ?? null, body ?? null]);
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error", details: e.message });
  }
});

// DELETE
// DELETE /api/notes/:id
app.delete("/api/notes/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "id required" });

    const q = `DELETE FROM notes WHERE id = $1`;
    await pool.query(q, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error", details: e.message });
  }
});

// =========================
//   ASK (Gemini + kontekst)
// =========================

// POST /api/ask  { userId, question }
app.post('/api/ask', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { question, mode = 'general-with-notes', language = 'en' } = req.body || {};
    if (!userId || !question) return res.status(400).json({ error: 'userId and question required' });
    }

    // 1) Kontekst z notatek
    const notesText = await buildNotesContext(userId);

    // 2) Prompt
    const prompt = `Użytkownik pyta: ${question}

Oto jego notatki (fragmenty):
${notesText}

Instrukcje:
- Odpowiadaj po polsku, konkretnie i jasno.
- Jeśli pytanie dotyczy notatek, opieraj się na ich treści.
- Jeśli informacji brakuje w notatkach, sygnalizuj to i proponuj kroki uzupełnienia.
- Jeśli użytkownik prosi o streszczenie, przygotuj syntetyczne podsumowanie z punktami.`;

    // 3) Wywołanie Gemini (free tier przez API key)
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
      encodeURIComponent(GEMINI_API_KEY);

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(500).json({ error: "Gemini error", details: detail });
    }

    const data = await r.json();
    const answer =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(brak odpowiedzi)";

    res.json({ answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error", details: e.message });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log("API listening on :" + PORT);
});

/*
SQL pomocnicze (uruchom na Neon, jeśli jeszcze nie masz tabeli):

CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  body TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- opcjonalnie indeksy:
CREATE INDEX IF NOT EXISTS notes_user_id_idx ON notes(user_id);
CREATE INDEX IF NOT EXISTS notes_created_at_idx ON notes(created_at DESC);
*/
