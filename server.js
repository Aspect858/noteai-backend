// server.js  (ESM, gotowy pod Render)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { OAuth2Client } from 'google-auth-library';

const {
  PORT = 8080,
  NODE_ENV = 'production',
  GOOGLE_OAUTH_CLIENT_ID: WEB_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: WEB_CLIENT_SECRET,
} = process.env;

if (!WEB_CLIENT_ID || !WEB_CLIENT_SECRET) {
  console.error('[BOOT] Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET');
  process.exit(1);
}

// <<< KLUCZOWE: redirect_uri = 'postmessage' dla kodu z Androida
const oauth2 = new OAuth2Client(WEB_CLIENT_ID, WEB_CLIENT_SECRET, 'postmessage');

const app = express();
app.use(cors({ origin: '*', credentials: false }));
app.use(express.urlencoded({ extended: false }));         // form-urlencoded (Android/Retrofit)
app.use(express.json());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Wymiana serverAuthCode -> tokeny Google + profil
app.post('/auth/google/exchange', async (req, res) => {
  try {
    const code = (req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'missing_code' });

    // google-auth-library samo dośle redirect_uri=postmessage
    const { tokens } = await oauth2.getToken(code);

    if (!tokens?.access_token) {
      return res.status(400).json({ error: 'invalid_grant', detail: 'no access_token' });
    }

    // Pobierz profil przez /userinfo (bez manualnego verifyIdToken — unikasz błędu zegara)
    const uResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!uResp.ok) {
      const body = await uResp.text();
      return res.status(401).json({ error: 'unauthorized', detail: body });
    }

    const profile = await uResp.json();

    // Jeżeli masz własny JWT – tu go wystaw. Na szybko użyjemy id_token/access_token jako serverToken.
    const serverToken = tokens.id_token ?? tokens.access_token;

    return res.status(200).json({
      token: serverToken,
      user: {
        id: profile.sub,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
      },
    });
  } catch (err) {
    const msg = err?.response?.data || err?.message || String(err);
    // Zmapuj typowe błędy na 4xx, żeby nie widzieć 502 w aplikacji
    if (String(msg).includes('invalid_grant')) {
      return res.status(400).json({ error: 'invalid_grant', detail: msg });
    }
    if (String(msg).includes('unauthorized_client')) {
      return res.status(401).json({ error: 'unauthorized_client', detail: msg });
    }
    console.error('[AUTH] exchange failed', err);
    return res.status(500).json({ error: 'exchange_failed', detail: msg });
  }
});

// (opcjonalnie) prosty root
app.get('/', (_req, res) => res.redirect('/healthz'));

app.listen(PORT, () => {
  console.log(`API listening on http://0.0.0.0:${PORT}`);
});
