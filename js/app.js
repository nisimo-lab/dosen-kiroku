'use strict';
/* =====================================================================
   app.js : 画面・操作
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let P = newProject();
const UI = {
  mode: 'record', tool: 'select', tab: 'ent',
  sel: { eid: null, pid: null },
  view: { ox: 0, oy: 0, k: 1 }, minK: 1,
  range: { s: P.start, e: P.end },
  place: false, kindNew: 'teacher', newNo: 1,
  selArea: null, draft: null, cursor: null,
  showCircles: true, showTrails: true, arrows: true, showTimes: false,
  logFilter: '', pendingT: null, mic: false
};
const clock = { t: P.start, running: false, last: 0, speed: 1 };
let G = null;            // 進行中のジェスチャ
let imgDirty = false;
const undoStack = [], redoStack = [];

const svg = $('#svg'), stage = $('#stage'), gAreas = $('#gAreas'), gDyn = $('#gDyn'), gTool = $('#gTool');

/* ---------- 小物 ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function selEnt() { return P.entities.find(e => e.id === UI.sel.eid) || null; }
function entById(id) { return P.entities.find(e => e.id === id) || null; }
function nextNo(kind, from) {
  let n = Math.max(1, from || (kind === 'other' ? 11 : 1));
  while (P.entities.some(e => e.no === n)) n++;
  return n;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function fileBase() {
  const d = new Date();
  const ymd = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  return ((P.name || '動線記録').replace(/[\\/:*?"<>|]/g, '_')) + '_' + ymd;
}

/* ---------- IndexedDB 自動保存 ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      if (this.db) return res(this.db);
      const rq = indexedDB.open('dosen-kiroku', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => { this.db = rq.result; res(this.db); };
      rq.onerror = () => rej(rq.error);
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  async del(k) { const db = await this.open(); return new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; }); }
};
let saveTimer = null, appReady = false;
function scheduleSave() { if (!appReady) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }
async function saveNow() {
  try {
    const { imgData, ...rest } = P;
    await DB.set('project', JSON.parse(JSON.stringify(rest)));
    if (imgDirty) { await DB.set('image', imgData); imgDirty = false; }
  } catch (err) { console.warn('autosave failed', err); }
}

/* ---------- 取り消し ---------- */
const snap = () => JSON.stringify({ entities: P.entities, areas: P.areas });
function mutate(fn) {
  undoStack.push(snap()); if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  fn(); afterChange();
}
function restore(s) {
  const o = JSON.parse(s); P.entities = o.entities; P.areas = o.areas;
  if (UI.sel.eid && !selEnt()) UI.sel = { eid: null, pid: null };
  afterChange();
}
function undo() { if (!undoStack.length) return toast('これ以上戻せません'); redoStack.push(snap()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); }

function afterChange() {
  applyPaperState(); renderAreas(); renderDyn(); renderTool(); renderSide(); renderDockSelect(); syncDock(); updateSelBox(); scheduleSave();
}

/* =====================================================================
   タイマー
   ===================================================================== */
function clockT() {
  if (clock.running) {
    const n = performance.now();
    clock.t += (n - clock.last) / 1000 * clock.speed; clock.last = n;
    if (clock.t >= P.end) { clock.t = P.end; clock.running = false; onRunState(); toast(fmtHMS(P.end) + ' に到達したので停止しました'); }
  }
  return clock.t;
}
function setClock(t) { clock.t = clamp(t, P.start, P.end); clock.last = performance.now(); lastShown = -1; tick(); }
function startClock() { if (clock.running || clock.t >= P.end) return; clock.running = true; clock.last = performance.now(); onRunState(); }
function pauseClock() { clockT(); clock.running = false; onRunState(); tick(true); }
function onRunState() {
  $('#btnStart').disabled = clock.running; $('#btnPause').disabled = !clock.running;
  $('#clockWrap').classList.toggle('running', clock.running);
}
let lastShown = -1;
function tick(force) {
  const t = clockT(), s = Math.floor(t + 1e-6);
  if (s !== lastShown || force) {
    lastShown = s;
    $('#clockDisp').textContent = fmtHMS(t);
    if (document.activeElement !== $('#clockSet') ) $('#clockSet').value = fmtHMS(t);
    if (UI.mode === 'record' && !G) { renderDyn(); syncDock(); }
  }
}
setInterval(tick, 100);

/* =====================================================================
   表示（ズーム・パン）
   ===================================================================== */
function applyView() {
  const W = stage.clientWidth, H = stage.clientHeight, v = UI.view;
  if (!W || !H) return;
  svg.setAttribute('viewBox', `${v.ox} ${v.oy} ${W / v.k} ${H / v.k}`);
}
function fitView() {
  const [pw, ph] = paperSize(P), W = stage.clientWidth, H = stage.clientHeight;
  if (!W || !H) return;
  const k = Math.min((W - 40) / pw, (H - 40) / ph);
  UI.minK = k; UI._userView = false; UI.view = { k, ox: pw / 2 - W / (2 * k), oy: ph / 2 - H / (2 * k) };
  applyView(); renderDyn(); renderTool();
}
function toMM(ev) {
  const r = svg.getBoundingClientRect();
  return { x: UI.view.ox + (ev.clientX - r.left) / UI.view.k, y: UI.view.oy + (ev.clientY - r.top) / UI.view.k };
}
function zoomAt(cx, cy, f) {
  const r = svg.getBoundingClientRect(), px = cx - r.left, py = cy - r.top, v = UI.view;
  const mx = v.ox + px / v.k, my = v.oy + py / v.k;
  const nk = clamp(v.k * f, UI.minK * 0.4, UI.minK * 120);
  v.k = nk; v.ox = mx - px / nk; v.oy = my - py / nk; UI._userView = true;
  applyView(); scheduleDyn();
}
let dynRaf = 0;
function scheduleDyn() { if (dynRaf) return; dynRaf = requestAnimationFrame(() => { dynRaf = 0; renderDyn(); renderTool(); }); }
new ResizeObserver(() => { if (stage.clientWidth && (!UI._fitted || !UI._userView)) { UI._fitted = true; fitView(); } else applyView(); }).observe(stage);
stage.addEventListener('wheel', ev => {
  ev.preventDefault();
  const d = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
  zoomAt(ev.clientX, ev.clientY, Math.exp(-clamp(d, -120, 120) * 0.0018));
}, { passive: false });
$('#zIn').onclick = () => zoomAt(stage.getBoundingClientRect().left + stage.clientWidth / 2, stage.getBoundingClientRect().top + stage.clientHeight / 2, 1.4);
$('#zOut').onclick = () => zoomAt(stage.getBoundingClientRect().left + stage.clientWidth / 2, stage.getBoundingClientRect().top + stage.clientHeight / 2, 1 / 1.4);
$('#zFit').onclick = fitView;

/* =====================================================================
   描画
   ===================================================================== */
