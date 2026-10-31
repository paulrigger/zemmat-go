/**
 * zemmat go – API v1.5 (Google Apps Script, gebunden an ein Google Sheet)
 *
 * Einrichtung:
 *   1. Neues Google Sheet → Erweiterungen → Apps Script → diesen Code einfügen
 *   2. Funktion setup() einmal ausführen → Schlüssel steht im Ausführungsprotokoll
 *   3. Bereitstellen → Neue Bereitstellung → Web-App
 *        Ausführen als: Ich   |   Zugriff: Jeder
 *   4. /exec-URL in index.html bei API_URL eintragen
 *
 * GET  ?action=list&k=…                                   -> { ok, version, events:[…], total }
 * POST (text/plain) {action:"create", k, event:{…}}       -> { ok, event }
 *                   {action:"join"|"leave", k, id, name}  -> { ok, event }
 *                   {action:"cancel", k, id, name}        -> { ok }   (jede:r)
 *                   {action:"subscribe", k, sub, name, sports:[…], lang} -> { ok }  Push-Abo (lang: dia|de)
 *                   {action:"unsubscribe", k, endpoint}   -> { ok }
 *                   {action:"test", k, endpoint}          -> { ok, result }  Test-Popup an dieses Gerät
 *                   {action:"update", k, id, name, event:{…}} -> { ok, event }  (jede:r)
 *                   {action:"chat", k, id, name, text}    -> { ok, chat:[…] }  Chat-Nachricht zu einem Termin
 * Jeder Termin in list hat chat:[{n, t, z}] (Name, Text, Zeit).
 * Fehler immer als { ok:false, error:"…" }
 *
 * Skripteigenschaften:
 *   KEY       Zugangsschlüssel (von setup() erzeugt). Löschen = offen für alle.
 *   SHEET_ID  optional, falls das Skript NICHT an das Sheet gebunden ist.
 *   PUSH_URL     URL des Cloudflare Workers (z. B. https://zemmat-go-push.<name>.workers.dev)
 *   PUSH_SECRET  gleiches Secret wie im Worker (SECRET)
 *   APP_URL      optional, Standard https://paulrigger.github.io/zemmat-go/
 */
const VERSION = '1.5';
const TZ = 'Europe/Vienna';
const SHEET = 'Events';
const COLS = ['id', 'erstellt', 'von', 'datum', 'zeit', 'dauer', 'sport', 'sportText', 'wer', 'treffpunkt', 'drink', 'dabei', 'status'];
const SPORTS = ['mtb', 'rennrad', 'gravel', 'jogga', 'wandra', 'klettra', 'schitour', 'langlauf', 'schwimma', 'anders'];
const DAUER = ['', 'h05', 'h1', 'h15', 'h2', 'h3', 'halb', 'ganz'];
const MAX_OPEN = 300;
const ABOS = 'Abos';
const CHAT = 'Chat';
const CHAT_COLS = ['id', 'event', 'zeit', 'name', 'text'];
const ABO_COLS = ['endpoint', 'p256dh', 'auth', 'name', 'sports', 'erstellt', 'aktualisiert', 'lang'];
// [Emoji, Dialekt, Hochdeutsch]
const SPORT_TXT = { mtb: ['🚵', 'Mountainbika', 'Mountainbiken'], rennrad: ['🚴', 'Rennvelo fahra', 'Rennrad fahren'], gravel: ['🚲', 'gravla', 'graveln'],
  jogga: ['🏃', 'jogga', 'joggen'], wandra: ['🥾', 'wandra', 'wandern'], klettra: ['🧗', 'klettra', 'klettern'], schitour: ['⛷️', 'uf Schitour', 'auf Skitour'],
  langlauf: ['🎿', 'langlaufa', 'langlaufen'], schwimma: ['🏊', 'schwimma', 'schwimmen'], anders: ['✨', '', ''] };
const DAUER_TXT = { h05: ['a halbe Stund', 'eine halbe Stunde'], h1: ['a Stund', 'eine Stunde'], h15: ['anderthalb Stund', 'anderthalb Stunden'],
  h2: ['zwoa Stund', 'zwei Stunden'], h3: ['drei Stund', 'drei Stunden'], halb: ['an halba Tag', 'einen halben Tag'], ganz: ['an ganza Tag', 'einen ganzen Tag'] };
