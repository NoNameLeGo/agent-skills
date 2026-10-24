/**
 * 题面 → 标准文本 → 解析回结构化答案。
 * 所有 tier 共用同一套 prompt / 解析，保证换后端不改行为。
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 把题干+选项渲染成给模型看的文本 */
function renderQuestion(q) {
  const lines = [`【${q.qid}】${q.qtype === 'judge' ? '(判断题)' : q.qtype === 'multi' ? '(多选题)' : q.qtype === 'fill' ? '(填空题)' : '(单选题)'} ${q.stem}`];
  q.options.forEach((o, i) => {
    lines.push(`  ${LETTERS[i]}. ${o.text}`);
  });
  if (q.qtype === 'fill') lines.push(`  共 ${q.blanks || 1} 个空`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `你是严谨的答题机器人。用户会给你一批从在线课程平台抓来的题目。
要求：
1. 只输出 JSON，不要任何解释、不要 markdown 代码块围栏。
2. 输出格式：{"406077138":{"t":"single","a":"D"},"406077162":{"t":"multi","a":["A","B"]},"406077170":{"t":"judge","a":true},"406077180":{"t":"fill","a":["答案1","答案2"]}}
3. 单选题 a 是一个大写字母；多选题 a 是字母数组（按字母序）；判断题 a 是 true/false；填空题 a 是字符串数组，按空的顺序，一个空一项。
4. 判断题的「对」=true，「错」=false。
5. 宁可少答也不要乱答：完全看不懂的题直接不输出该 id。
6. 只依据题目本身作答，不要输出与题目 id 无关的内容。
7. 题干来自防复制字体的 OCR 还原，**可能有少量形近字错误**（例如「囯」应为「国」、「倜」应为「调」、「巾」应为「新」、「犬」应为「大」）。请先按上下文理解原意再作答，不要因为个别错字就跳过该题。
8. 选项字母是页面显示顺序（A/B/C/D），按显示顺序作答，不要按 DOM 顺序。`;

function buildUserPrompt(batch) {
  return `请作答以下 ${batch.length} 道题，输出 JSON：\n\n` + batch.map(renderQuestion).join('\n\n');
}

/** 从任意文本里抠出第一个完整 JSON 对象（容忍 ```json 围栏和前后废话） */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 把模型给的答案校正成内部结构；同时用题目里的选项 data 回填 */
function normalizeAnswer(q, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw.t || raw.type;
  let a = raw.a !== undefined ? raw.a : raw.ans;
  if (a === undefined || a === null) return null;

  if (q.qtype === 'judge') {
    if (typeof a === 'boolean') return { type: 'judge', ans: a };
    const s = String(a).trim().toLowerCase();
    if (['true', 't', '对', '正确', 'a', '1', '√', 'yes', '是'].includes(s)) return { type: 'judge', ans: true };
    if (['false', 'f', '错', '错误', 'b', '0', '×', 'no', '否'].includes(s)) return { type: 'judge', ans: false };
    return null;
  }

  if (q.qtype === 'fill') {
    const arr = Array.isArray(a) ? a : [a];
    const cleaned = arr.map(x => String(x).trim());
    if (!cleaned.length || cleaned.every(x => !x)) return null;
    return { type: 'fill', ans: cleaned };
  }

  // single / multi
  let letters = Array.isArray(a) ? a : String(a).split(/[^A-Za-z]+/).filter(Boolean);
  letters = letters
    .map(x => String(x).trim().toUpperCase())
    .filter(x => /^[A-Z]$/.test(x))
    .filter(x => LETTERS.indexOf(x) < q.options.length);
  letters = [...new Set(letters)].sort();

  if (q.qtype === 'single') {
    if (letters.length !== 1) return null;
    return { type: 'single', ans: letters[0] };
  }
  if (!letters.length) return null;
  return { type: 'multi', ans: letters };
}

/** 内部答案 -> fill.js 要的 data 值 */
function toDataTarget(q, ans) {
  if (ans.type === 'judge') return [ans.ans ? 'true' : 'false'];
  if (ans.type === 'single') {
    const i = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(ans.ans);
    return [q.options[i] ? q.options[i].data : ans.ans];
  }
  if (ans.type === 'multi') return ans.ans.map(l => {
    const i = LETTERS.indexOf(l);
    return q.options[i] ? q.options[i].data : l;
  });
  return [];
}

module.exports = { LETTERS, renderQuestion, SYSTEM_PROMPT, buildUserPrompt, extractJson, normalizeAnswer, toDataTarget };
