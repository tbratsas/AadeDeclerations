'use strict';
/* UI logic. Καμία λογική αυτοματοποίησης εδώ — μόνο παρουσίαση. */

const $ = id => document.getElementById(id);

const el = {
  afm: $('afm'), count: $('afmCount'), warn: $('afmWarn'),
  dry: $('btnDry'), go: $('btnGo'), stop: $('btnStop'),
  login: $('btnLogin'), logs: $('btnLogs'), imp: $('btnImport'), exp: $('btnExport'),
  recheck: $('recheck'), gate: $('gateNote'),
  bar: $('bar'), ptext: $('progressText'), chips: $('chips'),
  tbody: $('tbody'), empty: $('empty'), status: $('status'), dot: $('sessionDot'),
};

const LABEL = {
  ACCEPTED: 'Έγινε αποδοχή',
  WOULD_ACCEPT: 'Θα γινόταν αποδοχή',
  ALREADY_ACTIVE: 'Ήδη ενεργή',
  NO_PENDING: 'Άλλη κατάσταση',
  NOT_FOUND: 'Δεν στάλθηκε',
  MISMATCH: 'Ασυμφωνία ΑΦΜ',
  ERROR: 'Σφάλμα',
  SESSION_LOST: 'Χάθηκε συνεδρία',
};

let rows = new Map();        // afm -> record
let filter = 'ALL';
let running = false;
let dryDoneFor = null;       // λίστα για την οποία έχει τρέξει δοκιμαστικά
let pendingCount = 0;        // πόσα βρέθηκαν προς αποδοχή στο δοκιμαστικό

// ---------------------------------------------------------------- helpers
const listKey = list => list.join(',');
const setStatus = t => { el.status.textContent = t || ''; };

function setDot(state) {
  el.dot.className = 'dot' + (state ? ' ' + state : '');
}

function setRunning(on) {
  running = on;
  el.dry.disabled = on;
  el.stop.disabled = !on;
  el.login.disabled = on;
  el.imp.disabled = on;
  el.afm.readOnly = on;
  refreshGate();
}

/**
 * Το «Κανονικά» δουλεύει ΚΑΤΕΥΘΕΙΑΝ, όπως το --go στο CLI: ένα πέρασμα που
 * ελέγχει και αποδέχεται μαζί. Το δοκιμαστικό είναι προαιρετική προεπισκόπηση·
 * αν έχει τρέξει για την ίδια λίστα, το κανονικό αξιοποιεί τα ευρήματά του και
 * δεν ξανασαρώνει.
 */
async function refreshGate() {
  if (running) { el.go.disabled = true; return; }
  const p = await window.api.parse(el.afm.value);
  const known = dryDoneFor === listKey(p.list) && pendingCount > 0;

  el.go.disabled = p.list.length === 0;
  el.go.textContent = known ? 'Κανονικά (' + pendingCount + ')' : 'Κανονικά';
  el.go.title = known
    ? 'Αποδέχεται τις ' + pendingCount + ' εκκρεμείς που βρέθηκαν'
    : 'Ελέγχει και αποδέχεται σε ένα πέρασμα';

  el.gate.innerHTML = known
    ? 'Βρέθηκαν <strong>' + pendingCount + '</strong> εκκρεμείς. Το «Κανονικά» θα τις αποδεχθεί χωρίς νέο έλεγχο.'
    : 'Το «Κανονικά» ελέγχει και αποδέχεται <strong>σε ένα πέρασμα</strong>. Το «Δοκιμαστικά» είναι προαιρετικό — δείχνει πρώτα τι θα γίνει.';
}

async function updateCount() {
  const p = await window.api.parse(el.afm.value);
  el.count.textContent = p.list.length ? p.list.length + ' ΑΦΜ' : '—';
  el.count.classList.toggle('good', p.list.length > 0);

  const bits = [];
  if (p.dupes) bits.push(p.dupes + ' διπλά αγνοήθηκαν');
  if (p.bad.length) bits.push(p.bad.length + ' γραμμές χωρίς έγκυρο ΑΦΜ (π.χ. ' + p.bad.slice(0, 2).join(' / ') + ')');
  el.warn.textContent = bits.join(' · ');
  el.warn.classList.toggle('hidden', !bits.length);

  refreshGate();
}

