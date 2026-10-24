/**
 * 破译 font-cxsecret 防复制字体 v2
 *
 * 学习通把正文换成自定义字体：DOM 里的码位被打乱，但字形是真的。
 * 所以只要把「打乱字符」用 cxsecret 画出来，和候选汉字用系统黑体画出来做形状比对即可。
 *
 * v2 相比 v1 的改进：
 *   1. 灰度 + 面积平均重采样（不再是二值），保留笔画粗细信息
 *   2. 20×20 归一化（先裁墨迹包围盒，再等比缩放居中）
 *   3. 双参考字体取较优（微软雅黑 / 黑体），减小与 Source Han Sans 的字形差
 *   4. 先用「cxsecret 渲染 vs 系统渲染」的差异判断该字是否真的被混淆，未混淆的直接跳过
 *
 * 用法：
 *   node scripts/build-fontmap.js "要破译的字符串"
 *   结果累积进 state/fontmap.json
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('../src/cdp');

const MAP_FILE = path.join(__dirname, '..', 'state', 'fontmap.json');

const DECODE_FN = `(async function(targets, refFonts, N){
  try {
    await document.fonts.ready;
    const has = [...document.fonts].some(f => String(f.family).replace(/["']/g,'') === 'font-cxsecret' && f.status === 'loaded');
    if (!has) return { ok:false, skip:'no cxsecret in this context' };
  } catch (e) { return { ok:false, skip:'check err ' + e.message }; }

  const S = 40, PAD = 8, W = S + PAD * 2;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = W;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.textBaseline = 'top';

  // 画一个字 → 裁包围盒 → 等比缩放居中 → N×N 灰度
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
    const scale = (N - 2) / Math.max(bw, bh);          // 留 1 像素边，等比
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
    let dens = 0; for (let k = 0; k < out.length; k++) dens += out[k];
    return { g: out, dens };
  }

  const dist = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); return s / a.length; };

  // 是否被混淆：同一个字用 cxsecret 和系统字渲染，差异大说明被换过
  function obfuscated(ch, refFont) {
    const a = shape(ch, 'font-cxsecret'), b = shape(ch, refFont);
    if (!a || !b) return false;
    return dist(a.g, b.g) > 0.12;
  }

  const cands = [];
  for (let cp = 0x4e00; cp <= 0x9fa5; cp++) cands.push(String.fromCharCode(cp));
  for (const ch of '，。、；：？！“”‘’（）《》—…·0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') cands.push(ch);

  // 每个候选字在每个参考字体下的形状
  const candShapes = [];
  for (const ch of cands) {
    const per = [];
    for (const f of refFonts) { const s = shape(ch, f); if (s) per.push(s); }
    if (per.length) candShapes.push({ ch, per });
  }

  const res = {};
  for (const ch of targets) {
    const t = shape(ch, 'font-cxsecret');
    if (!t) { res[ch] = { skip: 'no glyph' }; continue; }
    const ob = refFonts.some(f => obfuscated(ch, f));
    if (!ob) { res[ch] = { plain: true }; continue; }
    const scored = [];
    for (const c of candShapes) {
      let best = 9;
      for (const s of c.per) { const dd = dist(t.g, s.g); if (dd < best) best = dd; }
      scored.push({ ch: c.ch, d: Math.round(best * 1000) / 1000 });
    }
    scored.sort((a, b) => a.d - b.d);
    res[ch] = { top: scored.slice(0, 4).map(x => x.ch + ':' + x.d) };
  }
  return { ok: true, candidates: candShapes.length, res };
})`;

(async () => {
  const chars = [...new Set((process.argv[2] || '').split('').filter(Boolean))];
  if (!chars.length) { console.log('用法: node scripts/build-fontmap.js "要破译的字符串"'); process.exit(1); }

  const refFonts = (process.env.REF_FONTS || '"Microsoft YaHei","SimHei"').split(',').map(s => s.trim());
  const cdp = await connect({ port: parseInt(process.env.CDP_PORT || '9223', 10), urlIncludes: process.env.CDP_HINT || 'chaoxing' });
  console.log('参考字体:', refFonts.join(' | '), ' 待解字符:', chars.length);
  const t0 = Date.now();
  const rs = await cdp.evaluateAll(`(${DECODE_FN})(${JSON.stringify(chars)}, ${JSON.stringify(refFonts)}, 20)`, {
    timeoutMs: 600000, awaitPromise: true,
  });
  let best = null;
  for (const r of rs) {
    if (r.error) { console.log('ctx', r.contextId, 'ERR', r.error.slice(0, 120)); continue; }
    if (r.value && r.value.ok) { best = r.value; break; }
  }
  cdp.close();
  if (!best) { console.log('破解失败'); process.exit(1); }
  console.log('候选字形', best.candidates, '用时', ((Date.now() - t0) / 1000).toFixed(1) + 's\n');

  const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
  for (const [k, v] of Object.entries(best.res)) {
    if (v.plain) { console.log(`${k} → （未混淆，原样保留）`); continue; }
    if (v.skip) { console.log(`${k} → (${v.skip})`); continue; }
    console.log(`${k} → ${v.top.join('  ')}`);
    const top = v.top[0].split(':')[0];
    const d0 = parseFloat(v.top[0].split(':')[1]);
    const d1 = v.top[1] ? parseFloat(v.top[1].split(':')[1]) : 9;
    // 只有「足够像」且「明显领先第二名」才写进字典，避免污染
    if (d0 <= 0.06 && d1 - d0 >= 0.012) map[k] = top;
  }
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 1), 'utf8');
  console.log('\n字典字符数:', Object.keys(map).length, '→', MAP_FILE);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
