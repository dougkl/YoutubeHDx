// Backup of your choices: per-video subtitle and TIDAL choices (sync shifts, picked songs, "YouTube's sound"...) and
// the Player settings. Never the TIDAL sign-in. Used by the service worker (automatic backups) and the settings page
// (choose the NAS folder, back up now, restore). Files: YoutubeHDx-Player-backup.json, plus one per day (14 kept).

const YHDX_BACKUP_FILE = 'YoutubeHDx-Player-backup.json';
const YHDX_BACKUP_DAYS = 14;
const YHDX_VIDEO_ID = /^[\w-]{6,20}$/;

// ---------------------------------------------------------------- the NAS folder you chose (kept in IndexedDB)
function yhdxBackupDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('yhdx-backup', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function yhdxBackupKv(key, value) {
  const db = await yhdxBackupDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const store = tx.objectStore('kv');
    const r = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
    r.onsuccess = () => resolve(value === undefined ? r.result ?? null : true);
    r.onerror = () => reject(r.error);
  });
}
const yhdxGetBackupDir = () => (typeof indexedDB === 'undefined' ? Promise.resolve(null) : yhdxBackupKv('nasDir').catch(() => null));
const yhdxSetBackupDir = (handle) => yhdxBackupKv('nasDir', handle);

// ---------------------------------------------------------------- what goes in it
async function yhdxBackupData(storage = chrome.storage) {
  const all = await storage.local.get(null);
  const videos = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('prefs:') && YHDX_VIDEO_ID.test(k.slice(6)) && v && typeof v === 'object') videos[k.slice(6)] = v;
  }
  const settings = await storage.sync.get(null);
  return { app: 'YoutubeHDx Player', version: chrome.runtime.getManifest?.().version ?? '', savedAt: new Date().toISOString(), settings, videos };
}

/** Puts a backup back: your per-video choices (the backup's win over what's here) and, if asked, the settings. */
async function yhdxRestoreBackup(data, { settings = true } = {}, storage = chrome.storage) {
  if (!data || data.app !== 'YoutubeHDx Player' || typeof data.videos !== 'object') throw new Error('not a YoutubeHDx Player backup');
  const items = {};
  for (const [id, prefs] of Object.entries(data.videos)) {
    if (YHDX_VIDEO_ID.test(id) && prefs && typeof prefs === 'object' && !Array.isArray(prefs)) items[`prefs:${id}`] = prefs;
  }
  if (Object.keys(items).length) await storage.local.set(items);
  if (settings && data.settings && typeof data.settings === 'object') await storage.sync.set(data.settings);
  return Object.keys(items).length;
}

// ---------------------------------------------------------------- writing it to the folder
async function yhdxWriteFile(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

/** 'ok' | 'not set' | 'needs permission' | 'error: …' */
async function yhdxBackupToFolder(dir, json, now = new Date()) {
  if (!dir) return 'not set';
  try {
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') return 'needs permission';
    await yhdxWriteFile(dir, YHDX_BACKUP_FILE, json);
    await yhdxWriteFile(dir, `YoutubeHDx-Player-backup-${now.toISOString().slice(0, 10)}.json`, json);
    // keep the last 14 days
    const daily = [];
    for await (const [name] of dir.entries()) if (/^YoutubeHDx-Player-backup-\d{4}-\d{2}-\d{2}\.json$/.test(name)) daily.push(name);
    daily.sort();
    for (const name of daily.slice(0, Math.max(0, daily.length - YHDX_BACKUP_DAYS))) await dir.removeEntry(name).catch(() => {});
    return 'ok';
  } catch (e) {
    return `error: ${e?.message || e}`;
  }
}

function yhdxBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
