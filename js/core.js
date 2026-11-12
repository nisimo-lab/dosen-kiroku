'use strict';
/* =====================================================================
   core.js : データモデル・時刻・幾何・状態計算・Excel/SVG/DXF 出力
   座標はすべて「A3用紙上の mm」（左上原点・y下向き）で保持する。
   ===================================================================== */

/* ---------- 定数 ---------- */
const SCALES = [50, 100, 200, 300, 400, 500];
const PAPER = [420, 297]; // A3 横 (mm)
const BASE_DIAM_AT_50 = 12; // 1/50 のとき直径12mm
const TEACHER_COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#8c564b', '#e377c2', '#17becf'];
const AREA_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

function defaultDiam() {
  const o = {};
  SCALES.forEach(s => { o[s] = Math.round(BASE_DIAM_AT_50 * 50 / s * 100) / 100; });
  return o;
}
function defaultFields() {
  // 入力項目（設定画面で追加・変更できる）。type: 'yn'=有/無, 'text'=自由記述。nearby=近接判定で自動入力
  return [
    { id: 'children', label: '園児の有無', type: 'yn', nearby: true },
    { id: 'motion', label: '動作の有無', type: 'yn', nearby: false }
  ];
}
function defaultPresets() {
  return ['ままごと遊び', 'トイレの介助', '食事の介助', '絵本の読み聞かせ', '見守り', '片付け', '記録・事務', '保護者対応'];
}

let _uidSeq = 0;
function uid() { return Date.now().toString(36) + (++_uidSeq).toString(36) + Math.random().toString(36).slice(2, 5); }

function newProject() {
  return {
    version: 1,
    name: '',
    imgData: null,        // 図面画像 (dataURL)
    img: null,            // {w,h} px
    orient: 'landscape',  // A3 横 / 縦
    scale: 100,
    diam: defaultDiam(),  // 縮尺ごとの丸の直径 (A3上 mm)
    start: 8 * 3600,
    end: 16 * 3600,
    nearbyM: 3,           // 「園児の有無」自動判定の半径 (実寸m)
    trailSec: 180,        // 記録モードで表示する軌跡の長さ(秒)
    showAreaLabels: true,
    fields: defaultFields(),
    presets: defaultPresets(),
    entities: [],         // {id,no,kind,name,color,visible,trail,smooth,pts:[{id,t,x,y}],acts:[{id,t,text,f:{}}]}
    areas: []             // {id,name,color,pts:[[x,y],...]}
  };
}

function normalizeProject(obj) {
  const base = newProject();
  const p = Object.assign(base, obj || {});
  p.diam = Object.assign(defaultDiam(), (obj && obj.diam) || {});
  p.fields = Array.isArray(p.fields) && p.fields.length ? p.fields : defaultFields();
  p.presets = Array.isArray(p.presets) ? p.presets : defaultPresets();
  p.entities = (p.entities || []).map(e => Object.assign({ visible: true, trail: e.kind === 'teacher', smooth: false, name: '', color: '#222', pts: [], acts: [] }, e));
  p.entities.forEach(e => { e.pts.sort((a, b) => a.t - b.t); e.acts.sort((a, b) => a.t - b.t); });
  p.areas = p.areas || [];
  return p;
}

/* ---------- 用紙・図面 ---------- */
function paperSize(P) { return P.orient === 'portrait' ? [PAPER[1], PAPER[0]] : [PAPER[0], PAPER[1]]; }
function diamMM(P) { const v = +P.diam[P.scale]; return v > 0 ? v : BASE_DIAM_AT_50 * 50 / P.scale; }
function imageRect(P) {
  if (!P.img) return null;
  const [pw, ph] = paperSize(P);
  const s = Math.min(pw / P.img.w, ph / P.img.h);
  const w = P.img.w * s, h = P.img.h * s;
  return { x: (pw - w) / 2, y: (ph - h) / 2, w, h };
}

