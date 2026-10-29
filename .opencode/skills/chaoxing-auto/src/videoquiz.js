/**
 * 视频内弹题（ananas 新版视频模块 v=2026-0920）。
 *
 * DOM 事实（2026-10-29 实测）：
 *   div.ans-videoquiz#videoquiz-<n>
 *     ├ .tkTopic_numbar          「共 1 题，已答对 0 题」（#rightNum 是真答对数）
 *     ├ .tkTopic_title           题型（判断题 / 单选题 / 多选题）
 *     └ .tkItem
 *         ├ .tkItem_title        题干
 *         └ ul.tkItem_ul > li.ans-videoquiz-opt
 *              label > span.tkRadio > input[type=radio|checkbox] + i ，文本形如「A、对」
 *   a#videoquiz-submit    提交
 *   a#videoquiz-continue  提交后出现，点它才继续播放
 *
 * 关键：视频模块自己会暂停等作答，但 study.js 的 ENFORCE_FN 每 3 秒强行 play()，
 * 会把弹题「冲过去」→ 弹题必须在这里主动处理，且在作答期间不能再强制播放。
 */
const { solve } = require('./answer');
const { sleep } = require('./util');

const BOX_FN = `(function(){
  const vis = e => !!(e && e.offsetParent !== null);
  const boxes = [...document.querySelectorAll('.ans-videoquiz')].filter(vis);
  const box = boxes[boxes.length - 1];
  if (!box) return null;
  const title = ((box.querySelector('.tkTopic_title') || {}).innerText || '').replace(/\\s+/g, ' ').trim();
  const items = [...box.querySelectorAll('.tkItem')];
  const qs = items.map((it, i) => {
    const stem = ((it.querySelector('.tkItem_title') || {}).innerText || '').replace(/\\s+/g, ' ').trim();
    const opts = [...it.querySelectorAll('li.ans-videoquiz-opt')].map((li, j) => {
      const raw = (li.innerText || '').replace(/\\s+/g, ' ').trim();
      const m = raw.match(/^([A-H])\\s*[、\\.．)）:：]?\\s*([\\s\\S]*)$/);
      const inp = li.querySelector('input');
      return { label: m ? m[1] : 'ABCDEFGH'[j], text: m ? m[2] : raw, checked: !!(inp && inp.checked) };
    });
    const isMulti = /多选/.test(title) || !!it.querySelector('input[type=checkbox]');
    return { qid: 'vq' + (i + 1), stem, options: opts, type: isMulti ? 'multi' : 'single' };
  });
  return {
    id: box.id || '',
    title,
    count: qs.length,
    qs,
    rightText: ((box.querySelector('#rightAnswerNum') || {}).innerText || '').replace(/\\s+/g, ' ').trim(),
    submitVisible: vis(box.querySelector('#videoquiz-submit')),
    submittingVisible: vis(box.querySelector('#videoquiz-submitting')),
    continueVisible: vis(box.querySelector('#videoquiz-continue')),
    notPassVisible: vis(box.querySelector('#spanNot')) || vis(box.querySelector('#spanNotBack')),
  };
})()`;

const PICK_FN = `(function(plan){
  const vis = e => !!(e && e.offsetParent !== null);
  const boxes = [...document.querySelectorAll('.ans-videoquiz')].filter(vis);
  const box = boxes[boxes.length - 1];
  if (!box) return { ok: false, why: 'no box' };
  const items = [...box.querySelectorAll('.tkItem')];
  const done = [];
  for (const p of plan) {
    const it = items[p.qi];
    if (!it) continue;
    const lis = [...it.querySelectorAll('li.ans-videoquiz-opt')];
    for (const idx of p.idx) {
      const li = lis[idx];
      if (!li) continue;
      const lab = li.querySelector('label') || li;
      try { lab.click(); } catch (e) {}
      const inp = li.querySelector('input');
      if (inp && !inp.checked) { try { inp.click(); } catch (e) {} }
    }
    done.push([...it.querySelectorAll('li.ans-videoquiz-opt')]
      .map((li, j) => (li.querySelector('input') || {}).checked ? j : -1)
      .filter(j => j >= 0));
  }
  return { ok: true, done };
})()`;

