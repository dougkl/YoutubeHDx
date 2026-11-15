// Backup of your choices (backup.js + the service worker's automatic backups).
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { loadPlayerBackground } from './harness.mjs';

const src = readFileSync(new URL('../../extension-player/backup.js', import.meta.url), 'utf8');
function loadBackup() {
  const ctx = vm.createContext({ chrome: { runtime: {} }, TextEncoder, btoa, JSON, Object, Date, Math, Error, Promise, String });
  vm.runInContext(src + '\n;globalThis.__x = { yhdxBackupData, yhdxRestoreBackup, yhdxBackupToFolder, YHDX_BACKUP_FILE };', ctx);
  return ctx.__x;
}

/** A folder like the one you pick in the settings (File System Access), in memory. */
function fakeFolder(files = {}, permission = 'granted') {
  return {
    name: 'Backups', files,
    queryPermission: async () => permission,
    getFileHandle: async (name) => ({ createWritable: async () => { let text = ''; return { write: async (t) => { text += t; }, close: async () => { files[name] = text; } }; } }),
    async *entries() { for (const name of Object.keys(files)) yield [name, {}]; },
    removeEntry: async (name) => { delete files[name]; },
  };
}

const fakeStorage = (local, sync = {}) => ({
  local: { get: async () => ({ ...local }), set: async (o) => Object.assign(local, o) },
  sync: { get: async () => ({ ...sync }), set: async (o) => Object.assign(sync, o) },
});

describe('backup of your choices', () => {
  test('has your per-video choices and the settings, never the TIDAL sign-in or caches', async () => {
    const B = loadBackup();
    const local = { 'prefs:abcdefghijk': { audioOffset: 1.5, pickedTrack: { id: '7', title: 'x', artist: 'y', seconds: 200 } },
                    'prefs:bad id!': { off: true }, tidalAuth: { access: 'secret' }, 'tidal:abcdefghijk': { at: 1 }, 'lyrics:abcdefghijk': {} };
    const data = await B.yhdxBackupData(fakeStorage(local, { captions: 'english' }));
    assert.equal(data.app, 'YoutubeHDx Player');
    assert.deepEqual(Object.keys(data.videos), ['abcdefghijk']);
    assert.equal(data.videos.abcdefghijk.audioOffset, 1.5);
    assert.equal(data.settings.captions, 'english');
    assert.doesNotMatch(JSON.stringify(data), /secret/);
  });

  test('restore puts your choices back (the backup wins), skips anything odd', async () => {
    const B = loadBackup();
    const local = { 'prefs:abcdefghijk': { audioOffset: 9 } };
    const sync = {};
    const n = await B.yhdxRestoreBackup({ app: 'YoutubeHDx Player', settings: { captions: 'english' },
      videos: { abcdefghijk: { audioOffset: 1.5 }, 'no way!': { off: true }, zzzzzzzzzzz: 'x' } }, {}, fakeStorage(local, sync));
    assert.equal(n, 1);
    assert.equal(local['prefs:abcdefghijk'].audioOffset, 1.5);
    assert.equal(sync.captions, 'english');
    await assert.rejects(B.yhdxRestoreBackup({ hello: 1 }, {}, fakeStorage({}, {})), /not a YoutubeHDx Player backup/);
  });

  test('the NAS folder: the backup file, one per day, the last 14 days kept', async () => {
    const B = loadBackup();
    const files = {};
    for (let d = 1; d <= 15; d++) files[`YoutubeHDx-Player-backup-2026-10-${String(d).padStart(2, '0')}.json`] = '{}';
    files['other.txt'] = 'mine';
    assert.equal(await B.yhdxBackupToFolder(fakeFolder(files), '{"a":1}', new Date('2026-11-14T22:00:00Z')), 'ok');
    assert.equal(files[B.YHDX_BACKUP_FILE], '{"a":1}');
    assert.equal(files['YoutubeHDx-Player-backup-2026-11-14.json'], '{"a":1}');
    const daily = Object.keys(files).filter((f) => /backup-\d/.test(f)).sort();
    assert.equal(daily.length, 14);
    assert.equal(daily[0], 'YoutubeHDx-Player-backup-2026-10-03.json');
    assert.equal(files['other.txt'], 'mine', 'other files left alone');
    assert.equal(await B.yhdxBackupToFolder(fakeFolder({}, 'prompt'), '{}'), 'needs permission');
    assert.equal(await B.yhdxBackupToFolder(null, '{}'), 'not set');
  });

  test('service worker: backs up 10 s after a change, once, to the folder you chose; never a download', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
      const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
      const files = {};
      bg.ctx.yhdxGetBackupDir = async () => fakeFolder(files);
      await bg.ctx.chrome.storage.local.set({ 'prefs:abcdefghijk': { audioOffset: 2 } });
      await bg.ctx.chrome.storage.local.set({ 'prefs:abcdefghijk': { audioOffset: 2.5 } });
      mock.timers.tick(9000);
      await flush();
      assert.equal(Object.keys(files).length, 0, 'waits for you to finish');
      mock.timers.tick(1000);
      await flush();
      assert.equal(JSON.parse(files['YoutubeHDx-Player-backup.json']).videos.abcdefghijk.audioOffset, 2.5);
      assert.equal(bg.downloads.saved.length, 0, 'nothing through Chrome\'s downloads (no Save As)');
      assert.equal(bg.local.backupStatus.nas, 'ok');
      assert.equal(bg.local.backupStatus.videos, 1);
      assert.equal('downloads' in bg.local.backupStatus, false);
    } finally {
      mock.timers.reset();
    }
  });

  test('service worker: "Back up now" only from the settings page', async () => {
    const bg = loadPlayerBackground({ fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    assert.equal(await bg.send({ type: 'backup-now' }, { tab: { id: 5 }, url: 'https://www.youtube.com/' }), undefined);
    const r = await bg.send({ type: 'backup-now' }, { url: 'chrome-extension://test/options.html' });
    assert.equal(r.nas, 'not set');
  });
});