function applyPaperState() {
  const [pw, ph] = paperSize(P);
  const pr = $('#paperRect'); pr.setAttribute('width', pw); pr.setAttribute('height', ph);
  const img = $('#planImg'), ir = imageRect(P);
  if (ir && P.imgData) {
    img.setAttribute('x', ir.x); img.setAttribute('y', ir.y); img.setAttribute('width', ir.w); img.setAttribute('height', ir.h);
    if (img._src !== P.imgData) { img.setAttribute('href', P.imgData); img._src = P.imgData; }
    img.style.display = '';
  } else { img.style.display = 'none'; img._src = null; }
  $('#selOrient').value = P.orient;
  $('#selOrient').disabled = !!(P.entities.length || P.areas.length);
  $('#selOrient').title = $('#selOrient').disabled ? 'プロット済みのため向きは変更できません' : 'A3の向き';
  $('#emptyMsg').classList.toggle('hide', !!P.imgData);
  $('#selScale').value = P.scale;
  $('#dInfo').textContent = `丸 φ${diamMM(P)}mm（A3上）／ 紙上1mm＝実寸${P.scale / 1000}m`;
}
function renderAreas() {
  gAreas.innerHTML = areasMarkup(P, { fill: true, labels: P.showAreaLabels, selArea: UI.selArea });
}
function renderDyn() {
  const o = { interactive: true, sel: UI.sel, k: UI.view.k, hitPx: 12 };
  if (UI.mode === 'record') {
    const T = clock.t;
    Object.assign(o, { S: T, E: T, trailS: T - P.trailSec, history: false, trails: P.trailSec > 0, circles: true, arrows: true, times: false });
  } else {
    Object.assign(o, { S: UI.range.s, E: UI.range.e, trailS: UI.range.s, history: true, trails: UI.showTrails, circles: UI.showCircles, arrows: UI.arrows, times: UI.showTimes });
  }
  gDyn.innerHTML = dynMarkup(P, o);
}
function renderTool() {
  const k = UI.view.k; let s = '';
  if (UI.tool === 'areaPoly' && UI.draft) {
    const pts = UI.draft, cur = UI.cursor;
    const poly = pts.concat(cur ? [[cur.x, cur.y]] : []);
    s += `<polyline points="${poly.map(p => p[0] + ',' + p[1]).join(' ')}" fill="rgba(37,99,235,.12)" stroke="#2563eb" stroke-width="${2 / k}" stroke-dasharray="${6 / k} ${4 / k}" pointer-events="none"/>`;
    pts.forEach((p, i) => { s += `<circle cx="${p[0]}" cy="${p[1]}" r="${(i === 0 ? 7 : 4) / k}" fill="${i === 0 ? '#fff' : '#2563eb'}" stroke="#2563eb" stroke-width="${1.5 / k}" pointer-events="none"/>`; });
  }
  if (UI.tool === 'areaRect' && UI.draft) {
    const d = UI.draft;
    s += `<rect x="${Math.min(d.x0, d.x1)}" y="${Math.min(d.y0, d.y1)}" width="${Math.abs(d.x1 - d.x0)}" height="${Math.abs(d.y1 - d.y0)}" fill="rgba(37,99,235,.12)" stroke="#2563eb" stroke-width="${2 / k}" stroke-dasharray="${6 / k} ${4 / k}" pointer-events="none"/>`;
  }
  if (UI.tool === 'areaEdit') {
    P.areas.forEach(a => a.pts.forEach((p, i) => {
      s += `<circle data-aid="${a.id}" data-vi="${i}" cx="${p[0]}" cy="${p[1]}" r="${6 / k}" fill="#fff" stroke="${a.color}" stroke-width="${2 / k}" style="cursor:move"/>`;
    }));
  }
  gTool.innerHTML = s;
}

/* =====================================================================
   ツール・ヒント
   ===================================================================== */
