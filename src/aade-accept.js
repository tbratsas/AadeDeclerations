#!/usr/bin/env node
'use strict';
/**
 * CLI — λεπτό περιτύλιγμα γύρω από το src/core.js.
 * Όλη η λογική είναι στον πυρήνα· εδώ μόνο argv και εκτύπωση.
 *
 * Το login γίνεται ΠΑΝΤΑ χειροκίνητα από τον χρήστη. Δεν αποθηκεύονται
 * credentials πουθενά — μόνο η συνεδρία, τοπικά.
 *
 *   node src/aade-accept.js                 # DRY RUN
 *   node src/aade-accept.js --go            # κανονικά
 *   node src/aade-accept.js --login         # μόνο σύνδεση
 */

const path = require('path');
const readline = require('readline');
const core = require('./core');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const GO       = flag('--go');
const VERIFY   = !flag('--no-verify');
const HEADLESS = flag('--headless');
const RECHECK  = flag('--recheck');
const FROMDRY  = flag('--from-dry');
const FILE     = path.resolve(ROOT, opt('--file', 'afm.txt'));
const DELAY    = parseInt(opt('--delay', '1500'), 10);
const LIMIT    = parseInt(opt('--limit', '0'), 10);

// ---------------------------------------------------------------- εκτύπωση
let pad = 1;
const tagOf = e => '  [' + String(e.index).padStart(pad) + '/' + e.total + '] ' + e.afm;

const LINE = {
  ACCEPTED:       e => tagOf(e) + '  OK ΑΠΟΔΟΧΗ: ' + e.onoma +
                       (VERIFY ? (e.verified ? ' (επιβεβαιώθηκε ενεργή)' : ' (χωρίς ένδειξη ενεργής)') : ''),
  WOULD_ACCEPT:   e => tagOf(e) + '  -> ΘΑ ΑΠΟΔΕΧΟΤΑΝ: ' + e.onoma + ' [' + e.id + ']',
  ALREADY_ACTIVE: e => tagOf(e) + '  = ήδη ενεργή: ' + e.onoma,
  NO_PENDING:     e => tagOf(e) + '  - υπάρχει εγγραφή αλλά ούτε εκκρεμής ούτε ενεργή (' + e.message + ')',
  NOT_FOUND:      e => tagOf(e) + '  X ΚΑΜΙΑ ΕΞΟΥΣΙΟΔΟΤΗΣΗ — ο πελάτης δεν την έστειλε',
  MISMATCH:       e => tagOf(e) + '  ! Τα αποτελέσματα δεν ταιριάζουν με το ΑΦΜ — παραλείπεται',
  ERROR:          e => tagOf(e) + '  X σφάλμα: ' + (e.message || ''),
};

function onEvent(e) {
  switch (e.type) {
    case 'plan':
      pad = String(e.queue).length;
      if (e.skipped) console.log('  Παραλείπονται ' + e.skipped + ' ήδη ολοκληρωμένα (resume).');
      console.log('  Προς επεξεργασία: ' + e.queue + '\n');
      break;

    case 'session':
      if (e.state === 'restored') console.log('  Session ενεργό (επαναφέρθηκε — χωρίς login).\n');
      else if (e.state === 'active') console.log('  Session ενεργό (από προηγούμενο τρέξιμο).\n');
      else if (e.state === 'needed') {
        console.log('\n  +-------------------------------------------------------+');
        console.log('  |  ΧΡΕΙΑΖΕΤΑΙ ΣΥΝΔΕΣΗ                                    |');
        console.log('  |  Κάνε login με τα TAXISnet credentials σου στο         |');
        console.log('  |  παράθυρο του browser που άνοιξε.                      |');
        console.log('  |  ΜΗΝ κλείσεις το παράθυρο — συνεχίζει μόνο του.        |');
        console.log('  +-------------------------------------------------------+\n');
      } else if (e.state === 'waiting') {
        console.log('  ...περιμένω login (' + e.seconds + 's / ' + e.max + 's)');
      } else if (e.state === 'ok') {
        console.log('  Session ενεργό. Ξεκινάω.');
        console.log('  (Η συνεδρία αποθηκεύτηκε — το επόμενο τρέξιμο δεν θα ζητήσει login.)\n');
      }
      break;

    case 'item':
      console.log((LINE[e.status] || (x => tagOf(x) + '  ' + x.status))(e));
      break;

    case 'session-lost':
      if (e.fatal) {
        console.error('\n[X] Το session χάνεται επανειλημμένα. Σταματάω.');
        console.error('    Ξανατρέξε την ίδια εντολή — συνεχίζει από εδώ.\n');
      } else {
        console.error('\n  [!] Χάθηκε το session στο ΑΦΜ ' + e.afm + ' (' + e.attempt + '/' + e.max + ').');
        console.error('      Κάνε ξανά login στο παράθυρο — συνεχίζω μόνος μου.\n');
      }
      break;

    case 'error':
      console.error('\n[X] Απρόσμενο σφάλμα: ' + e.message + '\n');
      break;

    case 'done':
      if (e.aborted === 'LOGIN_TIMEOUT') {
        console.error('\n[X] Δεν ολοκληρώθηκε το login μέσα στον χρόνο αναμονής.');
        console.error('    Ξανατρέξε το και κάνε σύνδεση στο παράθυρο που ανοίγει.\n');
      } else if (e.aborted === 'BROWSER_CLOSED') {
        console.error('\n[X] Το παράθυρο του browser έκλεισε πριν τελειώσει η δουλειά.');
        console.error('    ΜΗΝ κλείνεις τον Chromium όσο τρέχει — ξανατρέξε την ίδια εντολή');
        console.error('    και θα συνεχίσει από εκεί που έμεινε.\n');
      } else if (e.aborted === 'NO_RELOGIN') {
        console.error('\n[X] Δεν έγινε επανασύνδεση. Ξανατρέξε την ίδια εντολή.\n');
      }
      console.log('\n=== Σύνοψη ===');
      for (const k of Object.keys(e.tally)) if (e.tally[k]) console.log('  ' + k.padEnd(15) + e.tally[k]);
      if (e.confirmLabels.length) console.log('  Κουμπί επιβεβαίωσης: "' + e.confirmLabels.join('", "') + '"');
      console.log('  Αναλυτικό log: ' + core.paths(ROOT).logFile + '\n');
      break;
  }
}