const WD = { dia: ['Sunntig', 'Mäntig', 'Zischtig', 'Mittwoch', 'Donnstig', 'Fritig', 'Samstig'], de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'] }; // Schutz gegen Spam: max. offene Termine

const props_ = () => PropertiesService.getScriptProperties();

function ss_() {
  const id = props_().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function tab_(name, cols) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@'); // alles als Text (Datum/Zeit nicht umwandeln)
  }
  return sh;
}
function sheet_() { return tab_(SHEET, COLS); }
function chat_() { return tab_(CHAT, CHAT_COLS); }
function abos_() {
  const sh = tab_(ABOS, ABO_COLS);
  if (sh.getLastColumn() < ABO_COLS.length) sh.getRange(1, 1, 1, ABO_COLS.length).setValues([ABO_COLS]).setFontWeight('bold'); // neue Spalten nachziehen
  return sh;
}

/** Einmalig ausführen. */
function setup() {
  sheet_();
  abos_();
  chat_();
  let key = props_().getProperty('KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    props_().setProperty('KEY', key);
  }
  Logger.log('Sheet bereit. Schlüssel: ' + key);
  Logger.log('Gruppen-Link: https://paulrigger.github.io/zemmat-go/?k=' + key);
}

function doGet(e) { return out_(run_((e && e.parameter) || {})); }
function doPost(e) {
  let p;
  try { p = JSON.parse(e.postData.contents); } catch (x) { return out_({ ok: false, error: 'Ungültigs JSON' }); }
  return out_(run_(p));
}
function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function run_(p) {
  try {
    const key = props_().getProperty('KEY');
    if (key && p.k !== key) return { ok: false, error: 'Falscha oder kua Schlüssel – nimm da Link us dr Gruppa.' };
    switch (p.action) {
      case 'list':   return list_();
      case 'create': {
        const r = locked_(() => create_(p.event || {}));
        if (r.ok) { try { notify_(r.event); } catch (x) { console.error('Push: ' + x); } }
        return r;
      }
      case 'subscribe':   return locked_(() => subscribe_(p));
      case 'unsubscribe': return locked_(() => unsubscribe_(p.endpoint));
      case 'test':        return test_(p.endpoint);
      case 'update': {
        const r = locked_(() => update_(p.id, p.name, p.event || {}));
        if (r.ok) { try { notifyChange_(r.before, r.event, name_(p.name)); } catch (x) { console.error('Push Änderung: ' + x); } delete r.before; }
        return r;
      }
      case 'chat': {
        const r = locked_(() => chatPost_(p.id, p.name, p.text));
        if (r.ok) { try { notifyChat_(r.event, r.msg); } catch (x) { console.error('Push Chat: ' + x); } delete r.event; delete r.msg; }
        return r;
      }
      case 'join':   return locked_(() => join_(p.id, p.name, true));
      case 'leave':  return locked_(() => join_(p.id, p.name, false));
      case 'cancel': {
        const r = locked_(() => cancel_(p.id, p.name));
        if (r.ok) { try { notifyCancel_(r.event, name_(p.name)); } catch (x) { console.error('Push Absage: ' + x); } delete r.event; }
        return r;
      }
      default:       return { ok: false, error: 'Dia Aktion kenn i ned' };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function locked_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'Grad viel los – bitte nomol probiera.' };
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- Lesen ---------- */
function rows_() {
  const sh = sheet_();
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) if (v[i][0]) out.push({ row: i + 1, ev: toEvent_(v[i]) });
  return { sh, rows: out };
}
function str_(x, fmt) { return x instanceof Date ? Utilities.formatDate(x, TZ, fmt) : String(x == null ? '' : x); }
function toEvent_(r) {
  const o = {};
  COLS.forEach((c, i) => o[c] = r[i]);
  o.id = String(o.id);
  o.datum = str_(o.datum, 'yyyy-MM-dd');
  o.zeit = str_(o.zeit, 'HH:mm');
  o.erstellt = str_(o.erstellt, "yyyy-MM-dd'T'HH:mm:ssXXX");
  o.drink = o.drink === 'ja' || o.drink === true;
  o.dabei = String(o.dabei || '').split(',').map(s => s.trim()).filter(String);
  const w = String(o.wer || 'i');
  o.wer = w === 'i' || w === 'mir' ? { mode: w, names: [] } : { mode: 'names', names: w.split(',').map(s => s.trim()).filter(String) };
  o.status = String(o.status || '');
  return o;
}
function today_(offset) { return Utilities.formatDate(new Date(Date.now() + (offset || 0) * 864e5), TZ, 'yyyy-MM-dd'); }

function list_() {
  const { rows } = rows_();
  const from = today_(-1);
  const events = rows.map(r => r.ev).filter(e => e.status !== 'abgsagt' && e.datum >= from);
  const chats = chatMap_();
  events.forEach(e => e.chat = chats[e.id] || []);
  return { ok: true, version: VERSION, events, total: rows.length, push: vapid_() };
}

/* ---------- Schreiben ---------- */
function name_(s) { return String(s || '').replace(/[,<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24); }
function text_(s, n) { return String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n); }

/** Gemeinsame Prüfung für create/update → bereinigte Felder */
function fields_(e) {
  if (!/^\d{4}-\d\d-\d\d$/.test(e.datum || '') || e.datum < today_(0) || e.datum > today_(366)) throw new Error('Ungültigs Datum');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.zeit || '')) throw new Error('Ungültigi Zit');
  if (SPORTS.indexOf(e.sport) < 0) throw new Error('Dia Sportart kenn i ned');
  const dauer = DAUER.indexOf(e.dauer || '') >= 0 ? (e.dauer || '') : '';
  const w = e.wer || {};
  let wer = 'i';
  if (w.mode === 'mir') wer = 'mir';
  if (w.mode === 'names') {
    const n = (w.names || []).map(name_).filter(String).slice(0, 8);
    wer = n.length ? n.join(', ') : 'i';
  }
  return { datum: e.datum, zeit: e.zeit, dauer, sport: e.sport, sportText: e.sport === 'anders' ? text_(e.sportText, 40) : '',
           wer, treffpunkt: text_(e.treffpunkt, 60), drink: e.drink ? 'ja' : '' };
}

