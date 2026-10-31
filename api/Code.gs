/**
 * zemmat go – API v1.1 (Google Apps Script, gebunden an ein Google Sheet)
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
 *                   {action:"cancel", k, id, name}        -> { ok }   (nur Ersteller:in)
 *                   {action:"subscribe", k, sub, name, sports:[…]} -> { ok }  Push-Abo anlegen/ändern
 *                   {action:"unsubscribe", k, endpoint}   -> { ok }
 *                   {action:"test", k, endpoint}          -> { ok, result }  Test-Popup an dieses Gerät
 * Fehler immer als { ok:false, error:"…" }
 *
 * Skripteigenschaften:
 *   KEY       Zugangsschlüssel (von setup() erzeugt). Löschen = offen für alle.
 *   SHEET_ID  optional, falls das Skript NICHT an das Sheet gebunden ist.
 *   PUSH_URL     URL des Cloudflare Workers (z. B. https://zemmat-go-push.<name>.workers.dev)
 *   PUSH_SECRET  gleiches Secret wie im Worker (SECRET)
 *   APP_URL      optional, Standard https://paulrigger.github.io/zemmat-go/
 */
const VERSION = '1.1';
const TZ = 'Europe/Vienna';
const SHEET = 'Events';
const COLS = ['id', 'erstellt', 'von', 'datum', 'zeit', 'dauer', 'sport', 'sportText', 'wer', 'treffpunkt', 'drink', 'dabei', 'status'];
const SPORTS = ['mtb', 'rennrad', 'gravel', 'jogga', 'wandra', 'klettra', 'schitour', 'langlauf', 'schwimma', 'anders'];
const DAUER = ['', 'h05', 'h1', 'h15', 'h2', 'h3', 'halb', 'ganz'];
const MAX_OPEN = 300;
const ABOS = 'Abos';
const ABO_COLS = ['endpoint', 'p256dh', 'auth', 'name', 'sports', 'erstellt', 'aktualisiert'];
const SPORT_TXT = { mtb: ['🚵', 'Mountainbika'], rennrad: ['🚴', 'Rennvelo fahra'], gravel: ['🚲', 'gravla'], jogga: ['🏃', 'jogga'],
  wandra: ['🥾', 'wandra'], klettra: ['🧗', 'klettra'], schitour: ['⛷️', 'uf Schitour'], langlauf: ['🎿', 'langlaufa'], schwimma: ['🏊', 'schwimma'], anders: ['✨', ''] };
const DAUER_TXT = { h05: 'a halbe Stund', h1: 'a Stund', h15: 'anderthalb Stund', h2: 'zwoa Stund', h3: 'drei Stund', halb: 'an halba Tag', ganz: 'an ganza Tag' };
const WD = ['Sunntig', 'Mäntig', 'Zischtig', 'Mittwoch', 'Donnstig', 'Fritig', 'Samstig']; // Schutz gegen Spam: max. offene Termine

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
function abos_() { return tab_(ABOS, ABO_COLS); }

/** Einmalig ausführen. */
function setup() {
  sheet_();
  abos_();
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
    if (key && p.k !== key) return { ok: false, error: 'Falscher oder fehlender Schlüssel – bitte Link us dr Gruppa verwenda.' };
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
      case 'join':   return locked_(() => join_(p.id, p.name, true));
      case 'leave':  return locked_(() => join_(p.id, p.name, false));
      case 'cancel': return locked_(() => cancel_(p.id, p.name));
      default:       return { ok: false, error: 'Unbekannte Aktion' };
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
  return { ok: true, version: VERSION, events, total: rows.length, push: vapid_() };
}

/* ---------- Schreiben ---------- */
function name_(s) { return String(s || '').replace(/[,<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24); }
function text_(s, n) { return String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n); }

