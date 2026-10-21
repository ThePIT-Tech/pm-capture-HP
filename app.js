import * as db from './db.js';
import { makeZip } from './zip.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SIDE_TH = { before: 'ก่อน PM', after: 'หลัง PM' };
const MAX_PX = 1600;          // longest side of a saved photo (the report shrinks it further)
const JPEG_Q = 0.88;
const EXTRA_ASPECT = 4 / 3;   // frame for extra photos that have no reference

const state = {
  job: null,        // {id, name, data, loadedAt}
  photos: [],       // photo records of the open job
  st: 0,            // station index
  side: 'before',
  mode: localStorage.getItem('mode') || 'seq',
  shot: null,       // shot being taken ({id, items, aspect, ref} or an extra shot)
  pending: null,    // captured blob waiting for keep/retake
  stream: null,
  wake: null,
};

// ------------------------------------------------------------------ helpers
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms);
}
function show(id) {
  $$('.screen').forEach((s) => (s.hidden = s.id !== id));
  window.scrollTo(0, 0);
}
const station = () => state.job.data.stations[state.st];
const shotsOf = (st, side) => st.shots.filter((s) => s.side === side);
const photosOf = (stKey, side, shotId) =>
  state.photos.filter((p) => p.station === stKey && p.side === side && (shotId == null || p.shotId === shotId));
const itemTitle = (st, no) => st.items.find((i) => i.no === no)?.title || `${no}.`;
const fmtTime = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// ------------------------------------------------------------------ home
async function renderHome() {
  const jobs = (await db.listJobs()).sort((a, b) => b.loadedAt.localeCompare(a.loadedAt));
  const all = await Promise.all(jobs.map((j) => db.jobPhotos(j.id)));
  $('#jobList').innerHTML = jobs.length ? jobs.map((j, i) => {
    const total = j.data.stations.reduce((s, st) => s + st.shots.length, 0);
    const done = new Set(all[i].filter((p) => p.shotId !== 'X').map((p) => `${p.station}|${p.side}|${p.shotId}`)).size;
    return `<li><div class="grow"><b>${esc(j.name)}</b>
      <span class="muted small">${j.data.stations.map((s) => esc(s.name)).join(', ')} · ถ่ายแล้ว ${done}/${total} จุด · ${all[i].length} รูป</span></div>
      <button class="btn" data-open="${esc(j.id)}">เปิด</button>
      <button class="icon" data-del="${esc(j.id)}" aria-label="ลบงาน">🗑</button></li>`;
  }).join('') : '<li class="muted">ยังไม่มีงาน กด "โหลดไฟล์งาน"</li>';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#storageInfo').textContent = `ใช้พื้นที่ ${(est.usage / 1e6).toFixed(0)} MB จาก ${(est.quota / 1e6).toFixed(0)} MB`;
  } catch { /* storage estimate is optional */ }
  show('home');
}

$('#jobFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.format !== 'pm-capture/1' || !Array.isArray(data.stations)) throw new Error('ไม่ใช่ไฟล์งาน PM Capture');
    const id = `${data.name}|${data.created}`;
    const old = await db.getJob(id);
    await db.putJob({ id, name: data.name, data, loadedAt: old?.loadedAt || new Date().toISOString() });
    await db.persist();
    toast(old ? 'โหลดงานซ้ำ ใช้รูปที่ถ่ายไว้เดิมต่อ' : 'โหลดงานแล้ว');
    renderHome();
  } catch (err) {
    toast(`เปิดไฟล์ไม่ได้: ${err.message}`, 4000);
  }
});

$('#jobList').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]')?.dataset.open;
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (open) return openJob(open);
  if (del) {
    const j = await db.getJob(del);
    const n = (await db.jobPhotos(del)).length;
    if (confirm(`ลบงาน "${j.name}" และรูปที่ถ่ายไว้ ${n} รูปออกจากเครื่อง?\nส่งออก zip แล้วหรือยัง`)) {
      await db.deleteJob(del); renderHome();
    }
  }
});

// ------------------------------------------------------------------ job
async function openJob(id) {
  state.job = await db.getJob(id);
  state.photos = await db.jobPhotos(id);
  state.st = 0; state.side = 'before';
  $('#jobTitle').textContent = state.job.name;
  renderJob(); show('job');
}

function nextMissing(after = -1) {
  const shots = shotsOf(station(), state.side);
  const missing = (i) => !photosOf(station().key, state.side, shots[i].id).length;
  for (let i = after + 1; i < shots.length; i++) if (missing(i)) return shots[i];
  for (let i = 0; i <= after && i < shots.length; i++) if (missing(i)) return shots[i];
  return null;
}