/* ---------- 時刻 ---------- */
const pad2 = n => String(n).padStart(2, '0');
function fmtHMS(t) {
  t = Math.max(0, Math.floor(t + 1e-6));
  return pad2(Math.floor(t / 3600)) + ':' + pad2(Math.floor(t % 3600 / 60)) + ':' + pad2(t % 60);
}
function fmtShort(t) { // 8:12:34
  t = Math.max(0, Math.floor(t + 1e-6));
  return Math.floor(t / 3600) + ':' + pad2(Math.floor(t % 3600 / 60)) + ':' + pad2(t % 60);
}
function parseHMS(str) {
  if (str == null) return null;
  str = String(str).normalize('NFKC').trim();
  let m = str.match(/^(\d{1,2})\s*[:：時.]\s*(\d{1,2})(?:\s*[:：分.]\s*(\d{1,2}))?\s*秒?$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + (+m[3] || 0);
  m = str.match(/^(\d{1,2})(\d{2})(\d{2})?$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + (+m[3] || 0);
  return null;
}

/* ---------- 幾何 ---------- */
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return a / 2;
}
function polyCentroid(poly) {
  const A = polyArea(poly);
  if (Math.abs(A) < 1e-6) {
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  }
  let cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    cx += (poly[j][0] + poly[i][0]) * f; cy += (poly[j][1] + poly[i][1]) * f;
  }
  return [cx / (6 * A), cy / (6 * A)];
}
const f2 = n => Math.round(n * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- 位置・状態の取得 ---------- */
// arr(t昇順) のうち t<=T の最後の添字（なければ -1）
function lastIdx(arr, T) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= T) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
// 時刻範囲 [S,E] に表示する点：S時点で最後にプロットされた点(繰り越し) + (S,E] の点
function collect(e, S, E) {
  const out = [];
  const i = lastIdx(e.pts, S);
  if (i >= 0) out.push(e.pts[i]);
  for (let k = i + 1; k < e.pts.length; k++) { const p = e.pts[k]; if (p.t > E) break; out.push(p); }
  return out;
}
function placeAt(P, x, y) {
  let best = null, ba = Infinity;
  for (const a of P.areas) {
    if (pointInPoly(x, y, a.pts)) { const ar = Math.abs(polyArea(a.pts)); if (ar < ba) { ba = ar; best = a; } }
  }
  return best ? (best.name || '(名称未設定)') : 'エリア外';
}
function nearbyCount(P, e, pos, T) {
  const R = P.nearbyM * 1000 / P.scale; // 実寸m → 用紙上mm
  let n = 0;
  for (const o of P.entities) {
    if (o === e || o.kind === 'teacher') continue;
    const k = lastIdx(o.pts, T);
    if (k < 0) continue;
    if (Math.hypot(o.pts[k].x - pos.x, o.pts[k].y - pos.y) <= R) n++;
  }
  return n;
}
function describeAt(P, e, T) {
  const i = lastIdx(e.pts, T), j = lastIdx(e.acts, T);
  const pos = i >= 0 ? e.pts[i] : null, rec = j >= 0 ? e.acts[j] : null;
  const exists = !!(pos || rec);
  const place = pos ? placeAt(P, pos.x, pos.y) : '';
  const action = rec ? rec.text : '';
  const vals = P.fields.map(f => {
    let v = rec && rec.f && rec.f[f.id] != null ? rec.f[f.id] : '';
    if (f.nearby && v === '' && pos) v = nearbyCount(P, e, pos, T) > 0 ? '有' : '無';
    return v;
  });
  return { exists, pos, rec, place, action, vals, key: [place, action, ...vals].join('\u0001') };
}
// [a,b) の間に到着した移動の距離合計（用紙上mm）
function moveBetween(e, a, b) {
  let d = 0;
  for (let i = 1; i < e.pts.length; i++) {
    const t = e.pts[i].t;
    if (t >= b) break;
    if (t >= a) d += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].y - e.pts[i - 1].y);
  }
  return d;
}
const mmToM = (P, mm) => Math.round(mm * P.scale / 1000 * 100) / 100;