function create_(e) {
  const von = name_(e.von);
  if (!von) throw new Error('Nama fehlt');
  const f = fields_(e);
  const { sh, rows } = rows_();
  const open = rows.filter(r => r.ev.status !== 'abgsagt' && r.ev.datum >= today_(0)).length;
  if (open >= MAX_OPEN) throw new Error('Z\'viel offne Termin');

  const ev = Object.assign({
    id: Utilities.getUuid().replace(/-/g, '').slice(0, 8),
    erstellt: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    von, dabei: '', status: ''
  }, f);
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, COLS.length).setNumberFormat('@').setValues([COLS.map(c => ev[c])]);
  return { ok: true, event: toEvent_(COLS.map(c => ev[c])) };
}

function find_(id) {
  const { sh, rows } = rows_();
  const hit = rows.find(r => r.ev.id === String(id));
  if (!hit || hit.ev.status === 'abgsagt') throw new Error('Termin nüm gfunda');
  return { sh, hit };
}

function join_(id, name, add) {
  const n = name_(name);
  if (!n) throw new Error('Nama fehlt');
  const { sh, hit } = find_(id);
  const ev = hit.ev;
  const lc = n.toLowerCase();
  let list = ev.dabei.filter(x => x.toLowerCase() !== lc);
  if (add) list.push(n);
  if (list.length > 50) throw new Error('Z\'viel Lüt 😅');
  sh.getRange(hit.row, COLS.indexOf('dabei') + 1).setValue(list.join(', '));
  ev.dabei = list;
  return { ok: true, event: ev };
}

function cancel_(id, name) {
  const { sh, hit } = find_(id);
  if (!name_(name)) throw new Error('Nama fehlt');
  sh.getRange(hit.row, COLS.indexOf('status') + 1).setValue('abgsagt');
  return { ok: true, event: hit.ev };
}

/* ---------- Push ---------- */
function vapid_() {
  const url = props_().getProperty('PUSH_URL');
  if (!url) return '';
  let key = props_().getProperty('VAPID_PUBLIC');
  if (key) return key;
  try {
    const r = JSON.parse(UrlFetchApp.fetch(url.replace(/\/$/, '') + '/key', { muteHttpExceptions: true }).getContentText());
    if (r.ok && r.key) { props_().setProperty('VAPID_PUBLIC', r.key); return r.key; }
  } catch (e) { console.error('VAPID-Key: ' + e); }
  return '';
}

