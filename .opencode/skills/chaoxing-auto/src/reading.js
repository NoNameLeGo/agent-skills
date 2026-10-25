/**
 * 「阅读」类任务点（mooc-ans/coursedata/readjobv2/show）。
 *
 * 这类节点页面本身没有内容，只有一句「点击去阅读，可完成阅读任务点」+ 一个入口：
 *   1) a.readTitleText              —— 卡片标题（target=_blank，但 href 常为空）
 *   2) 文本恰好是「去阅读」的 span   —— 由页面内联 JS 绑定，没有 onclick 属性
 * 光在当前页停留/滚动**不会**计时，必须点进阅读器（图文读本）里待够时间。
 *
 * 实测（2026-10）：入口的点击处理器并不稳定可编程触发 —— 元素 click() 能触发 click 事件，
 * 但页面没有因此开新页或跳转；换成 CDP 真实鼠标事件也不保证。
 * 所以本模块的策略是「能自动就自动，不能自动就明确报给用户并等」：
 *   点击 → 等新标签页 / 等阅读器 iframe 跳转
 *     ├─ 成功：在阅读器里停留 + 尝试翻页 → 关掉 → 返回
 *     └─ 失败：日志提示「请手动点一下去阅读」，然后轮询任务点完成状态（默认等 5 分钟）
 */
const { attach, listTargets, closeTab } = require('./cdp');
const { sleep } = require('./util');

const ENTRY_TEXT_RE = /^(去阅读|去阅读>|阅读)$/;

/** 在所有上下文里找阅读入口（异步渲染，调用方重试） */
const FIND_ENTRY_FN = `(function(){
  var a = document.querySelector('a.readTitleText');
  if (a) return { ok: true, via: 'a.readTitleText', text: (a.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 40) };
  var cand = [].slice.call(document.querySelectorAll('span,div,a,button')).filter(function(e){
    if (e.children.length) return false;
    var t = (e.innerText || '').replace(/\\s+/g,'').trim();
    return t === '去阅读' || t === '阅读';
  });
  if (cand.length) return { ok: true, via: 'text', text: '去阅读' };
  return { ok: false };
})()`;

const CLICK_ENTRY_FN = `(function(via){
  var el;
  if (via === 'a.readTitleText') el = document.querySelector('a.readTitleText');
  else {
    var cand = [].slice.call(document.querySelectorAll('span,div,a,button')).filter(function(e){
      if (e.children.length) return false;
      var t = (e.innerText || '').replace(/\\s+/g,'').trim();
      return t === '去阅读' || t === '阅读';
    });
    el = cand[cand.length - 1] || null;
  }
  if (!el) return { ok: false, why: 'entry gone' };
  el.click();
  return { ok: true, tag: el.tagName, text: (el.innerText || '').trim().slice(0, 20) };
})`;

/** 阅读器里：试翻页，翻不动就滚动，让计时器持续走 */
const READER_TICK_FN = `(function(){
  var turned = false;
  var sel = ['.next', '.nextBtn', '[class*="next"]', '[class*="right-btn"]', '.turn-right'];
  for (var i = 0; i < sel.length && !turned; i++) {
    var b = document.querySelector(sel[i]);
    if (b && b.offsetParent !== null) { try { b.click(); turned = true; } catch (e) {} }
  }
  if (!turned) {
    var d = document.scrollingElement || document.body;
    if (d && d.scrollHeight > d.clientHeight + 40) {
      var step = Math.max(150, d.clientHeight * 0.8);
      var bottom = d.scrollTop + d.clientHeight >= d.scrollHeight - 10;
      d.scrollTop = bottom ? 0 : d.scrollTop + step;
    } else {
      window.scrollBy(0, 200);
    }
  }
  return true;
})()`;

const DONE_FN = kid => `(function(){var el=document.getElementById('cur${kid}');return !!(el&&el.querySelector('.icon_Completed'))})()`;

const isInternal = u => /^(edge|chrome|devtools|about|data):/i.test(u || '');
const val = r => (r && r.value !== undefined ? r.value : r);

/**
 * 打开阅读任务并等它完成。
 * @returns {Promise<boolean>} true = 已走「去阅读」流程（调用方不必再按普通文档停留）
 */
