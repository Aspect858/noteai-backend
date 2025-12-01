// server.js — backend dla NoteAI (Render, Node 22+, ESM)
import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import crypto from "crypto";
import { OAuth2Client, GoogleAuth } from "google-auth-library";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();

// ─────────────────────  MIDDLEWARE  ─────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Na start możesz zostawić origin: "*", ale w produkcji ogranicz do zaufanych originów
app.use(cors({ origin: "*" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ─────────────────────  ENV / CONFIG  ─────────────────────
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

const JWT_SECRET = SERVER_JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!SERVER_JWT_SECRET) {
  console.warn("[BOOT] SERVER_JWT_SECRET not set — using ephemeral secret (not for production).");
}
if (!GOOGLE_OAUTH_CLIENT_ID) {
  console.warn("[BOOT] GOOGLE_OAUTH_CLIENT_ID not set — Google OAuth will fail.");
}
if (!GOOGLE_OAUTH_CLIENT_SECRET) {
  console.warn("[BOOT] GOOGLE_OAUTH_CLIENT_SECRET not set — Google token exchange will fail.");
}

// ─────────────────────  OAUTH / GOOGLE AUTH  ─────────────────────
// OAuth2Client do wymiany code -> token i weryfikacji id_token
const oauth2Client = new OAuth2Client(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);

// GoogleAuth do pobierania tokenu serwisowego dla Gemini (preferowane)
let googleAuth;
try {
  const gaConfig = { scopes: ["https://www.googleapis.com/auth/cloud-platform"] };
  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      gaConfig.credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
      console.log("[BOOT] Parsed GOOGLE_SERVICE_ACCOUNT_JSON (using embedded service account).");
    } catch (err) {
      console.warn("[BOOT] GOOGLE_SERVICE_ACCOUNT_JSON provided but failed to parse:", err.message);
      // pozwól GoogleAuth użyć ADC (np. GOOGLE_APPLICATION_CREDENTIALS) lub fallback na API key
    }
  }
  googleAuth = new GoogleAuth(gaConfig);
} catch (err) {
  console.warn("[BOOT] GoogleAuth init failed:", err.message);
  googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
}

// ─────────────────────  HEALTHCHECK  ─────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ─────────────────────  GOOGLE OAUTH  ─────────────────────

// GET /auth/config — klient mobilny pobiera publiczne clientId (web + android)
app.get("/auth/config", (_req, res) => {
  return res.json({
    webClientId: GOOGLE_OAUTH_CLIENT_ID || null,
    androidClientId: GOOGLE_OAUTH_CLIENT_ID_ANDROID || null,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI || null
  });
});

/**
 * POST /auth/google/exchange
 * Body: { code: string }  // serverAuthCode z Androida (requestServerAuthCode)
 * Zwraca: { ok: true, user, token } lub błąd
 */
app.post("/auth/google/exchange", async (req, res) => {
  const { code } = req.body ?? {};
  if (!code) {
    return res.status(400).json({ ok: false, error: "missing_code" });
  }

  try {
    // wymiana kodu na tokeny (access_token, id_token, refresh_token)
    const r = await oauth2Client.getToken(code);
    const tokens = r.tokens || {};
    const idToken = tokens.id_token;

    if (!idToken) {
      console.error("[AUTH] No id_token in token response:", tokens);
      return res.status(400).json({ ok: false, error: "no_id_token", detail: tokens });
    }

    // weryfikacja id_token
    const ticket = await oauth2Client.verifyIdToken({
      idToken,
      audience: GOOGLE_OAUTH_CLIENT_ID
    });
    const payload = ticket.getPayload() || {};

    // prosty obiekt użytkownika — dostosuj do Twojej bazy
    const user = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture || null,
      locale: payload.locale || null
    };

    // generujemy własny JWT (lub zamiast tego zapisz session w DB)
    const sessionToken = jwt.sign(
      { sub: user.sub, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    // TODO: zapisz użytkownika w DB / utwórz realną sesję — tutaj zwracamy tylko demo token
    return res.json({ ok: true, user, token: sessionToken });
  } catch (err) {
    console.error("[AUTH] exchange failed:", err);
    return res.status(500).json({ ok: false, error: "server_error", detail: err.message });
  }
});

// GET /auth/me — wymaga Authorization: Bearer <token>
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

// POST /auth/logout
app.post("/auth/logout", (_req, res) => {
  // Jeśli implementujesz sesje w DB: usuń tutaj sesję.
  return res.json({ ok: true });
});

// ─────────────────────  GEMINI /api/ask  ─────────────────────
/**
 * POST /api/ask
 * Body: { userId?: string, question: string }
 */
app.post("/api/ask", async (req, res) => {
  const { userId, question } = req.body ?? {};
  if (!question) {
    return res.status(400).json({ ok: false, error: "missing_question" });
  }

  try {
    // Preferujemy service account + Bearer token
    let accessToken = null;
    try {
      const client = await googleAuth.getClient();
      const t = await client.getAccessToken();
      accessToken = (t && typeof t === "object") ? t.token : t; // getAccessToken może zwracać { token } lub string
    } catch (err) {
      console.warn("[GEMINI] Could not obtain service account token:", err.message);
    }

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

    const headers = { "Content-Type": "application/json" };
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

// ─────────────────────  START SERWERA  ─────────────────────
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[BOOT] API listening on http://0.0.0.0:${PORT}`);
});
