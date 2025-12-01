// server.js — backend dla NoteAI (Render, Node 22, ESM)
import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import crypto from "crypto";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();

// MIDDLEWARE
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Na start można zostawić origin: "*", ale w prod ogranicz do zaufanych originów
app.use(cors({ origin: "*" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ENV / CONFIG
const {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_CLIENT_ID_ANDROID,
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_SERVICE_ACCOUNT_JSON, // optional (stringified JSON)
  GEMINI_API_KEY,              // optional fallback
  GEMINI_MODEL = "gemini-1.5-flash",
  GEMINI_TEMPERATURE = "0.2",
  GEMINI_MAX_TOKENS = "1024",
  SERVER_JWT_SECRET
} = process.env;

// JWT secret
const JWT_SECRET = SERVER_JWT_SECRET || process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SERVER_JWT_SECRET) {
  console.warn("[BOOT] SERVER_JWT_SECRET not set — using ephemeral secret (not for production).");
}

if (!GOOGLE_OAUTH_CLIENT_ID) {
  console.warn("[BOOT] GOOGLE_OAUTH_CLIENT_ID not set — Google OAuth will fail.");
}

// OAUTH2 client (do wymiany code => token + verify id_token)
const oauth2Client = new OAuth2Client(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);

// GoogleAuth for Gemini (service account) — preferowane
let googleAuth;
try {
  const googleAuthCfg = { scopes: ["https://www.googleapis.com/auth/cloud-platform"] };
  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      googleAuthCfg.credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
      console.log("[BOOT] Using GOOGLE_SERVICE_ACCOUNT_JSON for GoogleAuth (parsed).");
    } catch (err) {
      console.warn("[BOOT] Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", err.message);
      // fallthrough to default ADC (if set in env as path) or to API_KEY fallback
    }
  }
  googleAuth = new GoogleAuth(googleAuthCfg);
} catch (err) {
  console.warn("[BOOT] GoogleAuth init failed:", err.message);
  googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
}

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// Auth config — klient mobilny wywoła to aby pobrać webClientId / androidClientId / redirectUri
app.get("/auth/config", (_req, res) => {
  return res.json({
    webClientId: GOOGLE_OAUTH_CLIENT_ID || null,
    androidClientId: GOOGLE_OAUTH_CLIENT_ID_ANDROID || null,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI || null
  });
});

// POST /auth/google/exchange
// body: { code: string }  <-- serverAuthCode z Androida (requestServerAuthCode)
app.post("/auth/google/exchange", async (req, res) => {
  const { code } = req.body ?? {};
  if (!code) {
    return res.status(400).json({ ok: false, error: "missing_code" });
  }

  try {
    // getToken obsłuży wymianę na access_token, id_token, refresh_token (jeśli dostępne)
    const r = await oauth2Client.getToken(code);
    const tokens = r.tokens || {};
    const idToken = tokens.id_token;

    if (!idToken) {
      console.error("[AUTH] No id_token in token response:", tokens);
      return res.status(400).json({ ok: false, error: "no_id_token", detail: tokens });
    }

    // Verify id_token and extract payload
    const ticket = await oauth2Client.verifyIdToken({
      idToken,
      audience: GOOGLE_OAUTH_CLIENT_ID
    });
    const payload = ticket.getPayload() || {};

    // Build user object (customize to your DB schema)
    const user = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture || null,
      locale: payload.locale || null
    };

    // Create our own JWT session token (or use DB to create session)
    const sessionToken = jwt.sign({
      sub: user.sub,
      email: user.email,
      name: user.name
    }, JWT_SECRET, { expiresIn: "30d" });

    // TODO: tutaj zapisz użytkownika w DB lub utwórz realną sesję (DB lub Redis)
    // Dla prostoty zwracamy user + token
    return res.json({ ok: true, user, token: sessionToken });

  } catch (err) {
    console.error("[AUTH] exchange failed:", err);
    // Jeśli Google zwraca 400/401 -> pokaż szczegóły w logach, ale w odpowiedzi ogólny błąd
    return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
  }
});

// GET /auth/me — zwróć obecną sesję (Authorization: Bearer <token>)
app.get("/auth/me", (req, res) => {
  try {
    const auth = req.header("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: "missing_token" });

    const payload = jwt.verify(token, JWT_SECRET);
    return res.json({ ok: true, user: payload });
  } catch (err) {
    return res.status(401).json({ ok: false, error: "invalid_token", detail: err.message });
  }
});

// POST /auth/logout (opcjonalne)
app.post("/auth/logout", (_req, res) => {
  // Jeśli trzymasz sesje w DB: usuń. Jeśli JWT — klient po prostu usuwa token.
  return res.json({ ok: true });
});

// POST /api/ask — Gemini
// body: { userId?: string, question: string }
app.post("/api/ask", async (req, res) => {
  const { userId, question } = req.body ?? {};
  if (!question) {
    return res.status(400).json({ ok: false, error: "missing_question" });
  }

  // Preferujemy service account (GoogleAuth + Bearer token). Fallback: API key (GEMINI_API_KEY)
  try {
    let accessToken = null;

    // jeśli googleAuth ma credentials (service account) lub ADC jest ustawione, pobierz token
    try {
      const client = await googleAuth.getClient();
      const t = await client.getAccessToken();
      accessToken = (t && t.token) ? t.token : t;
    } catch (err) {
      console.warn("[GEMINI] Could not get service account token:", err.message);
    }

    // Jeśli nie udało się uzyskać access token, sprawdź fallback na API key
    const useApiKey = !accessToken && GEMINI_API_KEY;
    if (!accessToken && !useApiKey) {
      console.error("[GEMINI] No credentials for Gemini: set GOOGLE_SERVICE_ACCOUNT_JSON or GEMINI_API_KEY");
      return res.status(500).json({ ok: false, error: "missing_gemini_credentials" });
    }

    const prompt = `
You are Notes Assistant for an Android notebook app.
User id (may be empty): ${userId || "anonymous"}.
User question: ${question}
Answer concisely in Polish unless user clearly uses another language.
    `;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent${useApiKey ? `?key=${encodeURIComponent(GEMINI_API_KEY)}` : ""}`;

    const headers = {
      "Content-Type": "application/json"
    };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    const gResp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: Number(GEMINI_TEMPERATURE || "0.2"),
          maxOutputTokens: Number(GEMINI_MAX_TOKENS || "1024")
        }
      })
    });

    const gJson = await gResp.json();

    if (!gResp.ok) {
      console.error("[GEMINI] API error", gJson);
      return res.status(500).json({ ok: false, error: "gemini_error", detail: gJson });
    }

    const text = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(Brak odpowiedzi od Gemini)";
    return res.json({ ok: true, answer: text });

  } catch (err) {
    console.error("[GEMINI] request failed", err);
    return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
  }
});

// START
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => console.log(`[BOOT] API listening on http://0.0.0.0:${PORT}`));
