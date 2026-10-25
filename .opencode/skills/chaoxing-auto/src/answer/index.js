/**
 * 四级降级链调度：
 *   freeai（免费 AI，带 key） → webai（网页 AI） → websearch（必应） → localllm（本地模型）
 * 每一级只处理「还没解出来」的题，解不出来自然落到下一级。
 * 命中过的题目按题干哈希缓存，同题再遇到直接复用（学习通题库重复率很高）。
 */
const crypto = require('crypto');
const { readJson, saveJson, mapLimit } = require('../util');

const CACHE_FILE = 'answer-cache.json';

const qkey = q => crypto.createHash('md5').update(String(q.qtype) + '|' + String(q.stem).replace(/\s+/g, '')).digest('hex').slice(0, 16);

const TIERS = {
  freeai: require('./openaiCompat'),
  webai: require('./webai'),
  websearch: require('./websearch'),
  localllm: require('./openaiCompat'),
};

async function solve(questions, cfg, log, ctx = {}) {
  const cache = readJson(CACHE_FILE, {}) || {};
  const answers = {};
  const pending = [];

  for (const q of questions) {
    const hit = cache[qkey(q)];
    if (hit) {
      // 缓存里存的是扁平的 {type,ans}，这里必须还原成 {ans:{type,ans}}，否则 buildPlan 解不出目标选项
      answers[q.qid] = { ans: { type: hit.type, ans: hit.ans }, src: (hit.src || 'cache') + '(cache)' };
    } else {
      pending.push(q);
    }
  }
  if (Object.keys(answers).length) log.ok(`缓存命中 ${Object.keys(answers).length}/${questions.length}`);

  let rest = pending;
  const chain = (cfg.chain || ['freeai', 'webai', 'websearch', 'localllm']).filter(n => TIERS[n]);

  for (const name of chain) {
    if (!rest.length) break;
    const tierCfg = cfg[name];
    if (!tierCfg || tierCfg.enabled === false) { log.info(`${name} 已关闭，跳过`); continue; }
    const t0 = Date.now();
    log.info(`— ${name}：待解 ${rest.length} 题`);
    let got = new Map();
    try {
      if (name === 'freeai' || name === 'localllm') {
        got = await TIERS[name].runTier(rest, { ...tierCfg }, log, name);
      } else {
        got = await TIERS[name].runTier(rest, tierCfg, log, ctx);
      }
    } catch (e) {
      log.warn(`${name} 整级失败: ${e.message}`);
    }
    for (const [qid, v] of got) {
      answers[qid] = v;
      const q = rest.find(x => x.qid === qid);
      if (q) cache[qkey(q)] = { type: v.ans.type, ans: v.ans.ans, src: v.src };
    }
    rest = rest.filter(q => !answers[q.qid]);
    log.info(`— ${name} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，剩余 ${rest.length}`);
  }

  // 双模型交叉校验：主模型与备用模型答案不一致的题，交给备用模型带着双方答案再裁一次。
  // 两个模型错的地方往往不同（实测 agnes 与 dots3 各有 1 题不同），交叉后准确率明显更高。
  if (cfg.crossCheck && Object.keys(answers).length) {
    const fb = (cfg.freeai && cfg.freeai.fallbacks && cfg.freeai.fallbacks[0]) || null;
    if (fb) {
      const checkQs = questions.filter(q => answers[q.qid]);
      log.info('— 交叉校验：' + checkQs.length + ' 题');
      let second = new Map();
      try {
        const { runTier } = require('./openaiCompat');
        second = await runTier(checkQs, { ...fb, enabled: true, batchSize: 6, timeoutMs: 120000 }, log, 'crosscheck');
      } catch (e) { log.warn('交叉校验失败: ' + e.message); }
      const diffs = [];
      for (const q of checkQs) {
        const a = answers[q.qid], b = second.get(q.qid);
        if (!b) continue;
        const ka = JSON.stringify(a.ans.ans), kb = JSON.stringify(b.ans.ans);
        if (ka !== kb) diffs.push({ q, a: a.ans, b: b.ans });
      }
      if (diffs.length) {
        log.warn(`交叉校验发现 ${diffs.length} 题不一致，正在裁决`);
        for (const d of diffs) {
          const hint = `下面这道题两个模型给了不同答案，请独立重新推理，只输出该题的 JSON。\n` +
            `【${d.q.qid}】${d.q.stem}\n` +
            d.q.options.map((o, i) => '  ' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] + '. ' + o.text).join('\n') +
            `\n候选：甲=${JSON.stringify(d.a.ans)}，乙=${JSON.stringify(d.b.ans)}`;
          try {
            const { chat } = require('./openaiCompat');
            const txt = await chat(cfg.freeai, hint, { timeoutMs: 120000, log });
            const { extractJson, normalizeAnswer } = require('./prompt');
            const j = extractJson(txt) || {};
            const ans = normalizeAnswer(d.q, j[d.q.qid] || Object.values(j)[0]);
            if (ans) {
              answers[d.q.qid] = { ans, src: 'arbitrated' };
              log.ok(`qid=${d.q.qid} 裁决为 ${JSON.stringify(ans.ans)}（甲${JSON.stringify(d.a.ans)}/乙${JSON.stringify(d.b.ans)}）`);
            } else {
              log.warn(`qid=${d.q.qid} 裁决无结果，保留主模型答案 ${JSON.stringify(d.a.ans)}`);
            }
          } catch (e) { log.warn('裁决失败: ' + e.message); }
        }
      } else {
        log.ok('交叉校验：两模型完全一致');
      }
    }
  }

  // 兜底补答：主模型漏解的题，直接交给备用 API 模型（dots3）再答一次。
  // 比 webai（网页版千问）快一个数量级，而且不会新开标签页、不吃 UI 时序。
  if (rest.length) {
    const fb = (cfg.freeai && cfg.freeai.fallbacks && cfg.freeai.fallbacks[0]) || null;
    if (fb) {
      log.info('— 备用模型补答未解 ' + rest.length + ' 题');
      try {
        const { runTier } = require('./openaiCompat');
        const m2 = await runTier(rest, { ...fb, enabled: true, batchSize: 6, timeoutMs: 120000 }, log, 'fallback-answer');
        for (const [qid, v] of m2) {
          if (answers[qid]) continue;
          answers[qid] = { ans: v.ans, src: 'fallback' };
          const q = rest.find(x => x.qid === qid);
          if (q) cache[qkey(q)] = { type: v.ans.type, ans: v.ans.ans, src: v.src };
        }
        rest = rest.filter(q => !answers[q.qid]);
        log[rest.length ? 'warn' : 'ok'](`备用模型补答后剩余 ${rest.length} 题未解`);
      } catch (e) { log.warn('备用模型补答失败: ' + e.message); }
    }
  }

  saveJson(CACHE_FILE, cache);
  return { answers, unsolved: rest };
}

module.exports = { solve, qkey, TIERS };