/* ---------- 変化時の行 / 1分ごとの行 ---------- */
function candTimes(P, e) {
  const S = P.start, E = P.end, set = new Set();
  const add = t => { if (t > S && t < E) set.add(t); };
  e.pts.forEach(p => add(p.t)); e.acts.forEach(a => add(a.t));
  if (P.fields.some(f => f.nearby)) P.entities.forEach(o => { if (o.kind !== 'teacher') o.pts.forEach(p => add(p.t)); });
  return [S, ...[...set].sort((a, b) => a - b)];
}
function changeRows(P, e) {
  const rows = []; let prev = null;
  for (const t of candTimes(P, e)) {
    const st = describeAt(P, e, t);
    if (!st.exists) continue;
    if (st.key !== prev) { rows.push({ t, st }); prev = st.key; }
  }
  rows.forEach((r, i) => { r.end = i + 1 < rows.length ? rows[i + 1].t : P.end; r.move = moveBetween(e, r.t, r.end); });
  return rows;
}
function minuteRows(P, e) {
  const C = candTimes(P, e), out = [];
  for (let m = P.start; m < P.end; m += 60) {
    const b = Math.min(m + 60, P.end);
    const times = [m, ...C.filter(c => c > m && c < b), b];
    const acc = new Map();
    for (let j = 0; j < times.length - 1; j++) {
      const st = describeAt(P, e, times[j]);
      const rec = acc.get(st.key) || { st, dur: 0 };
      rec.dur += times[j + 1] - times[j];
      acc.set(st.key, rec);
    }
    let best = null;
    for (const v of acc.values()) if (!best || v.dur > best.dur + 1e-9) best = v;
    out.push({ t: m, st: best.st, move: moveBetween(e, m, b) });
  }
  return out;
}

/* ---------- 軌跡の幾何 ---------- */
function segs(pts, smooth) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    if (!smooth) { out.push({ p1, p2 }); continue; }
    const p0 = pts[i - 1] || p1, p3 = pts[i + 2] || p2;
    out.push({
      p1, p2,
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    });
  }
  return out;
}
function pathD(pts, smooth) {
  if (pts.length < 2) return '';
  let d = `M${f2(pts[0].x)} ${f2(pts[0].y)}`;
  for (const s of segs(pts, smooth)) {
    d += s.c1 ? ` C${f2(s.c1.x)} ${f2(s.c1.y)} ${f2(s.c2.x)} ${f2(s.c2.y)} ${f2(s.p2.x)} ${f2(s.p2.y)}` : ` L${f2(s.p2.x)} ${f2(s.p2.y)}`;
  }
  return d;
}
function segMid(s) {
  if (!s.c1) return { x: (s.p1.x + s.p2.x) / 2, y: (s.p1.y + s.p2.y) / 2, dx: s.p2.x - s.p1.x, dy: s.p2.y - s.p1.y };
  const { p1, p2, c1, c2 } = s;
  return {
    x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
    dx: 0.75 * (c1.x - p1.x) + 1.5 * (c2.x - c1.x) + 0.75 * (p2.x - c2.x),
    dy: 0.75 * (c1.y - p1.y) + 1.5 * (c2.y - c1.y) + 0.75 * (p2.y - c2.y)
  };
}
function sampleSegs(pts, smooth, n = 12) { // DXF用：曲線を折れ線に展開
  if (pts.length < 2) return pts.map(p => [p.x, p.y]);
  const out = [[pts[0].x, pts[0].y]];
  for (const s of segs(pts, smooth)) {
    if (!s.c1) { out.push([s.p2.x, s.p2.y]); continue; }
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push([
        u * u * u * s.p1.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.p2.x,
        u * u * u * s.p1.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.p2.y
      ]);
    }
  }
  return out;
}

