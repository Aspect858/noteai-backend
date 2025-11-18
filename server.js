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
  const code = req.body.code;
  if (!code) {
    return res.status(400).json({ ok: false, error: "missing_code" });
  }

  try {
    const params = new URLSearchParams();
    params.append("code", code);
    params.append("client_id", process.env.GOOGLE_OAUTH_CLIENT_ID);
    params.append("client_secret", process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    params.append("grant_type", "authorization_code");
    // Dla kodów z Androida GoogleSignIn redirect_uri zazwyczaj jest "postmessage"
    params.append("redirect_uri", "postmessage");

    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const tokens = await resp.json();
    if (!resp.ok) {
      console.error("[AUTH] Google token error", resp.status, tokens);
      return res.status(400).json({ ok: false, error: "google_error", detail: tokens });
    }

    // tutaj możesz zwrócić dalej tokeny / swój JWT
    return res.json({ ok: true, tokens });
  } catch (e) {
    console.error("[AUTH] exchange error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
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