// ---------------------------------------------------------------- main
(async () => {
  console.log('\n=== Μαζική αποδοχή εξουσιοδοτήσεων myAADE ===');

  if (flag('--login')) {
    console.log('  ΛΕΙΤΟΥΡΓΙΑ: ΣΥΝΔΕΣΗ ΜΟΝΟ — καμία αποδοχή.\n');
    try {
      await core.loginOnly({ dataDir: ROOT, loginTimeout: 600, onEvent: onEvent });
      console.log('  Έτοιμο. Τρέξε τώρα κανονικά χωρίς να ξαναμπείς.\n');
    } catch (e) {
      console.error('\n[X] Δεν ολοκληρώθηκε η σύνδεση.\n');
      process.exitCode = 1;
    }
    return;
  }

  console.log(GO ? '  ΛΕΙΤΟΥΡΓΙΑ: ΚΑΝΟΝΙΚΗ — οι αποδοχές θα σταλούν!'
                 : '  ΛΕΙΤΟΥΡΓΙΑ: DRY RUN — καμία αποδοχή δεν θα σταλεί.');
  console.log('  Αρχείο ΑΦΜ: ' + FILE);

  let parsed;
  try {
    parsed = core.readAfmFile(FILE);
  } catch (e) {
    console.error('\n[X] Δεν βρέθηκε το αρχείο: ' + FILE);
    console.error('    Φτιάξε το με ένα ΑΦΜ ανά γραμμή (ή δώσε --file <path>).\n');
    process.exit(1);
  }

  console.log('  Διαβάστηκαν ' + parsed.list.length + ' μοναδικά ΑΦΜ' +
    (parsed.dupes ? ' (' + parsed.dupes + ' διπλά αγνοήθηκαν)' : '') +
    (parsed.bad.length ? ' — ' + parsed.bad.length + ' γραμμές χωρίς έγκυρο ΑΦΜ' : ''));
  if (parsed.bad.length) console.log('    π.χ. ' + parsed.bad.slice(0, 3).join(' / '));

  if (!parsed.list.length) { console.error('\n[X] Κενή λίστα.\n'); process.exit(1); }

  if (flag('--parse-only')) {
    console.log('\n  Λίστα όπως διαβάστηκε (χωρίς άνοιγμα browser):');
    parsed.list.forEach((a, i) => console.log('    ' + String(i + 1).padStart(4) + '. ' + a));
    console.log('');
    return;
  }

  if (RECHECK) console.log('  (--recheck: αγνοείται το ιστορικό, ελέγχονται όλα από την αρχή)');

  if (GO && !flag('--yes')) {
    if (!process.stdin.isTTY) {
      console.error('\n[X] Το --go θέλει επιβεβαίωση, αλλά το τερματικό δεν είναι διαδραστικό.');
      console.error('    Τρέξε το σε κανονικό παράθυρο PowerShell, ή πρόσθεσε --yes:');
      console.error('    node src/aade-accept.js --go --yes\n');
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise(r =>
      rl.question('  Θα γίνει ΠΡΑΓΜΑΤΙΚΗ αποδοχή των εκκρεμών εξουσιοδοτήσεων.\n  Γράψε NAI για συνέχεια: ',
        a => { rl.close(); r(String(a).trim().toUpperCase()); }));
    if (ans !== 'NAI' && ans !== 'ΝΑΙ') { console.log('\n  Ακυρώθηκε.\n'); process.exit(0); }
  }
  if (GO && flag('--yes')) console.log('  (--yes: χωρίς ερώτηση επιβεβαίωσης)\n');

  let plan = null;
  if (GO && FROMDRY && !RECHECK) {
    plan = core.planFromLog(core.paths(ROOT));
    console.log('  (--from-dry: ' + plan.length + ' εκκρεμείς από το τελευταίο δοκιμαστικό — χωρίς νέα σάρωση)');
    if (!plan.length) {
      console.log('\n  Δεν υπάρχει πλάνο αποδοχής. Τρέξε πρώτα δοκιμαστικά.\n');
      return;
    }
  }

  await core.runAccept({
    afmList: parsed.list,
    acceptPlan: plan,
    go: GO, verify: VERIFY, headless: HEADLESS, recheck: RECHECK,
    delay: DELAY, limit: LIMIT, dataDir: ROOT,
    onEvent: onEvent,
  });
})();
