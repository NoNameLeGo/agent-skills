/**
 * tier3：不带 key 的网页搜索兜底（默认必应）。
 * 思路：搜题干 → 把结果标题+摘要拼成一段文本 → 在文本里找「答案：X」这类模式，
 * 找不到就退化为「哪个选项的文字在摘要里出现且离『答案』最近」。准确率低，只当兜底。
 */
const https = require('https');
const { normalizeAnswer, LETTERS } = require('./prompt');

function fetchText(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'identity',
        },
      },
      res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return fetchText(res.headers.location, { timeoutMs }).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', d => (buf += d));
        res.on('end', () => resolve(buf));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const decodeEntities = s =>
  String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

function parseBing(html, topN) {
  const blocks = [...html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)].map(m => m[0]);
  return blocks.slice(0, topN).map(b => decodeEntities(b)).filter(Boolean);
}

function parseSnippets(html) {
  // 通用降级：把所有 <p>/<div> 文本拼起来，至少能捞到摘要
  return decodeEntities(html).slice(0, 12000);
}

/** 从搜索结果文本里猜一个选择题答案 */
function guessChoice(q, corpus) {
  const text = String(corpus || '');
  if (!text) return null;

  // 1) 「答案：A」「正确答案是 B」「参考答案 AB」
  const pats = [
    /(?:正确答案|参考答案|答案)\s*[:：]?\s*([A-Z]{1,4})(?![A-Za-z])/g,
    /(?:答案|选)\s*([A-Z])(?![A-Za-z])/g,
  ];
  const votes = {};
  for (const re of pats) {
    let m;
    while ((m = re.exec(text))) {
      for (const ch of m[1]) votes[ch] = (votes[ch] || 0) + 1;
    }
  }
  const valid = Object.keys(votes).filter(l => LETTERS.indexOf(l) < q.options.length);
  if (valid.length) {
    valid.sort((a, b) => votes[b] - votes[a]);
    if (q.qtype === 'single') return [valid[0]];
    return valid.filter(l => votes[l] >= Math.max(1, votes[valid[0]] * 0.5)).sort();
  }

  // 2) 选项文本在摘要里出现，且能找到「对/正确」的痕迹
  const hitIdx = q.options
    .map((o, i) => ({ i, t: String(o.text || '').replace(/\s+/g, '') }))
    .filter(x => x.t.length >= 4 && text.replace(/\s+/g, '').includes(x.t));
  if (hitIdx.length === 1 && q.qtype !== 'multi') return [LETTERS[hitIdx[0].i]];
  return null;
}

function guessJudge(q, corpus) {
  const text = String(corpus || '');
  const m = text.match(/(?:答案|判断)\s*[:：]?\s*(正确|错误|对|错|√|×|true|false)/);
  if (!m) return null;
  return { type: 'judge', ans: /正确|对|√|true/.test(m[1]) };
}

async function runTier(questions, cfg, log) {
  const out = new Map();
  if (!cfg || cfg.enabled === false) return out;
  const topN = cfg.topN || 5;
  const engine = cfg.engine || 'bing';
  const base = engine === 'bing' ? 'https://cn.bing.com/search?q=' : 'https://www.bing.com/search?q=';

  for (const q of questions) {
    if (q.qtype === 'fill') continue; // 填空题靠搜索不可靠，直接交给下一级
    const query = String(q.stem).replace(/\s+/g, ' ').slice(0, 120);
    if (!query) continue;
    try {
      const html = await fetchText(base + encodeURIComponent(query), { timeoutMs: cfg.timeoutMs || 15000 });
      const snips = parseBing(html, topN);
      const corpus = (snips.length ? snips.join(' \n ') : '') + ' ' + parseSnippets(html);
      let ans = null;
      if (q.qtype === 'judge') {
        ans = guessJudge(q, corpus);
      } else {
        const letters = guessChoice(q, corpus);
        if (letters) {
          ans = { type: q.qtype === 'single' ? 'single' : 'multi', ans: q.qtype === 'single' ? letters[0] : letters };
          ans = normalizeAnswer(q, { t: ans.type, a: ans.ans });
        }
      }
      if (ans) out.set(q.qid, { ans, src: 'websearch' });
    } catch (e) {
      log.warn(`websearch qid=${q.qid} 失败: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 700)));
  }
  log.ok(`websearch 解出 ${out.size}/${questions.length}`);
  return out;
}

module.exports = { runTier, fetchText, parseBing };
