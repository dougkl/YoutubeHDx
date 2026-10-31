// Player extension service worker: toolbar button opens settings; looks up lyrics for videos without captions.
importScripts('lyrics.js');

const DAY = 24 * 60 * 60 * 1000;
const TTL = { found: 30 * DAY, notFound: 7 * DAY, retry: 60 * 60 * 1000 };

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function cachedLyrics(videoId) {
  const key = `lyrics:${videoId}`;
  const hit = (await chrome.storage.local.get(key))[key];
  return hit && Date.now() - hit.at < hit.ttl ? hit.result : undefined;
}

async function rememberLyrics(videoId, result) {
  const ttl = result.cues ? TTL.found : result.retryable ? TTL.retry : TTL.notFound;
  await chrome.storage.local.set({ [`lyrics:${videoId}`]: { at: Date.now(), ttl, result } });
}

async function lookupLyrics(msg) {
  if (!/^[\w-]{6,20}$/.test(String(msg.videoId || ''))) return { cues: null, reason: 'bad video id' };
  const cached = await cachedLyrics(msg.videoId);
  if (cached !== undefined) return cached;

  const { openSubtitlesKey } = await chrome.storage.local.get({ openSubtitlesKey: '' });
  const result = await yhdxFindLyrics(
    { title: msg.title, author: msg.author, duration: Number(msg.duration) },
    { fetchFn: (url, init) => fetch(url, init), openSubtitlesKey: String(openSubtitlesKey || '').trim() },
  );
  await rememberLyrics(msg.videoId, result);
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'lyrics') return false;
  lookupLyrics(msg).then(sendResponse, (e) => sendResponse({ cues: null, reason: String(e?.message || e), retryable: true }));
  return true; // async response
});
