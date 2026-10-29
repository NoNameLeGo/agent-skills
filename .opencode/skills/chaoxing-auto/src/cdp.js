/**
 * 零依赖 CDP 客户端（Node 22 原生 WebSocket + http）
 *
 * 为什么不用 Playwright/Puppeteer：本机 Node 无法 spawn 子进程（browser.launch 直接 EBUSY），
 * 浏览器必须由外部（edge-start.cmd / Bash 后台任务）拉起，这里只负责连接和驱动。
 *
 * 注意：用 node:http 直连 127.0.0.1，不用 fetch —— 本机有 HTTP_PROXY，fetch 可能把 localhost 也代理走。
 */
const http = require('http');

const DEFAULT_PORT = 9223;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpJson(port, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method, timeout: 5000, agent: false },
      res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', d => (buf += d));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${p}`));
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('非 JSON: ' + buf.slice(0, 120))); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function listTargets(port = DEFAULT_PORT) {
  return httpJson(port, '/json/list');
}

async function version(port = DEFAULT_PORT) {
  return httpJson(port, '/json/version');
}

async function isAlive(port = DEFAULT_PORT) {
  try {
    const v = await version(port);
    return !!(v && v.Browser);
  } catch { return false; }
}

async function newTab(port, url) {
  // 新版 Chromium/Edge 的 /json/new 只接受 PUT，用 GET 会返回 405
  try {
    return await httpJson(port, '/json/new?' + encodeURIComponent(url || 'about:blank'), 'PUT');
  } catch (e) {
    return httpJson(port, '/json/new?' + encodeURIComponent(url || 'about:blank'), 'GET');
  }
}

async function closeTab(port, targetId) {
  return httpJson(port, '/json/close/' + targetId);
}

class CDP {
  constructor(ws, target) {
    this.ws = ws;
    this.target = target;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = {};
    this.ctxByFrame = new Map();
    ws.addEventListener('message', ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message || JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        (this.handlers[m.method] || []).forEach(f => { try { f(m.params); } catch {} });
      }
    });
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); return reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, timeoutMs);
    });
  }

  on(method, fn) { (this.handlers[method] = this.handlers[method] || []).push(fn); }

  async evaluate(expr, opts = {}) {
    const { awaitPromise = false, contextId, returnByValue = true } = opts;
    const p = { expression: expr, returnByValue, awaitPromise };
    if (contextId) p.contextId = contextId;
    const r = await this.send('Runtime.evaluate', p, opts.timeoutMs || 60000);
    if (r.exceptionDetails) {
      throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  /** 在所有 main-world 上下文（含 iframe）里执行，返回 [{contextId, frameUrl, value, error}] */
  async evaluateAll(expr, opts = {}) {
    let ids = [...new Set([...this.ctxByFrame.values()].filter(v => v != null))];
    if (opts.onlyContext != null) ids = [opts.onlyContext];
    else if (Array.isArray(opts.onlyContexts) && opts.onlyContexts.length) ids = opts.onlyContexts;
    const out = [];
    for (const id of ids) {
      try {
        const value = await this.evaluate(expr, { ...opts, contextId: id });
        out.push({ contextId: id, value });
      } catch (e) {
        out.push({ contextId: id, error: e.message.slice(0, 200) });
      }
    }
    return out;
  }

  async navigate(url, waitMs = 3000) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }

  /**
   * 返回「当前章节」那棵 iframe 子树里的所有 execution context id。
   *
   * 为什么需要：切节时旧的 knowledge/cards iframe 有时不会被销毁，仍作为独立的
   * execution context 存在。全量 evaluateAll 会把上一节残留的题目也算进来，
   * 导致每个节点都被误判成 questions、然后在错误的上下文里填答一败涂地。
   *
   * @param {string} kid 当前 knowledgeid
   */
  async subtreeCtxIds(kid) {
    let tree;
    try { tree = await this.send('Page.getFrameTree', {}, 8000); } catch { return null; }
    const nodes = [];
    const walk = (n, parent, depth) => {
      const f = { id: n.frame.id, url: n.frame.url || '', parent, depth };
      nodes.push(f);
      for (const c of n.childFrames || []) walk(c, f.id, depth + 1);
    };
    walk(tree.frameTree, null, 0);
    if (!kid) return null;
    const root = nodes.find(n => n.url.includes('knowledgeid=' + kid));
    if (!root) return null;
    const ids = new Set([root.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes) {
        if (!ids.has(n.id) && n.parent && ids.has(n.parent)) { ids.add(n.id); grew = true; }
      }
    }
    const ctxIds = [...ids].map(fid => this.ctxByFrame.get(fid)).filter(v => v != null);
    return ctxIds.length ? ctxIds : null;
  }

  /** 断言在某个 URL 片段上（如 work/dowork），用于防止填错页面 */
  async assertUrl(re, label) {
    const href = await this.evaluate('location.href');
    if (re && !re.test(href)) throw new Error(`${label || '页面'}校验失败，当前：${href}`);
    return href;
  }

  /**
   * 把浏览器窗口从最小化恢复成正常（页面 hidden=true 时学习通会停止计时，视频卡住不动）。
   * @returns {Promise<boolean>} 是否真的做了恢复
   */
  async unminimize() {
    try {
      const r = await this.send('Browser.getWindowForTarget', {}, 6000);
      const windowId = r && r.windowId;
      if (windowId == null) return false;
      const b = await this.send('Browser.getWindowBounds', { windowId }, 6000);
      const state = b && b.bounds && b.bounds.windowState;
      if (state === 'minimized') {
        await this.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, 6000);
        return true;
      }
      return false;
    } catch { return false; }
  }

  /** 让页面以为自己在前台（缓解计时器节流），只是兜底手段，不能替代真的把窗口放出来 */
  async focusEmulate() {
    try { await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 5000); return true; }
    catch { return false; }
  }

  close() { try { this.ws.close(); } catch {} }
}