const HINTS = {
  areaPoly: 'エリア：頂点をクリック → ダブルクリック（または最初の点をクリック／Enter）で確定　Escで取消',
  areaRect: 'エリア：ドラッグで四角形を描きます',
  areaEdit: 'エリアの頂点（白丸）をドラッグして形を調整します',
  place: '図面をクリックして配置（連続配置できます）　Escで終了'
};
function updateHint() {
  const h = $('#hint');
  const txt = UI.place ? HINTS.place : HINTS[UI.tool] || '';
  h.style.display = txt ? 'block' : 'none'; h.textContent = txt;
  svg.style.cursor = (UI.place || UI.tool === 'areaPoly' || UI.tool === 'areaRect') ? 'crosshair' : 'default';
  $('#btnPlace').textContent = UI.place ? '配置を終了する' : 'この番号で配置する';
  $('#btnPlace').classList.toggle('on', UI.place);
}
function setTool(t) {
  UI.tool = t; UI.draft = null;
  if (t !== 'select') UI.place = false;
  $$('#toolbar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  renderTool(); updateHint();
}
$$('#toolbar [data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;

/* =====================================================================
   ポインタ操作
   ===================================================================== */
svg.addEventListener('contextmenu', e => e.preventDefault());
svg.addEventListener('pointerdown', ev => {
  if (ev.button === 2) return;
  const p = toMM(ev); UI.cursor = p;
  const tEnt = ev.target.closest && ev.target.closest('g.ent[data-pid]');
  const tVtx = ev.target.closest && ev.target.closest('[data-vi]');
  svg.setPointerCapture(ev.pointerId);
  if (ev.button === 0 && UI.tool === 'areaEdit' && tVtx) {
    G = { type: 'vtx', aid: tVtx.dataset.aid, vi: +tVtx.dataset.vi, snap: snap(), moved: false };
  } else if (ev.button === 0 && UI.tool === 'areaRect') {
    UI.draft = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; G = { type: 'rect' };
  } else if (ev.button === 0 && tEnt && UI.tool === 'select') {
    const e = entById(tEnt.dataset.eid), pt = e && e.pts.find(x => x.id === tEnt.dataset.pid);
    if (e && pt) G = { type: 'drag', el: tEnt, eid: e.id, pid: pt.id, sp: p, p0: { x: pt.x, y: pt.y }, moved: false, cx: ev.clientX, cy: ev.clientY };
  }
  if (!G) G = { type: 'pan', cx: ev.clientX, cy: ev.clientY, ox: UI.view.ox, oy: UI.view.oy, moved: false, button: ev.button };
});
svg.addEventListener('pointermove', ev => {
  const p = toMM(ev); UI.cursor = p;
  if (!G) { if (UI.tool === 'areaPoly' && UI.draft) renderTool(); return; }
  const [pw, ph] = paperSize(P);
  if (G.type === 'pan') {
    const dx = ev.clientX - G.cx, dy = ev.clientY - G.cy;
    if (!G.moved && Math.hypot(dx, dy) > 4) G.moved = true;
    if (G.moved) { UI.view.ox = G.ox - dx / UI.view.k; UI.view.oy = G.oy - dy / UI.view.k; UI._userView = true; applyView(); }
    if (UI.tool === 'areaPoly' && UI.draft) renderTool();
  } else if (G.type === 'drag') {
    if (!G.moved && Math.hypot(ev.clientX - G.cx, ev.clientY - G.cy) > 4) G.moved = true;
    if (G.moved) {
      const nx = clamp(G.p0.x + p.x - G.sp.x, 0, pw), ny = clamp(G.p0.y + p.y - G.sp.y, 0, ph);
      G.nx = nx; G.ny = ny;
      G.el.setAttribute('transform', `translate(${nx - G.p0.x} ${ny - G.p0.y})`);
    }
  } else if (G.type === 'rect') {
    UI.draft.x1 = p.x; UI.draft.y1 = p.y; renderTool();
  } else if (G.type === 'vtx') {
    const a = P.areas.find(x => x.id === G.aid);
    if (a) { a.pts[G.vi] = [f2(clamp(p.x, 0, pw)), f2(clamp(p.y, 0, ph))]; G.moved = true; renderAreas(); renderTool(); }
  }
});
svg.addEventListener('pointerup', ev => {
  const g = G; G = null;
  if (!g) return;
  const p = toMM(ev);
  if (g.type === 'pan') {
    if (!g.moved && g.button === 0) bgClick(p);
  } else if (g.type === 'drag') {
    if (g.moved && g.nx != null) commitDrag(g);
    else selectEnt(g.eid, g.pid);
  } else if (g.type === 'rect') {
    const d = UI.draft; UI.draft = null;
    if (d && Math.abs(d.x1 - d.x0) > 2 && Math.abs(d.y1 - d.y0) > 2) {
      const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)], [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      createArea([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(q => [f2(q[0]), f2(q[1])]));
    } else renderTool();
  } else if (g.type === 'vtx') {
    if (g.moved) { undoStack.push(g.snap); redoStack.length = 0; afterChange(); }
  }
});
svg.addEventListener('pointercancel', () => { G = null; renderDyn(); });
svg.addEventListener('dblclick', () => { if (UI.tool === 'areaPoly' && UI.draft) finishPoly(); });

function bgClick(p) {
  const [pw, ph] = paperSize(P);
  if (UI.tool === 'areaPoly') {
    if (!UI.draft) UI.draft = [];
    const d = UI.draft;
    if (d.length >= 3 && Math.hypot(p.x - d[0][0], p.y - d[0][1]) < 10 / UI.view.k) return finishPoly();
    const last = d[d.length - 1];
    if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 3 / UI.view.k) return;
    d.push([f2(clamp(p.x, 0, pw)), f2(clamp(p.y, 0, ph))]); renderTool();
    return;
  }
  if (UI.place && UI.mode === 'record') return placeEntity(clamp(p.x, 0, pw), clamp(p.y, 0, ph));
  if (UI.tool === 'select') { UI.sel = { eid: null, pid: null }; selectionChanged(); }
}
function finishPoly() {
  const d = UI.draft; UI.draft = null;
  if (d && d.length >= 3) createArea(d); else { renderTool(); if (d && d.length) toast('頂点が3つ以上必要です'); }
}
function createArea(pts) {
  let id;
  mutate(() => {
    id = uid(); UI.selArea = id;
    P.areas.push({ id, name: 'エリア' + (P.areas.length + 1), color: AREA_COLORS[P.areas.length % AREA_COLORS.length], pts });
  });
  switchTab('area');
  const inp = $(`#areaList [data-aid="${id}"] .an`);
  if (inp) { inp.focus(); inp.select(); }
  toast('エリアを作成しました。名称を入力してください');
}
function commitDrag(g) {
  const e = entById(g.eid); if (!e) return;
  const x = f2(g.nx), y = f2(g.ny);
  if (UI.mode === 'record') {
    const T = r1(clockT());
    mutate(() => { const pt = addPoint(e, T, x, y); UI.sel = { eid: e.id, pid: pt.id }; });
    toast(`${entLabel(e)} を移動  ${fmtHMS(T)}`);
  } else {
    mutate(() => { const pt = e.pts.find(q => q.id === g.pid); if (pt) { pt.x = x; pt.y = y; } UI.sel = { eid: e.id, pid: g.pid }; });
  }
}
function addPoint(e, t, x, y) {
  t = r1(t);
  const ex = e.pts.find(p => Math.abs(p.t - t) < 0.05);
  if (ex) { ex.x = x; ex.y = y; return ex; }
  const p = { id: uid(), t, x, y }; e.pts.push(p); e.pts.sort((a, b) => a.t - b.t); return p;
}
function placeEntity(x, y) {
  const T = r1(clockT());
  let no = UI.newNo;
  if (P.entities.some(e => e.no === no)) no = nextNo(UI.kindNew, no);
  mutate(() => {
    const kind = UI.kindNew, nT = P.entities.filter(q => q.kind === 'teacher').length;
    const e = {
      id: uid(), no, kind, name: '', color: kind === 'teacher' ? TEACHER_COLORS[nT % TEACHER_COLORS.length] : '#222222',
      visible: true, trail: kind === 'teacher', smooth: false, pts: [{ id: uid(), t: T, x: f2(x), y: f2(y) }], acts: []
    };
    P.entities.push(e); UI.sel = { eid: e.id, pid: e.pts[0].id };
  });
  UI.newNo = nextNo(UI.kindNew, no + 1); $('#newNo').value = UI.newNo;
}

/* ---------- 選択 ---------- */
function curPid(e) {
  const T = UI.mode === 'record' ? clock.t : UI.range.e;
  const i = lastIdx(e.pts, T);
  return i >= 0 ? e.pts[i].id : null;
}
function selectEnt(eid, pid) {
  UI.sel = { eid: eid || null, pid: null };
  const e = selEnt(); if (e) UI.sel.pid = pid || curPid(e);
  selectionChanged();
}
function selectionChanged() { renderDyn(); updateSelBox(); syncDock(); $$('#entList .erow').forEach(r => r.classList.toggle('sel', r.dataset.eid === UI.sel.eid)); }
function updateSelBox() {
  const box = $('#selBox'), e = selEnt();
  if (!e) { box.hidden = true; return; }
  const p = e.pts.find(x => x.id === UI.sel.pid);
  box.hidden = false;
  box.innerHTML = `<b>${esc(entLabel(e))}</b>` +
    (p ? ` この位置の時刻 <input id="sbT" class="timeIn" value="${fmtHMS(p.t)}"> <button id="sbDel" class="del">この点を削除</button>` : ' <span class="info">（位置の記録なし）</span>') +
    ` <button id="sbX" title="選択解除">×</button>`;
}
$('#selBox').addEventListener('change', ev => {
  if (ev.target.id !== 'sbT') return;
  const e = selEnt(), p = e && e.pts.find(x => x.id === UI.sel.pid), t = parseHMS(ev.target.value);
  if (!p || t == null) { updateSelBox(); return toast('時刻の形式が正しくありません（例 8:30:15）'); }
  mutate(() => { p.t = clamp(t, P.start, P.end); e.pts.sort((a, b) => a.t - b.t); });
});
$('#selBox').addEventListener('click', ev => {
  const e = selEnt();
  if (ev.target.id === 'sbX') { UI.sel = { eid: null, pid: null }; selectionChanged(); }
  if (ev.target.id === 'sbDel' && e) {
    mutate(() => { e.pts = e.pts.filter(x => x.id !== UI.sel.pid); UI.sel.pid = curPid(e); });
    toast('位置の記録を1点削除しました（Ctrl+Zで戻せます）');
  }
});

/* =====================================================================
   サイドパネル
   ===================================================================== */
function switchTab(t) {
  UI.tab = t;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $$('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + t));
  renderSide();
}
$$('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
function renderSide() {
  if (UI.tab === 'ent') renderEntList();
  else if (UI.tab === 'area') renderAreaList();
  else if (UI.tab === 'log') renderLog();
  else if (UI.tab === 'set') renderSettings();
}

/* ----- 対象者 ----- */
$$('#kindSeg button').forEach(b => b.onclick = () => {
  UI.kindNew = b.dataset.kind;
  $$('#kindSeg button').forEach(x => x.classList.toggle('on', x === b));
  UI.newNo = nextNo(UI.kindNew, UI.kindNew === 'other' ? 11 : 1); $('#newNo').value = UI.newNo;
});
$('#newNo').onchange = ev => { UI.newNo = Math.max(1, parseInt(ev.target.value, 10) || 1); ev.target.value = UI.newNo; };
$('#btnPlace').onclick = () => {
  if (UI.mode !== 'record') return toast('配置は「記録」モードで行います');
  UI.place = !UI.place; if (UI.place) setTool('select');
  updateHint();
};
$('#btnOnlyT').onclick = () => { P.entities.forEach(e => e.visible = e.kind === 'teacher'); renderSide(); renderDyn(); scheduleSave(); };
$('#btnAll').onclick = () => { P.entities.forEach(e => e.visible = true); renderSide(); renderDyn(); scheduleSave(); };

function renderEntList() {
  const list = [...P.entities].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'teacher' ? -1 : 1) || a.no - b.no);
  $('#entList').innerHTML = list.length ? list.map(e => {
    const t = e.kind === 'teacher';
    return `<div class="erow${UI.sel.eid === e.id ? ' sel' : ''}" data-eid="${e.id}">
      <input type="checkbox" class="ev" ${e.visible !== false ? 'checked' : ''} title="図面に表示">
      <span class="sym ${t ? 'f' : ''}" style="${t ? `background:${e.color};border-color:${e.color}` : ''}">${e.no}</span>
      <input type="number" class="eno" min="1" max="999" value="${e.no}" title="番号（音声で「○番」と呼ぶ番号）">
      <select class="ek"><option value="teacher"${t ? ' selected' : ''}>先生●</option><option value="other"${t ? '' : ' selected'}>園児等○</option></select>
      <input type="text" class="nm" value="${esc(e.name)}" placeholder="名前メモ">
      <button class="del" title="削除">✕</button>
      <div class="sub">
        <label><input type="checkbox" class="et" ${e.trail ? 'checked' : ''}> 軌跡</label>
        <label><input type="checkbox" class="es" ${e.smooth ? 'checked' : ''}> 曲線にする</label>
        ${t ? `<label>色 <input type="color" class="ec" value="${e.color}"></label>` : ''}
        <span class="cnt">${e.pts.length}点／行為${e.acts.length}</span>
      </div></div>`;
  }).join('') : '<p class="note">まだ誰も配置されていません。上のボタンから先生・園児を配置します。</p>';
}
$('#entList').addEventListener('click', ev => {
  const row = ev.target.closest('.erow'); if (!row) return;
  const e = entById(row.dataset.eid); if (!e) return;
  if (ev.target.classList.contains('del')) {
    if (confirm(`${entLabel(e)} を削除しますか？\n（位置・行為の記録もすべて消えます。Ctrl+Zで戻せます）`)) mutate(() => { P.entities = P.entities.filter(x => x !== e); if (UI.sel.eid === e.id) UI.sel = { eid: null, pid: null }; });
    return;
  }
  if (['INPUT', 'SELECT', 'LABEL'].includes(ev.target.tagName)) return;
  selectEnt(e.id);
});
$('#entList').addEventListener('input', ev => {
  const row = ev.target.closest('.erow'); if (!row) return;
  const e = entById(row.dataset.eid);
  if (ev.target.classList.contains('nm')) { e.name = ev.target.value; renderDockSelect(); scheduleSave(); }
});
$('#entList').addEventListener('change', ev => {
  const row = ev.target.closest('.erow'); if (!row) return;
  const e = entById(row.dataset.eid), c = ev.target.classList;
  if (c.contains('ev')) e.visible = ev.target.checked;
  else if (c.contains('et')) e.trail = ev.target.checked;
  else if (c.contains('es')) e.smooth = ev.target.checked;
  else if (c.contains('ec')) { e.color = ev.target.value; renderEntList(); }
  else if (c.contains('eno')) {
    const n = parseInt(ev.target.value, 10);
    if (!n || P.entities.some(x => x !== e && x.no === n)) { toast('その番号は使用中か不正です'); ev.target.value = e.no; return; }
    e.no = n; renderEntList(); renderDockSelect();
  } else if (c.contains('ek')) {
    e.kind = ev.target.value;
    if (e.kind === 'teacher') { e.trail = true; if (!/^#/.test(e.color) || e.color === '#222222') e.color = TEACHER_COLORS[P.entities.filter(q => q.kind === 'teacher').length % TEACHER_COLORS.length]; }
    else e.trail = false;
    renderEntList();
  }
  renderDyn(); scheduleSave();
});

/* ----- エリア ----- */
function renderAreaList() {
  $('#areaList').innerHTML = P.areas.length ? P.areas.map(a => `
    <div class="arow${UI.selArea === a.id ? ' sel' : ''}" data-aid="${a.id}">
      <span class="sw" style="background:${a.color}"></span>
      <input type="text" class="an" value="${esc(a.name)}" placeholder="エリア名">
      <button class="del" title="削除">✕</button></div>`).join('')
    : '<p class="note">エリアがまだありません。</p>';
  $('#chkAreaLabel').checked = P.showAreaLabels;
}
$('#areaList').addEventListener('input', ev => {
  if (!ev.target.classList.contains('an')) return;
  const a = P.areas.find(x => x.id === ev.target.closest('.arow').dataset.aid);
  if (a) { a.name = ev.target.value; renderAreas(); scheduleSave(); }
});
$('#areaList').addEventListener('click', ev => {
  const row = ev.target.closest('.arow'); if (!row) return;
  const a = P.areas.find(x => x.id === row.dataset.aid); if (!a) return;
  if (ev.target.classList.contains('del')) {
    if (confirm(`エリア「${a.name}」を削除しますか？`)) mutate(() => { P.areas = P.areas.filter(x => x !== a); if (UI.selArea === a.id) UI.selArea = null; });
    return;
  }
  UI.selArea = a.id; $$('#areaList .arow').forEach(r => r.classList.toggle('sel', r === row)); renderAreas();
});
$('#chkAreaLabel').onchange = ev => { P.showAreaLabels = ev.target.checked; renderAreas(); scheduleSave(); };

/* ----- 行為ログ ----- */
function fieldCell(f, val, attrs) {
  if (f.type === 'text') return `<input type="text" class="lf" ${attrs} value="${esc(val || '')}">`;
  return `<select class="lf" ${attrs}><option value="">${f.nearby ? '自動' : '—'}</option><option${val === '有' ? ' selected' : ''}>有</option><option${val === '無' ? ' selected' : ''}>無</option></select>`;
}
function renderLog() {
  const rows = [];
  P.entities.forEach(e => { if (UI.logFilter && UI.logFilter !== e.id) return; e.acts.forEach(a => rows.push({ e, a })); });
  rows.sort((x, y) => x.a.t - y.a.t);
  const opts = ['<option value="">全員</option>'].concat([...P.entities].sort((a, b) => a.no - b.no).map(e => `<option value="${e.id}"${UI.logFilter === e.id ? ' selected' : ''}>${esc(entLabel(e))}</option>`)).join('');
  $('#logBox').innerHTML = `<div class="line" style="margin:0 0 8px"><label>表示対象 <select id="logFilter">${opts}</select></label><span class="info">${rows.length}件</span></div>
  <table class="lg"><thead><tr><th>時刻</th><th>対象</th><th>行為</th>${P.fields.map(f => `<th>${esc(f.label)}</th>`).join('')}<th></th></tr></thead><tbody>
  ${rows.map(({ e, a }) => `<tr data-eid="${e.id}" data-aid="${a.id}">
    <td><input class="lt" value="${fmtHMS(a.t)}"></td><td>${e.kind === 'teacher' ? '●' : '○'}${e.no}</td>
    <td><input class="ltx" value="${esc(a.text)}"></td>
    ${P.fields.map(f => `<td>${fieldCell(f, a.f && a.f[f.id], `data-fid="${f.id}"`)}</td>`).join('')}
    <td style="white-space:nowrap"><button class="seek mini" title="この時刻へ移動">⏱</button><button class="ldel del mini">✕</button></td></tr>`).join('')}
  </tbody></table>${rows.length ? '' : '<p class="note">行為の記録はまだありません。</p>'}`;
}
$('#logBox').addEventListener('change', ev => {
  if (ev.target.id === 'logFilter') { UI.logFilter = ev.target.value; return renderLog(); }
  const tr = ev.target.closest('tr[data-aid]'); if (!tr) return;
  const e = entById(tr.dataset.eid), a = e && e.acts.find(x => x.id === tr.dataset.aid); if (!a) return;
  const c = ev.target.classList;
  mutate(() => {
    if (c.contains('lt')) { const t = parseHMS(ev.target.value); if (t != null) { a.t = clamp(t, P.start, P.end); e.acts.sort((x, y) => x.t - y.t); } else toast('時刻の形式が正しくありません'); }
    else if (c.contains('ltx')) a.text = ev.target.value.trim();
    else if (c.contains('lf')) { a.f = a.f || {}; a.f[ev.target.dataset.fid] = ev.target.value; }
  });
});
$('#logBox').addEventListener('click', ev => {
  const tr = ev.target.closest('tr[data-aid]'); if (!tr) return;
  const e = entById(tr.dataset.eid), a = e && e.acts.find(x => x.id === tr.dataset.aid); if (!a) return;
  if (ev.target.classList.contains('ldel')) mutate(() => { e.acts = e.acts.filter(x => x !== a); });
  if (ev.target.classList.contains('seek')) { setClock(a.t); if (UI.mode === 'view') { UI.range.s = Math.max(P.start, a.t - 60); UI.range.e = Math.min(P.end, a.t + 60); syncRange(); renderDyn(); } selectEnt(e.id); }
});

/* ----- 設定 ----- */
function renderSettings() {
  $('#setBox').innerHTML = `
  <div class="setSec"><h4>丸記号の大きさ（A3用紙上の直径）</h4>
    <div class="dgrid">${SCALES.map(s => `<span>縮尺 1/${s}</span><input type="number" step="0.1" min="0.2" data-sc="${s}" value="${P.diam[s]}"><span class="info">mm${s === P.scale ? '　←現在' : ''}</span>`).join('')}</div>
    <p class="note">標準は「1/50で直径12mm」を基準に、縮尺に反比例して小さくなります（数字の大きさも丸に連動）。変更もできます。<button id="diamReset" class="mini">標準に戻す</button></p></div>
  <div class="setSec"><h4>調査時間</h4>
    開始 <input id="setStart" class="timeIn" value="${fmtHMS(P.start)}"> 終了 <input id="setEnd" class="timeIn" value="${fmtHMS(P.end)}"></div>
  <div class="setSec"><h4>記録モードの軌跡表示</h4>
    直近 <input id="setTrail" type="number" min="0" step="30" class="num" value="${P.trailSec}"> 秒分の軌跡を表示（0で非表示）</div>
  <div class="setSec"><h4>入力項目（行為に付ける項目）</h4>
    <div id="fieldEd">${P.fields.map((f, i) => `<div class="frow" data-fi="${i}">
      <input type="text" class="fl" value="${esc(f.label)}">
      <select class="ft"><option value="yn"${f.type === 'yn' ? ' selected' : ''}>有／無</option><option value="text"${f.type === 'text' ? ' selected' : ''}>自由記述</option></select>
      <label title="先生の近くに園児等の丸があるかで自動入力"><input type="checkbox" class="fn" ${f.nearby ? 'checked' : ''} ${f.type === 'text' ? 'disabled' : ''}>近接で自動</label>
      <button class="del">✕</button></div>`).join('')}</div>
    <button id="fieldAdd" class="mini">＋項目を追加</button>
    <p class="note">ここで増減・名称変更した項目は、記録画面のプルダウンとExcelの列に反映されます。</p></div>
  <div class="setSec"><h4>園児の有無の自動判定</h4>
    先生から実寸 <input id="setNear" type="number" min="0.5" step="0.5" class="num" value="${P.nearbyM}"> m 以内に園児・その他の丸があれば「有」
    <p class="note">プルダウンで「有／無」を手入力した場合は、そちらが優先されます。</p></div>
  <div class="setSec"><h4>行為のクイック入力ボタン（1行に1つ）</h4>
    <textarea id="setPresets" rows="7" style="width:100%">${esc(P.presets.join('\n'))}</textarea></div>`;
}
$('#setBox').addEventListener('change', ev => {
  const t = ev.target;
  if (t.dataset.sc) { const v = parseFloat(t.value); if (v > 0) { P.diam[t.dataset.sc] = v; applyPaperState(); renderDyn(); scheduleSave(); } }
  else if (t.id === 'setStart' || t.id === 'setEnd') {
    const v = parseHMS(t.value), s = t.id === 'setStart' ? v : P.start, e = t.id === 'setEnd' ? v : P.end;
    if (v == null || e <= s) { toast('時刻が正しくありません'); t.value = fmtHMS(t.id === 'setStart' ? P.start : P.end); return; }
    P.start = s; P.end = e; clock.t = clamp(clock.t, s, e); UI.range = { s: Math.max(UI.range.s, s), e: Math.min(UI.range.e, e) };
    if (UI.range.s > UI.range.e) UI.range = { s, e };
    syncRange(); setClock(clock.t); scheduleSave();
  }
  else if (t.id === 'setTrail') { P.trailSec = Math.max(0, parseInt(t.value, 10) || 0); renderDyn(); scheduleSave(); }
  else if (t.id === 'setNear') { P.nearbyM = Math.max(0.5, parseFloat(t.value) || 3); scheduleSave(); syncDock(); }
  else if (t.id === 'setPresets') { P.presets = t.value.split('\n').map(s => s.trim()).filter(Boolean); renderChips(); scheduleSave(); }
  else if (t.closest('.frow')) {
    const f = P.fields[+t.closest('.frow').dataset.fi]; if (!f) return;
    if (t.classList.contains('fl')) f.label = t.value.trim() || '項目';
    if (t.classList.contains('ft')) { f.type = t.value; if (f.type === 'text') f.nearby = false; renderSettings(); }
    if (t.classList.contains('fn')) f.nearby = t.checked;
    renderDockFields(); scheduleSave();
  }
});
$('#setBox').addEventListener('click', ev => {
  const t = ev.target;
  if (t.id === 'diamReset') { P.diam = defaultDiam(); renderSettings(); applyPaperState(); renderDyn(); scheduleSave(); }
  else if (t.id === 'fieldAdd') { P.fields.push({ id: 'f' + uid(), label: '新しい項目', type: 'yn', nearby: false }); renderSettings(); renderDockFields(); scheduleSave(); }
  else if (t.classList.contains('del') && t.closest('.frow')) {
    const i = +t.closest('.frow').dataset.fi;
    if (confirm(`項目「${P.fields[i].label}」を削除しますか？（記録済みの値はExcelに出なくなります）`)) { P.fields.splice(i, 1); renderSettings(); renderDockFields(); scheduleSave(); }
  }
});

/* =====================================================================
   下部ドック（記録モード）
   ===================================================================== */
let dockSig = '';
function renderDockSelect() {
  const list = [...P.entities].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'teacher' ? -1 : 1) || a.no - b.no);
  const sig = list.map(e => e.id + e.no + e.kind + e.name).join('|');
  if (sig !== dockSig) {
    dockSig = sig;
    $('#dEnt').innerHTML = '<option value="">（未選択）</option>' + list.map(e => `<option value="${e.id}">${esc(entLabel(e))}</option>`).join('');
  }
  $('#dEnt').value = UI.sel.eid || '';
}
function renderDockFields() {
  $('#dFields').innerHTML = P.fields.map(f => f.type === 'text'
    ? `<label>${esc(f.label)} <input type="text" class="df" data-fid="${f.id}" size="10"></label>`
    : `<label>${esc(f.label)} <select class="df" data-fid="${f.id}"><option value="">${f.nearby ? '自動' : '—'}</option><option>有</option><option>無</option></select></label>`).join('');
  syncDock();
}
function renderChips() {
  $('#chips').innerHTML = P.presets.map(p => `<button data-p="${esc(p)}">${esc(p)}</button>`).join('');
}
function syncDock() {
  renderDockSelect();
  const e = selEnt(), cur = $('#dCur');
  if (!e) { cur.textContent = '対象の丸をタップするか、右の一覧で選択してください'; $$('#dFields .df').forEach(x => x.disabled = true); return; }
  const T = clock.t, st = describeAt(P, e, T);
  cur.innerHTML = `場所：<b>${esc(st.place || '—')}</b>　行為：<b>${esc(st.action || '—')}</b>${st.rec ? `（${fmtShort(st.rec.t)}〜）` : ''}`;
  P.fields.forEach((f, i) => {
    const el = $(`#dFields .df[data-fid="${f.id}"]`); if (!el) return;
    el.disabled = false;
    if (document.activeElement === el) return;
    el.value = (st.rec && st.rec.f && st.rec.f[f.id]) || '';
    if (f.nearby && el.tagName === 'SELECT') el.options[0].textContent = '自動' + (st.pos ? `（${st.vals[i]}）` : '');
  });
}
$('#dEnt').onchange = ev => selectEnt(ev.target.value || null);
$('#dFields').addEventListener('change', ev => {
  const el = ev.target; if (!el.classList.contains('df')) return;
  const e = selEnt(); if (!e) return;
  const T = r1(clockT()), fid = el.dataset.fid;
  mutate(() => {
    const j = lastIdx(e.acts, T), rec = j >= 0 ? e.acts[j] : null;
    if (rec && Math.abs(rec.t - T) < 0.05) { rec.f = rec.f || {}; rec.f[fid] = el.value; }
    else addAct(e, T, rec ? rec.text : '', Object.assign({}, rec ? rec.f : {}, { [fid]: el.value }));
  });
  toast(`${entLabel(e)}：${P.fields.find(f => f.id === fid).label} → ${el.value || '自動/未設定'}（${fmtHMS(T)}）`);
});
function addAct(e, t, text, f) {
  t = r1(t);
  const ex = e.acts.find(a => Math.abs(a.t - t) < 0.05);
  if (ex) { ex.text = text; ex.f = Object.assign({}, ex.f, f); return ex; }
  const a = { id: uid(), t, text, f: f || {} }; e.acts.push(a); e.acts.sort((x, y) => x.t - y.t); return a;
}
// 行為の記録（キーボード・チップ・音声共通）
function submitAction(raw, t) {
  const T = r1(t != null ? t : clockT());
  const pu = parseUtterance(raw);
  let e;
  if (pu.no != null) {
    e = P.entities.find(x => x.no === pu.no);
    if (!e) { toast(`${pu.no}番は登録されていません`); return false; }
    selectEnt(e.id);
  } else e = selEnt();
  if (!e) { toast('対象を選んでください'); return false; }
  if (!pu.text) return true;
  mutate(() => {
    const j = lastIdx(e.acts, T), rec = j >= 0 ? e.acts[j] : null;
    addAct(e, T, pu.text, Object.assign({}, rec ? rec.f : {}));
  });
  toast(`${entLabel(e)}：${pu.text}（${fmtHMS(T)}）`);
  return true;
}
function submitFromInput() {
  const inp = $('#actInput'), v = inp.value.trim(); if (!v) return;
  if (submitAction(v, UI.pendingT)) { inp.value = ''; UI.pendingT = null; }
  inp.focus();
}
$('#btnAct').onclick = submitFromInput;
$('#actInput').addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submitFromInput(); } });
$('#chips').addEventListener('click', ev => { const b = ev.target.closest('button[data-p]'); if (b) submitAction(b.dataset.p); });

