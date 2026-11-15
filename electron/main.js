// Application Windows (Electron) : affiche l'éditeur Prisme dans une fenêtre native.
const { app, BrowserWindow, protocol, net, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const WWW = path.join(__dirname, '..', 'www');

// Schéma app:// sécurisé : permet les modules JavaScript et le stockage local hors file://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- Fichiers ouverts depuis l'Explorateur (« Ouvrir avec », double-clic sur un .prisme) ----------
const OPENABLE = /\.(prisme|json|psd|jpe?g|png|webp|gif|avif|bmp|tiff?|heic|heif|hif|cr2|cr3|crw|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|srw|erf|kdc|mrw|3fr|iiq|x3f|rwl)$/i;
const MAX_FILE = 1024 * 1024 * 1024; // 1 Go
let rendererReady = false;
const pendingFiles = [];

function filesFromArgv(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && OPENABLE.test(a) && fs.existsSync(a));
}

function sendFile(file) {
  const [win] = BrowserWindow.getAllWindows();
  if (!win || !rendererReady) return pendingFiles.push(file);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE) return;
    win.webContents.send('open-file', { name: path.basename(file), data: fs.readFileSync(file) });
  } catch (e) {
    console.error('Ouverture impossible', file, e);
  }
}

ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  pendingFiles.splice(0).forEach(sendFile);
});

// macOS : glisser un fichier sur l'icône du Dock
app.on('open-file', (e, file) => {
  e.preventDefault();
  sendFile(file);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    title: 'Prisme — SuperEssence Studio',
    icon: path.join(WWW, 'icons', 'icon-256.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.webContents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) rendererReady = false;
  });
  win.loadURL('app://prisme/index.html');
  // Liens externes : navigateur du système
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(WWW, decodeURIComponent(pathname)));
    if (!file.startsWith(WWW)) return new Response('Interdit', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  filesFromArgv(process.argv).forEach(sendFile);
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('second-instance', (_e, argv) => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  filesFromArgv(argv).forEach(sendFile);
});

app.on('window-all-closed', () => app.quit());