function renderJob() {
  const st = station();
  $('#stationTabs').innerHTML = state.job.data.stations.map((s, i) =>
    `<button role="tab" data-st="${i}" aria-selected="${i === state.st}">${esc(s.name)}</button>`).join('');
  $$('[data-side]').forEach((b) => b.setAttribute('aria-selected', b.dataset.side === state.side));
  $$('[data-mode]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === state.mode));
  const shots = shotsOf(st, state.side);
  const done = shots.filter((s) => photosOf(st.key, state.side, s.id).length).length;
  $('#progBar').style.width = shots.length ? `${(100 * done) / shots.length}%` : '0';
  $('#progText').textContent = `${st.name} · ${SIDE_TH[state.side]} · ถ่ายแล้ว ${done}/${shots.length} จุด`;
  $('#startBtn').textContent = done === shots.length ? 'ครบทุกจุดแล้ว' : done ? 'ถ่ายต่อจุดที่ยังขาด' : 'เริ่มถ่าย';
  $('#startBtn').disabled = done === shots.length;
  const lock = state.mode === 'seq';
  const extras = photosOf(st.key, state.side, 'X');
  $('#shotList').innerHTML = shots.map((s) => {
    const ph = photosOf(st.key, state.side, s.id);
    return `<li class="${ph.length ? 'done' : ''} ${lock && !ph.length ? 'locked' : ''}" data-shot="${esc(s.id)}">
      <img src="${s.ref}" alt="" loading="lazy">
      <div><div class="t"><span class="id">${esc(s.id)}</span> · ข้อ ${esc(s.items.join('/'))}</div>
      <div class="t">${esc(itemTitle(st, s.items[0]).replace(/^\d+\.\s*/, ''))}</div>
      <div class="st">${ph.length ? `✓ ถ่ายแล้ว ${ph.length} รูป` : 'ยังไม่ถ่าย'}</div>
      ${ph.length ? `<div class="thumbs">${ph.map((p) => `<img data-photo="${esc(p.id)}" src="${URL.createObjectURL(p.blob)}" alt="">`).join('')}</div>` : ''}
      </div></li>`;
  }).join('') + (extras.length ? `<li><div></div><div><div class="t"><b>รูปเพิ่มเติม</b></div>
      <div class="thumbs">${extras.map((p) => `<img data-photo="${esc(p.id)}" src="${URL.createObjectURL(p.blob)}" alt="ข้อ ${esc(p.items.join('/'))}">`).join('')}</div></div></li>` : '');
}

$('#stationTabs').addEventListener('click', (e) => {
  const i = e.target.closest('[data-st]')?.dataset.st; if (i == null) return;
  state.st = +i; renderJob();
});
$$('[data-side]').forEach((b) => b.addEventListener('click', () => { state.side = b.dataset.side; renderJob(); }));
$$('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  state.mode = b.dataset.mode; localStorage.setItem('mode', state.mode); renderJob();
}));
$$('[data-go="home"]').forEach((b) => b.addEventListener('click', renderHome));
$('#startBtn').addEventListener('click', () => { const s = nextMissing(); if (s) openCamera(s); });

$('#shotList').addEventListener('click', async (e) => {
  const photoId = e.target.closest('[data-photo]')?.dataset.photo;
  if (photoId) {
    if (confirm('ลบรูปนี้?')) {
      await db.deletePhoto(photoId);
      state.photos = state.photos.filter((p) => p.id !== photoId);
      renderJob();
    }
    return;
  }
  const id = e.target.closest('[data-shot]')?.dataset.shot; if (!id) return;
  const shot = shotsOf(station(), state.side).find((s) => s.id === id);
  const taken = photosOf(station().key, state.side, id).length;
  if (state.mode === 'seq' && !taken && shot !== nextMissing()) {
    toast('โหมดไล่ตามลำดับ: ถ่ายจุดก่อนหน้าให้ครบก่อน หรือเปลี่ยนเป็น "เลือกถ่ายเฉพาะจุด"');
    return;
  }
  openCamera(shot);
});

$('#extraBtn').addEventListener('click', () => {
  const st = station();
  $('#extraItems').innerHTML = st.items.map((i) =>
    `<label><input type="checkbox" value="${esc(i.no)}"> ${esc(i.title)}</label>`).join('');
  $('#extraDialog').showModal();
});
// act on the buttons, not the dialog's 'close' event: that event is queued behind rendering
// and was seen not to fire at all in a page that is not being painted
$('#extraCancel').addEventListener('click', () => $('#extraDialog').close());
$('#extraOk').addEventListener('click', () => {
  const items = $$('#extraItems input:checked').map((c) => c.value);
  if (!items.length) return toast('เลือกอย่างน้อย 1 ข้อ');
  $('#extraDialog').close();
  openCamera({ id: 'X', items, aspect: EXTRA_ASPECT, ref: null });
});

