const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const STATUS_LABEL = {
  queued: 'Queued', running: 'Downloading', completed: 'Saved', completedWithErrors: 'Saved with errors',
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
    title.textContent = j.title || j.url;
    title.title = j.error || j.lastFile || j.url;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const status = document.createElement('span');
    status.className = `s-${j.status}`;
    status.textContent = STATUS_LABEL[j.status] || j.status;
    const detail = document.createElement('span');
    if (j.status === 'running') detail.textContent = [`${j.percent.toFixed(1)}%`, j.speed, j.eta && `ETA ${j.eta}`].filter(Boolean).join(' · ');
    else if (j.itemsCompleted > 1) detail.textContent = `${j.itemsCompleted} videos`;
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
    if (j.status === 'running' || j.status === 'queued') {
      const c = document.createElement('button');
      c.className = 'cancel';
      c.textContent = 'Cancel';
      c.onclick = async () => { c.disabled = true; await send({ type: 'cancel', jobId: j.id }); refreshJobs(); };
      meta.append(c);
    }
    ul.append(li);
  }
}

async function refreshJobs() {
  renderJobs(await send({ type: 'status' }));
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
