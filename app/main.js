'use strict';
/**
 * Electron main process.
 *
 * Δεν περιέχει καθόλου λογική αυτοματοποίησης — καλεί τον src/core.js,
 * τον ίδιο πυρήνα που χρησιμοποιεί και το CLI.
 *
 * ΣΗΜΑΝΤΙΚΟ: τα δεδομένα χρήστη (συνεδρία, log, λίστα ΑΦΜ) πάνε στο
 * %APPDATA%, ΟΧΙ δίπλα στο exe — ώστε δύο χρήστες στο ίδιο μηχάνημα να μην
 * μοιράζονται συνεδρία TAXISnet.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------- browser
/**
 * Επιλογή μηχανής Chromium. ΠΡΕΠΕΙ να τρέξει ΠΡΙΝ φορτωθεί το playwright,
 * γιατί το PLAYWRIGHT_BROWSERS_PATH διαβάζεται κατά την αρχικοποίηση.
 *
 *   πλήρης έκδοση  -> ενσωματωμένος Chromium στο resources/ms-playwright
 *   ελαφριά έκδοση -> ο Google Chrome του χρήστη (channel: 'chrome')
 *   ανάπτυξη       -> ο Chromium του ms-playwright του μηχανήματος
 */
function pickBrowser() {
  if (!app.isPackaged) return {};
  const bundled = path.join(process.resourcesPath, 'ms-playwright');
  let hasChromium = false;
  try { hasChromium = fs.readdirSync(bundled).some(d => /^chromium-/.test(d)); } catch (_) {}
  if (hasChromium) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
    return {};
  }
  return { channel: 'chrome' };
}

const BROWSER = pickBrowser();
const core = require('../src/core');   // μετά το pickBrowser()

// Σταθερό όνομα φακέλου δεδομένων, ώστε %APPDATA% να είναι το ΙΔΙΟ σε dev και
// σε πακεταρισμένη έκδοση (αλλιώς ο χρήστης χάνει συνεδρία και ιστορικό όταν
// περάσει από το ένα στο άλλο). Πρέπει να γίνει πριν το app.whenReady().
app.setName('aade-auth-accept');

let win = null;
let running = false;
let stopRequested = false;

// Ευρήματα του τελευταίου δοκιμαστικού, ώστε το κανονικό να μη σαρώσει ξανά.
// Ισχύει μόνο για την ΙΔΙΑ ακριβώς λίστα ΑΦΜ.
let lastPlan = null;   // { key, items }

const dataDir = () => app.getPath('userData');
const afmFile = () => path.join(dataDir(), 'afm.txt');
const send = e => { if (win && !win.isDestroyed()) win.webContents.send('core-event', e); };

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: 'Εξουσιοδοτήσεις myAADE',
    backgroundColor: '#12151c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,           // ο preload χρειάζεται require
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  fs.mkdirSync(dataDir(), { recursive: true });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------------------------------------------------------------- IPC
ipcMain.handle('afm:parse', (_e, text) => core.parseAfmText(text));

ipcMain.handle('afm:load', () => {
  try { return fs.existsSync(afmFile()) ? fs.readFileSync(afmFile(), 'utf8') : ''; }
  catch (_) { return ''; }
});

ipcMain.handle('afm:save', (_e, text) => {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(afmFile(), String(text || ''), 'utf8');
    return true;
  } catch (_) { return false; }
});

ipcMain.handle('afm:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Επιλογή αρχείου με ΑΦΜ',
    filters: [{ name: 'Λίστες', extensions: ['txt', 'csv'] }, { name: 'Όλα', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try { return fs.readFileSync(r.filePaths[0], 'utf8'); }
  catch (_) { return null; }
});

/** Πόσα ΑΦΜ θα ελεγχθούν πραγματικά, αφού αφαιρεθεί το ιστορικό. */
ipcMain.handle('afm:plan', (_e, o) => {
  const parsed = core.parseAfmText(o && o.text);
  let done;
  try { done = (o && o.recheck) ? new Set() : core.alreadyDone(core.paths(dataDir())); }
  catch (_) { done = new Set(); }
  const todo = parsed.list.filter(a => !done.has(a));
  return { total: parsed.list.length, todo: todo.length, skipped: parsed.list.length - todo.length };
});

ipcMain.handle('results:list', () => {
  try { return [...core.readResults(core.paths(dataDir())).values()]; }
  catch (_) { return []; }
});

ipcMain.handle('results:export', async () => {
  const src = core.paths(dataDir()).logFile;
  if (!fs.existsSync(src)) return { ok: false, message: 'Δεν υπάρχει ακόμα αρχείο αποτελεσμάτων.' };
  const r = await dialog.showSaveDialog(win, {
    title: 'Αποθήκευση αποτελεσμάτων',
    defaultPath: 'apotelesmata.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  try { fs.copyFileSync(src, r.filePath); return { ok: true, path: r.filePath }; }
  catch (e) { return { ok: false, message: String(e.message) }; }
});

ipcMain.handle('logs:open', () => shell.openPath(core.paths(dataDir()).logDir));
ipcMain.handle('app:dataDir', () => dataDir());

ipcMain.handle('session:login', async () => {
  if (running) return { ok: false, message: 'Εκτελείται ήδη εργασία.' };
  running = true;
  try {
    await core.loginOnly(Object.assign({ dataDir: dataDir(), loginTimeout: 600, onEvent: send }, BROWSER));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e && e.message || e) };
  } finally { running = false; }
});

ipcMain.handle('run:start', async (_e, o) => {
  if (running) return { ok: false, message: 'Εκτελείται ήδη εργασία.' };
  const parsed = core.parseAfmText(o.text);
  if (!parsed.list.length) return { ok: false, message: 'Δεν βρέθηκε κανένα έγκυρο ΑΦΜ.' };

  const key = parsed.list.join(',');
  const usePlan = !!o.go && !o.recheck && lastPlan && lastPlan.key === key ? lastPlan.items : null;

  running = true;
  stopRequested = false;
  try {
    const res = await core.runAccept({
      afmList: parsed.list,
      acceptPlan: usePlan,
      go: !!o.go,
      verify: true,                       // δεν εκτίθεται στο GUI — κρύβει αποτυχίες
      headless: false,
      recheck: !!o.recheck,
      delay: Math.max(1000, parseInt(o.delay, 10) || 1500),
      limit: parseInt(o.limit, 10) || 0,
      dataDir: dataDir(),
      shouldStop: () => stopRequested,
      onEvent: send,
      channel: BROWSER.channel || null,
    });
    if (!o.go) lastPlan = { key: key, items: res.pending || [] };
    else lastPlan = null;                    // μετά το κανονικό, ξανά δοκιμαστικό
    return { ok: true, result: res };
  } catch (e) {
    const msg = String(e && e.message || e);
    send({ type: 'error', scope: 'run', message: msg.slice(0, 200) });
    return { ok: false, message: msg };
  } finally { running = false; }
});

ipcMain.handle('run:stop', () => { stopRequested = true; return true; });
