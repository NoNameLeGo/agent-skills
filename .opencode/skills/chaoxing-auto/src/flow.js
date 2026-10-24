/**
 * 单页 / 单课程流程编排。
 * 一条流水线：抽题 → 四级降级出答案 → 填答 → （测验提交 / 作业暂存） → 复核
 */
const { extractQuestions, sanityCheck } = require('./extract');
const { solve } = require('./answer');
const { applyAnswers, saveDraft, submitNow, verify, relocalCtx } = require('./fill');
const { listChapters, watchCurrent, probe } = require('./study');
const { sleep, saveJson } = require('./util');

/** 处理当前页面上的题（作业页 / 章节测验页通用） */
async function handleQuestions(cdp, cfg, log, { autoSubmit = false, tag = 'quiz', presetAnswers = null } = {}) {
  const page = await extractQuestions(cdp, log);
  if (!page.questions.length) {
    log.warn('本页没有抓到题目');
    await probe(cdp, log);
    return { ok: false, reason: 'no-questions', page };
  }
  sanityCheck(page.questions, log);
  saveJson(`${tag}-questions.json`, page);

  // 硬闸：选择题/判断题没解析到选项时，绝不能把「没有选项的题干」丢给模型让它瞎猜字母
  const noOpts = page.questions.filter(
    q => (q.qtype === 'single' || q.qtype === 'multi' || q.qtype === 'judge') && (q.options || []).length < 2
  );
  if (noOpts.length) {
    log.warn(`${noOpts.length} 题没解析到选项（qid=${noOpts.map(q => q.qid).join(',')}），这些题不送模型、不猜`);
    if (noOpts.length === page.questions.length) {
      log.err('整页都没有选项，放弃本页（可能已是「已完成/已批阅」的结果页）');
      return { ok: false, reason: 'no-options', page };
    }
  }

  let answers = {}, unsolved = [];
  if (presetAnswers) {
    log.info('使用外部答案文件（跳过出答案）');
    for (const q of page.questions) {
      const a = presetAnswers[q.qid];
      if (a) answers[q.qid] = { ans: a, src: 'manual' };
      else unsolved.push(q);
    }
  } else {
    const answerable = page.questions.filter(q => !noOpts.includes(q));
    log.info('开始出答案（降级链：' + (cfg.answer.chain || []).join(' → ') + '）');
    const r = await solve(answerable, cfg.answer, log, { port: cdp.port });
    answers = r.answers;
    unsolved = r.unsolved;
  }
  saveJson(`${tag}-answers.json`, { url: page.url, answers, unsolved: unsolved.map(q => q.qid) });

  const solvedN = Object.keys(answers).length;
  log[unsolved.length ? 'warn' : 'ok'](`出答案 ${solvedN}/${page.questions.length}` + (unsolved.length ? `，未解 ${unsolved.length} 题（留空不猜）` : ''));

  if (!solvedN) { log.warn('一道都没解出来，不填答，直接返回'); return { ok: false, reason: 'no-answers', page }; }

  const bad = await applyAnswers(cdp, page.questions, answers, cfg, log, page.ctx);
  // 视频播完/提交前页面会重渲染，提交与复核前重新定位题目所在上下文
  const ctx2 = (await relocalCtx(cdp, page.questions[0].qid).catch(() => null)) || page.ctx;
  if (bad) log.warn(`填答阶段有 ${bad} 处异常，继续走复核`);

  // 安全闸：有题缺选项 / 填答有异常 → 一律不提交，只暂存（宁可少交，也不交白卷）
  if (noOpts.length || bad > 0) {
    log.err(`填答不完整（缺选项 ${noOpts.length} 题 / 异常 ${bad} 处），本轮不提交，只暂存`);
    await saveDraft(cdp, log, ctx2);
    return { ok: false, reason: 'fill-incomplete', page, answers };
  }

  if (autoSubmit) {
    await submitNow(cdp, log, ctx2);
  } else {
    await saveDraft(cdp, log, ctx2);
  }
  await sleep(1500);
  const vbad = await verify(cdp, page.questions, answers, log, ctx2).catch(e => { log.warn('复核失败: ' + e.message); return -1; });
  return { ok: true, page, answers, unsolved, autoSubmit, verifyBad: vbad };
}

/**
 * 刷一门课：按目录顺序逐节处理。
 * 已完成的节跳过；视频节播完自动进下一节；遇到测验页按 autoSubmit 提交；遇到作业只暂存。
 */
const LINGER_FN = `(function(){
  // 文档/PPT 类任务点常按「阅读时长」计，模拟阅读：逐步滚到底再回顶
  const doc = document.scrollingElement || document.body;
  if (!doc) return false;
  const h = Math.max(doc.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
  if (h <= 40) return false;
  const y = Math.min(doc.scrollTop + Math.max(120, h / 12), h);
  window.scrollTo({ top: y, behavior: 'smooth' });
  return true;
})()`;

/** 在文档/PPT 类节点上停留一会儿并模拟阅读，尽量把「阅读时长」任务点耗满 */
async function linger(cdp, log, seconds = 60) {
  const t0 = Date.now();
  let ticks = 0;
  while (Date.now() - t0 < seconds * 1000) {
    const rs = await cdp.evaluateAll(LINGER_FN);
    const scrolled = rs.filter(r => r.value === true).length;
    if (ticks % 10 === 0) log.out(`阅读中… ${Math.round((Date.now() - t0) / 1000)}s（可滚动上下文 ${scrolled}）`);
    ticks++;
    await sleep(3000);
  }
}

