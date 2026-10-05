'use strict';
/**
 * ΠΥΡΗΝΑΣ — όλη η λογική, χωρίς κονσόλα και χωρίς argv.
 *
 * Χρησιμοποιείται από:
 *   - το CLI  (src/aade-accept.js)
 *   - το GUI  (app/ — Electron)
 *
 * Η επικοινωνία γίνεται με γεγονότα μέσω `opts.onEvent(e)`:
 *
 *   {type:'plan',         total, skipped, queue}
 *   {type:'session',      state:'restored'|'active'|'needed'|'waiting'|'ok', seconds?}
 *   {type:'item',         index, total, afm, status, onoma?, id?, message?}
 *   {type:'session-lost', afm, attempt, max}
 *   {type:'error',        scope:'run', message}
 *   {type:'done',         tally, confirmLabels, aborted}
 *
 * Καμία συνάρτηση εδώ δεν τυπώνει τίποτα.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HOST = 'https://www1.gsis.gr';
const BASE = HOST + '/taxisnet/mytaxisnet/protected';
const ENTRY_URL = BASE + '/authorizations.htm?tab=e';
const LIST_URL = BASE + '/eInvoiceAuthorizationsGrantee.htm';
const ACCEPT_URL = BASE + '/granteeAcceptAuthorization.htm?authorizationId=';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- διαδρομές
/**
 * Όλα τα δεδομένα χρήστη κάτω από έναν φάκελο, ώστε το GUI να τα βάλει
 * στο %APPDATA% και το CLI δίπλα στο project.
 */
function paths(dataDir) {
  return {
    dataDir: dataDir,
    profileDir: path.join(dataDir, '.profile'),
    authFile: path.join(dataDir, '.auth-state.json'),
    logDir: path.join(dataDir, 'logs'),
    logFile: path.join(dataDir, 'logs', 'results.csv'),
  };
}