/* ---------- 音声入力 ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, utterT = null, interimOn = false;
function setMicUI() {
  const b = $('#btnMic'); b.classList.toggle('on', UI.mic);
  b.textContent = UI.mic ? '🎤 音声入力 ON（聞いています）' : '🎤 音声入力 OFF';
  if (!UI.mic) $('#liveTr').textContent = '';
}
function startMic() {
  if (!SR) return toast('このブラウザは音声入力に未対応です。Chrome か Edge を使ってください');
  recog = new SR(); recog.lang = 'ja-JP'; recog.continuous = true; recog.interimResults = true;
  recog.onspeechstart = () => { if (!interimOn) utterT = clockT(); };
  recog.onresult = ev => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i], txt = r[0].transcript;
      if (utterT == null) utterT = clockT();
      interimOn = true;
      if (r.isFinal) {
        const t = utterT; utterT = null; interimOn = false; $('#liveTr').textContent = '';
        if (!submitAction(txt, t)) { $('#actInput').value = txt.trim(); UI.pendingT = t; }
      } else $('#liveTr').textContent = '…' + txt;
    }
  };
  recog.onerror = ev => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { UI.mic = false; setMicUI(); toast('マイクの使用が許可されていません（アドレスバーの鍵マークから許可してください）'); }
    else if (ev.error === 'network') { UI.mic = false; setMicUI(); toast('音声認識サーバーに接続できません（ネット接続を確認してください）'); }
  };
  recog.onend = () => { interimOn = false; utterT = null; if (UI.mic) setTimeout(() => { try { recog.start(); } catch (_) { } }, 250); };
  try { recog.start(); UI.mic = true; } catch (err) { UI.mic = false; }
  setMicUI();
}
function stopMic() { UI.mic = false; setMicUI(); try { recog && recog.stop(); } catch (_) { } }
$('#btnMic').onclick = () => UI.mic ? stopMic() : startMic();
if (!SR) { $('#btnMic').title = '音声入力はChrome／Edgeで使えます'; }

/* =====================================================================
   閲覧モード：範囲スライダー
   ===================================================================== */