async function attach(port, target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败（端口 ' + port + '）')), { once: true });
  });
  const c = new CDP(ws, target);
  c.ctxByFrame = new Map();
  c.on('Runtime.executionContextCreated', p => {
    const ctx = p.context;
    if (ctx.auxData && ctx.auxData.isDefault) c.ctxByFrame.set(ctx.auxData.frameId, ctx.id);
  });
  c.on('Runtime.executionContextDestroyed', p => {
    for (const [f, id] of c.ctxByFrame) if (id === p.executionContextId) c.ctxByFrame.delete(f);
  });
  await c.send('Page.enable').catch(() => {});
  await c.send('Runtime.enable').catch(() => {});
  await sleep(600);
  return c;
}

/**
 * 连到一个页面。urlIncludes 命中优先；否则取第一个 page。
 * 若 openUrl 传入且没有合适页面，则新开一个 tab。
 */
async function connect({ port = DEFAULT_PORT, urlIncludes, openUrl, preferNew = false } = {}) {
  if (!(await isAlive(port))) {
    throw new Error(
      `Edge 调试端口 ${port} 未响应。先运行：\n  D:\\Vibe-Coding\\chaoxing-auto\\edge-start.cmd`
    );
  }
  let targets = (await listTargets(port)).filter(t => t.type === 'page');
  // 优先排除浏览器内部页（edge:// / chrome:// / devtools / 扩展页），否则容易连到同步提示这种无用标签
  const isInternal = u => /^(edge|chrome|devtools|about):/i.test(u || '') || /^(devtools|chrome-extension):/.test(u || '');
  let t = null;
  if (!preferNew) {
    if (urlIncludes) t = targets.find(x => (x.url || '').includes(urlIncludes));
    if (!t) t = targets.find(x => !isInternal(x.url));
    if (!t) t = targets[0];
  }
  if (!t && openUrl) {
    t = await newTab(port, openUrl);
    await sleep(1200);
  }
  if (!t) throw new Error('没有可用的页面目标');
  const c = await attach(port, t);
  c.port = port;
  return c;
}

/** 等某个表达式返回真（轮询），超时抛错 */
async function waitFor(cdp, expr, { timeoutMs = 60000, intervalMs = 800, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await cdp.evaluate(expr); } catch (e) { last = 'ERR ' + e.message; }
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时${label ? '（' + label + '）' : ''}: ${expr.slice(0, 80)} … last=${JSON.stringify(last)}`);
}

module.exports = { CDP, connect, attach, listTargets, newTab, closeTab, isAlive, version, waitFor, sleep, DEFAULT_PORT };
