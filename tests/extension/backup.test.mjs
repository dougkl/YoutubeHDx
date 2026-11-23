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

  test('service worker: the TIDAL log is kept as YoutubeHDx-Player-log.txt in that folder, 5 s after new entries', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
      const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
      const files = {};
      bg.ctx.yhdxGetBackupDir = async () => fakeFolder(files);
      bg.local.tidalAuth = { access: 'a', refresh: 'r' };
      await bg.ctx.chrome.storage.local.set({ tidalLog: [
        { at: Date.UTC(2026, 10, 21, 1, 0), video: 'Night Ranger - Sister Christian', step: 'player', outcome: 'started TIDAL for you: pressed the song in TIDAL', track: '[74131674]' },
        { at: Date.UTC(2026, 10, 21, 0, 59), video: 'Night Ranger - Sister Christian', step: 'player', outcome: 'diag', track: '[74131674]', detail: 'got the song: tab hidden' }] });
      mock.timers.tick(4000);
      await flush();
      assert.equal(files['YoutubeHDx-Player-log.txt'], undefined, 'waits a moment');
      mock.timers.tick(1000);
      await flush();
      const text = files['YoutubeHDx-Player-log.txt'];
      assert.match(text.split('\n')[0], /^YoutubeHDx Player .* · TIDAL audio on · signed in to TIDAL · Client ID (set|MISSING) · written /);
      assert.match(text, /Night Ranger - Sister Christian \| player: started TIDAL for you: pressed the song in TIDAL \| \[74131674\]/);
      assert.match(text, /diag \| \[74131674\] \| got the song: tab hidden/);
      assert.doesNotMatch(text, /"refresh"|\br\b"/, 'never the sign-in');
      assert.equal(bg.local.logFileStatus.status, 'ok');
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

describe('ready check', () => {
  const okFetch = async (url) => {
    if (String(url).includes('lrclib.net')) return { ok: true, status: 200, json: async () => [] };
    if (String(url).includes('searchResults')) return { ok: true, status: 200, json: async () => ({ data: [{ relationships: { tracks: { data: [{ id: '1' }] } } }] }) };
    if (String(url).includes('/tracks')) return { ok: true, status: 200, json: async () => ({ data: [{ id: '1', attributes: { title: 'Bohemian Rhapsody', duration: 'PT5M55S' }, relationships: { artists: { data: [{ id: 'a' }] } } }], included: [{ id: 'a', type: 'artists', attributes: { name: 'Queen' } }] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };

  test('nothing set up yet: says what to fix, a red ! on the icon, and a line in the TIDAL log', async () => {
    const bg = loadPlayerBackground({ fetchFn: okFetch });
    const r = await bg.send({ type: 'ready-check' }, { url: 'chrome-extension://test/options.html' });
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    assert.equal(by['tidal-signin'].ok, false);
    assert.match(by['tidal-signin'].fix, /Sign in to TIDAL/);
    assert.equal(by['tidal-tab'].ok, null, 'no TIDAL tab yet is fine: it opens with the first song');
    assert.equal(by.folder.ok, false);
    assert.equal(by.lyrics.ok, true);
    assert.ok(r.problems >= 2);
    assert.equal(bg.action.badge, '!');
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(bg.local.tidalLog[0].step, 'ready check');
    assert.match(bg.local.tidalLog[0].detail, /PROBLEM Signed in to TIDAL/);
    assert.equal(await bg.send({ type: 'ready-check' }, { tab: { id: 5 }, url: 'https://www.youtube.com/' }), undefined, 'only from the settings page');
  });

  test('all set: TIDAL tab answers, the Player can press Play, folder writes; no badge', async () => {
    const bg = loadPlayerBackground({ fetchFn: okFetch });
    bg.local.tidalClientId = 'abc';
    bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3 };
    bg.tabs.open.push({ id: 70, url: 'https://tidal.com/' });
    bg.session.tidalWebTab = 70;
    bg.tabs.answer[70] = (m) => (m.cmd === 'check' ? { signedIn: true, autoplay: 'allowed', visible: false, bar: true } : undefined);
    bg.dbg.answer = 1;
    const files = {};
    bg.ctx.yhdxGetBackupDir = async () => ({ name: 'Backups', queryPermission: async () => 'granted',
      getFileHandle: async (name) => ({ createWritable: async () => ({ write: async (t) => { files[name] = t; }, close: async () => {} }) }) });
    const r = await bg.send({ type: 'ready-check' }, { url: 'chrome-extension://test/options.html' });
    const bad = r.items.filter((i) => i.ok === false).map((i) => `${i.id}: ${i.detail}`);
    assert.equal(JSON.stringify(bad), '[]');
    assert.equal(r.problems, 0);
    assert.equal(bg.action.badge, '');
    assert.ok(files['YoutubeHDx-Player-log.txt'], 'the log file was written as the folder test');
    assert.equal(r.items.find((i) => i.id === 'tidal-search').ok, true);
    assert.equal(r.items.find((i) => i.id === 'debugger').ok, true);
  });

  test('autoplay blocked in the TIDAL tab: reported with the fix', async () => {
    const bg = loadPlayerBackground({ fetchFn: okFetch });
    bg.local.tidalAuth = { access: 'tok', refresh: 'r', expires: Date.now() + 3600e3 };
    bg.tabs.open.push({ id: 70, url: 'https://tidal.com/' });
    bg.session.tidalWebTab = 70;
    bg.tabs.answer[70] = (m) => (m.cmd === 'check' ? { signedIn: null, autoplay: 'blocked', visible: true, bar: true } : undefined);
    const r = await bg.send({ type: 'ready-check' }, { url: 'chrome-extension://test/options.html' });
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    assert.equal(by.autoplay.ok, false);
    assert.match(by.autoplay.fix, /admin/);
    assert.equal(by['tidal-web-signin'].ok, null, "can't tell is not a problem");
  });
});

describe('error log', () => {
  test('errors from the Player\'s parts are kept (the same one again counts up), others ignored; settings page only reads it', async () => {
    const bg = loadPlayerBackground({ fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    const id = bg.ctx.chrome.runtime.id;
    const tick = () => new Promise((r) => setTimeout(r, 20));
    await bg.send({ type: 'yhdx-error', where: 'tidal-remote', message: 'x is not defined', stack: 'ReferenceError: x\n at chrome-extension://id/tidal-remote.js:1:1' }, { id, tab: { id: 70 }, url: 'https://tidal.com/' });
    await bg.send({ type: 'yhdx-error', where: 'tidal-remote', message: 'x is not defined' }, { id, tab: { id: 70 }, url: 'https://tidal.com/' });
    await bg.send({ type: 'yhdx-error', where: 'bridge', message: 'boom' }, { id, tab: { id: 5 }, url: 'https://www.youtube.com/watch?v=1' });
    await bg.send({ type: 'yhdx-error', where: 'evil', message: 'spam' }, { id: 'some-other-extension', url: 'https://evil.example/' });
    await tick();
    const log = bg.local.errorLog;
    assert.equal(log.length, 2);
    const tidal = log.find((e) => e.where === 'tidal-remote (TIDAL tab)');
    assert.equal(tidal.count, 2);
    assert.match(tidal.stack, /tidal-remote\.js/);
    assert.ok(log.some((e) => e.where === 'bridge (YouTube page)' && e.message === 'boom'));
    assert.equal(await bg.send({ type: 'error-log' }, { tab: { id: 5 }, url: 'https://www.youtube.com/' }), undefined);
    const fromSettings = await bg.send({ type: 'error-log' }, { url: 'chrome-extension://test/options.html' });
    assert.equal(fromSettings.length, 2);
    await bg.send({ type: 'error-log-clear' }, { url: 'chrome-extension://test/options.html' });
    await tick();
    assert.equal(bg.local.errorLog.length, 0);
  });

  test('written as YoutubeHDx-Player-errors.txt next to the TIDAL log; the ready check counts the last 24 hours', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const bg = loadPlayerBackground({ fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
      const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
      const files = {};
      bg.ctx.yhdxGetBackupDir = async () => fakeFolder(files);
      await bg.ctx.chrome.storage.local.set({ errorLog: [{ at: Date.now(), where: 'background', message: 'TIDAL answered 503', stack: 'Error: 503\n at tidalExchange' }] });
      mock.timers.tick(5000);
      await flush();
      assert.match(files['YoutubeHDx-Player-errors.txt'], /\| background \| TIDAL answered 503\n    Error: 503/);
      assert.ok(files['YoutubeHDx-Player-log.txt']);
    } finally {
      mock.timers.reset();
    }
    const bg2 = loadPlayerBackground({ fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    bg2.local.errorLog = [{ at: Date.now(), where: 'bridge', message: 'a', count: 3 }, { at: Date.now() - 3 * 86400e3, where: 'bridge', message: 'old' }];
    const r = await bg2.send({ type: 'ready-check' }, { url: 'chrome-extension://test/options.html' });
    const e = r.items.find((i) => i.id === 'errors');
    assert.equal(e.ok, null);
    assert.match(e.detail, /^3 /);
  });
});