// ---------------------------------------------------------------- πίνακας
function renderChips() {
  const counts = {};
  for (const r of rows.values()) counts[r.status] = (counts[r.status] || 0) + 1;
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  const mk = (k, label, n) =>
    '<span class="chip' + (filter === k ? ' active' : '') + '" data-k="' + k + '">' +
    label + ' <b>' + n + '</b></span>';

  el.chips.innerHTML = rows.size
    ? mk('ALL', 'Όλα', rows.size) + keys.map(k => mk(k, LABEL[k] || k, counts[k])).join('')
    : '';

  for (const c of el.chips.querySelectorAll('.chip')) {
    c.onclick = () => { filter = c.dataset.k; renderChips(); renderTable(); };
  }
}

function renderTable() {
  const list = [...rows.values()].filter(r => filter === 'ALL' || r.status === filter);
  el.empty.style.display = list.length ? 'none' : '';
  el.tbody.innerHTML = list.map(r =>
    '<tr>' +
    '<td class="afm">' + esc(r.afm) + '</td>' +
    '<td>' + esc(r.onoma || '') + '</td>' +
    '<td class="st st-' + esc(r.status) + '">' + esc(LABEL[r.status] || r.status) + '</td>' +
    '<td class="note-cell">' + esc(r.message || r.minima || '') + '</td>' +
    '</tr>').join('');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function upsert(r) {
  rows.set(r.afm, Object.assign(rows.get(r.afm) || {}, r));
}

// ---------------------------------------------------------------- γεγονότα
window.api.onEvent(e => {
  switch (e.type) {
    case 'plan':
      el.bar.style.width = '0%';
      el.ptext.textContent = e.skipped
        ? 'Προς επεξεργασία ' + e.queue + ' — παραλείπονται ' + e.skipped + ' ήδη ολοκληρωμένα'
        : 'Προς επεξεργασία ' + e.queue;
      break;

    case 'session':
      if (e.state === 'needed') {
        setDot('wait');
        setStatus('Κάνε login στο παράθυρο του browser που άνοιξε — μην το κλείσεις.');
      } else if (e.state === 'waiting') {
        setStatus('Περιμένω σύνδεση… (' + e.seconds + 's / ' + e.max + 's)');
      } else {
        setDot('ok');
        setStatus(e.state === 'restored' ? 'Συνεδρία ενεργή (χωρίς login).' : 'Συνεδρία ενεργή.');
      }
      break;

    case 'item': {
      upsert({ afm: e.afm, status: e.status, onoma: e.onoma, message: e.message });
      const pct = Math.round(e.index / e.total * 100);
      el.bar.style.width = pct + '%';
      el.ptext.textContent = e.index + ' / ' + e.total + '  (' + pct + '%)  ·  ' + e.afm;
      renderChips(); renderTable();
      break;
    }

    case 'session-lost':
      setDot(e.fatal ? 'err' : 'wait');
      setStatus(e.fatal
        ? 'Η συνεδρία χάνεται επανειλημμένα — σταμάτησε. Ξαναδοκίμασε αργότερα.'
        : 'Χάθηκε η συνεδρία. Κάνε ξανά login στο παράθυρο — συνεχίζει μόνο του.');
      break;

    case 'error':
      setDot('err');
      setStatus('Σφάλμα: ' + e.message);
      break;

    case 'done': {
      const t = e.tally || {};
      const parts = Object.keys(t).filter(k => t[k]).map(k => (LABEL[k] || k) + ': ' + t[k]);
      el.bar.style.width = '100%';
      el.ptext.textContent = parts.length ? parts.join('  ·  ') : 'Δεν έγινε καμία ενέργεια';

      const reason = {
        LOGIN_TIMEOUT: 'Δεν ολοκληρώθηκε το login.',
        BROWSER_CLOSED: 'Έκλεισε το παράθυρο του browser πριν τελειώσει.',
        NO_RELOGIN: 'Δεν έγινε επανασύνδεση.',
        SESSION_LOST: 'Η συνεδρία χάθηκε επανειλημμένα.',
        STOPPED: 'Διακόπηκε από εσένα.',
      }[e.aborted];
      if (reason) setStatus(reason + ' Μπορείς να ξανατρέξεις — συνεχίζει από εκεί που έμεινε.');
      else if (!e.aborted) setStatus('Ολοκληρώθηκε.');
      break;
    }
  }
});

// ---------------------------------------------------------------- ενέργειες
async function run(go) {
  const p = await window.api.parse(el.afm.value);
  if (!p.list.length) { setStatus('Δεν βρέθηκε κανένα έγκυρο ΑΦΜ.'); return; }
  const plan = await window.api.plan({ text: el.afm.value, recheck: el.recheck.checked });

  if (!plan.todo) {
    setStatus('Όλα τα ΑΦΜ έχουν ήδη τακτοποιηθεί — δεν χρειάζεται καμία ενέργεια.');
    return;
  }

  if (go) {
    const known = dryDoneFor === listKey(p.list) && pendingCount > 0;
    const what = known
      ? 'Θα γίνουν ' + pendingCount + ' ΠΡΑΓΜΑΤΙΚΕΣ αποδοχές εξουσιοδοτήσεων.'
      : 'Θα ελεγχθούν ' + plan.todo + ' ΑΦΜ' +
        (plan.skipped ? ' (παραλείπονται ' + plan.skipped + ' ήδη τακτοποιημένα)' : '') +
        ' και θα γίνει\nΠΡΑΓΜΑΤΙΚΗ αποδοχή σε όσες εκκρεμείς εξουσιοδοτήσεις βρεθούν.';
    const ok = confirm(what + '\n\nΗ αποδοχή επέχει θέση δήλωσης προς την ΑΑΔΕ. Συνέχεια;');
    if (!ok) return;
  }

  await window.api.saveAfm(el.afm.value);
  setRunning(true);
  setStatus(go ? 'Εκτελείται…' : 'Δοκιμαστική εκτέλεση…');

  const res = await window.api.start({
    text: el.afm.value, go: go,
    recheck: el.recheck.checked, delay: 1500, limit: 0,
  });

  setRunning(false);
  if (!res.ok && res.message) { setDot('err'); setStatus(res.message); return; }

  const tally = (res.result && res.result.tally) || {};
  if (!go) {
    pendingCount = tally.WOULD_ACCEPT || 0;
    dryDoneFor = pendingCount > 0 ? listKey(p.list) : null;
    if (!pendingCount) setStatus('Καμία εκκρεμής εξουσιοδότηση — δεν χρειάζεται καμία ενέργεια.');
  } else {
    dryDoneFor = null;                         // μετά από κανονικό, ξανά δοκιμαστικό
    pendingCount = 0;
  }
  refreshGate();
}

el.dry.onclick = () => run(false);
el.go.onclick = () => run(true);
el.stop.onclick = async () => { await window.api.stop(); setStatus('Διακοπή μετά το τρέχον ΑΦΜ…'); };

el.login.onclick = async () => {
  setRunning(true);
  setDot('wait');
  setStatus('Άνοιξε το παράθυρο σύνδεσης — κάνε login εκεί.');
  const r = await window.api.login();
  setRunning(false);
  setDot(r.ok ? 'ok' : 'err');
  setStatus(r.ok ? 'Η συνεδρία αποθηκεύτηκε.' : 'Δεν ολοκληρώθηκε η σύνδεση.');
};

el.imp.onclick = async () => {
  const text = await window.api.importAfm();
  if (text == null) return;
  el.afm.value = text;
  dryDoneFor = null;
  await window.api.saveAfm(text);
  updateCount();
};

el.exp.onclick = async () => {
  const r = await window.api.exportCsv();
  if (r.ok) setStatus('Αποθηκεύτηκε: ' + r.path);
  else if (r.message) setStatus(r.message);
};

el.logs.onclick = () => window.api.openLogs();

let saveTimer = null;
el.afm.addEventListener('input', () => {
  dryDoneFor = null;                                   // άλλαξε η λίστα -> ξανά δοκιμαστικό
  updateCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.saveAfm(el.afm.value), 600);
});
el.recheck.addEventListener('change', () => { dryDoneFor = null; refreshGate(); });

// ---------------------------------------------------------------- εκκίνηση
(async () => {
  el.afm.value = await window.api.loadAfm();
  for (const r of await window.api.results()) {
    upsert({ afm: r.afm, status: r.status, onoma: r.onoma, message: r.minima });
  }
  renderChips(); renderTable();
  updateCount();
  setStatus(rows.size ? 'Φορτώθηκε ιστορικό ' + rows.size + ' ΑΦΜ.' : '');
})();