function aboRows_() {
  const sh = abos_();
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < v.length; i++) if (v[i][0]) {
    const o = {}; ABO_COLS.forEach((c, j) => o[c] = String(v[i][j]));
    o.row = i + 1; out.push(o);
  }
  return { sh, rows: out };
}

function subscribe_(p) {
  const sub = p.sub || {}, keys = sub.keys || {};
  if (!/^https:\/\/[^\s]+$/.test(sub.endpoint || '') || !keys.p256dh || !keys.auth) throw new Error('Ungültigs Abo');
  const sports = (p.sports || []).filter(s => SPORTS.indexOf(s) >= 0).join(',');
  const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const { sh, rows } = aboRows_();
  const hit = rows.find(r => r.endpoint === sub.endpoint);
  const lang = p.lang === 'de' ? 'de' : 'dia';
  const vals = [sub.endpoint, String(keys.p256dh), String(keys.auth), name_(p.name), sports, hit ? hit.erstellt : now, now, lang];
  if (hit) sh.getRange(hit.row, 1, 1, ABO_COLS.length).setValues([vals]);
  else {
    if (rows.length >= 1000) throw new Error('Z\'viel Abos');
    sh.getRange(sh.getLastRow() + 1, 1, 1, ABO_COLS.length).setNumberFormat('@').setValues([vals]);
  }
  return { ok: true };
}

function unsubscribe_(endpoint) {
  const { sh, rows } = aboRows_();
  rows.filter(r => r.endpoint === String(endpoint)).reverse().forEach(r => sh.deleteRow(r.row));
  return { ok: true };
}

function dayLabel_(datum, lang) {
  const de = lang === 'de', wd = WD[de ? 'de' : 'dia'];
  const d = new Date(datum + 'T12:00:00');
  const n = Math.round((new Date(datum + 'T00:00:00').getTime() - new Date(today_(0) + 'T00:00:00').getTime()) / 864e5);
  const dm = d.getDate() + '.' + (d.getMonth() + 1) + '.';
  if (n === 0) return de ? 'heute' : 'hüt';
  if (n === 1) return (de ? 'morgen' : 'morn') + ' (' + wd[d.getDay()].slice(0, 2) + ' ' + dm + ')';
  if (n === 2) return (de ? 'übermorgen' : 'übermorn') + ' (' + wd[d.getDay()].slice(0, 2) + ' ' + dm + ')';
  return 'am ' + wd[d.getDay()] + ' ' + dm;
}

function message_(ev, lang) {
  const de = lang === 'de';
  const sp = SPORT_TXT[ev.sport] || SPORT_TXT.anders;
  const t = ev.sport === 'anders' ? (ev.sportText || (de ? 'etwas unternehmen' : 'öppis macha')) : sp[de ? 2 : 1];
  const w = ev.wer || { mode: 'i' };
  const pl = w.mode !== 'i';
  const wer = w.mode === 'i' ? ev.von : w.mode === 'mir' ? ev.von + ' & Co.' : (w.names || []).join(', ');
  const verb = pl ? (de ? 'gehen' : 'gond') : (de ? 'geht' : 'goht');
  let body = dayLabel_(ev.datum, lang) + ' um ' + ev.zeit + (ev.dauer && DAUER_TXT[ev.dauer] ? ' für ' + DAUER_TXT[ev.dauer][de ? 1 : 0] : '');
  if (ev.treffpunkt) body += '\n📍 ' + ev.treffpunkt;
  body += (de ? '\nWer kommt mit?' : '\nWer kunnt mit?') + (ev.drink ? ' 🍺' : '');
  const app = props_().getProperty('APP_URL') || 'https://paulrigger.github.io/zemmat-go/';
  return { title: sp[0] + ' ' + wer + ' ' + verb + ' ' + t, body, url: app + '#e' + ev.id, tag: 'zg-' + ev.id };
}