// ------------------------------------------------------------------ camera
async function startStream() {
  if (state.stream) return true;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
    $('#video').srcObject = state.stream;
    await $('#video').play().catch(() => {});
    return true;
  } catch (err) {
    console.warn('camera', err);
    return false;
  }
}
function stopStream() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.wake?.release?.().catch(() => {}); state.wake = null;
}

async function openCamera(shot) {
  const st = station();
  state.shot = shot; state.pending = null;
  $('#stage').style.setProperty('--ar', shot.aspect || EXTRA_ASPECT);
  $('#ghost').src = shot.ref || ''; $('#ghost').hidden = !shot.ref;
  $('#refBtn').disabled = !shot.ref;
  $('#ghost').style.opacity = $('#ghostOpacity').value / 100;
  const shots = shotsOf(st, state.side);
  const pos = shot.id === 'X' ? 'รูปเพิ่มเติม' : `${shot.id} (${shots.indexOf(shot) + 1}/${shots.length})`;
  $('#camWhere').textContent = `${st.name} · ${SIDE_TH[state.side]} · ${pos}`;
  $('#camTitle').textContent = shot.items.map((n) => itemTitle(st, n)).join(' | ');
  $('#skipBtn').hidden = state.mode === 'seq' || shot.id === 'X';
  $('#camMsg').textContent = 'เปิดกล้องในหน้าเว็บไม่ได้ ใช้ปุ่ม "แอปกล้อง" แทน (รูปจะถูกตัดให้ได้สัดส่วนเดียวกับรูปตัวอย่าง)';
  show('cam');
  setReview(false);
  const ok = await startStream();
  if (!state.pending) setReview(false);  // a photo picked meanwhile stays in review
  $('#shutter').disabled = !ok;
  try { state.wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}

function setReview(on) {
  $('#shootBar').hidden = on; $('#reviewBar').hidden = !on;
  $('#camMsg').hidden = on || !!state.stream;
  $('#still').hidden = !on; $('#video').hidden = on; $('#ghost').hidden = on || !state.shot?.ref;
}

// crop the centre of a source to the shot's aspect ratio (what the framed view shows)
function cropToBlob(src, sw, sh, aspect) {
  let cw = sw, ch = sh;
  if (sw / sh > aspect) cw = Math.round(sh * aspect); else ch = Math.round(sw / aspect);
  const scale = Math.min(1, MAX_PX / Math.max(cw, ch));
  const c = document.createElement('canvas');
  c.width = Math.round(cw * scale); c.height = Math.round(ch * scale);
  c.getContext('2d').drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', JPEG_Q));
}

async function acceptBlob(blob) {
  state.pending = { blob, time: new Date() };
  $('#still').src = URL.createObjectURL(blob);
  setReview(true);
}

$('#shutter').addEventListener('click', async () => {
  const v = $('#video');
  if (!v.videoWidth) return toast('กล้องยังไม่พร้อม');
  acceptBlob(await cropToBlob(v, v.videoWidth, v.videoHeight, state.shot.aspect || EXTRA_ASPECT));
});
$('#nativeFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) await acceptFile(f);
});
// also used by tests: turn any image file/blob into a framed photo
async function acceptFile(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  acceptBlob(await cropToBlob(bmp, bmp.width, bmp.height, state.shot.aspect || EXTRA_ASPECT));
}
window.pmCapture = { acceptFile, state };

async function keep() {
  const st = station(); const s = state.shot; const p = state.pending;
  const rec = {
    id: `${state.job.id}|${st.key}|${state.side}|${s.id}|${p.time.getTime()}`,
    jobId: state.job.id, station: st.key, side: state.side, shotId: s.id, items: s.items,
    blob: p.blob, time: fmtTime(p.time),
  };
  await db.putPhoto(rec);
  state.photos.push(rec); state.pending = null;
}