function create_(e) {
  const von = name_(e.von);
  if (!von) throw new Error('Nama fehlt');
  if (!/^\d{4}-\d\d-\d\d$/.test(e.datum || '') || e.datum < today_(0) || e.datum > today_(366)) throw new Error('Ungültigs Datum');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.zeit || '')) throw new Error('Ungültige Zit');
  if (SPORTS.indexOf(e.sport) < 0) throw new Error('Unbekannte Sportart');
  const dauer = DAUER.indexOf(e.dauer || '') >= 0 ? (e.dauer || '') : '';
  const w = e.wer || {};
  let wer = 'i';
  if (w.mode === 'mir') wer = 'mir';
  if (w.mode === 'names') {
    const n = (w.names || []).map(name_).filter(String).slice(0, 8);
    wer = n.length ? n.join(', ') : 'i';
  }
  const { sh, rows } = rows_();
  const open = rows.filter(r => r.ev.status !== 'abgsagt' && r.ev.datum >= today_(0)).length;
  if (open >= MAX_OPEN) throw new Error('Z\'viel offene Termine');

  const ev = {
    id: Utilities.getUuid().replace(/-/g, '').slice(0, 8),
    erstellt: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    von, datum: e.datum, zeit: e.zeit, dauer, sport: e.sport,
    sportText: e.sport === 'anders' ? text_(e.sportText, 40) : '',
    wer, treffpunkt: text_(e.treffpunkt, 60), drink: e.drink ? 'ja' : '', dabei: '', status: ''
  };
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
  if (name_(name).toLowerCase() !== String(hit.ev.von).toLowerCase()) throw new Error('Nur ' + hit.ev.von + ' ka des absaga');
  sh.getRange(hit.row, COLS.indexOf('status') + 1).setValue('abgsagt');
  return { ok: true };
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
  const vals = [sub.endpoint, String(keys.p256dh), String(keys.auth), name_(p.name), sports, hit ? hit.erstellt : now, now];
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

function dayLabel_(datum) {
  const d = new Date(datum + 'T12:00:00');
  const n = Math.round((new Date(datum + 'T00:00:00').getTime() - new Date(today_(0) + 'T00:00:00').getTime()) / 864e5);
  const dm = d.getDate() + '.' + (d.getMonth() + 1) + '.';
  if (n === 0) return 'hüt';
  if (n === 1) return 'morn (' + WD[d.getDay()].slice(0, 2) + ' ' + dm + ')';
  if (n === 2) return 'übermorn (' + WD[d.getDay()].slice(0, 2) + ' ' + dm + ')';
  return 'am ' + WD[d.getDay()] + ' ' + dm;
}

function message_(ev) {
  const sp = SPORT_TXT[ev.sport] || SPORT_TXT.anders;
  const t = ev.sport === 'anders' ? (ev.sportText || 'öppis macha') : sp[1];
  const w = ev.wer || { mode: 'i' };
  const pl = w.mode !== 'i';
  const wer = w.mode === 'i' ? ev.von : w.mode === 'mir' ? ev.von + ' & Co.' : (w.names || []).join(', ');
  let body = dayLabel_(ev.datum) + ' um ' + ev.zeit + (ev.dauer && DAUER_TXT[ev.dauer] ? ' für ' + DAUER_TXT[ev.dauer] : '');
  if (ev.treffpunkt) body += '\n📍 ' + ev.treffpunkt;
  body += '\nWer kunnt mit?' + (ev.drink ? ' 🍺' : '');
  const app = props_().getProperty('APP_URL') || 'https://paulrigger.github.io/zemmat-go/';
  return { title: sp[0] + ' ' + wer + ' ' + (pl ? 'gond' : 'goht') + ' ' + t, body, url: app + '#e' + ev.id, tag: 'zg-' + ev.id };
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
  return push_(subs, message_(ev));
}

function test_(endpoint) {
  const { rows } = aboRows_();
  const a = rows.find(r => r.endpoint === String(endpoint));
  if (!a) throw new Error('Abo nüm gfunda – Popups nomol iischalta');
  if (!props_().getProperty('PUSH_URL')) throw new Error('PUSH_URL fehlt in de Skripteigenschafta');
  const app = props_().getProperty('APP_URL') || 'https://paulrigger.github.io/zemmat-go/';
  const j = push_([a], { title: '🔔 zemmat go', body: 'Hoi ' + (a.name || 'du') + '! Popups funktioniarand. 🎉', url: app, tag: 'zg-test' });
  const res = j && j.results && j.results[0];
  if (!res || res.status < 200 || res.status >= 300) throw new Error('Push-Dienst seit ' + (res ? res.status + ' ' + (res.error || '') : 'nüt'));
  return { ok: true, result: res };
}