// ---------------------------------------------------------------- είσοδος
/** Εξάγει ΑΦΜ από ελεύθερο κείμενο (paste από Excel, CSV, μία ανά γραμμή). */
function parseAfmText(text) {
  const raw = String(text || '').replace(/^﻿/, '');
  const found = [];
  const bad = [];

  for (const line of raw.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    if (/^(αφμ|afm|vat)/i.test(clean)) continue;
    const fields = clean.split(/[;,\t|]/).map(f => f.replace(/["']/g, '').trim());
    let hit = null;
    for (const f of fields) {
      const digits = f.replace(/\D/g, '');
      if (digits.length === 9) { hit = digits; break; }
      if (digits.length === 8) { hit = '0' + digits; break; }   // χαμένο leading zero
    }
    if (hit) found.push(hit); else bad.push(clean.slice(0, 40));
  }

  const seen = new Set();
  const list = found.filter(a => (seen.has(a) ? false : seen.add(a)));
  return { list: list, dupes: found.length - list.length, bad: bad };
}

function readAfmFile(file) {
  if (!fs.existsSync(file)) { const e = new Error('FILE_NOT_FOUND'); e.file = file; throw e; }
  return parseAfmText(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------- log
function initLog(P) {
  if (!fs.existsSync(P.logDir)) fs.mkdirSync(P.logDir, { recursive: true });
  if (!fs.existsSync(P.logFile)) {
    fs.writeFileSync(P.logFile, '﻿' + 'timestamp;afm;status;authorizationId;onoma;minima\n', 'utf8');
  }
}

/**
 * ΑΦΜ οριστικά τακτοποιημένα. Σκόπιμα ΔΕΝ περιλαμβάνεται το NOT_FOUND:
 * ο πελάτης μπορεί να στείλει την εξουσιοδότηση αργότερα.
 */
function alreadyDone(P) {
  const done = new Set();
  if (!fs.existsSync(P.logFile)) return done;
  for (const line of fs.readFileSync(P.logFile, 'utf8').split(/\r?\n/).slice(1)) {
    const p = line.split(';');
    if (p[1] && /^(ACCEPTED|ALREADY_ACTIVE)$/.test(p[2] || '')) done.add(p[1]);
  }
  return done;
}

function logRow(P, afm, status, id, onoma, minima) {
  const esc = s => String(s == null ? '' : s).replace(/[;\r\n]/g, ' ').trim();
  fs.appendFileSync(P.logFile,
    [new Date().toISOString(), afm, status, id || '', esc(onoma), esc(minima)].join(';') + '\n', 'utf8');
}

/** Τελική κατάσταση ανά ΑΦΜ (τελευταία εγγραφή κερδίζει) — για τον πίνακα του GUI. */
function readResults(P) {
  const out = new Map();
  if (!fs.existsSync(P.logFile)) return out;
  for (const line of fs.readFileSync(P.logFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const p = line.split(';');
    if (p[1]) out.set(p[1], { afm: p[1], status: p[2], id: p[3], onoma: p[4], minima: p[5], ts: p[0] });
  }
  return out;
}

/**
 * Πλάνο αποδοχής από το log: ΑΦΜ των οποίων η ΤΕΛΕΥΤΑΙΑ εγγραφή είναι
 * WOULD_ACCEPT — δηλαδή ό,τι εντόπισε το πιο πρόσφατο δοκιμαστικό και δεν έχει
 * τακτοποιηθεί έκτοτε. Επιτρέπει στο κανονικό να μη σαρώσει ξανά.
 */
function planFromLog(P) {
  const out = [];
  for (const r of readResults(P).values()) {
    if (r.status === 'WOULD_ACCEPT' && r.id) {
      out.push({ afm: r.afm, id: r.id, onoma: r.onoma, antikeimeno: r.minima });
    }
  }
  return out;
}

// ---------------------------------------------------------------- συνεδρία
/**
 * Το cookie του TAXISnet είναι session-scoped και χάνεται στο κλείσιμο του
 * browser. Το αποθηκεύουμε ρητά ώστε το επόμενο τρέξιμο να μη ζητάει login.
 */
async function saveSession(ctx, P) {
  try {
    fs.writeFileSync(P.authFile, JSON.stringify(await ctx.storageState()),
      { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (e) { return false; }
}

async function restoreSession(ctx, P) {
  if (!fs.existsSync(P.authFile)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(P.authFile, 'utf8'));
    if (!state.cookies || !state.cookies.length) return false;
    await ctx.addCookies(state.cookies);
    return true;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- σελίδα
async function onSearchPage(page) {
  return (await page.locator('#vatNumber').count()) > 0;
}

async function ensureSearchPage(page) {
  if (await onSearchPage(page)) return true;
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (await onSearchPage(page)) return true;

  await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const showAll = page.locator('a,button').filter({ hasText: /Εμφάνιση όλων/ }).first();
  if (await showAll.count()) {
    await showAll.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
  return await onSearchPage(page);
}

function looksLoggedOut(page) {
  const u = page.url();
  return /login|oauth|sso|logout|idp/i.test(u) || !u.includes('/protected/');
}

/**
 * Είναι ο χρήστης στη μέση εισαγωγής στοιχείων;
 *
 * ΚΡΙΣΙΜΟ: όσο περιμένουμε σύνδεση ΔΕΝ επιτρέπεται καμία πλοήγηση, γιατί
 * σβήνει ό,τι πληκτρολογεί ο χρήστης. Θεωρούμε ότι πληκτρολογεί όταν υπάρχει
 * πεδίο κωδικού, ή όποιο ορατό πεδίο έχει ήδη περιεχόμενο (π.χ. κωδικός 2FA).
 */
async function userIsTyping(page) {
  return await page.evaluate(() => {
    const visible = e => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    for (const i of document.querySelectorAll('input')) {
      if (i.type === 'password' && visible(i)) return true;
      if (/^(text|tel|number|email)$/.test(i.type) && visible(i) && String(i.value || '').trim()) return true;
    }
    return false;
  }).catch(() => true);      // σε αμφιβολία, ΜΗΝ πλοηγείσαι
}

/**
 * Περιμένει σύνδεση. ΔΕΝ ζητάει πάτημα πλήκτρου — ανιχνεύει μόνο του πότε
 * εμφανίστηκε η σελίδα αναζήτησης.
 */
async function waitForLogin(page, P, emit, maxSeconds) {
  if (maxSeconds == null) maxSeconds = 300;
  const ctx = page.context();

  const restored = await restoreSession(ctx, P);
  await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (await ensureSearchPage(page)) {
    emit({ type: 'session', state: restored ? 'restored' : 'active' });
    await saveSession(ctx, P);
    return;
  }

  emit({ type: 'session', state: 'needed' });
  let waited = 0;
  while (waited < maxSeconds) {
    await page.waitForTimeout(3000);
    waited += 3;

    let ready = false;
    try {
      if (await onSearchPage(page)) {
        ready = true;                              // ήδη εκεί, χωρίς πλοήγηση
      } else if (!await userIsTyping(page)) {
        ready = await ensureSearchPage(page);      // ασφαλές να πλοηγηθούμε
      }
    } catch (_) { ready = false; }

    if (ready) {
      await saveSession(ctx, P);
      emit({ type: 'session', state: 'ok' });
      return;
    }
    if (waited % 30 === 0) emit({ type: 'session', state: 'waiting', seconds: waited, max: maxSeconds });
  }
  throw new Error('LOGIN_TIMEOUT');
}

/** Αναζήτηση με ΚΑΙ ΤΑ ΔΥΟ φίλτρα, ώστε να ξεχωρίζει "ήδη ενεργό" από "ανύπαρκτο". */
async function searchAuthorizations(page, afm) {
  if (!await ensureSearchPage(page)) throw new Error('SESSION_LOST');

  await page.fill('#vatNumber', afm);
  const active = page.locator('#filterActive');
  const pending = page.locator('#filterPending');
  if (!await active.isChecked().catch(() => false)) await active.check().catch(() => {});
  if (!await pending.isChecked().catch(() => false)) await pending.check().catch(() => {});

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.getByRole('button', { name: 'Αναζήτηση' }).first().click(),
  ]);
  await page.waitForTimeout(250);

  if (looksLoggedOut(page)) throw new Error('SESSION_LOST');

  return await page.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll('table tr')) {
      const td = tr.querySelectorAll('td');
      if (td.length < 5) continue;
      const afm = td[0].textContent.trim();
      if (!/^\d{9}$/.test(afm)) continue;
      const btn = [...tr.querySelectorAll('button')].find(b => b.textContent.trim() === 'Αποδοχή');
      const oc = btn ? String(btn.getAttribute('onclick') || '') : '';
      const m = oc.match(/authorizationId=(\d+)/);
      out.push({
        afm: afm,
        onoma: td[1].textContent.trim(),
        antikeimeno: td[2].textContent.trim(),
        katastasi: td[3].textContent.trim(),
        id: m ? m[1] : null,
      });
    }
    return out;
  });
}

// Κείμενα κουμπιών στη σελίδα επιβεβαίωσης.
const CONFIRM_RE = /(αποδοχ|επιβεβαί|υποβολ|καταχώρ|συνέχ|^ναι$|^ok$)/i;
const CANCEL_RE  = /(ακύρω|άκυρο|επιστροφ|^όχι$|απόρριψ|ανάκλ)/i;
const BTN_SEL = 'button, input[type=submit], input[type=button], a';

/** Κλείνει modal/backdrop που μπλοκάρει τα κλικ. */
async function dismissOverlays(page) {
  return await page.evaluate(() => {
    let closed = 0;
    const visible = e => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    for (const m of document.querySelectorAll('.modal.show, .modal.in, [role=dialog]')) {
      if (!visible(m)) continue;
      const x = [...m.querySelectorAll('button, a')]
        .find(b => /^(×|x|κλείσιμο|close)$/i.test(String(b.textContent || '').trim()));
      if (x) { x.click(); closed++; }
    }
    for (const b of document.querySelectorAll('.modal-backdrop')) { b.remove(); closed++; }
    return closed;
  }).catch(() => 0);
}

/**
 * Μετά το GET αποδοχής η ΑΑΔΕ δείχνει σελίδα επιβεβαίωσης με [Ναι] [Όχι].
 * Πατάει το «Ναι», προτιμώντας ΟΡΑΤΟ στοιχείο, με ρητό αποκλεισμό ό,τι
 * μοιάζει με ακύρωση/απόρριψη.
 */
async function confirmIfNeeded(page) {
  if (await page.locator('#vatNumber').count()) return null;   // γυρίσαμε ήδη στη λίστα

  const scan = async () => await page.evaluate(sel => {
    const visible = e => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' &&
             s.display !== 'none' && e.offsetParent !== null;
    };
    return [...document.querySelectorAll(sel)]
      .map((e, i) => ({ i: i, t: String(e.textContent || e.value || '').trim(), vis: visible(e) }))
      .filter(x => x.t && x.t.length < 40);
  }, BTN_SEL);

  const choose = cands => {
    const ok = c => CONFIRM_RE.test(c.t) && !CANCEL_RE.test(c.t);
    return cands.find(c => ok(c) && c.vis) || cands.find(c => ok(c)) || null;
  };

  let pick = choose(await scan());
  if (pick && !pick.vis) {
    await dismissOverlays(page);
    await page.waitForTimeout(300);
    pick = choose(await scan()) || pick;
  }
  if (!pick) return null;

  // Δικλείδα: το στοιχείο σε αυτή τη θέση πρέπει ΑΚΟΜΑ να είναι το σωστό.
  const target = page.locator(BTN_SEL).nth(pick.i);
  const liveText = String(await target.textContent().catch(() => '') ||
                          await target.getAttribute('value').catch(() => '') || '').trim();
  if (!CONFIRM_RE.test(liveText) || CANCEL_RE.test(liveText)) {
    throw new Error('CONFIRM_MISMATCH: βρέθηκε "' + pick.t + '" αλλά στη θέση του είναι "' + liveText + '"');
  }

  const attempts = [
    () => target.click({ timeout: 15000 }),
    async () => { await dismissOverlays(page); await target.click({ timeout: 15000 }); },
    async () => { await page.evaluate(a => { document.querySelectorAll(a.sel)[a.i].click(); },
      { sel: BTN_SEL, i: pick.i }); },
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), attempt()]);
      await page.waitForTimeout(400);
      return liveText;
    } catch (e) { lastErr = e; await page.waitForTimeout(500); }
  }
  throw new Error('CONFIRM_CLICK_FAILED: ' + String(lastErr && lastErr.message || '').split('\n')[0]);
}

/** Προσοχή: από την ΑΡΧΗ της λέξης, ώστε το "Ανενεργή" να μην περάσει ως ενεργό. */
const isActive = r => /^ενεργ/i.test(String(r.katastasi || '').trim());

async function verifyAccepted(page, afm) {
  await page.waitForTimeout(400);
  const rows = (await searchAuthorizations(page, afm)).filter(r => r.afm === afm);
  return { ok: !rows.some(r => r.id), nowActive: rows.some(isActive) };
}

/**
 * Η σελίδα επιβεβαίωσης αναφέρει η ίδια το ΑΦΜ του πελάτη:
 *   «Έχω λάβει εξουσιοδότηση από τον πελάτη Χ με ΑΦΜ 444444444 για το ...»
 * Το διαβάζουμε για να βεβαιωθούμε ότι αποδεχόμαστε αυτό που νομίζουμε.
 * Είναι ισχυρότερος έλεγχος από τη γραμμή του πίνακα, γιατί προέρχεται από
 * τη σελίδα που πρόκειται να επιβεβαιωθεί.
 */
async function confirmPageAfm(page) {
  return await page.evaluate(() => {
    const t = document.body ? (document.body.innerText || '') : '';
    const m = t.match(/ΑΦΜ\s*:?\s*(\d{9})/);
    return m ? m[1] : null;
  }).catch(() => null);
}

// ---------------------------------------------------------------- εκτέλεση
function emptyTally() {
  return { ACCEPTED: 0, WOULD_ACCEPT: 0, ALREADY_ACTIVE: 0, NO_PENDING: 0,
           NOT_FOUND: 0, MISMATCH: 0, ERROR: 0 };
}

/**
 * `channel` / `executablePath` επιτρέπουν στην πακεταρισμένη εφαρμογή να
 * χρησιμοποιήσει τον Chrome του χρήστη αντί για ενσωματωμένο Chromium.
 */
function browserOptions(o) {
  const opts = { headless: !!o.headless, viewport: { width: 1400, height: 950 }, locale: 'el-GR' };
  if (o.channel) opts.channel = o.channel;
  if (o.executablePath) opts.executablePath = o.executablePath;
  return opts;
}

/** Ανοίγει browser μόνο για σύνδεση και αποθηκεύει τη συνεδρία. */
async function loginOnly(opts) {
  const o = Object.assign({ dataDir: process.cwd(), loginTimeout: 600,
    channel: null, executablePath: null, headless: false, onEvent: function () {} }, opts);
  const P = paths(o.dataDir);
  const emit = e => { try { o.onEvent(e); } catch (_) {} };

  const ctx = await chromium.launchPersistentContext(P.profileDir, browserOptions(
    { headless: false, channel: o.channel, executablePath: o.executablePath }));
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await waitForLogin(page, P, emit, o.loginTimeout);
    return true;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Η κύρια ρουτίνα. Δεν τυπώνει τίποτα — εκπέμπει γεγονότα.
 * Επιστρέφει {tally, confirmLabels, aborted}.
 */
async function runAccept(opts) {
  const o = Object.assign({
    afmList: [], go: false, verify: true, headless: false,
    delay: 1500, limit: 0, recheck: false,
    dataDir: process.cwd(), loginTimeout: 300,
    channel: null, executablePath: null,
    shouldStop: function () { return false; },
    onEvent: function () {},
  }, opts);

  const P = paths(o.dataDir);
  initLog(P);
  const emit = e => { try { o.onEvent(e); } catch (_) {} };

  // Το ιστορικό ισχύει ΚΑΙ στο δοκιμαστικό: ό,τι θα παραλειφθεί στο κανονικό
  // δεν έχει νόημα να ελέγχεται στην προεπισκόπηση. Έτσι, προσθέτοντας 10 νέα
  // ΑΦΜ σε λίστα 137, το δοκιμαστικό ελέγχει 10 και όχι 137.
  const done = o.recheck ? new Set() : alreadyDone(P);

  /**
   * Λειτουργία «μόνο αποδοχή»: αξιοποιεί τα ευρήματα του δοκιμαστικού ώστε να
   * ΜΗΝ ξαναγίνει σάρωση. Χωρίς αυτό, μια λίστα 100 νέων ΑΦΜ σαρωνόταν δύο
   * φορές — μία στο δοκιμαστικό και μία στο κανονικό.
   * Η ασφάλεια δεν χαλαρώνει: το ΑΦΜ επαληθεύεται στη σελίδα επιβεβαίωσης.
   */
  const cached = (o.go && Array.isArray(o.acceptPlan) && o.acceptPlan.length)
    ? o.acceptPlan.filter(x => x && /^\d{9}$/.test(String(x.afm)) && x.id && !done.has(String(x.afm)))
    : null;

  let items = cached
    ? cached.map(x => ({ afm: String(x.afm),
        row: { id: String(x.id), onoma: x.onoma || '', antikeimeno: x.antikeimeno || '' } }))
    : o.afmList.filter(a => !done.has(a)).map(a => ({ afm: a, row: null }));

  const skipped = o.afmList.length - items.length;
  if (o.limit > 0) items = items.slice(0, o.limit);

  emit({ type: 'plan', total: o.afmList.length, skipped: skipped,
         queue: items.length, mode: cached ? 'accept' : 'scan' });

  const tally = emptyTally();
  const confirmLabels = new Set();
  const pending = [];          // ευρήματα δοκιμαστικού, για το επόμενο κανονικό
  let aborted = null;

  if (!items.length) {
    const empty = { tally: tally, confirmLabels: [], pending: pending, aborted: null };
    emit(Object.assign({ type: 'done' }, empty));
    return empty;
  }

  const ctx = await chromium.launchPersistentContext(P.profileDir, browserOptions(o));
  const page = ctx.pages()[0] || await ctx.newPage();
  let userClosedBrowser = false;
  ctx.on('close', () => { userClosedBrowser = true; });

  let sessionLosses = 0;

  /**
   * Μία αποδοχή: σελίδα επιβεβαίωσης -> έλεγχος ΑΦΜ -> «Ναι» -> επαλήθευση.
   * Με `strict` (λειτουργία «μόνο αποδοχή») απαιτείται να βρεθεί το ΑΦΜ στη
   * σελίδα· αν λείπει, δεν πατιέται τίποτα.
   */
  async function acceptRow(afm, row, at, strict) {
    await page.goto(ACCEPT_URL + row.id, { waitUntil: 'domcontentloaded' });
    if (looksLoggedOut(page)) throw new Error('SESSION_LOST');

    const pageAfm = await confirmPageAfm(page);
    if (pageAfm && pageAfm !== afm) {
      throw new Error('ACCEPT_PAGE_MISMATCH: η σελίδα αφορά ΑΦΜ ' + pageAfm + ' αντί για ' + afm);
    }
    if (!pageAfm && strict) {
      throw new Error('ACCEPT_PAGE_NO_AFM: δεν επιβεβαιώθηκε το ΑΦΜ στη σελίδα');
    }

    const clicked = await confirmIfNeeded(page);
    if (clicked) confirmLabels.add(clicked);
    else if (!await page.locator('#vatNumber').count()) {
      logRow(P, afm, 'ERROR', row.id, row.onoma, 'confirm button not found');
      tally.ERROR++;
      emit(Object.assign({ type: 'item', status: 'ERROR', onoma: row.onoma,
        id: row.id, message: 'δεν βρέθηκε κουμπί επιβεβαίωσης' }, at));
      return;
    }

    let ok = true, nowActive = null;
    if (o.verify) { const v = await verifyAccepted(page, afm); ok = v.ok; nowActive = v.nowActive; }

    if (ok) {
      logRow(P, afm, 'ACCEPTED', row.id, row.onoma,
        o.verify ? (nowActive ? 'verified active' : 'accepted, active flag not seen') : 'not verified');
      tally.ACCEPTED++;
      emit(Object.assign({ type: 'item', status: 'ACCEPTED', onoma: row.onoma,
        id: row.id, verified: !!nowActive }, at));
    } else {
      logRow(P, afm, 'ERROR', row.id, row.onoma, 'still pending after accept');
      tally.ERROR++;
      emit(Object.assign({ type: 'item', status: 'ERROR', onoma: row.onoma,
        id: row.id, message: 'στάλθηκε αλλά παραμένει εκκρεμής' }, at));
    }
  }

  try {
    await waitForLogin(page, P, emit, o.loginTimeout);

    for (let i = 0; i < items.length; i++) {
      if (o.shouldStop()) { aborted = 'STOPPED'; break; }
      const afm = items[i].afm;
      const at = { index: i + 1, total: items.length, afm: afm };

      try {
        if (items[i].row) {
          // Γνωστή εκκρεμότητα από το δοκιμαστικό — κατευθείαν αποδοχή.
          await acceptRow(afm, items[i].row, at, true);
          if (i < items.length - 1) await sleep(o.delay);
          continue;
        }

        const rows = await searchAuthorizations(page, afm);
        const mine = rows.filter(r => r.afm === afm);     // ασφάλεια: μόνο ακριβές match
        const pend = mine.filter(r => r.id);
        const act = mine.filter(isActive);

        if (rows.length && !mine.length) {
          logRow(P, afm, 'MISMATCH', '', '', 'search returned other AFMs');
          tally.MISMATCH++;
          emit(Object.assign({ type: 'item', status: 'MISMATCH' }, at));
        } else if (!pend.length && act.length) {
          logRow(P, afm, 'ALREADY_ACTIVE', '', act[0].onoma, act[0].katastasi);
          tally.ALREADY_ACTIVE++;
          emit(Object.assign({ type: 'item', status: 'ALREADY_ACTIVE', onoma: act[0].onoma }, at));
        } else if (!pend.length && mine.length) {
          logRow(P, afm, 'NO_PENDING', '', mine[0].onoma, mine[0].katastasi);
          tally.NO_PENDING++;
          emit(Object.assign({ type: 'item', status: 'NO_PENDING',
            onoma: mine[0].onoma, message: mine[0].katastasi }, at));
        } else if (!pend.length) {
          logRow(P, afm, 'NOT_FOUND', '', '', 'no authorization at all');
          tally.NOT_FOUND++;
          emit(Object.assign({ type: 'item', status: 'NOT_FOUND' }, at));
        } else {
          for (const row of pend) {
            if (!o.go) {
              logRow(P, afm, 'WOULD_ACCEPT', row.id, row.onoma, row.antikeimeno);
              tally.WOULD_ACCEPT++;
              pending.push({ afm: afm, id: row.id, onoma: row.onoma, antikeimeno: row.antikeimeno });
              emit(Object.assign({ type: 'item', status: 'WOULD_ACCEPT',
                onoma: row.onoma, id: row.id }, at));
              continue;
            }
            await acceptRow(afm, row, at, false);
          }
        }
      } catch (e) {
        const msg = String(e && e.message || e);
        if (msg.includes('SESSION_LOST')) {
          sessionLosses++;
          if (sessionLosses > 3) {
            logRow(P, afm, 'SESSION_LOST', '', '', 'aborted after 3 losses');
            aborted = 'SESSION_LOST';
            emit({ type: 'session-lost', afm: afm, attempt: sessionLosses, max: 3, fatal: true });
            break;
          }
          emit({ type: 'session-lost', afm: afm, attempt: sessionLosses, max: 3, fatal: false });
          let recovered = false;
          try { await waitForLogin(page, P, emit, o.loginTimeout); recovered = true; } catch (_) {}
          if (recovered) { i--; continue; }            // ξαναδοκίμασε το ΙΔΙΟ ΑΦΜ
          logRow(P, afm, 'SESSION_LOST', '', '', 'aborted - no re-login');
          aborted = 'NO_RELOGIN';
          break;
        }
        const clean = msg.split('\n')[0].trim();
        logRow(P, afm, 'ERROR', '', '', clean.slice(0, 250));
        tally.ERROR++;
        emit(Object.assign({ type: 'item', status: 'ERROR', message: clean.slice(0, 160) }, at));
      }

      if (i < items.length - 1) await sleep(o.delay);
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg.includes('LOGIN_TIMEOUT')) aborted = 'LOGIN_TIMEOUT';
    else if (userClosedBrowser || /has been closed|Target page|browser has disconnected/i.test(msg)) {
      aborted = 'BROWSER_CLOSED';
    } else {
      aborted = 'UNEXPECTED';
      emit({ type: 'error', scope: 'run', message: msg.slice(0, 200) });
    }
  } finally {
    await saveSession(ctx, P).catch(() => {});
    await ctx.close().catch(() => {});
  }

  const result = { tally: tally, confirmLabels: [...confirmLabels],
                   pending: pending, aborted: aborted };
  emit(Object.assign({ type: 'done' }, result));
  return result;
}

module.exports = {
  paths, parseAfmText, readAfmFile,
  initLog, alreadyDone, logRow, readResults, planFromLog,
  runAccept, loginOnly, userIsTyping,
  URLS: { HOST: HOST, BASE: BASE, ENTRY_URL: ENTRY_URL, LIST_URL: LIST_URL, ACCEPT_URL: ACCEPT_URL },
};
