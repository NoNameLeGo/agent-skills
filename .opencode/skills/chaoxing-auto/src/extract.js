/**
 * 题目抽取（全 main-world 上下文遍历，含 iframe）+ 页面类型识别。
 * DOM 事实来自 chaoxing-cdp-autofill 的实测结论，本文件是唯一需要跟着页面改的地方。
 */

const { decodeStrings } = require('./decode');

const EXTRACT_SRC = `(() => {
  const txt = el => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
  // 公式题正文/选项是图片，真值在 img.ans-latex-moudle 的 data 上（URL 编码的带引号 LaTeX）
  const latex = root => {
    const imgs = root ? root.querySelectorAll('img.ans-latex-moudle') : [];
    if (!imgs.length) return '';
    return [...imgs].map(im => {
      const d = im.getAttribute('data') || '';
      try { return decodeURIComponent(d).replace(/^"|"$/g, ''); } catch { return d; }
    }).join(' ').trim();
  };

  const res = { url: location.href, title: document.title, questions: [] };
  const nodes = document.querySelectorAll('[id^="question"]');
  const seen = new Set();
  nodes.forEach(node => {
    const m = (node.id || '').match(/^question(\\d+)$/);
    if (!m) return;
    const qid = m[1];
    if (seen.has(qid)) return;
    seen.add(qid);

    const qtypeAttr = node.getAttribute('qtype') || (node.querySelector('[qtype]') || {}).getAttribute?.('qtype') || '';
    let stem = '';
    for (const s of ['.Zy_TItle .qtContent', '.qtContent', '.Zy_TItle', '.mark_name', '.q_content', '.subject', '.questionTitle']) {
      const e = node.querySelector(s);
      if (e && (txt(e) || latex(e))) { stem = txt(e) || latex(e); break; }
    }
    if (!stem) {
      const c = node.cloneNode(true);
      c.querySelectorAll('.answerBg, textarea, iframe, script, style, .mark_answer').forEach(x => x.remove());
      stem = txt(c) || latex(c);
    }
    const stemTex = latex(node.querySelector('.mark_name') || node);
    if (stemTex && !stem.includes(stemTex)) stem = (stem + ' ' + stemTex).trim();
    stem = stem.replace(/^(\\d+\\s*[\\\\.、,，]?\\s*)+/, '').replace(/[（(]\\s*\\d+(\\.\\d+)?\\s*分\\s*[)）]/g, '').trim();

    const options = [];
    // 布局 A：div.answerBg（老版作业页）
    node.querySelectorAll('.answerBg').forEach(bg => {
      const span = bg.querySelector('span.num_option') || bg.querySelector('span.num_option_dx') || bg.querySelector('[data]');
      const t = txt(bg) || latex(bg);
      if (span) options.push({ data: span.getAttribute('data') || '', text: t });
    });
    // 布局 B：li[qid][qtype] > span.num_option[data] + a.after（doHomeWorkNew）
    if (!options.length) {
      node.querySelectorAll('li[qid]').forEach(li => {
        const span = li.querySelector('span.num_option') || li.querySelector('span.num_option_dx');
        const after = li.querySelector('a.after') || li.querySelector('.after');
        let t = after ? txt(after) : txt(li);
        if (!after) t = t.replace(/^[A-Z]\\s*/, '');
        const tex = latex(li);
        if (tex) t = (t + ' ' + tex).trim();
        options.push({
          data: span ? (span.getAttribute('data') || '') : '',
          // 关键：span 里的文字才是页面显示的 A/B/C/D，data 是真正要提交的答案码（顺序可能被打乱）
          label: span ? txt(span).replace(/[^A-Za-z]/g, '').toUpperCase() : '',
          text: t,
        });
      });
      // 按显示字母排序，保证 options[0] 对应 A
      if (options.some(o => o.label)) {
        options.sort((a, b) => (a.label || 'ZZ').localeCompare(b.label || 'ZZ'));
      }
    }

    // 布局 C：div.TiMu.newTiMu（2025-10 新版章节测验）
    //   <ul class="Zy_ulTop qtDetail"><li class="clearfix"><i class="fl">A、</i><a ...>选项文本</a></li>
    //   没有 li[qid]、没有 span.num_option、没有 .answerBg，字母在 <i> 里
    if (!options.length) {
      node.querySelectorAll('ul.Zy_ulTop li, ul.qtDetail li').forEach(li => {
        const i = li.querySelector('i');
        const a = li.querySelector('a');
        if (!i || !a) return;
        const label = txt(i).replace(/[^A-Za-z]/g, '').toUpperCase();
        if (!label) return;
        const t = txt(a) || txt(li);
        options.push({ data: label, label, text: t, from: 'newTiMu' });
      });
    }

    // 判断：选项 data 是 true/false
    let qtype = qtypeAttr || (node.querySelector('li[qtype]') || {}).getAttribute?.('qtype') || '';
    if (!qtype && options.length) {
      const ds = options.map(o => String(o.data).toLowerCase());
      if (ds.length === 2 && ds.includes('true') && ds.includes('false')) qtype = '3';
    }
    if (!qtype) {
      const isDx = !!node.querySelector('span.num_option_dx');
      if (isDx) qtype = '1';
      else if (options.length) qtype = '0';
    }
    // 兜底：已批阅/结果页没有 li[qid]，从整段文本里按 "A、 xxx" 反解选项
    if (!options.length) {
      const rt = txt(node);
      const re = /(?:^|[\\s　])([A-H])[\\s]*[、\\.．)）]\\s*([^A-H]{1,80}?)(?=(?:[\\s　][A-H][\\s]*[、\\.．)）])|我的答案|正确答案|$)/g;
      let m2, guard = 0;
      while ((m2 = re.exec(rt)) && guard++ < 10) {
        const t2 = m2[2].replace(/\\s+/g, ' ').trim();
        if (t2) options.push({ data: m2[1], label: m2[1], text: t2, from: 'rawText' });
      }
    }

    if (!qtypeAttr) {
      const st = txt(node).slice(0, 40);
      if (/【\\s*多选/.test(st)) qtype = '1';
      else if (/【\\s*判断/.test(st)) qtype = '3';
      else if (/【\\s*单选/.test(st)) qtype = '0';
    }

    // 判断题兜底：页面固定是 对=true / 错=false，选项没解析出来也补上，否则模型无从判断
    if ((qtype === '3' || qtype === 'judge') && options.length < 2) {
      options.length = 0;
      options.push({ data: 'true', label: 'A', text: '对', from: 'judge' });
      options.push({ data: 'false', label: 'B', text: '错', from: 'judge' });
    }

    const editors = [];
    node.querySelectorAll('textarea[id^="answerEditor"]').forEach(t => { if (!editors.includes(t.id)) editors.push(t.id); });
    if (editors.length) qtype = 'fill';

    // rawText 反解出来的选项不能点击（已批阅页），只有真实 DOM 选项才算「可填答」
    const fillable = options.filter(o => o.from !== 'rawText').length;
    const typeMap = { '0': 'single', '1': 'multi', '3': 'judge', fill: 'fill' };
    res.questions.push({
      qid,
      qtype: typeMap[String(qtype)] || 'single',
      stem,
      options,
      fillable,
      editors,
      blanks: editors.length || 0,
      rawText: txt(node).slice(0, 1200),
    });
  });
  res.questions.sort((a, b) => parseInt(a.qid) - parseInt(b.qid));
  res.bodyLen = document.body ? document.body.innerText.length : 0;
  res.bodyHead = document.body ? document.body.innerText.slice(0, 1500) : '';
  res.hasSubmit = typeof submitWork === 'function' || typeof saveWork === 'function';
  return res;
})()`;

