/**
 * zemmat go – Push-Worker v1.0 (Cloudflare Workers, kein Build, keine Abhängigkeiten)
 *
 * Verschickt Web-Push-Nachrichten (RFC 8291 aes128gcm + RFC 8292 VAPID) an die
 * Abos, die Apps Script mitschickt. Der Worker speichert selbst nichts.
 *
 * Variablen (Settings → Variables and Secrets):
 *   VAPID_JWK  (Secret)  privater VAPID-Schlüssel als JWK – beim ersten Aufruf von GET / erzeugen lassen
 *   SECRET     (Secret)  gemeinsames Passwort mit Apps Script (Skripteigenschaft PUSH_SECRET)
 *   SUBJECT    (Text)    optional, Kontakt für Push-Dienste, z. B. mailto:du@example.com
 *
 * GET  /        → Status bzw. Einrichtungshilfe (neuer Schlüssel, solange VAPID_JWK fehlt)
 * GET  /key     → { key }  öffentlicher VAPID-Schlüssel (base64url) für pushManager.subscribe()
 * POST /send    { secret, subs:[{endpoint, keys:{p256dh, auth}}], payload:{…} }
 *               → { ok, results:[{endpoint, status, gone}] }   gone = Abo abgelaufen (404/410) → löschen
 */
const SUBJECT_DEFAULT = 'https://paulrigger.github.io/zemmat-go/';

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' } });

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** Öffentlichen Schlüssel (65 Byte, unkomprimiert) aus JWK bauen */
const pubFromJwk = j => concat(new Uint8Array([4]), unb64u(j.x), unb64u(j.y));

/** RFC 8291: Payload für ein Abo verschlüsseln → Body (aes128gcm) */
export async function encrypt(payload, p256dh, auth) {
  const uaPub = unb64u(p256dh), authSecret = unb64u(auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));

  const header = new Uint8Array(21 + asPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  header.set(asPub, 21);
  return concat(header, ct);
}

/** RFC 8292: VAPID-JWT für die Origin des Push-Dienstes */
export async function vapidAuth(endpoint, jwk, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${b64u(pubFromJwk(jwk))}`;
}

async function sendOne(sub, payload, jwk, subject) {
  try {
    if (!sub || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { endpoint: sub && sub.endpoint, status: 0, gone: true, error: 'ungültiges Abo' };
    const body = await encrypt(payload, sub.keys.p256dh, sub.keys.auth);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': await vapidAuth(sub.endpoint, jwk, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '43200',
        'Urgency': 'normal'
      },
      body
    });
    const out = { endpoint: sub.endpoint, status: r.status, gone: r.status === 404 || r.status === 410 };
    if (r.status >= 400) out.error = (await r.text()).slice(0, 200);
    return out;
  } catch (e) {
    return { endpoint: sub && sub.endpoint, status: 0, gone: false, error: String(e && e.message || e) };
  }
}

async function newJwk() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await crypto.subtle.exportKey('jwk', k.privateKey);
  return JSON.stringify({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d });
}

function jwk_(env) {
  if (!env.VAPID_JWK) return null;
  try { const j = JSON.parse(env.VAPID_JWK); return j.x && j.y && j.d ? j : null; } catch (e) { return null; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' } });
    const jwk = jwk_(env);

    if (req.method === 'GET' && url.pathname === '/') {
      if (!jwk) return json({
        ok: false,
        hinweis: 'VAPID_JWK fehlt. Den Wert unten als Secret VAPID_JWK speichern (Settings → Variables and Secrets → Add → Type: Secret). Danach diese Seite neu laden.',
        VAPID_JWK: await newJwk()
      });
      return json({ ok: true, service: 'zemmat go push', key: b64u(pubFromJwk(jwk)), secret: env.SECRET ? 'gesetzt' : 'FEHLT' });
    }
    if (req.method === 'GET' && url.pathname === '/key') {
      return jwk ? json({ ok: true, key: b64u(pubFromJwk(jwk)) }) : json({ ok: false, error: 'VAPID_JWK fehlt' }, 500);
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      if (!jwk) return json({ ok: false, error: 'VAPID_JWK fehlt' }, 500);
      let p;
      try { p = await req.json(); } catch (e) { return json({ ok: false, error: 'Ungültiges JSON' }, 400); }
      if (!env.SECRET || p.secret !== env.SECRET) return json({ ok: false, error: 'Falsches Secret' }, 403);
      const subs = Array.isArray(p.subs) ? p.subs.slice(0, 500) : [];
      const payload = JSON.stringify(p.payload || {});
      if (payload.length > 3000) return json({ ok: false, error: 'Payload zu groß' }, 400);
      const subject = env.SUBJECT || SUBJECT_DEFAULT;
      const results = await Promise.all(subs.map(s => sendOne(s, payload, jwk, subject)));
      return json({ ok: true, sent: results.filter(r => r.status >= 200 && r.status < 300).length, results });
    }
    return json({ ok: false, error: 'Nicht gefunden' }, 404);
  }
};
