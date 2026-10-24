/**
 * 刷课：目录遍历 + 视频播放守护 + 章节测验/作业分流。
 *
 * 页面层级（学习通，实测形态）：
 *   mycourse/studentstudy (顶层)
 *     └ #iframe → knowledge/cards?...            （本节所有「卡片」）
 *          └ iframe.ans-attach-online → ans-insertvideo-online.html   （视频播放器，含 <video>）
 * 所以「找 video」必须遍历所有 main-world 上下文，不能只看顶层 document。
 *
 * 静音策略：--mute-audio 让整个浏览器实例静音（含 iframe / WebAudio），
 * 页面里再设 video.muted = true 做双保险；两者都不影响 playbackRate 与进度上报。
 */
const { sleep, randInt } = require('./util');

/* ---------------- 目录 ---------------- */

const LIST_FN = `(function(){
  const out = [];
  // 实测结构（2026-10，mmooc2 学习页）：
  //   div.posCatalog_select[firstLayer 可选] > span.posCatalog_name[title][onclick="getTeacherAjax(cid,clazzid,kid)"]
  //                                          + span.icon_Completed（有=已完成）
  // 章标题是 firstLayer，没有 cur 前缀 id，点它只是展开/收起。
  document.querySelectorAll('.posCatalog_select').forEach((el, i) => {
    const nameEl = el.querySelector('.posCatalog_name');
    const id = el.id || '';
    const m = id.match(/^cur(\\d+)$/);
    const kid = m ? m[1] : '';
    const oc = nameEl ? (nameEl.getAttribute('onclick') || '') : '';
    const ocM = oc.match(/getTeacherAjax\\(\\s*'?(\\d+)'?\\s*,\\s*'?(\\d+)'?\\s*,\\s*'?(\\d+)'?/);
    out.push({
      i,
      kid: kid || (ocM ? ocM[3] : ''),
      name: ((nameEl && (nameEl.getAttribute('title') || nameEl.innerText)) || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      done: !!el.querySelector('.icon_Completed'),
      active: el.classList.contains('posCatalog_active'),
      header: el.classList.contains('firstLayer') || !m,
      onclick: oc.slice(0, 120),
      canClick: !!nameEl,
    });
  });
  return { url: location.href, count: out.length, items: out };
})()`;

async function listChapters(cdp, log) {
  const r = await cdp.evaluateAll(LIST_FN);
  let best = { count: 0, items: [] };
  for (const x of r) if (x.value && x.value.count > best.count) best = x.value;
  if (log) log.info(`目录条目 ${best.count} 个，已完成 ${best.items.filter(i => i.done).length} 个`);
  return best;
}

/* ---------------- 视频 ---------------- */

const VIDEO_SCAN_FN = `(function(){
  const vs = [...document.querySelectorAll('video')];
  return vs.map((v, i) => ({
    i, src: (v.currentSrc || v.src || '').slice(0, 90),
    dur: Math.round((v.duration || 0) * 10) / 10,
    cur: Math.round((v.currentTime || 0) * 10) / 10,
    paused: v.paused, ended: v.ended, rate: v.playbackRate, muted: v.muted,
    ready: v.readyState, w: v.clientWidth
  }));
})()`;

/** 找到「最长/最活跃」的那个 video 上下文 */
async function findVideoCtx(cdp) {
  const all = await cdp.evaluateAll(VIDEO_SCAN_FN);
  let best = null;
  for (const r of all) {
    if (!r.value || !r.value.length) continue;
    const v = r.value.slice().sort((a, b) => (b.dur || 0) - (a.dur || 0))[0];
    if (!best || (v.dur || 0) > (best.v.dur || 0)) best = { ctx: r.contextId, v, n: r.value.length };
  }
  return best;
}

const ENFORCE_FN = `(function(rate, mute){
  const vs = [...document.querySelectorAll('video')];
  const out = [];
  vs.forEach(v => {
    try {
      if (rate && v.playbackRate !== rate) v.playbackRate = rate;
      if (mute) { v.muted = true; v.volume = 0; }
      if (v.paused && !v.ended) { const p = v.play(); if (p && p.catch) p.catch(()=>{}); }
      out.push({ rate: v.playbackRate, muted: v.muted, paused: v.paused });
    } catch (e) { out.push({ err: e.message }); }
  });
  return out;
})`;

/** 关掉「继续学习/是否离开」一类弹窗，避免卡住 */
const KILL_POPUP_FN = `(function(){
  const sels = ['.layui-layer-btn0','.popup_con .pop_ok','a.pop_ok','.ans-video-again','#videoAgain','.layui-layer-close'];
  const hit = [];
  for (const s of sels) {
    document.querySelectorAll(s).forEach(e => {
      const t = (e.innerText||'').trim();
      if (/继续|确定|知道了|好的|关闭/.test(t) || s.includes('close')) { try { e.click(); hit.push(s + '|' + t); } catch(e){} }
    });
  }
  return hit;
})()`;

