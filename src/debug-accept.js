#!/usr/bin/env node
/**
 * ΔΙΑΓΝΩΣΤΙΚΟ — δεν αποδέχεται τίποτα μόνο του.
 * Πηγαίνει στη σελίδα αποδοχής ενός ΑΦΜ και τυπώνει τι ΑΚΡΙΒΩΣ επιστρέφει,
 * ώστε να δούμε αν υπάρχει ενδιάμεσο βήμα επιβεβαίωσης.
 *
 *   node src/debug-accept.js <ΑΦΜ>
 */
const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, '.profile');
const BASE = 'https://www1.gsis.gr/taxisnet/mytaxisnet/protected';
const ENTRY_URL = BASE + '/authorizations.htm?tab=e';
const LIST_URL = BASE + '/eInvoiceAuthorizationsGrantee.htm';
const ACCEPT_URL = BASE + '/granteeAcceptAuthorization.htm?authorizationId=';

const AFM = process.argv[2];
if (!/^\d{9}$/.test(AFM || '')) { console.error('Χρήση: node src/debug-accept.js <9ψήφιο ΑΦΜ>'); process.exit(1); }

const dump = async (page, label) => {
  console.log('\n---------- ' + label + ' ----------');
  console.log('URL   : ' + page.url());
  console.log('TITLE : ' + await page.title().catch(() => '?'));
  const info = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim();
    return {
      text: txt.slice(0, 1200),
      buttons: [...document.querySelectorAll('button,input[type=submit],input[type=button],a.btn')]
        .map(b => (b.textContent || b.value || '').trim()).filter(Boolean).slice(0, 25),
      forms: [...document.forms].map(f => (f.name || 'anon') + ' -> ' + f.action.split('/').pop().split('?')[0] +
        ' [' + [...f.elements].filter(e => e.name).map(e => e.name).join(',') + ']'),
      hasVat: !!document.querySelector('#vatNumber'),
    };
  });
  console.log('FORMS :\n  ' + (info.forms.join('\n  ') || '(none)'));
  console.log('BUTTONS: ' + (info.buttons.join(' | ') || '(none)'));
  console.log('SEARCH PAGE? ' + info.hasVat);
  console.log('TEXT  :\n' + info.text);
};

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1400, height: 950 }, locale: 'el-GR',
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded' });

    // Περίμενε έως 3 λεπτά να γίνει login αν χρειάζεται
    let waited = 0;
    while (!(await page.locator('#vatNumber').count())) {
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (await page.locator('#vatNumber').count()) break;
      if (waited === 0) console.log('\n>>> Κάνε login στο παράθυρο του browser. Περιμένω...\n');
      if (waited > 180) { console.error('Λήξη αναμονής για login.'); process.exit(1); }
      await page.waitForTimeout(3000); waited += 3;
    }
    console.log('Session ενεργό.');

    // Αναζήτηση
    await page.fill('#vatNumber', AFM);
    const a = page.locator('#filterActive'), p = page.locator('#filterPending');
    if (!await a.isChecked().catch(() => false)) await a.check().catch(() => {});
    if (!await p.isChecked().catch(() => false)) await p.check().catch(() => {});
    await page.getByRole('button', { name: 'Αναζήτηση' }).first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(400);

    const rows = await page.evaluate(() => {
      const out = [];
      for (const tr of document.querySelectorAll('table tr')) {
        const td = tr.querySelectorAll('td');
        if (td.length < 5) continue;
        if (!/^\d{9}$/.test(td[0].textContent.trim())) continue;
        const btn = [...tr.querySelectorAll('button')].find(b => b.textContent.trim() === 'Αποδοχή');
        const oc = btn ? String(btn.getAttribute('onclick') || '') : '';
        out.push({
          afm: td[0].textContent.trim(),
          katastasi: td[3].textContent.trim(),
          id: (oc.match(/authorizationId=(\d+)/) || [])[1] || null,
          rawOnclickShape: oc.replace(/\d+/g, 'N').slice(0, 120),
        });
      }
      return out;
    });

    console.log('\n=== ΓΡΑΜΜΕΣ ΓΙΑ ' + AFM + ' ===');
    for (const r of rows) console.log('  ΑΦΜ=' + r.afm + ' | κατάσταση="' + r.katastasi + '" | id=' + r.id +
      '\n     onclick~ ' + r.rawOnclickShape);

    const target = rows.find(r => r.afm === AFM && r.id);
    if (!target) { console.log('\nΔεν υπάρχει εκκρεμής γραμμή για αποδοχή.'); await ctx.close(); return; }

    console.log('\n>>> Πηγαίνω στο URL αποδοχής για id=' + target.id + ' (χωρίς να πατήσω τίποτα άλλο)');
    await page.goto(ACCEPT_URL + target.id, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await dump(page, 'ΣΕΛΙΔΑ ΜΕΤΑ ΤΟ GET ΑΠΟΔΟΧΗΣ');

    console.log('\n(Ο browser κλείνει σε 15 δευτ.)');
    await page.waitForTimeout(15000);
  } catch (e) {
    console.error('ΣΦΑΛΜΑ: ' + e.message);
  } finally {
    await ctx.close().catch(() => {});
  }
})();
