const $ = (id) => document.getElementById(id);
const STYLE_FIELDS = ['fontFamily', 'fontSizePx', 'color', 'backgroundColor', 'backgroundOpacity', 'edge'];

function fill(s) {
  $('forceQuality').checked = s.forceQuality;
  $('quality').value = s.quality;
  $('captions').value = s.captions;
  $('captionLanguages').value = (s.captionLanguages || []).join(', ');
  $('lyricsWhenNoCaptions').checked = s.lyricsWhenNoCaptions;
  $('hideEndCards').checked = s.hideEndCards;
  $('hideEndScreen').checked = s.hideEndScreen;
  $('hideComments').checked = s.hideComments;
  $('tidalAudio').checked = s.tidalAudio;
  $('styleEnabled').checked = s.captionStyle.enabled;
  for (const f of STYLE_FIELDS) $(f).value = s.captionStyle[f];
  preview();
}

function read() {
  const style = { enabled: $('styleEnabled').checked };
  for (const f of STYLE_FIELDS) style[f] = $(f).value;
  style.fontSizePx = Number(style.fontSizePx);
  style.backgroundOpacity = Number(style.backgroundOpacity);
  return {
    forceQuality: $('forceQuality').checked,
    quality: $('quality').value,
    captions: $('captions').value,
    captionLanguages: $('captionLanguages').value.split(',').map((x) => x.trim()).filter(Boolean),
    lyricsWhenNoCaptions: $('lyricsWhenNoCaptions').checked,
    hideEndCards: $('hideEndCards').checked,
    hideEndScreen: $('hideEndScreen').checked,
    hideComments: $('hideComments').checked,
    tidalAudio: $('tidalAudio').checked,
    captionStyle: style,
  };
}

function preview() {
  const style = read().captionStyle;
  $('opacityOut').textContent = `${Math.round(style.backgroundOpacity * 100)}%`;
  // Preview always shows the custom style so you can tune it before enabling.
  $('preview-style').textContent = yhdxBuildCaptionCss({ ...style, enabled: true })
    .replace('.ytp-caption-segment', '.preview .ytp-caption-segment');
}

function flash(text) {
  $('saved').textContent = text;
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
}

document.addEventListener('input', preview);
$('save').onclick = async () => {
  await chrome.storage.sync.set(read());
  // The API key is a credential: kept in this PC's local storage, never synced to the Google account.
  await chrome.storage.local.set({ openSubtitlesKey: $('openSubtitlesKey').value.trim() });
  const clientId = $('tidalClientId').value.trim();
  if (clientId) await chrome.storage.local.set({ tidalClientId: clientId });
  else await chrome.storage.local.remove('tidalClientId');
  flash('Saved. Open YouTube tabs update right away.');
};
$('reset').onclick = async () => { await chrome.storage.sync.set(YHDX_DEFAULTS); fill(YHDX_DEFAULTS); flash('Defaults restored.'); };

chrome.storage.sync.get(YHDX_DEFAULTS).then(fill);
chrome.storage.local.get({ openSubtitlesKey: '' }).then((r) => { $('openSubtitlesKey').value = r.openSubtitlesKey; });

$('resetVideoChoices').onclick = async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('prefs:'));
  if (keys.length) await chrome.storage.local.remove(keys);
  flash(keys.length ? `Forgot choices for ${keys.length} video(s).` : 'No per-video choices saved.');
};

// ---------------------------------------------------------------- TIDAL sign-in
async function tidalState() {
  const st = await chrome.runtime.sendMessage({ type: 'tidal-status' });
  $('tidalRedirect').textContent = st?.redirectUri ?? '';
  if (!$('tidalClientId').value) $('tidalClientId').value = st?.clientId ?? '';
  $('tidalState').textContent = st?.signedIn ? (st.previewOnly ? 'Signed in, but TIDAL gives this app 30-second previews only, so videos keep YouTube\'s sound (checked again daily).' : 'Signed in to TIDAL.') : st?.clientId ? 'Not signed in.' : 'Enter the Client ID, Save, then sign in.';
}
$('tidalSignIn').onclick = async () => {
  const clientId = $('tidalClientId').value.trim();
  if (clientId) await chrome.storage.local.set({ tidalClientId: clientId });
  $('tidalState').textContent = 'Opening TIDAL sign-in…';
  const r = await chrome.runtime.sendMessage({ type: 'tidal-signin' });
  $('tidalState').textContent = r?.error ? r.error : 'Signed in to TIDAL.';
};
$('tidalSignOut').onclick = async () => { await chrome.runtime.sendMessage({ type: 'tidal-signout' }); tidalState(); };
chrome.storage.local.get({ tidalClientId: '' }).then((r) => { $('tidalClientId').value = r.tidalClientId; tidalState(); });