$('#keepBtn').addEventListener('click', async () => {
  await keep();
  const cur = state.shot;
  if (cur.id !== 'X' && state.mode === 'seq') {
    const shots = shotsOf(station(), state.side);
    const nxt = nextMissing(shots.indexOf(cur));
    if (nxt) return openCamera(nxt);
    toast(`ครบทุกจุดของ ${station().name} ${SIDE_TH[state.side]} แล้ว`, 3000);
  }
  closeCamera();
});
$('#keepMoreBtn').addEventListener('click', async () => { await keep(); toast('บันทึกแล้ว ถ่ายเพิ่มได้'); setReview(false); });
$('#retakeBtn').addEventListener('click', () => { state.pending = null; setReview(false); });
$('#skipBtn').addEventListener('click', () => {
  const shots = shotsOf(station(), state.side);
  const nxt = shots[shots.indexOf(state.shot) + 1];
  nxt ? openCamera(nxt) : closeCamera();
});
$('#camClose').addEventListener('click', closeCamera);
function closeCamera() { stopStream(); renderJob(); show('job'); }
$('#ghostOpacity').addEventListener('input', (e) => {
  $('#ghost').style.opacity = e.target.value / 100; localStorage.setItem('ghost', e.target.value);
});
$('#ghostOpacity').value = localStorage.getItem('ghost') ?? 35;
$('#refBtn').addEventListener('click', () => { $('#refFull').src = state.shot.ref; $('#refDialog').showModal(); });
$('#refClose').addEventListener('click', () => $('#refDialog').close());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopStream();
  else if (!$('#cam').hidden && !state.pending) openCamera(state.shot);
});

// ------------------------------------------------------------------ export
// Layout the PC report script reads: <station folder>/Before|After/<photo>.jpg plus
// mapping.csv (station, photo, side, item, time, ...) - items are known, nothing to guess.
async function buildExport() {
  const data = state.job.data;
  const entries = []; const rows = [['station', 'photo', 'side', 'item', 'time', 'check', 'how', 'score']];
  const count = {};
  for (const st of data.stations) {
    for (const side of ['before', 'after']) {
      const ps = photosOf(st.key, side).sort((a, b) => a.time.localeCompare(b.time));
      for (const p of ps) {
        const k = `${st.key}|${side}|${p.shotId}`; count[k] = (count[k] || 0) + 1;
        const name = `${side === 'before' ? 'Before' : 'After'}/${p.shotId}_${p.items.join('-')}_${count[k]}.jpg`;
        entries.push({ name: `${st.folder}/${name}`, data: p.blob, date: new Date(p.time.replace(' ', 'T')) });
        rows.push([st.folder, name, side, p.items.join('/'), p.time, '', 'phone app', '']);
      }
    }
  }
  if (!entries.length) throw new Error('ยังไม่มีรูป');
  const csv = '﻿' + rows.map((r) => r.map((v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\r\n');
  entries.push({ name: 'mapping.csv', data: csv });
  const sideSummary = (st, side) => {
    const shots = shotsOf(st, side);
    const missing = shots.filter((s) => !photosOf(st.key, side, s.id).length);
    return { shots: shots.length, done: shots.length - missing.length,
             missing: missing.map((s) => `${st.name} ${s.id} (ข้อ ${s.items.join('/')})`) };
  };
  const summary = {
    format: 'pm-capture-result/1', job: data.name, master: data.master, exported: fmtTime(new Date()),
    stations: data.stations.map((st) => ({
      name: st.name, folder: st.folder, before: sideSummary(st, 'before'), after: sideSummary(st, 'after'),
    })),
  };
  entries.push({ name: 'capture.json', data: JSON.stringify(summary, null, 2) });
  const stamp = fmtTime(new Date()).replace(/[-: ]/g, '').slice(0, 12);
  const fname = `${data.name}_${stamp}.zip`.replace(/[\\/:*?"<>|\s]+/g, '_');
  return { blob: await makeZip(entries), fname, summary, count: entries.length - 2 };
}
window.pmCapture.buildExport = buildExport;

$('#exportBtn').addEventListener('click', async () => {
  const btn = $('#exportBtn'); btn.disabled = true; btn.textContent = 'กำลังรวมไฟล์...';
  try {
    const { blob, fname, summary, count } = await buildExport();
    const missing = summary.stations.flatMap((s) => [...s.before.missing, ...s.after.missing]);
    if (missing.length && !confirm(`ยังขาด ${missing.length} จุด เช่น ${missing.slice(0, 3).join(', ')}\nส่งออกเท่าที่มีหรือไม่?`)) return;
    const file = new File([blob], fname, { type: 'application/zip' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: fname }); toast(`ส่งออก ${count} รูปแล้ว`); return; }
      catch (err) { if (err.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fname; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(`บันทึก ${fname} (${count} รูป)`, 3500);
  } catch (err) {
    toast(`ส่งออกไม่ได้: ${err.message}`, 4000);
  } finally {
    btn.disabled = false; btn.textContent = 'ส่งออก zip ให้คอมทำรายงาน';
  }
});

// ------------------------------------------------------------------ start
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
renderHome();
