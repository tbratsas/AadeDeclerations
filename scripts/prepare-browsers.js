#!/usr/bin/env node
'use strict';
/**
 * Ετοιμάζει το `vendor/ms-playwright` που θα μπει στο πακέτο.
 *
 *   node scripts/prepare-browsers.js          # ΠΛΗΡΗΣ: αντιγράφει τον Chromium (~433MB)
 *   node scripts/prepare-browsers.js --lite   # ΕΛΑΦΡΙΑ: κενό — η εφαρμογή θα ψάξει
 *                                             # τον Chrome του χρήστη
 *
 * Αντιγράφεται ΜΟΝΟ η έκδοση που ζητάει το εγκατεστημένο playwright-core,
 * ώστε να μην πακεταριστεί λάθος build.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'ms-playwright');
const LITE = process.argv.includes('--lite');

function browsersRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (process.platform === 'darwin') return path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright');
  return path.join(process.env.HOME, '.cache', 'ms-playwright');
}

/** Η αναθεώρηση chromium που περιμένει το εγκατεστημένο playwright-core. */
function requiredRevision() {
  const dir = path.dirname(require.resolve('playwright-core/package.json'));
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'browsers.json'), 'utf8'));
  const entry = json.browsers.find(b => b.name === 'chromium');
  if (!entry) throw new Error('Δεν βρέθηκε ορισμός chromium στο browsers.json');
  return String(entry.revision);
}

function dirSize(dir) {
  let total = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else try { total += fs.statSync(p).size; } catch (_) {}
    }
  };
  try { walk(dir); } catch (_) {}
  return total;
}

const mb = n => (n / 1024 / 1024).toFixed(0) + 'MB';

// ----------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

if (LITE) {
  fs.writeFileSync(path.join(OUT, 'README.txt'),
    'Ελαφριά έκδοση: δεν περιέχει Chromium.\r\n' +
    'Η εφαρμογή θα χρησιμοποιήσει τον Google Chrome του χρήστη.\r\n', 'utf8');
  console.log('ΕΛΑΦΡΙΑ ΕΚΔΟΣΗ — δεν αντιγράφεται Chromium.');
  console.log('Η εφαρμογή θα απαιτεί εγκατεστημένο Google Chrome στον υπολογιστή του χρήστη.');
  process.exit(0);
}

const src = browsersRoot();
const rev = requiredRevision();
const want = ['chromium-' + rev];

// Το winldd χρησιμοποιείται από το Playwright στα Windows για έλεγχο εξαρτήσεων.
if (process.platform === 'win32') {
  try {
    const ldd = fs.readdirSync(src).filter(d => /^winldd-/.test(d)).sort().pop();
    if (ldd) want.push(ldd);
  } catch (_) {}
}

console.log('Πηγή     : ' + src);
console.log('Απαιτείται: chromium-' + rev);

let total = 0;
for (const name of want) {
  const from = path.join(src, name);
  if (!fs.existsSync(from)) {
    console.error('\n[X] Λείπει: ' + from);
    console.error('    Τρέξε πρώτα:  npx playwright install chromium\n');
    process.exit(1);
  }
  const to = path.join(OUT, name);
  process.stdout.write('  αντιγραφή ' + name + ' … ');
  fs.cpSync(from, to, { recursive: true });
  const s = dirSize(to);
  total += s;
  console.log(mb(s));
}

// Ο Chromium κουβαλάει ~220 αρχεία γλωσσών (~43MB). Κρατάμε ελληνικά και
// αγγλικά· τα αγγλικά είναι το fallback, οπότε δεν σπάει τίποτα αν λείπει άλλη.
const KEEP_LOCALES = ['el.pak', 'en-US.pak', 'en-GB.pak'];
const locDir = path.join(OUT, 'chromium-' + rev, 'chrome-win64', 'locales');
if (fs.existsSync(locDir)) {
  let freed = 0, removed = 0;
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.some(k => f === k || f === k + '.info')) continue;
    const fp = path.join(locDir, f);
    try { freed += fs.statSync(fp).size; fs.rmSync(fp, { force: true }); removed++; } catch (_) {}
  }
  total -= freed;
  console.log('  αφαιρέθηκαν ' + removed + ' αρχεία γλωσσών … -' + mb(freed));
}

console.log('\nΣύνολο: ' + mb(total) + ' -> vendor/ms-playwright');
