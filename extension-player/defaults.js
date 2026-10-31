// Shared defaults + caption CSS builder. Loaded by the isolated-world content script and the options page.
// (Intentionally not loaded into the page's MAIN world, so nothing leaks into YouTube's globals.)

const YHDX_DEFAULTS = {
  forceQuality: true,
  quality: 'highres',           // highres (best the video has) | hd2160 | hd1440 | hd1080 | hd720
  captions: 'english',          // english (human-made only) | off | leave
  captionLanguages: ['en', 'en-US', 'en-GB'],
  captionStyle: {
    enabled: true,
    fontFamily: '"Segoe UI", Roboto, Arial, sans-serif',
    fontSizePx: 14,
    color: '#ffea00',           // yellow
    backgroundColor: '#000000',
    backgroundOpacity: 0,       // no box behind the text
    edge: 'outline',            // none | drop-shadow | outline
  },
};

function yhdxHexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  const a = Math.min(1, Math.max(0, Number(alpha) || 0));
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function yhdxSafe(value, fallback) {
  // Settings are the user's own, but keep CSS well-formed no matter what was typed.
  const s = String(value ?? '').replace(/[{}<>;\\]/g, '').trim();
  return s || fallback;
}

/** CSS applied to YouTube's caption segments. Empty string = leave YouTube's styling alone. */
function yhdxBuildCaptionCss(style) {
  if (!style || !style.enabled) return '';
  const size = Math.min(96, Math.max(10, Number(style.fontSizePx) || 28));
  const color = /^#[0-9a-f]{6}$/i.test(style.color) ? style.color : '#ffffff';
  const shadow = {
    'none': 'none',
    'drop-shadow': '2px 2px 3px rgba(0,0,0,0.9)',
    'outline': '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
  }[style.edge] ?? 'none';

  return `
.ytp-caption-segment {
  font-family: ${yhdxSafe(style.fontFamily, 'Arial, sans-serif')} !important;
  font-size: ${size}px !important;
  line-height: 1.3 !important;
  color: ${color} !important;
  background: ${yhdxHexToRgba(style.backgroundColor, style.backgroundOpacity)} !important;
  text-shadow: ${shadow} !important;
}`;
}