/* ---------- SVG マークアップ（画面表示・書き出し共通） ---------- */
function areasMarkup(P, o) {
  let s = '';
  P.areas.forEach(a => {
    const sel = o.selArea === a.id;
    const pts = a.pts.map(p => f2(p[0]) + ',' + f2(p[1])).join(' ');
    s += `<polygon points="${pts}" fill="${o.fill ? a.color : 'none'}" fill-opacity="${o.fill ? 0.14 : 0}" stroke="${a.color}" stroke-width="${sel ? 0.9 : 0.4}" stroke-dasharray="${sel ? '' : '2 1'}" stroke-linejoin="round"/>`;
    if (o.labels && a.name) {
      const c = polyCentroid(a.pts);
      s += `<text transform="translate(${f2(c[0])} ${f2(c[1])}) scale(.1)" font-size="32" text-anchor="middle" dominant-baseline="central" fill="${a.color}" stroke="#fff" stroke-width="8" paint-order="stroke" stroke-linejoin="round" font-family="sans-serif" font-weight="600">${esc(a.name)}</text>`;
    }
  });
  return s;
}

function circleMarkup(P, e, p, cur, o, g) {
  const teacher = e.kind === 'teacher';
  const fill = teacher ? e.color : '#fff', stroke = teacher ? e.color : '#222';
  const str = String(e.no);
  const fs = g.d * (str.length <= 1 ? 0.62 : str.length === 2 ? 0.52 : 0.4);
  let sel = false;
  if (o.interactive && o.sel && o.sel.eid === e.id) sel = o.history ? (o.sel.pid ? o.sel.pid === p.id : cur) : cur;
  const x = f2(p.x), y = f2(p.y);
  let s = `<g class="ent ${cur ? 'cur' : 'hist'}"${o.interactive ? ` data-eid="${e.id}" data-pid="${p.id}"` : ''}${cur ? '' : ' opacity="0.5"'}>`;
  if (sel) s += `<circle cx="${x}" cy="${y}" r="${f2(g.r * 1.45 + g.sw)}" fill="none" stroke="#ff9800" stroke-width="${f2(Math.max(g.sw * 1.3, 0.25))}" stroke-dasharray="${f2(g.r * 0.5)} ${f2(g.r * 0.3)}"/>`;
  if (g.hitR) s += `<circle cx="${x}" cy="${y}" r="${f2(g.hitR)}" fill="transparent"/>`;
  s += `<circle cx="${x}" cy="${y}" r="${f2(g.r)}" fill="${fill}" stroke="${stroke}" stroke-width="${f2(g.sw)}"/>`;
  s += `<text transform="translate(${x} ${y}) scale(.1)" font-size="${f2(fs * 10)}" text-anchor="middle" dominant-baseline="central" fill="${teacher ? '#fff' : '#111'}" font-family="sans-serif" font-weight="600" pointer-events="none">${esc(str)}</text>`;
  if (o.times) {
    const tfs = Math.max(g.d * 0.34, 1.2);
    s += `<text transform="translate(${x} ${f2(p.y - g.r - tfs * 0.6)}) scale(.1)" font-size="${f2(tfs * 10)}" text-anchor="middle" dominant-baseline="central" fill="#333" stroke="#fff" stroke-width="${f2(tfs * 2)}" paint-order="stroke" font-family="sans-serif" pointer-events="none">${fmtShort(p.t)}</text>`;
  }
  return s + '</g>';
}