function syncRange() {
  const rs = $('#rs'), re = $('#re');
  [rs, re].forEach(x => { x.min = P.start; x.max = P.end; });
  UI.range.s = clamp(UI.range.s, P.start, P.end); UI.range.e = clamp(UI.range.e, P.start, P.end);
  rs.value = UI.range.s; re.value = UI.range.e;
  $('#rsT').value = fmtHMS(UI.range.s); $('#reT').value = fmtHMS(UI.range.e);
  const span = P.end - P.start, f = $('#rFill');
  f.style.left = ((UI.range.s - P.start) / span * 100) + '%';
  f.style.right = ((P.end - UI.range.e) / span * 100) + '%';
  let tk = '';
  for (let t = Math.ceil(P.start / 1800) * 1800; t <= P.end; t += 1800) {
    const hh = t % 3600 === 0;
    tk += `<span style="left:${(t - P.start) / span * 100}%"${hh ? '' : ' class="half"'}>${hh ? Math.floor(t / 3600) + ':00' : ''}</span>`;
  }
  $('#rTicks').innerHTML = tk;
}
function onRangeInput(which) {
  const v = +$(which === 's' ? '#rs' : '#re').value;
  if (which === 's') { UI.range.s = v; if (v > UI.range.e) UI.range.e = v; }
  else { UI.range.e = v; if (v < UI.range.s) UI.range.s = v; }
  syncRange(); scheduleDyn();
}
$('#rs').addEventListener('input', () => onRangeInput('s'));
$('#re').addEventListener('input', () => onRangeInput('e'));
$('#rsT').onchange = ev => { const t = parseHMS(ev.target.value); if (t != null) { UI.range.s = clamp(t, P.start, P.end); if (UI.range.s > UI.range.e) UI.range.e = UI.range.s; } syncRange(); renderDyn(); };
$('#reT').onchange = ev => { const t = parseHMS(ev.target.value); if (t != null) { UI.range.e = clamp(t, P.start, P.end); if (UI.range.e < UI.range.s) UI.range.s = UI.range.e; } syncRange(); renderDyn(); };
$('#rAll').onclick = () => { UI.range = { s: P.start, e: P.end }; syncRange(); renderDyn(); };
function shiftRange(dir) {
  const w = Math.max(UI.range.e - UI.range.s, 60);
  let s = UI.range.s + dir * w, e = UI.range.e + dir * w;
  if (s < P.start) { e += P.start - s; s = P.start; }
  if (e > P.end) { s -= e - P.end; e = P.end; }
  UI.range = { s: Math.max(P.start, s), e: Math.min(P.end, e) }; syncRange(); renderDyn();
}
$('#rPrev').onclick = () => shiftRange(-1); $('#rNext').onclick = () => shiftRange(1);
[['#oCircle', 'showCircles'], ['#oTrail', 'showTrails'], ['#oArrow', 'arrows'], ['#oTime', 'showTimes']].forEach(([sel, key]) => {
  $(sel).onchange = ev => { UI[key] = ev.target.checked; renderDyn(); };
});

