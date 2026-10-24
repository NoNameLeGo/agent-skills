/**
 * 填答 / 暂存 / 提交。
 * DOM 事实（实测，别凭直觉改）：
 *   单选 qtype=0 → onclick=addChoice()          选中类 check_answer      span.num_option
 *   判断 qtype=3 → onclick=addChoice()          data = true/false
 *   多选 qtype=1 → onclick=addMultipleChoice()  选中类 check_answer_dx   span.num_option_dx
 *   填空 → UEditor，实例表是 UE.instants（不是 instances），key = answerEditor{qid}{n}，必须 sync()
 *   真值 → 隐藏 input #answer{qid} / textarea#answerEditor{qid}{n}.value
 *
 * ⚠️ addChoice 会先清空同题其它选项，多选误用它只会留下最后一个。
 * 这里统一用 bg.click() 触发页面自己的 onclick，最真实；点完再按类名校验，没变化才显式调用页面函数。
 */
const { sleep, randInt } = require('./util');

// 单题版本：一题一次 evaluate，题间间隔由 Node 侧控制。
// 批量版出现过「整页 await 不回包」——点完最后一题页面重渲染，promise 就丢了。单题更稳，也能打印进度。
const APPLY_ONE_FN = `(function (p) {
  const node = document.getElementById('question' + p.qid);
  if (!node) return { qid: p.qid, err: 'no node' };
  const isMulti = p.type === 'multi';
  const cls = isMulti ? 'check_answer_dx' : 'check_answer';
  let spans = [...node.querySelectorAll(isMulti ? 'span.num_option_dx' : 'span.num_option')];
  if (!spans.length) spans = [...node.querySelectorAll('span.num_option, span.num_option_dx')];
  const target = new Set(p.target);
  const before = [], after = [];
  let clicks = 0, fixed = 0;
  for (const s of spans) {
    const d = s.getAttribute('data');
    if (s.classList.contains(cls)) before.push(d);
    const want = target.has(d), has = s.classList.contains(cls);
    if (want === has) continue;
    const bg = s.closest('div.answerBg') || s.closest('li[qid]') || s.closest('li');
    if (!bg) continue;
    try {
      bg.click();                              // 真实点击，走页面自己的 addChoice / addMultipleChoice
      let now = s.classList.contains(cls);
      if (now !== want) {
        try {
          if (isMulti && typeof addMultipleChoice === 'function') addMultipleChoice(bg);
          else if (!isMulti && typeof addChoice === 'function') addChoice(bg);
          fixed++;
          now = s.classList.contains(cls);
        } catch (e) {}
      }
      if (want) clicks++;
    } catch (e) {}
  }
  for (const s of spans) if (s.classList.contains(cls)) after.push(s.getAttribute('data'));
  const inp = document.getElementById('answer' + p.qid);
  return { qid: p.qid, type: p.type, want: p.target, before, after, clicks, fixed, val: inp ? inp.value : null };
})`;

const FILL_FN = `(function (plan, gapMin, gapMax) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a,b) => a + Math.floor(Math.random()*(b-a+1));
  return (async () => {
    const out = [];
    const bag = (typeof UE !== 'undefined') ? (UE.instants || {}) : {};
    const byKey = {};
    Object.keys(bag).forEach(k => { const e = bag[k]; if (e && e.key) byKey[e.key] = e; });
    for (let pi = 0; pi < plan.length; pi++) {
      const p = plan[pi];
      const res = [];
      for (let i = 0; i < p.answers.length; i++) {
        const id = 'answerEditor' + p.qid + (i + 1);
        const ed = byKey[id];
        if (!ed) { res.push({ id, err: 'no editor' }); continue; }
        try {
          ed.setContent(String(p.answers[i]));
          try { if (ed.fireEvent) ed.fireEvent('contentChange'); } catch (e) {}
          if (typeof ed.sync === 'function') ed.sync();
          const ta = document.getElementById(id);
          res.push({ id, want: p.answers[i], got: ta ? ta.value : null });
        } catch (e) { res.push({ id, err: e.message }); }
        await wait(rnd(200, 600));
      }
      out.push({ qid: p.qid, res });
      if (pi < plan.length - 1) await wait(rnd(gapMin, gapMax));
    }
    try { if (typeof answerContentChange === 'function') answerContentChange(); } catch (e) {}
    return out;
  })();
})`;