const KIND_SRC = `(() => {
  const u = location.href;
  const t = document.title || '';
  return { url: u, title: t };
})()`;

function kindOf(url, title = '') {
  if (/\/work\/dowork/.test(url)) return 'work';
  if (/\/work\/task/.test(url)) return 'work';
  if (/exam.*test|test.*reVersion|\/exam\/starttest/i.test(url)) return 'exam';
  if (/chapter|doworkq|quiz/i.test(url)) return 'work';
  if (/考试/.test(title)) return 'exam';
  if (/作业/.test(title)) return 'work';
  return 'unknown';
}

/** 在所有上下文里跑抽取，返回题目最多的那一份 */
async function extractQuestions(cdp, log) {
  // 只扫「当前章节」那棵 iframe 子树，避免把上一节残留 iframe 里的题目也算进来
  const kid = await cdp
    .evaluate(`((document.getElementById('iframe')||{}).src||'').match(/knowledgeid=(\\d+)/)?.[1] || ''`)
    .catch(() => '');
  const scope = await cdp.subtreeCtxIds(kid).catch(() => null);
  if (log && kid) log.info(`当前章节 kid=${kid}，限定上下文 ${scope ? scope.join(',') : '（全部）'}`);
  const all = await cdp.evaluateAll(EXTRACT_SRC, scope ? { onlyContexts: scope } : {});
  let best = { questions: [], url: '', title: '', bodyHead: '', hasSubmit: false, ctx: null };
  const stat = [];
  for (const r of all) {
    if (r.error) { stat.push({ ctx: r.contextId, err: r.error.slice(0, 60) }); continue; }
    const v = r.value;
    if (!v) continue;
    stat.push({ ctx: r.contextId, n: v.questions.length, url: String(v.url || '').slice(0, 60) });
    if (v.questions.length > best.questions.length) best = { ...v, ctx: r.contextId };
  }
  if (log) log.info('各上下文题目数: ' + JSON.stringify(stat));
  const kind = kindOf(best.url, best.title);

  // 解防复制字体：题干/选项里被打乱的码位还原成真字
  if (best.questions.length) {
    const texts = [];
    best.questions.forEach(q => { texts.push(q.stem); q.options.forEach(o => texts.push(o.text)); });
    const { texts: decoded } = await decodeStrings(cdp, texts, log);
    let i = 0;
    best.questions.forEach(q => {
      q.stem = decoded[i++];
      q.options.forEach(o => { o.text = decoded[i++]; });
    });
  }

  if (log) log.info(`页面类型=${kind}  题目数=${best.questions.length}  ${best.url.slice(0, 90)}`);
  return { ...best, kind };
}

/** 抽取后自检：题型分布是否合理（防止把判断题当单选题答） */
function sanityCheck(questions, log) {
  const by = {};
  for (const q of questions) by[q.qtype] = (by[q.qtype] || 0) + 1;
  if (log) log.info('题型分布: ' + JSON.stringify(by));
  const bad = questions.filter(q => (q.qtype === 'single' || q.qtype === 'multi') && q.options.length < 2);
  if (bad.length && log) log.warn('选项数 < 2 的题: ' + bad.map(q => q.qid).join(','));
  return bad;
}

module.exports = { extractQuestions, sanityCheck, kindOf, EXTRACT_SRC };
