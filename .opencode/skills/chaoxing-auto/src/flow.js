/**
 * 单页 / 单课程流程编排。
 * 一条流水线：抽题 → 四级降级出答案 → 填答 → （测验提交 / 作业暂存） → 复核
 */
const { extractQuestions, sanityCheck } = require('./extract');
const { solve } = require('./answer');
const { applyAnswers, saveDraft, submitNow, verify, relocalCtx } = require('./fill');
const { listChapters, watchCurrent, probe } = require('./study');
const { openReadingTask } = require('./reading');
const { sleep, saveJson } = require('./util');
const { randInt } = require('./util');

/** 当前章节 knowledgeid（取自外层 #iframe 的 src） */
const KID_EXPR = "((document.getElementById('iframe')||{}).src||'').match(/knowledgeid=(\\d+)/)?.[1] || ''";

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
    q => (q.qtype === 'single' || q.qtype === 'multi' || q.qtype === 'judge') && (q.fillable || 0) < 2
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

  let done = 0, skipped = 0, failed = 0, switchFailStreak = 0, lastGradedKid = '';
  for (let n = 0; n < todo.length && n < maxChapters; n++) {
    const ch = todo[n];
    log.info(`—— [${n + 1}/${todo.length}] ${ch.name || ch.kid}（kid=${ch.kid}）`);
    let sw = null;
    try {
      sw = await clickChapter(cdp, ch.i, ch.kid);
      switchFailStreak = 0;
    } catch (e) {
      log.err('打开章节失败: ' + e.message);
      failed++;
      if (++switchFailStreak >= 3) { log.err('连续 3 节打不开，停止（避免空转吞节点）'); break; }
      continue;
    }
    await sleep(3500);

    // 服务端「顺序解锁」会把请求退回当前待完成任务点 → 以页面上真实的 kid 为准，别拿目录里的 kid 硬认
    const liveKid = await cdp.evaluate(KID_EXPR).catch(() => '');
    const effKid = liveKid || ch.kid;
    if (sw && sw.redirected) log.warn(`服务端退回待完成节点 kid=${effKid}（请求的是 ${ch.kid}）`);

    // 视频/题目是异步加载进 iframe 的，刚点进来时可能还是空的 —— 判成 other 后再多看几眼
    let kind = await detectKind(cdp);
    for (let t = 0; t < 4 && kind === 'other'; t++) {
      await sleep(2500);
      kind = await detectKind(cdp);
    }
    // 已批阅页（selectWorkQuestionYiPiYue）= 这题之前已经交过，没有可点击的选项，跳过。
    // 注意：它在嵌套 iframe 里，只能扫当前章节子树的 URL 才看得到。
    const scopeIds = await cdp.subtreeCtxIds(await cdp.evaluate(KID_EXPR).catch(() => '')).catch(() => null);
    const urls = await cdp.evaluateAll('location.href', scopeIds ? { onlyContexts: scopeIds } : {}).catch(() => []);
    const graded = urls.some(x => /selectWorkQuestion/i.test(String(x.value || '')));
    log.info(`本节类型：${kind}${graded ? '（已批阅，跳过）' : ''}`);
    if (graded) {
      // 同一节点连续两次被判「已批阅」= 页面根本没走（服务端一直退回这一节），
      // 再往下点只会把后面全部吞掉，直接停。
      if (effKid === lastGradedKid) { log.err(`节点 kid=${effKid} 重复停在已批阅页，切换没生效，停止`); break; }
      lastGradedKid = effKid;
      skipped++;
      await sleep(1500);
      continue;
    }
    lastGradedKid = '';

    if (kind === 'questions') {
      const r = await handleQuestions(cdp, cfg, log, {
        autoSubmit: cfg.study?.chapterQuiz?.autoSubmit !== false,
        tag: `ch_${effKid}`,
      });
      r && r.ok ? done++ : failed++;
    } else if (kind === 'video') {
      const r = await watchCurrent(cdp, cfg, log, { maxMinutes: cfg.study?.maxMinutesPerPage || 45 });
      if (r.type === 'video-ended') done++;
      else if (r.type === 'no-video') skipped++;
      else failed++;
    } else {
      // 文档 / PPT / 阅读类任务点。
      // 「阅读」类（readjobv2/show）页面只给入口，必须点「去阅读」跳进阅读器才计时，光停留没用
      let openedReading = false;
      try {
        openedReading = await openReadingTask(cdp, cfg, log, { kid: effKid });
      } catch (e) { log.warn('阅读节点处理异常: ' + e.message); }

      if (!openedReading) {
        const secs = cfg.study?.readSeconds ?? 0;
        if (secs > 0) {
          log.info(`文档/PPT 类任务点，模拟阅读 ${secs}s`);
          await linger(cdp, log, secs);
        } else {
          // readSeconds=0：不耗阅读时长，只等页面加载完就过
          log.info('文档/PPT 类节点：按配置不耗时间，直接跳过');
          await sleep(3000);
        }
      }
      const doneNow = await cdp
        .evaluate(`(function(){const el=document.getElementById('cur${effKid}');return !!(el&&el.querySelector('.icon_Completed'))})()`)
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

/**
 * 兜底：直接调页面里的 getTeacherAjax(cid, clazzid, kid)。
 * 实测部分目录项（已批阅/未解锁节点）的 .posCatalog_name 上没有 onclick 属性，
 * click() 点了没反应 → 之前会一路「已批阅，跳过」把整章吞掉。
 * cid/clazzid 从任意一个带 onclick 的兄弟节点里抠出来。
 */
const AJAX_SWITCH_FN = `(function(kid){
  try {
    var any = document.querySelector('.posCatalog_name[onclick*="getTeacherAjax"]');
    var oc = any ? any.getAttribute('onclick') : '';
    var m = oc.match(/getTeacherAjax\\(\\s*'?(\\d+)'?\\s*,\\s*'?(\\d+)'?/);
    if (!m) return { ok: false, why: 'no cid/clazzid on page' };
    if (typeof getTeacherAjax !== 'function') return { ok: false, why: 'getTeacherAjax missing' };
    getTeacherAjax(m[1], m[2], kid);
    return { ok: true, cid: m[1], clazzid: m[2] };
  } catch (e) { return { ok: false, why: e.message }; }
})`;

/** 轮询等 iframe 的 knowledgeid 变化，返回最新 kid（超时返回原值） */
async function waitKidChange(cdp, prevKid, tries = 14) {
  for (let i = 0; i < tries; i++) {
    await sleep(700);
    const now = await cdp.evaluate(KID_EXPR).catch(() => '');
    if (now && now !== prevKid) return now;
  }
  return prevKid;
}

async function clickChapter(cdp, idx, kid) {
  // 已经是当前章节就不用点（点了 iframe 也不会变，白等 14 秒）
  const curKid = await cdp.evaluate(KID_EXPR).catch(() => '');
  if (kid && curKid === String(kid)) return { ok: true, skipped: true, name: '(已是当前节)', finalKid: curKid };

  let finalKid = curKid;
  const r = await cdp.evaluate(`(${CLICK_CHAPTER_FN})(${idx}, ${JSON.stringify(kid || '')})`);
  if (r && r.ok) finalKid = await waitKidChange(cdp, curKid);

  // 点击没生效（无 onclick / 被拦）→ 直接调 getTeacherAjax
  if (!finalKid || finalKid === curKid) {
    const a = await cdp.evaluate(`${AJAX_SWITCH_FN}(${JSON.stringify(kid || '')})`).catch(() => null);
    if (a && a.ok) finalKid = await waitKidChange(cdp, curKid, 16);
    else if (!r || !r.ok) throw new Error('目录项点击失败且无兜底: ' + JSON.stringify(r) + ' / ' + JSON.stringify(a));
  }

  // 仍然没变 → 明确报错，绝不冒充「已批阅」往下跳（否则会把整章吞掉）
  if (!finalKid || finalKid === curKid) throw new Error(`章节切换未生效（停在 kid=${curKid || '?'}）`);
  return { ok: true, finalKid, redirected: !!(kid && finalKid !== String(kid)) };
}

const DETECT_FN = `(function(){
  const hasQ = document.querySelectorAll('[id^="question"]').length > 0;
  let hasV = document.querySelectorAll('video').length > 0;
  return { hasQ, hasV, url: location.href, title: document.title };
})()`;

async function detectKind(cdp) {
  const kid = await cdp.evaluate(KID_EXPR).catch(() => '');
  const scope = await cdp.subtreeCtxIds(kid).catch(() => null);
  const all = await cdp.evaluateAll(DETECT_FN, scope ? { onlyContexts: scope } : {});
  let hasQ = false, hasV = false;
  for (const r of all) {
    if (!r.value) continue;
    if (r.value.hasQ) hasQ = true;
    if (r.value.hasV) hasV = true;
  }
  if (hasQ) {
    // 只有题目真的长在 work 页里才算测验；知识点/阅读节的卡片里也可能残留在别的 #question 节点
    const urls = await cdp.evaluateAll('location.href', scope ? { onlyContexts: scope } : {}).catch(() => []);
    const isWork = urls.some(u => /\/work\/(doHomeWorkNew|selectWorkQuestion)/i.test(String(u.value || '')));
    return isWork ? 'questions' : (hasV ? 'video' : 'other');
  }
  if (hasV) return 'video';
  return 'other';
}

module.exports = { handleQuestions, runCourse, detectKind, clickChapter, linger };
