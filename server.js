// server.js – backend dla NoteAI (Render, Node 22, ESM)

import express from "express";
import cors from "cors";
import morgan from "morgan";
import { OAuth2Client } from "google-auth-library";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// ─────────────────────  MIDDLEWARE  ─────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: "*", // dla prostoty; możesz zawęzić do swojej appki / domeny
  }),
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ─────────────────────  HEALTHCHECK  ─────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ─────────────────────  GOOGLE OAUTH  ─────────────────────

// Ustawione w Render → Environment
const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.warn(
    "[AUTH] Brakuje GOOGLE_OAUTH_CLIENT_ID lub GOOGLE_OAUTH_CLIENT_SECRET w Environment na Renderze",
  );
}

/**
 * POST /auth/google/exchange
 * Body: { code: string }
 * Zwraca: { ok: true, user, token } lub błąd
 */
app.post("/auth/google/exchange", async (req, res) => {
  const { code } = req.body ?? {};

  if (!code) {
    return res
      .status(400)
      .json({ ok: false, error: "missing_code", detail: "Brak pola 'code' w body" });
  }

  try {
    // 1) wymiana code -> tokeny
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: "authorization_code",
        // NIE podajemy redirect_uri – Androidowe "Installed app" tego nie wymaga
      }),
    });

    const tokenJson = await tokenResp.json();

    if (!tokenResp.ok) {
      console.error("[AUTH] Google token error", tokenJson);
      return res
        .status(400)
        .json({ ok: false, error: "google_error", detail: tokenJson });
    }

    const { access_token, id_token } = tokenJson;

    // 2) pobranie danych użytkownika
    const userResp = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${access_token}` },
      },
    );
    const userJson = await userResp.json();

    if (!userResp.ok) {
      console.error("[AUTH] Google userinfo error", userJson);
      return res
        .status(400)
        .json({ ok: false, error: "google_userinfo_error", detail: userJson });
    }

    const user = {
      id: userJson.sub,
      email: userJson.email,
      name: userJson.name,
      picture: userJson.picture,
    };

    console.log("[AUTH] Login OK:", user.email);

    // Tu możesz ew. zapisać usera w bazie (Neon) – login działa bez tego.
    return res.json({
      ok: true,
      token: id_token ?? access_token,
      user,
    });
  } catch (err) {
    console.error("[AUTH] exchange failed", err);
    return res
      .status(500)
      .json({ ok: false, error: "server_error", detail: "Internal error" });
  }
});

// ─────────────────────  GEMINI /api/ask  ─────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const GEMINI_TEMPERATURE = Number(process.env.GEMINI_TEMPERATURE || "0.2");
const GEMINI_MAX_TOKENS = Number(process.env.GEMINI_MAX_TOKENS || "1024");

if (!GEMINI_API_KEY) {
  console.warn(
    "[GEMINI] Brak GEMINI_API_KEY – endpoint /api/ask będzie zwracał błąd",
  );
}

/**
 * POST /api/ask
 * Body: { userId?: string, question: string }
 */
app.post("/api/ask", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "missing_gemini_key" });
  }

  const { userId, question } = req.body ?? {};

  if (!question) {
    return res
      .status(400)
      .json({ ok: false, error: "missing_question" });
  }

  try {
    const prompt = `
You are Notes Assistant for an Android notebook app.
User id (may be empty): ${userId || "anonymous"}.
User question: ${question}
Answer concisely in Polish unless user clearly uses another language.
`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL,
    )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const gResp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: GEMINI_TEMPERATURE,
          maxOutputTokens: GEMINI_MAX_TOKENS,
        },
      }),
    });

    const gJson = await gResp.json();

    if (!gResp.ok) {
      console.error("[GEMINI] API error", gJson);
      return res
        .status(500)
        .json({ ok: false, error: "gemini_error", detail: gJson });
    }

    const text =
      gJson.candidates?.[0]?.content?.parts?.[0]?.text ??
      "(Brak odpowiedzi od Gemini)";

    return res.json({ ok: true, answer: text });
  } catch (err) {
    console.error("[GEMINI] RAG failed", err);
    return res
      .status(500)
      .json({ ok: false, error: "server_error" });
  }
});

// ─────────────────────  START SERWERA  ─────────────────────

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[BOOT] API listening on http://0.0.0.0:${PORT}`);
});