function push_(subs, payload) {
  const url = props_().getProperty('PUSH_URL'), secret = props_().getProperty('PUSH_SECRET');
  if (!url || !secret || !subs.length) return null;
  const r = UrlFetchApp.fetch(url.replace(/\/$/, '') + '/send', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ secret, subs: subs.map(a => ({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } })), payload })
  });
  const j = JSON.parse(r.getContentText());
  if (!j.ok) throw new Error('Push-Worker: ' + j.error);
  const gone = (j.results || []).filter(x => x.gone).map(x => x.endpoint);
  if (gone.length) locked_(() => { gone.forEach(unsubscribe_); return { ok: true }; });
  return j;
}

function notify_(ev) {
  const { rows } = aboRows_();
  const von = String(ev.von).toLowerCase();
  const subs = rows.filter(a => a.sports.split(',').indexOf(ev.sport) >= 0 && a.name.toLowerCase() !== von);
  const de = subs.filter(a => a.lang === 'de'), dia = subs.filter(a => a.lang !== 'de');
  if (dia.length) push_(dia, message_(ev, 'dia'));
  if (de.length) push_(de, message_(ev, 'de'));
  return { ok: true };
}

function test_(endpoint) {
  const { rows } = aboRows_();
  const a = rows.find(r => r.endpoint === String(endpoint));
  if (!a) throw new Error('Abo nüm gfunda – Popups nomol iischalta');
  if (!props_().getProperty('PUSH_URL')) throw new Error('PUSH_URL fehlt in da Skripteigenschafta');
  const app = props_().getProperty('APP_URL') || 'https://paulrigger.github.io/zemmat-go/';
  const body = a.lang === 'de' ? 'Hallo ' + (a.name || '') + ', Benachrichtigungen funktionieren.' : 'Hoi ' + (a.name || 'du') + '! Popups funktioniarand. 🎉';
  const j = push_([a], { title: '🔔 zemmat go', body, url: app, tag: 'zg-test' });
  const res = j && j.results && j.results[0];
  if (!res || res.status < 200 || res.status >= 300) throw new Error('Push-Dienst seit ' + (res ? res.status + ' ' + (res.error || '') : 'nüt'));
  return { ok: true, result: res };
}

/* ---------- Chat ---------- */
function chatMap_() {
  const v = chat_().getDataRange().getValues();
  const m = {};
  for (let i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    const ev = String(v[i][1]);
    (m[ev] = m[ev] || []).push({ n: String(v[i][3]), t: String(v[i][4]), z: str_(v[i][2], "yyyy-MM-dd'T'HH:mm:ssXXX") });
  }
  Object.keys(m).forEach(k => { if (m[k].length > 100) m[k] = m[k].slice(-100); });
  return m;
}

function chatPost_(id, name, text) {
  const n = name_(name);
  if (!n) throw new Error('Nama fehlt');
  const t = String(text || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!t) throw new Error('Nüt gschrieba');
  const { hit } = find_(id);
  const sh = chat_();
  const z = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  sh.getRange(sh.getLastRow() + 1, 1, 1, CHAT_COLS.length).setNumberFormat('@')
    .setValues([[Utilities.getUuid().replace(/-/g, '').slice(0, 8), String(id), z, n, t]]);
  const chat = chatMap_()[String(id)] || [];
  return { ok: true, chat, event: hit.ev, msg: { n, t, z } };
}

/** Popup an alle, die beim Termin beteiligt sind (Ersteller:in, Dabei, Namen, Chat), außer Absender:in */
function notifyChat_(ev, msg) {
  const people = {};
  [ev.von].concat(ev.dabei || [], (ev.wer && ev.wer.names) || [], (chatMap_()[ev.id] || []).map(c => c.n))
    .forEach(x => { if (x) people[String(x).toLowerCase()] = 1; });
  delete people[msg.n.toLowerCase()];
  const { rows } = aboRows_();
  const subs = rows.filter(a => people[a.name.toLowerCase()]);
  if (!subs.length) return;
  const app = props_().getProperty('APP_URL') || 'https://paulrigger.github.io/zemmat-go/';
  const sp = SPORT_TXT[ev.sport] || SPORT_TXT.anders;
  const mk = de => ({
    title: '💬 ' + msg.n + ' (' + sp[0] + ' ' + (ev.sport === 'anders' ? ev.sportText : sp[de ? 2 : 1]) + ', ' + dayLabel_(ev.datum, de ? 'de' : 'dia').replace(/ \(.*\)$/, '') + ')',
    body: msg.t.slice(0, 180), url: app + '#c' + ev.id, tag: 'zg-chat-' + ev.id
  });
  const de = subs.filter(a => a.lang === 'de'), dia = subs.filter(a => a.lang !== 'de');
  if (dia.length) push_(dia, mk(false));
  if (de.length) push_(de, mk(true));
}

