/**
 * font-cxsecret 防复制字体解码器（分块版）
 *
 * 学习通把题干/选项换成自定义字体：DOM 里是打乱过的码位，肉眼看到的是正确字形。
 * 这里在页面里把「打乱字符」用 cxsecret 画出来，与候选汉字在系统黑体下的字形做归一化比对。
 * 纯本地、无 OCR、无网络；结果按字符缓存到 state/fontmap.json，越用越快。
 *
 * v3 稳定性改造（重要）：
 *   1. 候选字集限定为常用字（state/charfreq.json，约 5.4k），不再扫 20982 个，快 4 倍
 *   2. 候选字形只构建一次，挂在 window.__cx；匹配按 12 字一批分块执行
 *      —— 早期版本一次性阻塞页面主线程 2–3 分钟，会把渲染进程拖崩（标签页直接崩掉）
 */
const fs = require('fs');
const path = require('path');

const MAP_FILE = path.join(__dirname, '..', 'state', 'fontmap.json');
const FREQ_FILE = path.join(__dirname, '..', 'state', 'charfreq.json');

function loadMap() {
  try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { return {}; }
}
function saveMap(m) {
  fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  fs.writeFileSync(MAP_FILE, JSON.stringify(m, null, 1), 'utf8');
}

/** 已知映射的直接替换；未知字符原样保留 */
function decodeWithMap(str, map) {
  if (!str) return str;
  let out = '';
  for (const ch of str) out += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
  return out;
}

/** 探针：判断这个上下文是否加载了 cxsecret */
const CHECK_FN = `(function(){
  try {
    const cx = [...document.fonts].filter(f => String(f.family).replace(/["']/g,'') === 'font-cxsecret');
    return { url: (location.href||'').slice(0,80), has: cx.length > 0, loaded: cx.some(f => f.status === 'loaded') };
  } catch (e) { return { url:'', has:false, err: e.message }; }
})()`;

/** 一次性构建候选字形库，挂在 window.__cx */
const INIT_FN = `(async function(refFonts, N, commonStr){
  try {
    await document.fonts.ready;
    const loaded = [...document.fonts].some(f => String(f.family).replace(/["']/g,'') === 'font-cxsecret' && f.status === 'loaded');
    if (!loaded) return { ok:false, skip:'no cxsecret' };
  } catch (e) { return { ok:false, skip:'fonts err ' + e.message }; }

  const S = 40, PAD = 8, W = S + PAD * 2;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = W;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.textBaseline = 'top';

  function shape(ch, font) {
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, W);
    g.fillStyle = '#000';
    g.font = S + 'px ' + font;
    g.fillText(ch, PAD, PAD);
    const d = g.getImageData(0, 0, W, W).data;
    let x0 = W, y0 = W, x1 = -1, y1 = -1;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4] < 200) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const scale = (N - 2) / Math.max(bw, bh);
    const dw = Math.max(1, Math.round(bw * scale)), dh = Math.max(1, Math.round(bh * scale));
    const ox = Math.floor((N - dw) / 2), oy = Math.floor((N - dh) / 2);
    const out = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const di = i - ox, dj = j - oy;
      if (di < 0 || dj < 0 || di >= dw || dj >= dh) continue;
      const sx = x0 + Math.min(bw - 1, Math.floor(di * bw / dw));
      const sy = y0 + Math.min(bh - 1, Math.floor(dj * bh / dh));
      out[j * N + i] = (255 - d[(sy * W + sx) * 4]) / 255;
    }
    return out;
  }

  const base = commonStr && commonStr.length > 500
    ? commonStr + '，。、；：？！“”‘’（）《》—…·0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    : (() => { const a = []; for (let cp = 0x4e00; cp <= 0x9fa5; cp++) a.push(String.fromCharCode(cp)); return a.join(''); })();
  const chars = [...new Set(base.split(''))];

  const cands = [];
  for (const ch of chars) {
    const per = [];
    for (const f of refFonts) { const s = shape(ch, f); if (s) per.push(s); }
    if (per.length) cands.push({ ch, per });
  }
  window.__cx = { N, cands, shape, dist: (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); return s / a.length; } };
  return { ok:true, cands: cands.length, N };
})`;

