const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const STATUS_LABEL = {
  queued: 'Queued', running: 'Downloading', paused: 'Paused', completed: 'Saved', completedWithErrors: 'Saved with errors',
  failed: 'Failed', canceled: 'Canceled',
};

function showResult(reply) {
  const el = $('result');
  el.textContent = reply?.message || (reply?.ok ? 'Done.' : 'Something went wrong.');
  el.className = reply?.ok ? 'ok' : 'err';
}

async function run(button, msg) {
  button.disabled = true;
  try { showResult(await send(msg)); refreshJobs(); }
  finally { button.disabled = false; }
}

async function setupActions() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const info = tab?.url ? await send({ type: 'parse', url: tab.url }) : null;
  if (!info) return;

  const hint = $('hint');
  if (info.videoUrl) {
    const b = $('dl-video');
    b.hidden = false;
    b.onclick = () => run(b, { type: 'download', url: info.videoUrl, noPlaylist: true });
  }
  if (info.playlistUrl && !info.isMix) {
    const b = $('dl-playlist');
    b.hidden = false;
    b.onclick = () => run(b, { type: 'download', url: info.playlistUrl, noPlaylist: false });
    const w = $('watch-playlist');
    w.hidden = false;
    w.onclick = () => run(w, { type: 'watch', url: info.playlistUrl });
  }
  hint.hidden = !!(info.videoUrl || (info.playlistUrl && !info.isMix));
  if (info.isMix && !info.videoUrl) hint.textContent = 'YouTube Mixes are endless, so they can\'t be archived as a playlist.';
}

function renderJobs(reply) {
  const ul = $('jobs');
  ul.replaceChildren();
  if (!reply?.ok) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = reply?.message || 'App not reachable.';
    ul.append(li);
    return;
  }
  const jobs = reply.jobs || [];
  if (!jobs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing yet.';
    ul.append(li);
    return;
  }
  for (const j of jobs.slice(0, 10)) {
    const li = document.createElement('li');
    li.className = 'job';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = j.name || j.title || j.url;
    title.title = [j.summary, j.error, j.url].filter(Boolean).join('\n');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const status = document.createElement('span');
    status.className = `s-${j.status}`;
    status.textContent = j.statusText || STATUS_LABEL[j.status] || j.status;
    const detail = document.createElement('span');
    if (j.status === 'running' && j.title) detail.textContent = [`${j.percent.toFixed(1)}%`, j.speed, j.eta && `ETA ${j.eta}`].filter(Boolean).join(' · ');
    else if (j.unavailableCount > 0) detail.textContent = `${j.unavailableCount} unavailable`;
    meta.append(status, detail);

    li.append(title, meta);

    if (j.status === 'running') {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.min(100, j.percent)}%`;
      bar.append(fill);
      li.append(bar);
    }
    if (j.status === 'running' || j.status === 'queued' || j.status === 'paused') {
      const c = document.createElement('button');
      c.className = 'cancel';
      c.textContent = 'Cancel';
      c.onclick = async () => { c.disabled = true; await send({ type: 'cancel', jobId: j.id }); refreshJobs(); };
      meta.append(c);
    }
    ul.append(li);
  }
}

function renderPause(reply) {
  const bar = $('pausebar');
  bar.hidden = !reply?.ok; // only when the app is reachable
  if (!reply?.ok) return;
  const p = reply.pause || { isPaused: false };
  $('pause-idle').hidden = p.isPaused;
  $('pause-active').hidden = !p.isPaused;
  if (p.isPaused) {
    $('pause-text').textContent = p.until
      ? `Paused until ${new Date(p.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'Paused until you resume';
  }
}

async function pauseFor(minutes) {
  const r = await send({ type: 'pause', minutes });
  showResult(r);
  refreshJobs();
}

for (const b of document.querySelectorAll('#pause-idle button')) {
  b.onclick = () => pauseFor(Number(b.dataset.minutes) || null);
}
$('resume').onclick = async () => { showResult(await send({ type: 'resume' })); refreshJobs(); };

async function refreshJobs() {
  const reply = await send({ type: 'status' });
  renderPause(reply);
  renderJobs(reply);
}

async function checkLogin() {
  const el = $('login');
  const r = await send({ type: 'login' });
  if (r?.signedIn) {
    el.textContent = '✓ Signed in. Downloads use your YouTube account.';
    el.className = 'login ok';
  } else {
    el.textContent = r?.message || 'Not signed in.';
    el.className = 'login err';
  }
}

checkLogin();
setupActions();
refreshJobs();
setInterval(refreshJobs, 1500);