async function openReadingTask(cdp, cfg, log, { kid = '', seconds = 0 } = {}) {
  const dwell = seconds || cfg.study?.readOpenSeconds || 90;
  const manualWait = cfg.study?.readManualWaitSeconds || 300;

  // 1) 找入口（iframe 里异步渲染，多试几次）
  let hit = null;
  for (let i = 0; i < 8 && !hit; i++) {
    const rs = await cdp.evaluateAll(FIND_ENTRY_FN).catch(() => []);
    for (const r of rs) {
      let v = r.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
      if (v && v.ok) { hit = { ctx: r.contextId, via: v.via, text: v.text }; break; }
    }
    if (!hit) await sleep(1500);
  }
  if (!hit) return false;

  log.info(`发现阅读入口（${hit.via}「${hit.text}」），尝试打开阅读器`);

  // 2) 点击并观察：新标签页 or 阅读器 iframe 跳转
  const beforeTargets = (await listTargets(cdp.port).catch(() => [])).filter(t => t.type === 'page').map(t => t.id);
  const beforeUrls = (await cdp.evaluateAll('location.href').catch(() => [])).map(u => u.value || '');
  const clicked = val(await cdp.evaluate(`(${CLICK_ENTRY_FN})(${JSON.stringify(hit.via)})`, { contextId: hit.ctx }).catch(e => ({ ok: false, why: e.message })));

  let target = null;
  let moved = false;
  for (let i = 0; i < 8 && !target; i++) {
    await sleep(1000);
    const now = (await listTargets(cdp.port).catch(() => [])).filter(t => t.type === 'page');
    target = now.find(t => !beforeTargets.includes(t.id) && !isInternal(t.url)) || null;
    if (!target && i === 3) {
      // 没有新标签页，但阅读器 iframe 可能已就地跳转
      const after = (await cdp.evaluateAll('location.href').catch(() => [])).map(u => u.value || '');
      moved = after.some(u => /book|read/i.test(u) && !beforeUrls.includes(u));
    }
  }

  // 3a) 新标签页：进去待够时间
  if (target) {
    log.info(`阅读器已打开：${(target.url || '').slice(0, 90)}，停留 ${dwell}s`);
    let rd = null;
    try {
      rd = await attach(cdp.port, target);
      for (let i = 0; i < Math.ceil(dwell / 5); i++) {
        await rd.evaluateAll(READER_TICK_FN).catch(() => {});
        if (i % 3 === 0) log.out(`阅读中… ${Math.min((i + 1) * 5, dwell)}s / ${dwell}s`);
        await sleep(5000);
      }
    } catch (e) {
      log.warn('阅读器处理异常: ' + e.message);
    } finally {
      if (rd) rd.close();
      await closeTab(cdp.port, target.id).catch(() => {});
    }
    log.ok('阅读器停留结束');
    return true;
  }

  // 3b) 就地跳转：原页面/当前 iframe 停留
  if (moved) {
    log.info(`阅读器在原位置打开，停留 ${dwell}s`);
    for (let i = 0; i < Math.ceil(dwell / 5); i++) {
      await cdp.evaluateAll(READER_TICK_FN).catch(() => {});
      if (i % 3 === 0) log.out(`阅读中… ${Math.min((i + 1) * 5, dwell)}s / ${dwell}s`);
      await sleep(5000);
    }
    return true;
  }

  // 3c) 自动点不开：明确让用户点，然后轮询完成状态（这部分学习通只认真人点击）
  log.warn(`阅读入口点击后没有跳转（${JSON.stringify(clicked)}）。`);
  log.warn(`👉 请在那个 Edge 窗口里手动点一下「去阅读」，脚本会等你 ${manualWait}s 并自动检测完成`);
  if (!kid) return false;

  const t0 = Date.now();
  while (Date.now() - t0 < manualWait * 1000) {
    await sleep(5000);
    const done = val(await cdp.evaluate(DONE_FN(kid)).catch(() => false));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (done === true) { log.ok(`阅读任务点已完成（等待 ${secs}s）`); return true; }
    if (secs % 30 < 5) log.out(`等待阅读完成… ${secs}s / ${manualWait}s`);
  }
  log.warn(`等了 ${manualWait}s 仍未标记完成，先跳过这一节（下次运行会重试）`);
  return true;
}

module.exports = { openReadingTask, FIND_ENTRY_FN, DONE_FN };