/** 对一小批字符做匹配（依赖 INIT_FN 建好的 window.__cx） */
const MATCH_FN = `(function(targets, refFonts, minD, minGap, commonStr){
  const cx = window.__cx;
  if (!cx) return { ok:false, skip:'no candidate bank' };
  const { shape, dist, cands } = cx;
  const common = new Set(commonStr || '');
  const res = {};
  for (const ch of targets) {
    const t = shape(ch, 'font-cxsecret');
    if (!t) { res[ch] = { skip: 'no glyph' }; continue; }
    let maxDiff = 0;
    for (const f of refFonts) { const b = shape(ch, f); if (b) maxDiff = Math.max(maxDiff, dist(t, b)); }
    if (maxDiff <= 0.12) { res[ch] = { plain: true }; continue; }

    const scored = [];
    for (const c of cands) {
      let best = 9;
      for (const s of c.per) { const dd = dist(t, s); if (dd < best) best = dd; }
      scored.push({ ch: c.ch, d: Math.round(best * 1000) / 1000 });
    }
    scored.sort((a, b) => a.d - b.d);
    const top = scored.slice(0, 4);
    let pick = null;
    if (top[0].d <= minD) {
      const near = scored.filter(x => x.d <= top[0].d + 0.008);
      const commonNear = near.find(x => common.has(x.ch));
      if (commonNear) pick = commonNear.ch;
      else if (top[1] ? top[1].d - top[0].d >= minGap : true) pick = top[0].ch;
    }
    res[ch] = { top: top.map(x => x.ch + ':' + x.d), pick };
  }
  return { ok:true, res };
})`;

/**
 * 解码一批字符串：已知的直接替换，未知的分块匹配并写回字典。
 * @returns {Promise<{texts:string[], learned:number}>}
 */
async function decodeStrings(cdp, texts, log, opts = {}) {
  const map = loadMap();
  const unknown = new Set();
  for (const t of texts) {
    for (const ch of String(t || '')) {
      if (!Object.prototype.hasOwnProperty.call(map, ch) && ch.charCodeAt(0) > 0x2e80) unknown.add(ch);
    }
  }
  const unchanged = () => ({ texts: texts.map(t => decodeWithMap(t, map)), learned: 0 });
  if (!unknown.size) return unchanged();

  const refFonts = opts.refFonts ||
    (process.env.REF_FONTS ? process.env.REF_FONTS.split(',').map(s => s.trim()) : ['"Microsoft YaHei"', '"SimHei"']);
  const minD = opts.minD == null ? 0.20 : opts.minD;
  const minGap = opts.minGap == null ? 0.010 : opts.minGap;
  let commonStr = '';
  try { commonStr = JSON.parse(fs.readFileSync(FREQ_FILE, 'utf8')).chars || ''; } catch {}

  const t0 = Date.now();
  if (log) log.info(`防复制字体：${unknown.size} 个未知字形，开始匹配…`);

  // 1) 找真正加载了 cxsecret 的上下文（about:blank 里 check() 会误报 true，必须看 fonts 列表）
  const probes = await cdp.evaluateAll(CHECK_FN, { timeoutMs: 8000 });
  const hit = probes.find(p => p.value && p.value.has);
  if (!hit) {
    if (log) log.warn('字形匹配失败：当前页面没加载 cxsecret 字体（可能不在题目页）');
    return unchanged();
  }

  // 2) 建候选字形库（一次）
  let init = null;
  try {
    init = await cdp.evaluate(`(${INIT_FN})(${JSON.stringify(refFonts)}, 20, ${JSON.stringify(commonStr)})`,
      { contextId: hit.contextId, awaitPromise: true, timeoutMs: 120000 });
  } catch (e) {
    if (log) log.warn('候选字形库构建失败: ' + e.message);
    return unchanged();
  }
  if (!init || !init.ok) {
    if (log) log.warn('候选字形库不可用: ' + JSON.stringify(init));
    return unchanged();
  }
  if (log) log.info(`候选字形 ${init.cands} 个，开始分块匹配`);

  // 3) 分块匹配（每块 12 字，避免长时间阻塞页面主线程）
  const list = [...unknown];
  const CHUNK = 12;
  let learned = 0, unresolved = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    let r = null;
    try {
      r = await cdp.evaluate(`(${MATCH_FN})(${JSON.stringify(part)}, ${JSON.stringify(refFonts)}, ${minD}, ${minGap}, ${JSON.stringify(commonStr)})`,
        { contextId: hit.contextId, timeoutMs: 60000 });
    } catch (e) {
      if (log) log.warn(`块 ${Math.floor(i / CHUNK) + 1} 失败: ${e.message}`);
      continue;
    }
    if (!r || !r.ok) continue;
    for (const [k, v] of Object.entries(r.res)) {
      if (v.plain) map[k] = k;          // 没被混淆，记自映射，下次不再算
      else if (v.pick) { map[k] = v.pick; learned++; }
      else { map[k] = k; unresolved++; }
    }
    if (log && i % (CHUNK * 5) === 0 && i > 0) log.out(`匹配进度 ${Math.min(i + CHUNK, list.length)}/${list.length}`);
  }
  saveMap(map);
  if (log) {
    log.ok(`字形匹配完成：新增 ${learned}，未确定 ${unresolved}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (unresolved) log.warn('未确定的字已按原样保留，可手工改 state/fontmap.json');
  }
  return { texts: texts.map(t => decodeWithMap(t, map)), learned };
}

module.exports = { decodeStrings, decodeWithMap, loadMap, saveMap, MAP_FILE, FREQ_FILE };