/* =====================================================================
   モード・ヘッダ
   ===================================================================== */
function setMode(m) {
  UI.mode = m; UI.place = false;
  document.body.classList.toggle('mode-record', m === 'record'); document.body.classList.toggle('mode-view', m === 'view');
  $('#modeRec').classList.toggle('on', m === 'record'); $('#modeView').classList.toggle('on', m === 'view');
  $('#btnPlace').disabled = m !== 'record';
  if (m === 'view') syncRange();
  if (UI.sel.eid) { const e = selEnt(); if (e) UI.sel.pid = curPid(e); }
  updateHint(); renderDyn(); updateSelBox(); syncDock();
  requestAnimationFrame(() => { applyView(); });
}
$('#modeRec').onclick = () => setMode('record'); $('#modeView').onclick = () => setMode('view');

$('#btnStart').onclick = startClock; $('#btnPause').onclick = pauseClock;
$$('[data-adj]').forEach(b => b.onclick = () => setClock(clockT() + +b.dataset.adj));
function applyClockInput() { const t = parseHMS($('#clockSet').value); if (t == null) return toast('時刻の形式が正しくありません（例 8:30:15）'); setClock(t); $('#clockSet').blur(); }
$('#btnClockSet').onclick = applyClockInput;
$('#clockSet').addEventListener('keydown', ev => { if (ev.key === 'Enter') applyClockInput(); });
$('#selSpeed').onchange = ev => { clockT(); clock.speed = +ev.target.value; };

