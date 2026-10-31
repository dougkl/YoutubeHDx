// Service worker: the only part that talks to the C# host (via native messaging).
const HOST = 'com.doug.youtubehdx';
const COOKIE_REFRESH_MINUTES = 360;

// ---------- native host ----------

async function getYoutubeCookies() {
  const cookies = await chrome.cookies.getAll({ domain: 'youtube.com' });
  return cookies.map((c) => ({
    domain: c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    session: c.session,
    expirationDate: c.expirationDate ?? null,
    name: c.name,
    value: c.value,
  }));
}

async function callHost(message) {
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, message);
    return reply ?? { ok: false, message: 'No reply from the YoutubeHDx host.' };
  } catch (e) {
    const text = String(e?.message || e);
    if (/not found|forbidden/i.test(text)) {
      return { ok: false, message: 'The YoutubeHDx downloader app is not installed on this PC. Run Install-Downloader.cmd from the pack.' };
    }
    return { ok: false, message: text };
  }
}

/** Sends the current YouTube login to the app. Skipped when signed out, so a good login is never overwritten. */
async function refreshLogin() {
  const cookies = await getYoutubeCookies();
  if (!cookies.some((c) => c.name === 'LOGIN_INFO')) {
    return { ok: false, signedIn: false, message: 'Not signed in to YouTube in this Chrome profile.' };
  }
  const reply = await callHost({ type: 'cookies', cookies });
  return { ...reply, signedIn: reply.ok };
}

async function flashBadge(ok) {
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#1f9d55' : '#d93025' });
  await chrome.action.setBadgeText({ text: ok ? 'OK' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

async function download(url, noPlaylist) {
  const reply = await callHost({ type: 'download', url, noPlaylist, cookies: await getYoutubeCookies() });
  await flashBadge(reply.ok);
  return reply;
}

async function watchPlaylist(url) {
  const reply = await callHost({ type: 'watch', url, cookies: await getYoutubeCookies() });
  await flashBadge(reply.ok);
  return reply;
}

// ---------- URL helpers ----------

function parseYoutubeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;

  let videoId = null;
  if (host === 'youtu.be') videoId = u.pathname.slice(1).split('/')[0] || null;
  else if (u.pathname === '/watch') videoId = u.searchParams.get('v');
  else {
    const m = /^\/(shorts|live|embed)\/([\w-]{6,})/.exec(u.pathname);
    if (m) videoId = m[2];
  }
  const listId = u.searchParams.get('list');
  return {
    videoId,
    listId,
    // Auto-generated mixes (RD...) are endless; don't offer them as playlists.
    isMix: !!listId && listId.startsWith('RD'),
    videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    playlistUrl: listId ? `https://www.youtube.com/playlist?list=${listId}` : null,
  };
}

// ---------- context menu ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'yhdx-link',
      title: 'Download in 4K to NAS',
      contexts: ['link'],
      targetUrlPatterns: ['https://*.youtube.com/*', 'https://youtu.be/*'],
    });
    chrome.contextMenus.create({
      id: 'yhdx-page',
      title: 'Download this video in 4K to NAS',
      contexts: ['page', 'video'],
      documentUrlPatterns: ['https://www.youtube.com/watch*', 'https://www.youtube.com/shorts/*'],
    });
  });
  chrome.alarms.create('yhdx-cookies', { periodInMinutes: COOKIE_REFRESH_MINUTES });
  refreshLogin();
});

// Hand the app a fresh login every time Chrome starts, so scheduled syncs never run on stale cookies.
chrome.runtime.onStartup.addListener(() => { refreshLogin(); });

chrome.contextMenus.onClicked.addListener(async (info) => {
  const parsed = parseYoutubeUrl(info.linkUrl || info.pageUrl || '');
  if (!parsed) return flashBadge(false);
  if (parsed.videoUrl) return download(parsed.videoUrl, true);
  if (parsed.playlistUrl && !parsed.isMix) return download(parsed.playlistUrl, false);
  return flashBadge(false);
});

// Keep the host's cookie file fresh so scheduled playlist syncs can see private/unlisted playlists.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'yhdx-cookies') await refreshLogin();
});

// ---------- popup / options messages ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'parse': return parseYoutubeUrl(msg.url);
      case 'login': return refreshLogin();
      case 'download': return download(msg.url, !!msg.noPlaylist);
      case 'watch': return watchPlaylist(msg.url);
      case 'status': return callHost({ type: 'status' });
      case 'cancel': return callHost({ type: 'cancel', jobId: msg.jobId });
      case 'pause': return callHost({ type: 'pause', minutes: Number.isInteger(msg.minutes) && msg.minutes > 0 ? msg.minutes : null });
      case 'resume': return callHost({ type: 'resume' });
      default: return { ok: false, message: 'Unknown request.' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, message: String(e?.message || e) }));
  return true; // async response
});