/* ---------- Ändern ---------- */
function update_(id, name, e) {
  const { sh, hit } = find_(id);
  if (!name_(name)) throw new Error('Nama fehlt');
  const f = fields_(e);
  const row = sh.getRange(hit.row, 1, 1, COLS.length);
  const fmt = c => c === 'zeit' ? 'HH:mm' : c === 'datum' ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ssXXX";
  const raw = row.getValues()[0].map((v, j) => v instanceof Date ? str_(v, fmt(COLS[j])) : v);
  Object.keys(f).forEach(k => { raw[COLS.indexOf(k)] = f[k]; });
  row.setNumberFormat('@').setValues([raw]);
  const ev = toEvent_(row.getValues()[0]);
  ev.chat = chatMap_()[ev.id] || [];
  return { ok: true, event: ev, before: hit.ev };
}

/** Popup „Termin geändert“ an alle Beteiligten außer der Person, die geändert hat */
function notifyChange_(before, ev, by) {
  const what = [];
  if (before.datum !== ev.datum) what.push('datum');
  if (before.zeit !== ev.zeit) what.push('zeit');
  if (before.treffpunkt !== ev.treffpunkt) what.push('treff');
  if (before.sport !== ev.sport || before.sportText !== ev.sportText) what.push('sport');
  if (before.dauer !== ev.dauer) what.push('dauer');
  if (!what.length) return;                       // nur Kleinigkeiten (z. B. Drink) → kein Popup
  const people = {};
  [ev.von].concat(ev.dabei || [], (ev.wer && ev.wer.names) || [], (ev.chat || []).map(c => c.n))
    .forEach(x => { if (x) people[String(x).toLowerCase()] = 1; });
  delete people[String(by).toLowerCase()];
  const { rows } = aboRows_();
  const subs = rows.filter(a => people[a.name.toLowerCase()]);
  if (!subs.length) return;
  const app = props_().getProperty('APP_URL') || 'https://paulrigger.github.io/zemmat-go/';
  const mk = lang => {
    const m = message_(ev, lang);
    const von = same_(by, ev.von) ? '' : (lang === 'de' ? ' (von ' : ' (vo ') + by + ')';
    return { title: (lang === 'de' ? '✏️ Geändert: ' : '✏️ Gändert: ') + m.title.replace(/^\S+ /, '') + von, body: m.body, url: app + '#e' + ev.id, tag: 'zg-' + ev.id };
  };
  const de = subs.filter(a => a.lang === 'de'), dia = subs.filter(a => a.lang !== 'de');
  if (dia.length) push_(dia, mk('dia'));
  if (de.length) push_(de, mk('de'));
}

function same_(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }

/** Popup „abgesagt“ an alle Beteiligten außer der Person, die abgesagt hat */
function notifyCancel_(ev, by) {
  const people = {};
  [ev.von].concat(ev.dabei || [], (ev.wer && ev.wer.names) || [], (chatMap_()[ev.id] || []).map(c => c.n))
    .forEach(x => { if (x) people[String(x).toLowerCase()] = 1; });
  delete people[String(by).toLowerCase()];
  const { rows } = aboRows_();
  const subs = rows.filter(a => people[a.name.toLowerCase()]);
  if (!subs.length) return;
  const app = props_().getProperty('APP_URL') || 'https://paulrigger.github.io/zemmat-go/';
  const mk = lang => {
    const m = message_(ev, lang), de = lang === 'de';
    return { title: (de ? '❌ Abgesagt: ' : '❌ Abgsagt: ') + m.title.replace(/^\S+ /, ''),
             body: dayLabel_(ev.datum, lang) + ' um ' + ev.zeit + (de ? ' – abgesagt von ' : ' – abgsagt vo ') + by, url: app, tag: 'zg-' + ev.id };
  };
  const de = subs.filter(a => a.lang === 'de'), dia = subs.filter(a => a.lang !== 'de');
  if (dia.length) push_(dia, mk('dia'));
  if (de.length) push_(de, mk('de'));
}
