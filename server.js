// server.js (ESM)
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
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
// ⬇️ obsłuż JSON i x-www-form-urlencoded (żeby nie było 'missing_code')
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

app.post("/auth/google/exchange", async (req, res) => {
  try {
    console.log("[AUTH] POST /auth/google/exchange body:", req.body);
    const code = req.body?.code ?? req.body?.authorization_code ?? req.query?.code;
    if (!code) return res.status(400).json({ error: "missing_code" });

    // ⬇️ KLUCZ: ustaw 'postmessage' w konstruktorze i wołaj getToken(code)
    const oauth = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, "postmessage");
    const { tokens } = await oauth.getToken(code);

    if (!tokens?.id_token) {
      return res.status(400).json({ error: "exchange_failed", detail: tokens });
    }
    return res.json({ ok: true, tokens });
  } catch (e) {
    console.error("[AUTH] exchange failed", e?.response?.status, e?.response?.data || e);
    const mapped = mapGoogleExchangeError(e);
    return res.status(mapped.status).json(mapped.body);
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

const listenPort = Number(PORT || 8080);
app.listen(listenPort, () => {
  console.log(`[BOOT] API listening on http://0.0.0.0:${listenPort}`);
});
