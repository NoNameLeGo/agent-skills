#!/usr/bin/env node
/**
 * 学习通自动刷课做题 —— CLI 入口
 *
 * 用法：
 *   node run.js status                     检查 Edge 调试端口 / 页面 / 登录态
 *   node run.js open <url>                 在调试实例里打开一个页面
 *   node run.js probe                      打印当前页面的 DOM 结构（调选择器用）
 *   node run.js quiz [--submit]            处理当前页面上的题（默认只暂存）
 *   node run.js course [--url <课程页>]     刷一门课（视频自动过、测验提交、作业暂存）
 *   node run.js probe-answer               只看答案链能不能用（不碰页面）
 */
const { connect, listTargets, isAlive, version, sleep } = require('./src/cdp');
const { loadConfig, makeLogger, acquireLock } = require('./src/util');
const { extractQuestions } = require('./src/extract');
const { probe } = require('./src/study');
const { handleQuestions, runCourse } = require('./src/flow');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}
const has = f => process.argv.includes(f);

const LOGIN_RE = /passport|chaoxing\.com\/login|\/login|cas\.chaoxing/;

(async () => {
  const cmd = process.argv[2] || 'status';
  const release = ['status', 'probe', 'quiz', 'course', 'open', 'submit'].includes(cmd) ? acquireLock() : null;
  const log = makeLogger(cmd);

  if (cmd === 'status') {
    const cfg = (() => { try { return loadConfig(); } catch { return { cdpPort: 9223 }; } })();
    const port = cfg.cdpPort;
    const alive = await isAlive(port);
    log.info(`调试端口 ${port}: ${alive ? '存活' : '未响应'}`);
    if (!alive) {
      log.out('启动方式：双击 D:\\Vibe-Coding\\chaoxing-auto\\edge-start.cmd');
      return;
    }
    const v = await version(port);
    log.ok('Browser: ' + v.Browser);
    const ts = (await listTargets(port)).filter(t => t.type === 'page');
    log.info('页面数: ' + ts.length);
    for (const t of ts) log.out(`- ${String(t.title).slice(0, 40)} | ${String(t.url).slice(0, 90)}`);
    const cx = ts.find(t => /chaoxing|xuexitong/.test(t.url || ''));
    if (cx) log.ok('检测到学习通页面，登录态看起来正常');
    else log.warn('当前没有学习通页面，先 open 一个');
    return;
  }

  const cfg = loadConfig();
  const port = cfg.cdpPort;

  if (cmd === 'open') {
    const url = process.argv[3];
    if (!url) throw new Error('用法: node run.js open <url>');
    const cdp = await connect({ port, preferNew: true, openUrl: url });
    await cdp.navigate(url, 3000);
    log.ok('已打开: ' + url);
    log.info('地址: ' + (await cdp.evaluate('location.href')));
    cdp.close();
    return;
  }

  // 其余命令都需要浏览器：优先连学习通的标签页
  let cdp;
  for (const hint of ['chaoxing', 'xuexitong', null]) {
    try { cdp = await connect({ port, urlIncludes: hint }); break; } catch (e) { if (!hint) throw e; }
  }
  if (!cdp) throw new Error('连不上浏览器');

  if (cmd === 'probe') {
    await probe(cdp, log);
    const q = await extractQuestions(cdp, log).catch(() => null);
    if (q) log.info(`抓到题目 ${q.questions.length} 道，类型 ${q.kind}`);
    cdp.close();
    return;
  }

  if (cmd === 'quiz') {
    const href = await cdp.evaluate('location.href');
    if (LOGIN_RE.test(href)) throw new Error('当前在登录页，请先在 Edge 窗口里登录学习通');
    log.info('当前页: ' + String(href).slice(0, 110));
    const autoSubmit = has('--submit');
    const ansFile = arg('answers');
    let preset = null;
    if (ansFile) { preset = JSON.parse(require('fs').readFileSync(ansFile, 'utf8')); log.info('外部答案: ' + ansFile); }
    log.info('模式: ' + (autoSubmit ? '填答 + 提交（不可逆）' : '填答 + 只暂存'));
    await handleQuestions(cdp, cfg, log, { autoSubmit, tag: 'quiz', presetAnswers: preset });
    cdp.close();
    return;
  }

  if (cmd === 'videoquiz') {
    // 处理视频播放中的弹题（ananas 新版视频模块的 .ans-videoquiz 覆盖层）
    const { BOX_FN, answerVideoQuiz, dismissVideoQuiz } = require('./src/videoquiz');
    const rs = await cdp.evaluateAll(BOX_FN, { timeoutMs: 12000 });
    const hit = rs.find(r => r.value && r.value.count);
    if (!hit) { log.warn('当前没有可见的视频弹题'); cdp.close(); return; }
    log.info(`弹题上下文 ${hit.contextId}｜${hit.value.title} ${hit.value.count} 题｜${hit.value.rightText}`);
    if (hit.value.continueVisible) {
      log.info('弹题已作答，只点「继续学习」');
      await dismissVideoQuiz(cdp, hit.contextId);
    } else {
      await answerVideoQuiz(cdp, hit.contextId, cfg, log, hit.value);
    }
    cdp.close();
    return;
  }

  if (cmd === 'submit') {
    // 只提交当前页面上已经填好的答案（不重新抽题、不改答案），用于「暂存后人工确认再交卷」
    const probes = await cdp.evaluateAll(`document.querySelectorAll('[id^="question"]').length`, { timeoutMs: 8000 });
    const hit = probes.find(p => typeof p.value === 'number' && p.value > 0);
    if (!hit) throw new Error('当前页面没有题目，先进入测验/作业页');
    log.info(`题目所在上下文 ${hit.contextId}，共 ${hit.value} 题`);
    const { submitNow } = require('./src/fill');
    await submitNow(cdp, log, hit.contextId);
    await sleep(3000);
    const info = await cdp.evaluate(
      `(function(){
        const t = (document.body.innerText||'').replace(/\\s+/g,' ');
        const score = (t.match(/得分[:：]?\\s*[\\d.]+/) || t.match(/[\\d.]+\\s*分/) || [''])[0];
        return JSON.stringify({ url: location.href.slice(0,120), score, head: t.slice(0,160) });
      })()`,
      { contextId: hit.contextId }
    ).catch(() => '{}');
    log.ok('提交后： ' + info);
    cdp.close();
    return;
  }

  if (cmd === 'shot') {
    const out = process.argv[3] || 'state/shot.png';
    const fs = require('fs');
    const path = require('path');
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const p = path.resolve(out);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    log.ok('截图: ' + p);
    cdp.close();
    return;
  }

  if (cmd === 'course') {
    const url = arg('url');
    if (url) {
      await cdp.navigate(url, 4000);
      log.info('已进入课程页: ' + url);
    }
    const href = await cdp.evaluate('location.href');
    if (LOGIN_RE.test(href)) throw new Error('当前在登录页，请先在 Edge 窗口里登录学习通');
    if (!/studentstudy/.test(href)) throw new Error('当前不是课程学习页（应含 mycourse/studentstudy）：' + href);
    let fromKid = null;
    if (has('--from-here')) {
      fromKid = await cdp.evaluate(`((document.getElementById('iframe')||{}).src||'').match(/knowledgeid=(\\d+)/)?.[1] || ''`).catch(() => '');
      if (fromKid) log.info('从当前节点之后开始，当前 kid=' + fromKid);
      else log.warn('读不到当前节点，将从第一个未完成节点开始');
    }
    await runCourse(cdp, cfg, log, { maxChapters: parseInt(arg('max', '200'), 10), fromKid });
    cdp.close();
    return;
  }

  if (cmd === 'eval') {
    const js = process.argv[3];
    if (!js) throw new Error('用法: node run.js eval "<js>" [--all]');
    if (has('--all')) {
      const rs = await cdp.evaluateAll(js);
      for (const r of rs) console.log(JSON.stringify(r.error ? { ctx: r.contextId, err: r.error } : { ctx: r.contextId, v: r.value }, null, 2));
    } else {
      console.log(JSON.stringify(await cdp.evaluate(js), null, 2));
    }
    cdp.close();
    return;
  }

  if (cmd === 'list') {
    const { listChapters } = require('./src/study');
    const ch = await listChapters(cdp, log);
    const w = ch.items.filter(i => !i.header && i.kid);
    log.out(`条目 ${ch.count}，可处理 ${w.length}，已完成 ${w.filter(i => i.done).length}`);
    w.slice(0, 40).forEach(it => log.out(`${it.done ? '[x]' : '[ ]'} ${it.kid}  ${it.name}`));
    cdp.close();
    return;
  }

  if (cmd === 'probe-answer') {
    const { solve } = require('./src/answer');
    const demo = [
      { qid: '1', qtype: 'single', stem: '下列哪种数据结构是先进先出？', options: [{ data: 'A', text: '栈' }, { data: 'B', text: '队列' }, { data: 'C', text: '树' }, { data: 'D', text: '图' }], blanks: 0 },
      { qid: '2', qtype: 'judge', stem: '二叉树的每个结点最多有两个子结点。', options: [{ data: 'true', text: '对' }, { data: 'false', text: '错' }], blanks: 0 },
    ];
    const { answers, unsolved } = await solve(demo, cfg.answer, log, { port });
    log.ok('答案: ' + JSON.stringify(answers));
    if (unsolved.length) log.warn('未解: ' + unsolved.map(q => q.qid).join(','));
    return;
  }

  log.err('未知命令: ' + cmd);
  console.log('可用: status | open <url> | probe | quiz [--submit] | course [--url <url>] | probe-answer');
})().catch(e => {
  console.error('\n[x] ' + e.message);
  process.exit(1);
});
