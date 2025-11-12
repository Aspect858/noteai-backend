// server.js (ESM, Node 22)
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { OAuth2Client } from "google-auth-library";

// === env (Render) ===
const {
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  NODE_ENV,
  PORT,
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("[BOOT] Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: "*" }));

// <-- KLUCZOWE: obsługa JSON i form-urlencoded
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ——— utilities ———
function mapGoogleExchangeError(e) {
  const code = e?.response?.status;
  const data = e?.response?.data;
  if (code === 400 && data?.error === "invalid_grant") {
    return { status: 400, body: { error: "invalid_grant", detail: data } };
  }
  if (code === 401) {
    return { status: 401, body: { error: "unauthorized_client", detail: data } };
  }
  return { status: 502, body: { error: "oauth_exchange_failed", detail: data || String(e) } };
}

// ——— /auth/google/exchange ———
app.post("/auth/google/exchange", async (req, res) => {
try {
  console.log("[AUTH] POST /auth/google/exchange body:", req.body);

  const code = req.body?.code ?? req.body?.authorization_code ?? req.query?.code;
  if (!code) return res.status(400).json({ error: "missing_code" });

  // Tworzony z redirectUri 'postmessage' w konstruktorze
  const oauth = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, "postmessage");

  // Używamy prostego getToken(code) - biblioteka użyje redirectUri z konstruktora
  const result = await oauth.getToken(code);
  const tokens = result.tokens;

  if (!tokens || !tokens.id_token) {
    return res.status(400).json({ error: "exchange_failed", detail: tokens });
  }

  return res.json({ ok: true, tokens });
} catch (e) {
  console.error("[AUTH] exchange failed", e?.response?.status, e?.response?.data || e);
  const mapped = mapGoogleExchangeError(e);
  return res.status(mapped.status).json(mapped.body);
}
});

// ——— minimalne /api/ask (przykład) ———
async function getUserFromIdToken(idToken) {
  try {
    const oauth = new OAuth2Client(CLIENT_ID);
    const ticket = await oauth.verifyIdToken({ idToken, audience: CLIENT_ID });
    return ticket.getPayload();
  } catch {
    return null;
  }
}

app.post("/api/ask", async (req, res) => {
  const auth = req.headers.authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const user = idToken ? await getUserFromIdToken(idToken) : null;

  if (!user) return res.status(401).json({ error: "No user" });

  // ... tu Twój kod do Gemini ...
  return res.json({ ok: true });
});

app.get("/", (_, res) => res.status(404).send("ok"));
app.get("/healthz", (_, res) => res.send("ok"));

const listenPort = Number(PORT || 8080);
app.listen(listenPort, () => {
  console.log(`[BOOT] API listening on http://0.0.0.0:${listenPort}`);
});