$('#projName').oninput = ev => { P.name = ev.target.value; scheduleSave(); };
$('#selScale').innerHTML = SCALES.map(s => `<option value="${s}">${s}</option>`).join('');
$('#selScale').onchange = ev => { P.scale = +ev.target.value; applyPaperState(); renderDyn(); if (UI.tab === 'set') renderSettings(); scheduleSave(); };
$('#selOrient').onchange = ev => { P.orient = ev.target.value; applyPaperState(); fitView(); scheduleSave(); };

/* ---------- 図面の読み込み ---------- */
$('#btnImg').onclick = () => $('#fileImg').click();
$('#fileImg').onchange = ev => { if (ev.target.files[0]) loadImageFile(ev.target.files[0]); ev.target.value = ''; };
function readAsDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
function loadImg(url) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; }); }
async function loadImageFile(file) {
  try {
    let url = await readAsDataURL(file);
    const img = await loadImg(url);
    let w = img.naturalWidth || 1600, h = img.naturalHeight || 1131;
    if (Math.max(w, h) > 5000) {
      const s = 5000 / Math.max(w, h), c = document.createElement('canvas');
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(img, 0, 0, c.width, c.height);
      url = file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92); w = c.width; h = c.height;
    }
    P.imgData = url; P.img = { w, h }; imgDirty = true;
    if (!P.entities.length && !P.areas.length) P.orient = w >= h ? 'landscape' : 'portrait';
    applyPaperState(); fitView(); scheduleSave();
    toast('図面を読み込みました。縮尺を確認してください');
  } catch (err) { console.error(err); toast('画像を読み込めませんでした（JPG/PNGを使ってください。PDFは画像に変換してください）'); }
}
stage.addEventListener('dragover', ev => { ev.preventDefault(); document.body.classList.add('drop'); });
stage.addEventListener('dragleave', () => document.body.classList.remove('drop'));
stage.addEventListener('drop', ev => {
  ev.preventDefault(); document.body.classList.remove('drop');
  const f = ev.dataTransfer.files[0]; if (!f) return;
  if (f.type.startsWith('image/')) loadImageFile(f); else if (/\.json$/i.test(f.name)) openJsonFile(f);
});