/* o: {S,E,trailS,history,trails,circles,arrows,times,interactive,sel,hitPx,k,export} */
function dynMarkup(P, o) {
  const d = diamMM(P), r = d / 2;
  const g = { d, r, sw: Math.max(d * 0.08, 0.12), hitR: o.interactive ? Math.max(r, (o.hitPx || 12) / (o.k || 1)) : 0 };
  const lw = Math.max(d * 0.07, 0.15), asz = Math.max(d * 0.3, 0.5);
  const trailG = [], symH = [], symC = [];
  for (const e of P.entities) {
    if (e.visible === false) continue;
    const teacher = e.kind === 'teacher';
    if (o.trails && e.trail) {
      const tp = collect(e, o.trailS, o.E);
      if (tp.length >= 2) {
        const col = teacher ? e.color : '#555';
        let s = `<g class="trail" id="trail_${esc(teacher ? '先生' : '園児他')}${e.no}"><path d="${pathD(tp, e.smooth)}" fill="none" stroke="${col}" stroke-width="${f2(lw)}" stroke-linejoin="round" stroke-linecap="round" opacity=".85"${teacher ? '' : ` stroke-dasharray="${f2(d * 0.25)} ${f2(d * 0.2)}"`}/>`;
        if (o.arrows) {
          for (const sg of segs(tp, e.smooth)) {
            if (Math.hypot(sg.p2.x - sg.p1.x, sg.p2.y - sg.p1.y) < asz * 3.2) continue;
            const m = segMid(sg);
            if (Math.hypot(m.dx, m.dy) < 1e-6) continue;
            const ang = Math.atan2(m.dy, m.dx) * 180 / Math.PI;
            s += `<path d="M${f2(asz * 0.6)} 0L${f2(-asz * 0.5)} ${f2(asz * 0.45)}L${f2(-asz * 0.5)} ${f2(-asz * 0.45)}Z" transform="translate(${f2(m.x)} ${f2(m.y)}) rotate(${f2(ang)})" fill="${col}"/>`;
          }
        }
        trailG.push(s + '</g>');
      }
    }
    if (o.circles) {
      let list;
      if (o.history) list = collect(e, o.S, o.E);
      else { const i = lastIdx(e.pts, o.E); list = i >= 0 ? [e.pts[i]] : []; }
      list.forEach((p, i) => {
        const cur = i === list.length - 1;
        (cur ? symC : symH).push(circleMarkup(P, e, p, cur, o, g));
      });
    }
  }
  return `<g id="trails">${trailG.join('')}</g><g id="symbols">${symH.join('')}${symC.join('')}</g>`;
}

function buildExportSVG(P, o) {
  const [pw, ph] = paperSize(P);
  const wAttr = o.px ? `${o.px[0]}` : `${pw}mm`, hAttr = o.px ? `${o.px[1]}` : `${ph}mm`;
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${wAttr}" height="${hAttr}" viewBox="0 0 ${pw} ${ph}">\n`;
  if (o.plan) {
    s += `<rect width="${pw}" height="${ph}" fill="#fff"/>`;
    const ir = imageRect(P);
    if (ir && P.imgData) s += `<image id="plan" xlink:href="${P.imgData}" x="${f2(ir.x)}" y="${f2(ir.y)}" width="${f2(ir.w)}" height="${f2(ir.h)}" preserveAspectRatio="none"/>`;
  }
  if (o.areas) s += `<g id="areas">${areasMarkup(P, { fill: o.plan, labels: true })}</g>`;
  s += dynMarkup(P, { S: o.S, E: o.E, trailS: o.S, history: true, trails: o.trails, circles: o.circles, arrows: o.arrows, times: o.times });
  return s + '\n</svg>';
}

