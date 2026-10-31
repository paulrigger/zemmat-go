/**
 * zemmat go – API v1.0 (Google Apps Script, gebunden an ein Google Sheet)
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
 * Fehler immer als { ok:false, error:"…" }
 *
 * Skripteigenschaften:
 *   KEY       Zugangsschlüssel (von setup() erzeugt). Löschen = offen für alle.
 *   SHEET_ID  optional, falls das Skript NICHT an das Sheet gebunden ist.
 */
const VERSION = '1.0';
const TZ = 'Europe/Vienna';
const SHEET = 'Events';
const COLS = ['id', 'erstellt', 'von', 'datum', 'zeit', 'dauer', 'sport', 'sportText', 'wer', 'treffpunkt', 'drink', 'dabei', 'status'];
const SPORTS = ['mtb', 'rennrad', 'gravel', 'jogga', 'wandra', 'klettra', 'schitour', 'langlauf', 'schwimma', 'anders'];
const DAUER = ['', 'h05', 'h1', 'h15', 'h2', 'h3', 'halb', 'ganz'];
const MAX_OPEN = 300; // Schutz gegen Spam: max. offene Termine

const props_ = () => PropertiesService.getScriptProperties();

function ss_() {
  const id = props_().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), COLS.length).setNumberFormat('@'); // alles als Text (Datum/Zeit nicht umwandeln)
  }
  return sh;
}

/** Einmalig ausführen. */
function setup() {
  sheet_();
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
      case 'create': return locked_(() => create_(p.event || {}));
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
  return { ok: true, version: VERSION, events, total: rows.length };
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
