/**
 * tier2：网页 AI（用已登录的网页版大模型，通过 CDP 注入 prompt、读回复）。
 * 首次使用需要在该 Edge 窗口里手动登录一次对应站点，之后 cookie 常驻。
 *
 * 站点差异全靠 config.answer.webai.sites 里的选择器描述，不写死任何一家。
 */
const { connect, waitFor, sleep } = require('../cdp');
const { SYSTEM_PROMPT, buildUserPrompt, extractJson, normalizeAnswer } = require('./prompt');

const INJECT_FN = `(function(sel, text){
  const el = document.querySelector(sel);
  if (!el) return { ok:false, err:'no input', sel };
  el.focus();
  const isCE = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  if (!isCE && 'value' in el) {
    // React 受控组件：用原生 setter 再派发 input，才会进 state
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok:true, mode:'value', len: el.value.length };
  }
  // contenteditable：先清空再逐段插入，execCommand 才能触发框架的 onChange
  el.innerHTML = '';
  const lines = text.split('\\n');
  lines.forEach((ln, i) => {
    if (i) document.execCommand('insertLineBreak', false, null);
    document.execCommand('insertText', false, ln);
  });
  return { ok:true, mode:'ce', len: (el.innerText||'').length };
})`;

const READ_FN = `(function(sel){
  const list = [...document.querySelectorAll(sel)].filter(e => (e.innerText||'').trim().length > 0);
  if (!list.length) return '';
  return (list[list.length-1].innerText || '').trim();
})`;

const CLICK_FN = `(function(sel){
  const cands = [...document.querySelectorAll(sel)];
  const btn = cands.find(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
  if (!btn) return { ok:false, n:cands.length };
  btn.click();
  return { ok:true };
})`;

async function pickSite(cfg, log, port) {
  const sites = (cfg.sites || []).filter(s => s && s.enabled !== false);
  if (!sites.length) return null;
  // 已有该站点的标签页就复用，绝不劫持学习通那个页
  const targets = (await require('../cdp').listTargets(port)).filter(t => t.type === 'page');
  for (const s of sites) {
    const host = (() => { try { return new URL(s.url).host; } catch { return ''; } })();
    if (!host) continue;
    const t = targets.find(x => (x.url || '').includes(host));
    if (t) { s.__target = t; return s; }
  }
  return sites[0];
}

/** 只在本站点标签里工作：有就 attach，没有就新开，全程不碰学习通页面 */
async function attachSiteTab(port, site, log) {
  const { attach, newTab, listTargets } = require('../cdp');
  const host = (() => { try { return new URL(site.url).host; } catch { return ''; } })();
  let t = site.__target;
  if (!t) {
    const targets = (await listTargets(port)).filter(x => x.type === 'page');
    t = targets.find(x => host && (x.url || '').includes(host));
  }
  if (!t) {
    log.info('webai 新开标签: ' + site.url);
    t = await newTab(port, site.url);
    await new Promise(r => setTimeout(r, 1500));
    // /json/new 返回的 target 可能没有 webSocketDebuggerUrl，重新查一次
    if (!t.webSocketDebuggerUrl) {
      const targets = (await listTargets(port)).filter(x => x.type === 'page');
      t = targets.find(x => (x.url || '').includes(host)) || t;
    }
  }
  const cdp = await attach(port, t);
  cdp.port = port;
  return cdp;
}

async function runTier(questions, cfg, log, ctx) {
  const out = new Map();
  if (!cfg || cfg.enabled === false) return out;
  if (!ctx || !ctx.port) { log.warn('webai 需要浏览器连接，跳过'); return out; }

  const site = await pickSite(cfg, log, ctx.port);
  if (!site) { log.warn('webai 未配置站点，跳过'); return out; }

  let cdp = null;
  try {
    cdp = await attachSiteTab(ctx.port, site, log);
    const href = await cdp.evaluate('location.href');
    if (!href.includes(new URL(site.url).host)) {
      log.info(`webai 导航到 ${site.url}`);
      await cdp.navigate(site.url, 5000);
    }
    try {
      await waitFor(cdp, `!!document.querySelector(${JSON.stringify(site.readySelector || site.inputSelector)})`, {
        timeoutMs: 20000, label: 'webai 输入框'
      });
    } catch (e) {
      log.warn('webai 输入框未出现（可能未登录）：' + e.message);
      return out;
    }

    const size = 10;
    const batches = [];
    for (let i = 0; i < questions.length; i += size) batches.push(questions.slice(i, i + size));

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const prompt = `请严格按系统要求作答，只输出 JSON，不要解释。\n\n${SYSTEM_PROMPT}\n\n${buildUserPrompt(batch)}`;
      const prev = await cdp.evaluate(`(${READ_FN})(${JSON.stringify(site.replySelector)})`).catch(() => '');

      const inj = await cdp.evaluate(`(${INJECT_FN})(${JSON.stringify(site.inputSelector)}, ${JSON.stringify(prompt)})`);
      if (!inj || !inj.ok) { log.warn('webai 注入失败: ' + JSON.stringify(inj)); break; }
      await sleep(600);

      let sent = false;
      if (site.sendSelector) {
        const r = await cdp.evaluate(`(${CLICK_FN})(${JSON.stringify(site.sendSelector)})`).catch(() => null);
        sent = !!(r && r.ok);
      }
      if (!sent) {
        await cdp.evaluate(`(function(sel){
          const el=document.querySelector(sel); if(!el) return false;
          for (const type of ['keydown','keypress','keyup']) {
            el.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
          }
          return true;
        })(${JSON.stringify(site.inputSelector)})`).catch(() => false);
      }

      const deadline = Date.now() + (cfg.timeoutMs || 120000);
      let last = '', stable = 0, reply = '';
      while (Date.now() < deadline) {
        await sleep(1500);
        reply = await cdp.evaluate(`(${READ_FN})(${JSON.stringify(site.replySelector)})`).catch(() => '');
        if (reply && reply !== prev) {
          if (reply === last) stable++; else { stable = 0; last = reply; }
          if (stable >= 3) break;   // 连续 3 次（约 4.5s）无变化，视为生成完毕
        }
      }
      const json = extractJson(reply);
      if (!json) {
        log.warn(`webai 批次 ${bi + 1} 未读到可解析 JSON（回复长度 ${reply.length}）`);
        continue;
      }
      for (const q of batch) {
        const ans = normalizeAnswer(q, json[q.qid]);
        if (ans) out.set(q.qid, { ans, src: 'webai' });
      }
      log.ok(`webai 批次 ${bi + 1}/${batches.length} 解出 ${batch.filter(q => out.has(q.qid)).length}/${batch.length}`);
    }
  } catch (e) {
    log.warn('webai 出错: ' + e.message);
  } finally {
    if (cdp) cdp.close();
  }
  return out;
}

module.exports = { runTier };
