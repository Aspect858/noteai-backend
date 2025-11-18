// server.js (ESM)
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { OAuth2Client } from "google-auth-library";

// === ENV ===
const {
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  PORT,
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("[BOOT] Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: "*" }));
app.use(morgan("dev"));
// obsłuż JSON i form-urlencoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function mapGoogleExchangeError(e) {
  const code = e?.response?.status;
  const data = e?.response?.data;
  if (code === 400 && data?.error === "invalid_grant") {
    return { status: 400, body: { error: "invalid_grant", detail: data } };
  }
  if (code === 400 && data?.error === "redirect_uri_mismatch") {
    return { status: 400, body: { error: "redirect_uri_mismatch", detail: data } };
  }
  if (code === 401) {
    return { status: 401, body: { error: "unauthorized_client", detail: data } };
  }
  return { status: 502, body: { error: "oauth_exchange_failed", detail: data || String(e) } };
}

// POST /auth/google/exchange
// body: { code: "serverAuthCode from Android" }
app.post("/auth/google/exchange", async (req, res) => {
  try {
    console.log("[AUTH] POST /auth/google/exchange body:", req.body);
    const code = req.body?.code ?? req.body?.authorization_code ?? req.query?.code;
    if (!code) return res.status(400).json({ error: "missing_code" });

    // ważne: podajemy 'postmessage' w konstruktorze i wywołujemy getToken(code)
    const oauth = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, "postmessage");
    // biblioteka sama użyje redirectUri z konstruktora
    const result = await oauth.getToken(code);
    const tokens = result.tokens;

    if (!tokens || (!tokens.id_token && !tokens.access_token)) {
      return res.status(400).json({ error: "exchange_failed", detail: tokens });
    }

    return res.json({ ok: true, tokens });
  } catch (e) {
    console.error("[AUTH] exchange failed", e?.response?.status, e?.response?.data || e);
    const mapped = mapGoogleExchangeError(e);
    return res.status(mapped.status).json(mapped.body);
  }
});

// Minimalny protected endpoint (przykład)
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
  const idToken = (req.headers.authorization || "").startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const user = idToken ? await getUserFromIdToken(idToken) : null;
  if (!user) return res.status(401).json({ error: "No user" });
  // tu Twój kod do Gemini...
  return res.json({ ok: true });
});

app.get("/healthz", (_req, res) => res.send("ok"));
const listenPort = Number(PORT || 8080);
app.listen(listenPort, () => console.log(`[BOOT] API listening on http://0.0.0.0:${listenPort}`));