/* ---------- DXF（線データ：ASCII R12 互換） ---------- */
function buildDXF(P, o) {
  const [pw, ph] = paperSize(P);
  const Y = y => f2(ph - y);
  const layers = new Map(); // name -> color index
  const ents = [];
  const pair = (c, v) => `${c}\n${v}\n`;
  const aci = [1, 5, 3, 6, 30, 8, 220, 4];
  let ti = 0, oi = 0;
  const addLayer = (n, c) => { if (!layers.has(n)) layers.set(n, c); };
  const polyline = (layer, pts, closed) => {
    let s = pair(0, 'POLYLINE') + pair(8, layer) + pair(66, 1) + pair(70, closed ? 1 : 0);
    pts.forEach(p => { s += pair(0, 'VERTEX') + pair(8, layer) + pair(10, f2(p[0])) + pair(20, Y(p[1])) + pair(30, 0); });
    return s + pair(0, 'SEQEND') + pair(8, layer);
  };
  if (o.areas) {
    addLayer('AREA', 8);
    P.areas.forEach(a => ents.push(polyline('AREA', a.pts, true)));
  }
  const d = diamMM(P);
  for (const e of P.entities) {
    if (e.visible === false) continue;
    const teacher = e.kind === 'teacher';
    const col = teacher ? aci[(ti++) % aci.length] : 8;
    if (!teacher) oi++;
    const base = (teacher ? 'TEACHER_' : 'OTHER_') + e.no;
    if (o.trails && e.trail) {
      const tp = collect(e, o.S, o.E);
      if (tp.length >= 2) { addLayer(base + '_LINE', col); ents.push(polyline(base + '_LINE', sampleSegs(tp, e.smooth), false)); }
    }
    if (o.circles) {
      const list = collect(e, o.S, o.E);
      if (list.length) {
        addLayer(base + '_MARK', col);
        list.forEach(p => {
          ents.push(pair(0, 'CIRCLE') + pair(8, base + '_MARK') + pair(10, f2(p.x)) + pair(20, Y(p.y)) + pair(30, 0) + pair(40, f2(d / 2)));
          ents.push(pair(0, 'TEXT') + pair(8, base + '_MARK') + pair(10, f2(p.x)) + pair(20, Y(p.y)) + pair(30, 0) + pair(40, f2(d * 0.5)) + pair(1, e.no) + pair(72, 1) + pair(73, 2) + pair(11, f2(p.x)) + pair(21, Y(p.y)) + pair(31, 0));
        });
      }
    }
  }
  let s = pair(0, 'SECTION') + pair(2, 'HEADER') + pair(9, '$ACADVER') + pair(1, 'AC1009') + pair(9, '$INSUNITS') + pair(70, 4) + pair(0, 'ENDSEC');
  s += pair(0, 'SECTION') + pair(2, 'TABLES') + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, layers.size);
  layers.forEach((c, n) => { s += pair(0, 'LAYER') + pair(2, n) + pair(70, 0) + pair(62, c) + pair(6, 'CONTINUOUS'); });
  s += pair(0, 'ENDTAB') + pair(0, 'ENDSEC');
  s += pair(0, 'SECTION') + pair(2, 'ENTITIES') + ents.join('') + pair(0, 'ENDSEC') + pair(0, 'EOF');
  return s;
}

