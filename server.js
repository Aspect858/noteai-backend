// server.js (ESM)
import express from "express";
import cors from "cors";
import morgan from "morgan";

const { OAuth2Client } = require("google-auth-library");

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
    const { code } = req.body; // U NAS "code" = idToken z Androida
    if (!code) {
      return res.status(400).json({ ok: false, error: "missing_code" });
    }

    // weryfikujemy ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: code,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res
        .status(401)
        .json({ ok: false, error: "invalid_token_payload" });
    }

    const user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture,
    };

    // tutaj możesz dopisać zapisywanie usera do DB, jeśli chcesz
    // ...

    return res.json({ ok: true, user });
  } catch (err) {
    console.error(
      "[AUTH] Google token verify error",
      err && err.response ? await err.response.text?.() : err
    );
    return res
      .status(401)
      .json({ ok: false, error: "google_error" });
  }
});

// Minimalny protected endpoint (przykład)
async function getUserFromIdToken(idToken) {
  try {
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