const norm = s =>
  String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** 把 answers(map) 按题目顺序转成执行计划 */
function buildPlan(questions, answers) {
  const choice = [], fill = [], skipped = [];
  for (const q of questions) {
    const a = answers[q.qid];
    if (!a) { skipped.push(q.qid); continue; }
    if (a.ans.type === 'fill') {
      fill.push({ qid: q.qid, answers: a.ans.ans });
    } else if (a.ans.type === 'judge') {
      choice.push({ qid: q.qid, type: 'judge', target: [a.ans.ans ? 'true' : 'false'] });
    } else if (a.ans.type === 'multi') {
      const t = a.ans.ans.map(l => {
        const i = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(l);
        return q.options[i] ? q.options[i].data : l;
      });
      choice.push({ qid: q.qid, type: 'multi', target: t });
    } else {
      const i = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(a.ans.ans);
      choice.push({ qid: q.qid, type: 'single', target: [q.options[i] ? q.options[i].data : a.ans.ans] });
    }
  }
  return { choice, fill, skipped };
}

/**
 * 页面在播放结束后会自动重渲染 iframe，之前抓到的 contextId 会失效。
 * 这里按「哪个上下文里存在这道题」重新定位，返回新的 contextId。
 */
async function relocalCtx(cdp, qid) {
  const expr = `!!document.getElementById('question${qid}')`;
  const rs = await cdp.evaluateAll(expr, { timeoutMs: 8000 }).catch(() => []);
  const hit = rs.find(r => r.value === true);
  if (hit) return hit.contextId;
  // 没有具体 qid 时，退化为「任意有题目的上下文」
  const rs2 = await cdp.evaluateAll(`document.querySelectorAll('[id^="question"]').length > 0`, { timeoutMs: 8000 }).catch(() => []);
  const hit2 = rs2.find(r => r.value === true);
  return hit2 ? hit2.contextId : null;
}