async function runCourse(cdp, cfg, log, { maxChapters = 200, skipDone = true, fromKid = null } = {}) {
  const chapters = await listChapters(cdp, log);
  if (!chapters.count) {
    log.warn('没识别到目录条目，先跑一次 probe 看结构');
    await probe(cdp, log);
    return;
  }
  const workable = chapters.items.filter(it => !it.header && it.kid);
  const todo = skipDone ? workable.filter(it => !it.done) : workable;
  log.info(`可处理节点 ${workable.length} 个，未完成 ${todo.length} 个`);

  let done = 0, skipped = 0, failed = 0;
  for (let n = 0; n < todo.length && n < maxChapters; n++) {
    const ch = todo[n];
    log.info(`—— [${n + 1}/${todo.length}] ${ch.name || ch.kid}（kid=${ch.kid}）`);
    try {
      await clickChapter(cdp, ch.i, ch.kid);
    } catch (e) {
      log.err('打开章节失败: ' + e.message);
      failed++;
      continue;
    }
    await sleep(3500);

    const kind = await detectKind(cdp);
    log.info(`本节类型：${kind}`);

    if (kind === 'questions') {
      const r = await handleQuestions(cdp, cfg, log, {
        autoSubmit: cfg.study?.chapterQuiz?.autoSubmit !== false,
        tag: `ch_${ch.kid}`,
      });
      r && r.ok ? done++ : failed++;
    } else if (kind === 'video') {
      const r = await watchCurrent(cdp, cfg, log, { maxMinutes: cfg.study?.maxMinutesPerPage || 45 });
      if (r.type === 'video-ended') done++;
      else if (r.type === 'no-video') skipped++;
      else failed++;
    } else {
      // 文档 / PPT / 阅读类任务点：按阅读时长计，模拟滚动停留（study.readSeconds 可调）
      const secs = cfg.study?.readSeconds ?? 0;
      if (secs > 0) {
        log.info(`文档/PPT 类任务点，模拟阅读 ${secs}s`);
        await linger(cdp, log, secs);
      } else {
        // readSeconds=0：不耗阅读时长，只等页面加载完就过
        log.info('文档/PPT 类节点：按配置不耗时间，直接跳过');
        await sleep(3000);
      }
      const doneNow = await cdp
        .evaluate(`(function(){const el=document.getElementById('cur${ch.kid}');return !!(el&&el.querySelector('.icon_Completed'))})()`)
        .catch(() => false);
      if (doneNow) { log.ok('任务点已标记完成'); done++; }
      else { log.warn('停留后仍未标记完成（可能需更长阅读时长）；继续下一节'); skipped++; }
    }
    log.ok(`进度：完成 ${done} / 跳过 ${skipped} / 失败 ${failed} / 剩 ${todo.length - n - 1}`);
  }
  log.ok(`本课程处理完毕：完成 ${done}，跳过 ${skipped}，失败 ${failed}`);
}

const CLICK_CHAPTER_FN = `(function(idx, kid){
  const items = [...document.querySelectorAll('.posCatalog_select')];
  let el = kid ? items.find(e => e.id === 'cur' + kid) : items[idx];
  if (!el) return { ok: false, why: 'not found', n: items.length };
  const nameEl = el.querySelector('.posCatalog_name');
  if (!nameEl) return { ok: false, why: 'no clickable name' };
  const before = (document.getElementById('iframe') || {}).src || '';
  nameEl.click();
  return { ok: true, name: (nameEl.getAttribute('title') || nameEl.innerText || '').trim().slice(0, 40), before: before.slice(0, 80) };
})`;

async function clickChapter(cdp, idx, kid) {
  // 已经是当前章节就不用点（点了 iframe 也不会变，白等 14 秒）
  const curKid = await cdp
    .evaluate(`((document.getElementById('iframe')||{}).src||'').match(/knowledgeid=(\\d+)/)?.[1] || ''`)
    .catch(() => '');
  if (kid && curKid === String(kid)) return { ok: true, skipped: true, name: '(已是当前节)' };

  const r = await cdp.evaluate(`(${CLICK_CHAPTER_FN})(${idx}, ${JSON.stringify(kid || '')})`);
  if (!r || !r.ok) throw new Error('目录项点击失败: ' + JSON.stringify(r));
  // 等 iframe src 真的变了（知识页是 SPA 换 iframe，顶层 URL 不变）
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const now = await cdp
      .evaluate(`((document.getElementById('iframe')||{}).src||'').match(/knowledgeid=(\\d+)/)?.[1] || ''`)
      .catch(() => '');
    if (now && now !== curKid) break;
  }
  return r;
}

const DETECT_FN = `(function(){
  const hasQ = document.querySelectorAll('[id^="question"]').length > 0;
  let hasV = document.querySelectorAll('video').length > 0;
  return { hasQ, hasV, url: location.href, title: document.title };
})()`;

async function detectKind(cdp) {
  const kid = await cdp
    .evaluate(`((document.getElementById('iframe')||{}).src||'').match(/knowledgeid=(\\d+)/)?.[1] || ''`)
    .catch(() => '');
  const scope = await cdp.subtreeCtxIds(kid).catch(() => null);
  const all = await cdp.evaluateAll(DETECT_FN, scope ? { onlyContexts: scope } : {});
  let hasQ = false, hasV = false;
  for (const r of all) {
    if (!r.value) continue;
    if (r.value.hasQ) hasQ = true;
    if (r.value.hasV) hasV = true;
  }
  if (hasQ) return 'questions';
  if (hasV) return 'video';
  return 'other';
}

module.exports = { handleQuestions, runCourse, detectKind, clickChapter, linger };
