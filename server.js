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
app.use(cors({ origin: "*"}));
app.use(bodyParser.json());

// ——— utilities ———
function mapGoogleExchangeError(e) {
  // przydatne logi do diagnozy bez wysadzania 500
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
// body: { code: "<serverAuthCode from Android>" }
app.post("/auth/google/exchange", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "missing_code" });

    // Uwaga: redirect_uri MUSI być 'postmessage' przy wymianie kodu z GoogleSignIn (Android/iOS)
    const oauth = new OAuth2Client({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: "postmessage",
    });

    const { tokens } = await oauth.getToken({ code, redirect_uri: "postmessage" });
    // tokens: { access_token, id_token, refresh_token?, expires_in, scope, token_type }
    // Często refresh_token pojawia się tylko przy pierwszym logowaniu lub gdy forceCodeForRefreshToken=true (u Ciebie jest true)
    // Możesz tu zrobić lookup/create usera w DB bazując na id_token (sub)

    return res.json({ ok: true, tokens });
  } catch (e) {
    console.error("[AUTH] exchange failed", e?.response?.status, e?.response?.data || e);
    const mapped = mapGoogleExchangeError(e);
    return res.status(mapped.status).json(mapped.body);
  }
});

// ——— przykładowe zabezpieczenie do /api/ask ———
// jeśli wysyłasz idToken w nagłówku Authorization: Bearer <idToken>
async function getUserFromIdToken(idToken) {
  try {
    const oauth = new OAuth2Client(CLIENT_ID);
    const ticket = await oauth.verifyIdToken({ idToken, audience: CLIENT_ID });
    return ticket.getPayload(); // { sub, email, name, picture, ... }
  } catch {
    return null;
  }
}

app.post("/api/ask", async (req, res) => {
  // minimalny "auth"
  const auth = req.headers.authorization || "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const user = idToken ? await getUserFromIdToken(idToken) : null;

  if (!user) {
    // nie zabijaj 500 – frontend dostanie sensowny błąd
    return res.status(401).json({ error: "No user" });
  }

  // ... tutaj Twój kod do Gemini (zostawiam jak masz) ...
  // ważne: timeouts/reties – ustaw rozsądny timeout klienta HTTP (30s) i logi odpowiedzi

  return res.json({ ok: true /*, answer */ });
});

// health/ping
app.get("/", (_, res) => res.status(404).send("ok"));
app.get("/healthz", (_, res) => res.send("ok"));

const listenPort = Number(PORT || 8080);
app.listen(listenPort, () => {
  console.log(`[BOOT] API listening on http://0.0.0.0:${listenPort}`);
});