async function applyAnswers(cdp, questions, answers, cfg, log, ctxId) {
  const { choice, fill, skipped } = buildPlan(questions, answers);
  const g = cfg.humanize || { minGap: 3000, maxGap: 12000 };
  if (skipped.length) log.warn('无答案跳过: ' + skipped.join(','));
  log.info(`填答计划：选择/判断 ${choice.length} 题，填空 ${fill.length} 题`);

  let bad = 0, clicks = 0;
  let ctx = ctxId;
  // 一题一次 evaluate + Node 侧随机间隔（3–12s），既像人，也不会因为整页重渲染卡死
  for (let i = 0; i < choice.length; i++) {
    const p = choice[i];
    let r = null;
    try {
      r = await cdp.evaluate(`(${APPLY_ONE_FN})(${JSON.stringify(p)})`, { contextId: ctx, timeoutMs: 20000 });
    } catch (e) {
      if (/context/i.test(e.message)) {
        const nc = await relocalCtx(cdp, p.qid);
        if (nc && nc !== ctx) {
          log.warn(`页面已重渲染，上下文 ${ctx} → ${nc}，重试 qid=${p.qid}`);
          ctx = nc;
          try {
            r = await cdp.evaluate(`(${APPLY_ONE_FN})(${JSON.stringify(p)})`, { contextId: ctx, timeoutMs: 20000 });
          } catch (e2) { bad++; log.err(`qid=${p.qid} 重试失败: ${e2.message}`); continue; }
        } else {
          bad++; log.err(`qid=${p.qid} 上下文丢失且无法重定位`); continue;
        }
      } else {
        bad++; log.err(`qid=${p.qid} 执行失败: ${e.message}`); continue;
      }
    }
    clicks += r.clicks || 0;
    const got = [...(r.after || [])].sort().join('');
    const want = [...new Set(r.want || [])].sort().join('');
    if (r.err) { bad++; log.err(`qid=${r.qid} ${r.err}`); }
    else if (norm(got) !== norm(want)) { bad++; log.err(`qid=${r.qid} 不符 want=${want} got=${got}`); }
    else log.out(`  [${i + 1}/${choice.length}] qid=${r.qid} ${r.type} → ${got || '(空)'}${r.fixed ? ' (修正' + r.fixed + ')' : ''}`);
    if (i < choice.length - 1) await sleep(randInt(g.minGap, g.maxGap));
  }
  if (choice.length) log.ok(`选择题点击 ${clicks} 次，异常 ${bad}`);

  if (fill.length) {
    await sleep(600);
    const res = await cdp.evaluate(`(${FILL_FN})(${JSON.stringify(fill)}, ${g.minGap}, ${g.maxGap})`, { awaitPromise: true, contextId: ctx, timeoutMs: 120000 + fill.length * (g.maxGap + 3000) });
    let ok = 0;
    for (const r of res) for (const x of r.res) {
      if (x.err) { bad++; log.err(`填空 qid=${r.qid} ${x.err}`); }
      else if (norm(x.got) !== norm(x.want)) { bad++; log.err(`填空不符 ${x.id} want=${JSON.stringify(x.want)} got=${JSON.stringify(x.got)}`); }
      else ok++;
    }
    log.ok(`填空写入 ${ok} 空`);
  }
  return bad;
}

/**
 * 点掉「确认提交？」这类二次确认弹层。
 * 学习通有 3 套弹层：layui 的 .layui-layer、自定义 .Marking/.popDiv（按钮是 a.jb_btn）、
 * 以及 .AlertCon02（未达及格线的提示，按钮 #submitBackOk）。
 * 通用打法：找可见、文字是「确定/确认/提交/交卷」的按钮，排除底部按钮栏（.workBtnIndex），取层级最深的一个。
 */
const CONFIRM_FN = `(function(){
  const wanted = ['确定', '确认', '提交', '交卷'];
  const depth = e => { let n = 0, p = e; while (p) { n++; p = p.parentElement; } return n; };
  const cands = [...document.querySelectorAll('a,button,span,div')].filter(e => {
    const t = (e.innerText || '').trim();
    if (!wanted.includes(t)) return false;
    if (!e.offsetParent) return false;               // 不可见
    if (e.closest('.workBtnIndex')) return false;    // 底部按钮栏，别重复点
    const b = e.getBoundingClientRect();
    return b.width > 10 && b.height > 10;
  });
  if (!cands.length) return null;
  cands.sort((a, b) => depth(b) - depth(a));
  const el = cands[0];
  el.click();
  return el.tagName + '.' + String(el.className || '').slice(0, 30) + ' | ' + (el.innerText || '').trim();
})()`;

async function saveDraft(cdp, log, ctxId) {
  // 布局 A 用 saveWork()；doHomeWorkNew（布局 B）的「暂时保存」是 a.btnSave[onclick="noSubmit();"]
  const r = await cdp.evaluate(`(function(){
    try {
      if (typeof saveWork === 'function') { saveWork(); return 'saveWork()' }
      const b = document.querySelector('a.btnSave, #tempsave');
      if (b) { b.click(); return 'click .btnSave' }
      return 'no save control'
    } catch (e) { return 'err:' + e.message }
  })()`, { contextId: ctxId, timeoutMs: 15000 });
  log.info('暂存: ' + r);
  await sleep(2500);
  return r === 'saveWork()';
}