async function watchCurrent(cdp, cfg, log, { maxMinutes = 45 } = {}) {
  const rate = cfg.study?.playbackRate || 1;
  const mute = cfg.study?.muteVideoElement !== false;
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  let stalls = 0, lastCur = -1, ticks = 0;

  // 等 video 出现（章节可能先加载 PPT / 文档）
  let found = null;
  for (let i = 0; i < 40 && Date.now() < deadline; i++) {
    found = await findVideoCtx(cdp);
    if (found) break;
    await cdp.evaluateAll(KILL_POPUP_FN).catch(() => {});
    await sleep(2000);
  }
  if (!found) { log.info('本节没找到 video（可能是文档/PPT/测验）'); return { type: 'no-video' }; }

  log.ok(`发现视频：时长 ${found.v.dur}s，初始进度 ${found.v.cur}s，共 ${found.n} 个`);
  if (found.v.dur > 0 && found.v.cur > found.v.dur * 0.98) log.info('该视频已接近看完');
  if (found.v.dur > 600) log.info(`预计 ${Math.ceil((found.v.dur - found.v.cur) / 60 / rate)} 分钟`);

  while (Date.now() < deadline) {
    ticks++;
    const cur = await findVideoCtx(cdp);
    if (!cur) { await sleep(3000); continue; }
    await cdp.evaluate(`(${ENFORCE_FN})(${rate}, ${mute})`, { contextId: cur.ctx }).catch(() => {});
    await cdp.evaluateAll(KILL_POPUP_FN).catch(() => {});

    const v = cur.v;
    // 每 30 秒报一次进度
    if (ticks % 10 === 1) {
      const pct = v.dur ? ((v.cur / v.dur) * 100).toFixed(1) : '?';
      log.out(`进度 ${v.cur}s / ${v.dur}s (${pct}%) rate=${v.rate} paused=${v.paused}`);
    }

    if (v.ended || (v.dur > 0 && v.cur >= v.dur - 1.5)) {
      log.ok('本节视频播放结束');
      await sleep(2000);
      await cdp.evaluateAll(KILL_POPUP_FN).catch(() => {});
      return { type: 'video-ended', dur: v.dur };
    }

    if (v.cur === lastCur) {
      stalls++;
      if (stalls >= (cfg.study?.maxConsecutiveStalls || 3) * 4) {
        log.warn(`进度停滞 ${stalls} 次，尝试重新触发播放`);
        stalls = 0;
        await cdp.evaluate(`(function(){const v=document.querySelector('video');if(v){v.muted=true;const p=v.play();if(p&&p.catch)p.catch(()=>{})}})()`, { contextId: cur.ctx }).catch(() => {});
      }
    } else {
      stalls = 0;
      lastCur = v.cur;
    }
    await sleep(3000);
  }
  log.warn('本节超时未播完，跳过');
  return { type: 'timeout' };
}

/* ---------------- 页面结构探针（调 DOM 用） ---------------- */

const PROBE_FN = `(function(){
  const q = s => document.querySelectorAll(s).length;
  return {
    url: location.href,
    title: document.title,
    counts: {
      video: q('video'),
      iframe: q('iframe'),
      chapter_item: q('.chapter_item'),
      posCatalog: q('.posCatalog_select'),
      catalog_level: q('ul.catalog_level li'),
      questionNodes: q('[id^="question"]'),
      answerBg: q('.answerBg'),
      cards: q('.card'),
      attachOnline: q('iframe.ans-attach-online')
    },
    iframes: [...document.querySelectorAll('iframe')].map(f => ({ id: f.id, cls: f.className, src: (f.src||'').slice(0,120) })).slice(0,12),
    head: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0,300)
  };
})()`;

async function probe(cdp, log) {
  const all = await cdp.evaluateAll(PROBE_FN);
  log.info('=== 探针 ===');
  for (const r of all) {
    if (r.error) { log.out(`ctx ${r.contextId}: ERR ${r.error}`); continue; }
    log.out(`ctx ${r.contextId}: ${JSON.stringify(r.value.counts)}`);
    log.out(`  url=${String(r.value.url).slice(0, 100)}`);
    if (r.value.iframes.length) log.out('  iframes=' + JSON.stringify(r.value.iframes));
    if (r.value.head) log.out('  head=' + r.value.head.slice(0, 160));
  }
  return all;
}

module.exports = { listChapters, watchCurrent, findVideoCtx, probe, KILL_POPUP_FN, ENFORCE_FN };