const CLICK_FN = `(function(sel){
  const vis = e => !!(e && e.offsetParent !== null);
  const el = document.querySelector(sel);
  if (!el || !vis(el)) return false;
  el.click();
  return true;
})`;

/** 弹题是否还在等作答（返回快照或 null） */
async function peekVideoQuiz(cdp, ctx) {
  return cdp.evaluate(BOX_FN, { contextId: ctx, timeoutMs: 15000 }).catch(() => null);
}

/**
 * 作答当前弹题：出答案 → 勾选 → 提交 → 继续学习。
 * @returns 'answered' | 'already' | 'failed'
 */
async function answerVideoQuiz(cdp, ctx, cfg, log, snap) {
  const qs = snap.qs.filter(q => q.stem && q.options.length >= 2);
  if (!qs.length) { log.warn('弹题没解析出题干/选项，直接点继续'); await clickContinue(cdp, ctx); return 'failed'; }

  // 统一交给现有答题链（题干/选项结构已对齐 extract.js 的输出）
  const norm = qs.map(q => ({
    qid: q.qid,
    qtype: q.type,
    stem: q.stem,
    options: q.options.map(o => ({ data: o.label, label: o.label, text: o.text })),
    fillable: q.options.length,
    editors: [],
  }));

  const r = await solve(norm, cfg.answer, log, { port: cdp.port });
  const plan = [];
  for (let i = 0; i < norm.length; i++) {
    const q = norm[i];
    const a = r.answers[q.qid];
    if (!a) { log.warn(`弹题未解：${q.stem.slice(0, 30)}`); continue; }
    const letters = a.ans.type === 'multi' ? a.ans.ans : [String(a.ans.ans)];
    const idx = letters.map(l => q.options.findIndex(o => o.label === String(l).toUpperCase())).filter(n => n >= 0);
    if (!idx.length) { log.warn(`弹题答案映射失败：${q.qid} → ${JSON.stringify(a.ans)}`); continue; }
    plan.push({ qi: i, idx, letters: letters.join('') });
  }
  if (!plan.length) { log.warn('一道都没解出，点继续跳过弹题'); await clickContinue(cdp, ctx); return 'failed'; }

  const picked = await cdp.evaluate(`(${PICK_FN})(${JSON.stringify(plan.map(p => ({ qi: p.qi, idx: p.idx })))})`, { contextId: ctx, timeoutMs: 20000 }).catch(() => null);
  log.ok('弹题作答：' + plan.map(p => `${p.qi + 1}=${p.letters}`).join(' ') + (picked && picked.ok ? '' : '（勾选结果未知）'));
  await sleep(600);

  await cdp.evaluate(`(${CLICK_FN})('#videoquiz-submit')`, { contextId: ctx, timeoutMs: 10000 }).catch(() => {});

  // 等判卷：出现「继续学习」或答错提示
  for (let i = 0; i < 10; i++) {
    await sleep(1200);
    const s2 = await peekVideoQuiz(cdp, ctx);
    if (!s2) break;
    if (s2.continueVisible || s2.notPassVisible) break;
  }
  const after = await peekVideoQuiz(cdp, ctx);
  if (after) log.info(`弹题结果：${after.rightText || '(无)'}${after.notPassVisible ? '（答错）' : ''}`);

  await clickContinue(cdp, ctx);
  return 'answered';
}

async function clickContinue(cdp, ctx) {
  await sleep(400);
  const ok = await cdp.evaluate(`(${CLICK_FN})('#videoquiz-continue')`, { contextId: ctx, timeoutMs: 10000 }).catch(() => false);
  if (!ok) {
    // 有的版本提交后自动收起，找一下可见的继续按钮
    await cdp.evaluate(`(function(){
      const vis = e => !!(e && e.offsetParent !== null);
      const b = [...document.querySelectorAll('#videoquiz-continue, .ans-videoquiz-continue')].find(vis);
      if (b) b.click();
    })()`, { contextId: ctx, timeoutMs: 10000 }).catch(() => {});
  }
  await sleep(800);
}

async function dismissVideoQuiz(cdp, ctx) {
  return clickContinue(cdp, ctx);
}

module.exports = { peekVideoQuiz, answerVideoQuiz, dismissVideoQuiz, BOX_FN };
