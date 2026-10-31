const $ = (id) => document.getElementById(id);
const STYLE_FIELDS = ['fontFamily', 'fontSizePx', 'color', 'backgroundColor', 'backgroundOpacity', 'edge'];

function fill(s) {
  $('forceQuality').checked = s.forceQuality;
  $('quality').value = s.quality;
  $('captions').value = s.captions;
  $('captionLanguages').value = (s.captionLanguages || []).join(', ');
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
$('save').onclick = async () => { await chrome.storage.sync.set(read()); flash('Saved. Open YouTube tabs update right away.'); };
$('reset').onclick = async () => { await chrome.storage.sync.set(YHDX_DEFAULTS); fill(YHDX_DEFAULTS); flash('Defaults restored.'); };

chrome.storage.sync.get(YHDX_DEFAULTS).then(fill);