/* ---------- 保存・開く・新規 ---------- */
$('#btnSave').onclick = () => { download(new Blob([JSON.stringify(P)], { type: 'application/json' }), fileBase() + '.json'); toast('保存しました（ダウンロードフォルダ）'); };
$('#btnOpen').onclick = () => $('#fileJson').click();
$('#fileJson').onchange = ev => { if (ev.target.files[0]) openJsonFile(ev.target.files[0]); ev.target.value = ''; };
async function openJsonFile(file) {
  try { const obj = JSON.parse(await file.text()); if (!confirm('いま開いている調査データを、選んだファイルの内容に置き換えます。よろしいですか？')) return; imgDirty = true; loadProject(obj); toast('開きました'); }
  catch (err) { console.error(err); toast('ファイルを読み込めませんでした'); }
}
$('#btnNew').onclick = async () => {
  if (!confirm('新しい調査を始めます。現在のデータは消えます（先に［保存］しておくと安心です）。続けますか？')) return;
  stopMic(); await DB.del('project'); await DB.del('image'); imgDirty = false; loadProject(newProject());
};
function loadProject(obj) {
  pauseClock();
  P = normalizeProject(obj);
  UI.sel = { eid: null, pid: null }; UI.selArea = null; UI.draft = null; UI.place = false; UI.tool = 'select';
  UI.range = { s: P.start, e: P.end }; UI.logFilter = '';
  undoStack.length = 0; redoStack.length = 0;
  clock.t = P.start; lastShown = -1;
  UI.newNo = nextNo('teacher', 1); $('#newNo').value = UI.newNo; UI.kindNew = 'teacher';
  $$('#kindSeg button').forEach(b => b.classList.toggle('on', b.dataset.kind === 'teacher'));
  $('#projName').value = P.name || '';
  dockSig = '';
  applyPaperState(); renderAreas(); renderTool(); renderDockFields(); renderChips(); syncRange(); renderSide(); updateSelBox(); updateHint();
  setClock(P.start); fitView(); scheduleSave();
}

/* ---------- 出力 ---------- */
$('#btnXlsx').onclick = () => {
  if (!P.entities.some(e => e.kind === 'teacher')) return toast('先生が配置されていないため出力できません');
  if (typeof XLSX === 'undefined') return alert('Excel出力ライブラリ(lib/xlsx.full.min.js)が読み込めていません。');
  try { XLSX.writeFile(buildWorkbook(P), fileBase() + '.xlsx'); toast('Excelを出力しました（ダウンロードフォルダ）'); }
  catch (err) { console.error(err); alert('Excel出力でエラーが発生しました：' + err.message); }
};
$('#btnFig').onclick = () => $('#dlgFig').showModal();
$('#dlgFig').addEventListener('close', async () => {
  const dlg = $('#dlgFig'); if (dlg.returnValue !== 'ok') return;
  const fmt = $('input[name=fmt]:checked').value, rng = $('input[name=rng]:checked').value;
  const S = rng === 'all' ? P.start : UI.range.s, E = rng === 'all' ? P.end : UI.range.e;
  const o = { S, E, trails: $('#fTrail').checked, circles: $('#fCircle').checked, arrows: $('#fArrow').checked, times: $('#fTime').checked, areas: $('#fArea').checked, plan: $('#fPlan').checked };
  const base = fileBase() + '_動線図_' + fmtHMS(S).replace(/:/g, '') + '-' + fmtHMS(E).replace(/:/g, '');
  try {
    if (fmt === 'svg') download(new Blob([buildExportSVG(P, o)], { type: 'image/svg+xml' }), base + '.svg');
    else if (fmt === 'dxf') download(new Blob([buildDXF(P, o)], { type: 'application/dxf' }), base + '.dxf');
    else {
      const [pw, ph] = paperSize(P), W = Math.round(pw / 25.4 * 200), H = Math.round(ph / 25.4 * 200);
      const url = URL.createObjectURL(new Blob([buildExportSVG(P, Object.assign({ px: [W, H] }, o))], { type: 'image/svg+xml' }));
      const im = await loadImg(url);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const cx = c.getContext('2d'); cx.fillStyle = o.plan ? '#fff' : 'rgba(255,255,255,0)'; if (o.plan) cx.fillRect(0, 0, W, H);
      cx.drawImage(im, 0, 0, W, H); URL.revokeObjectURL(url);
      c.toBlob(b => download(b, base + '.png'), 'image/png');
    }
    toast('動線図を出力しました（ダウンロードフォルダ）');
  } catch (err) { console.error(err); alert('出力に失敗しました：' + err.message); }
});
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();

/* =====================================================================
   キーボード
   ===================================================================== */
document.addEventListener('keydown', ev => {
  const tg = ev.target, typing = tg && (tg.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(tg.type) || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT');
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z' && !typing) { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (ev.key === 'Escape') {
    if (UI.draft) { UI.draft = null; renderTool(); } else if (UI.place) { UI.place = false; updateHint(); } else if (UI.tool !== 'select') setTool('select');
    return;
  }
  if (ev.key === 'Enter' && UI.tool === 'areaPoly' && UI.draft && !typing) { finishPoly(); return; }
  if (ev.key === ' ' && !typing && !$('dialog[open]')) {
    ev.preventDefault();
    if (tg && tg.tagName === 'BUTTON') tg.blur();
    clock.running ? pauseClock() : startClock();
  }
});

/* =====================================================================
   起動
   ===================================================================== */
(async function init() {
  loadProject(newProject());
  try {
    const [pj, im] = await Promise.all([DB.get('project'), DB.get('image')]);
    if (pj && (pj.entities && pj.entities.length || pj.areas && pj.areas.length || im || pj.name)) {
      if (im) pj.imgData = im;
      loadProject(pj); imgDirty = false;
      toast('前回の続きを復元しました');
    }
  } catch (err) { console.warn(err); }
  appReady = true;
  setMode('record');
  onRunState();
})();