async function submitNow(cdp, log, ctxId) {
  // 布局 A：submitWork()；布局 B（doHomeWorkNew）：a.btnSubmit[onclick="btnBlueSubmit();"]
  const r = await cdp.evaluate(`(function(){
    try {
      if (typeof submitWork === 'function') { submitWork(); return 'submitWork()' }
      const b = document.querySelector('a.btnSubmit');
      if (b) { b.click(); return 'click .btnSubmit' }
      if (typeof btnBlueSubmit === 'function') { btnBlueSubmit(); return 'btnBlueSubmit()' }
      return 'no submit control'
    } catch (e) { return 'err:' + e.message }
  })()`, { contextId: ctxId, timeoutMs: 15000 });
  log.info('提交: ' + r);
  await sleep(1800);
  // 关键：确认弹层挂在外层 studentstudy 文档上，不在题目 iframe 里 —— 必须全上下文找
  for (let i = 0; i < 4; i++) {
    const rs = await cdp.evaluateAll(CONFIRM_FN, { timeoutMs: 8000 }).catch(() => []);
    const hit = rs.map(r => r.value).find(Boolean);
    if (!hit) { await sleep(1200); continue; }
    log.info('已点确认弹层: ' + hit);
    await sleep(1800);
    break;
  }
  await sleep(2500);
  const url = await cdp.evaluate('location.href', { contextId: ctxId }).catch(() => '');
  log.info('提交后地址: ' + String(url).slice(0, 110));
  return /submitWork|btnSubmit|btnBlueSubmit/.test(String(r));
}

/** 复核：直接读隐藏真值字段，不依赖页面视觉状态 */
async function verify(cdp, questions, answers, log, ctxId) {
  const plan = [];
  for (const q of questions) {
    const a = answers[q.qid];
    if (!a) continue;
    if (a.ans.type === 'fill') plan.push({ qid: q.qid, kind: 'fill', answers: a.ans.ans });
    else {
      const want = a.ans.type === 'judge'
        ? (a.ans.ans ? 'true' : 'false')
        : a.ans.type === 'single'
          ? (q.options['ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(a.ans.ans)] || {}).data || a.ans.ans
          : null;
      // 多选题要和 #answer{qid} 里的 data 码比对，不是显示字母
      const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const codes = a.ans.type === 'multi'
        ? a.ans.ans.map(l => (q.options[L.indexOf(l)] || {}).data || l).sort().join('')
        : null;
      plan.push({ qid: q.qid, kind: 'choice', want, letters: a.ans.type === 'multi' ? a.ans.ans : null, codes, qtype: a.ans.type });
    }
  }
  const res = await cdp.evaluate(`(function(plan){
    return plan.map(p => {
      if (p.kind === 'fill') {
        return { qid: p.qid, kind:'fill', got: p.answers.map((_,i)=>{const e=document.getElementById('answerEditor'+p.qid+(i+1));return e?e.value:null}) };
      }
      const e = document.getElementById('answer'+p.qid);
      return { qid: p.qid, kind:'choice', got: e ? e.value : null };
    });
  })(${JSON.stringify(plan)})`, { contextId: ctxId });

  let bad = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i], r = res[i];
    if (p.kind === 'fill') {
      const okAll = p.answers.every((w, k) => norm(r.got[k]) === norm(w));
      if (!okAll) { bad++; log.err(`复核填空 ${p.qid} want=${JSON.stringify(p.answers)} got=${JSON.stringify(r.got)}`); }
    } else {
      const got = norm(r.got);
      let ok;
      if (p.qtype === 'multi') ok = got.split('').sort().join('') === String(p.codes || '').split('').sort().join('');
      else ok = got === norm(p.want);
      if (!ok) { bad++; log.err(`复核选择 ${p.qid} want=${p.want}${p.letters ? '/' + p.letters.join('') : ''} got=${got}`); }
    }
  }
  log[bad ? 'warn' : 'ok'](`复核不符 ${bad} / ${plan.length}`);
  return bad;
}

module.exports = { applyAnswers, saveDraft, submitNow, verify, buildPlan, norm, relocalCtx };