/* ---------- Excel ---------- */
function teacherLabel(e) { return '先生' + e.no + (e.name ? '（' + e.name + '）' : ''); }
function entLabel(e) { return (e.kind === 'teacher' ? '先生' : '園児等') + e.no + (e.name ? '（' + e.name + '）' : ''); }
function safeSheet(name, used) {
  let n = name.replace(/[:\\/?*\[\]]/g, '_').slice(0, 31), i = 2;
  while (used.has(n)) n = name.slice(0, 28) + '_' + i++;
  used.add(n);
  return n;
}
function buildWorkbook(P) {
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const teachers = P.entities.filter(e => e.kind === 'teacher').sort((a, b) => a.no - b.no);
  const fl = P.fields.map(f => f.label);
  const setW = (ws, w) => { ws['!cols'] = w.map(x => ({ wch: x })); };

  const info = [
    ['項目', '内容'],
    ['調査名', P.name || ''],
    ['図面の縮尺', '1/' + P.scale + '（A3）'],
    ['丸記号の直径（A3上）', diamMM(P) + ' mm'],
    ['調査時間', fmtHMS(P.start) + ' 〜 ' + fmtHMS(P.end)],
    ['移動量の算出', '図面上の軌跡（直線）の長さの合計 × 縮尺。単位はm。到着時刻が属する区間に計上'],
    ['園児の有無の自動判定', '先生から実寸' + P.nearbyM + 'm以内に園児・その他の丸があれば「有」（手入力があればそちらを優先）'],
    ['出力日時', new Date().toLocaleString('ja-JP')]
  ];
  const wsI = XLSX.utils.aoa_to_sheet(info); setW(wsI, [26, 90]);
  XLSX.utils.book_append_sheet(wb, wsI, safeSheet('調査概要', used));

  teachers.forEach(e => {
    const rowsC = changeRows(P, e);
    const aoaC = [['開始時刻', '終了時刻', '継続(秒)', '場所名', '行為名', ...fl, '移動量(m)']];
    rowsC.forEach(r => aoaC.push([fmtHMS(r.t), fmtHMS(r.end), Math.round(r.end - r.t), r.st.place, r.st.action, ...r.st.vals, mmToM(P, r.move)]));
    const ws1 = XLSX.utils.aoa_to_sheet(aoaC); setW(ws1, [10, 10, 9, 18, 24, ...fl.map(() => 12), 11]);
    XLSX.utils.book_append_sheet(wb, ws1, safeSheet('先生' + e.no + '_変化時', used));

    const rowsM = minuteRows(P, e);
    const aoaM = [['時刻', '場所名', '行為名', ...fl, '移動量(m)']];
    rowsM.forEach(r => aoaM.push(r.st.exists ? [fmtHMS(r.t), r.st.place, r.st.action, ...r.st.vals, mmToM(P, r.move)] : [fmtHMS(r.t), '', '', ...fl.map(() => ''), '']));
    const ws2 = XLSX.utils.aoa_to_sheet(aoaM); setW(ws2, [10, 18, 24, ...fl.map(() => 12), 11]);
    XLSX.utils.book_append_sheet(wb, ws2, safeSheet('先生' + e.no + '_1分毎', used));
  });

  // 生データ（バックアップ・再集計用）
  const pos = [['対象', '種別', '番号', '時刻', 'x(mm,用紙上)', 'y(mm,用紙上)', '場所名']];
  const act = [['対象', '種別', '番号', '時刻', '行為名', ...fl]];
  P.entities.slice().sort((a, b) => a.no - b.no).forEach(e => {
    e.pts.forEach(p => pos.push([entLabel(e), e.kind === 'teacher' ? '先生' : '園児・その他', e.no, fmtHMS(p.t), f2(p.x), f2(p.y), placeAt(P, p.x, p.y)]));
    e.acts.forEach(a => act.push([entLabel(e), e.kind === 'teacher' ? '先生' : '園児・その他', e.no, fmtHMS(a.t), a.text, ...P.fields.map(f => (a.f && a.f[f.id]) || '')]));
  });
  const wsP = XLSX.utils.aoa_to_sheet(pos); setW(wsP, [16, 12, 6, 10, 12, 12, 18]);
  XLSX.utils.book_append_sheet(wb, wsP, safeSheet('位置記録(生)', used));
  const wsA = XLSX.utils.aoa_to_sheet(act); setW(wsA, [16, 12, 6, 10, 28, ...fl.map(() => 12)]);
  XLSX.utils.book_append_sheet(wb, wsA, safeSheet('行為記録(生)', used));

  const ar = [['エリア名', '頂点数', '面積(㎡・実寸換算)']];
  P.areas.forEach(a => ar.push([a.name, a.pts.length, Math.round(Math.abs(polyArea(a.pts)) * Math.pow(P.scale / 1000, 2) * 100) / 100]));
  const wsR = XLSX.utils.aoa_to_sheet(ar); setW(wsR, [24, 8, 18]);
  XLSX.utils.book_append_sheet(wb, wsR, safeSheet('エリア', used));
  return wb;
}

/* ---------- 音声入力テキストの解析 ---------- */
function kanjiToNum(s) {
  const d = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (/^\d+$/.test(s)) return +s;
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch in d) cur = cur * 10 + d[ch];
  }
  return total + cur;
}
// 「11番、ままごと遊び」→ {no:11, text:'ままごと遊び'}。番号がなければ no:null
function parseUtterance(raw) {
  const t = String(raw).normalize('NFKC').trim();
  const m = t.match(/^(?:先生\s*)?([0-9]+|[〇零一二三四五六七八九十百]+)\s*(?:番|ばん|バン)\s*(?:の先生|先生)?\s*[、,，:：\s]*(.*)$/);
  if (m) return { no: kanjiToNum(m[1]), text: m[2].replace(/[。.．\s]+$/, '').trim() };
  return { no: null, text: t.replace(/[。.．\s]+$/, '').trim() };
}
