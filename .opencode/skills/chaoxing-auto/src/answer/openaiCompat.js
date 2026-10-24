/**
 * OpenAI 兼容 chat/completions 调用（tier1 免费 AI、tier4 本地 LLM 共用）
 */
const { SYSTEM_PROMPT, buildUserPrompt, extractJson, normalizeAnswer } = require('./prompt');

/** 依次试 cfg 本身和 cfg.fallbacks[]，第一个成功的胜出 */
async function chat(cfg, userPrompt, opts = {}) {
  const list = [cfg, ...(Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [])]
    .filter(c => c && c.baseURL && c.model);
  let lastErr = null;
  for (const c of list) {
    try { return await chatOnce(c, userPrompt, opts); }
    catch (e) { lastErr = e; if (opts.log) opts.log.warn('  provider ' + c.model + ' 失败: ' + e.message.slice(0, 90)); }
  }
  throw lastErr || new Error('没有可用的 provider');
}

async function chatOnce(cfg, userPrompt, { timeoutMs = 60000 } = {}) {
  const base = String(cfg.baseURL || '').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (cfg.apiKey || ''),
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature == null ? 0.1 : cfg.temperature,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统一实现：按 batchSize 切批，逐批问，解析后只保留能对上的题。
 * 返回 Map<qid, {ans, src}>
 */
async function runTier(questions, cfg, log, tierName) {
  const out = new Map();
  if (!cfg || !cfg.baseURL || (tierName === 'freeai' && !cfg.apiKey)) {
    log.warn(`${tierName} 未配置 baseURL/apiKey，跳过`);
    return out;
  }
  const size = cfg.batchSize || 6;
  const batches = [];
  for (let i = 0; i < questions.length; i += size) batches.push(questions.slice(i, i + size));

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    log.info(`${tierName} 批次 ${bi + 1}/${batches.length}（${batch.length} 题）`);
    let text = '';
    try {
      text = await chat(cfg, buildUserPrompt(batch), { timeoutMs: cfg.timeoutMs || 90000, log });
    } catch (e) {
      log.warn(`${tierName} 请求失败: ${e.message}`);
      continue;
    }
    const json = extractJson(text);
    if (!json) {
      log.warn(`${tierName} 返回无法解析为 JSON，原始前 200 字: ${String(text).slice(0, 200)}`);
      continue;
    }
    for (const q of batch) {
      const raw = json[q.qid];
      const ans = normalizeAnswer(q, raw);
      if (ans) out.set(q.qid, { ans, src: tierName });
    }
    log.ok(`${tierName} 批次 ${bi + 1} 解出 ${batch.filter(q => out.has(q.qid)).length}/${batch.length}`);
  }
  return out;
}

module.exports = { runTier, chat, chatOnce };
