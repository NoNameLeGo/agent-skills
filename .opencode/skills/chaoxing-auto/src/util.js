/**
 * 通用工具：日志、随机抖动、配置加载、单账号串行锁
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** [min, max] 闭区间随机整数，用于「答题间隔 3–12 秒」这类人类化节奏 */
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

const ts = () => new Date().toTimeString().slice(0, 8);

function makeLogger(prefix = '') {
  const tag = prefix ? `[${prefix}] ` : '';
  const emit = (lv) => (...a) => {
    const line = `${ts()} ${lv} ${tag}${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
    console.log(line);
    LOG_BUFFER.push(line);
    if (LOG_BUFFER.length > 4000) LOG_BUFFER.shift();
  };
  return { info: emit('..'), ok: emit('ok'), warn: emit('!!'), err: emit('xx'), out: emit('  ') };
}
const LOG_BUFFER = [];

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) {
    throw new Error(`缺少 config.json，请复制 config.example.json 为 config.json 后填写（${p}）`);
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.__root = ROOT;
  cfg.cdpPort = cfg.cdpPort || 9223;
  cfg.humanize = { minGap: 3000, maxGap: 12000, ...(cfg.humanize || {}) };
  cfg.answer = cfg.answer || {};
  cfg.study = cfg.study || {};
  return cfg;
}

/**
 * 单账号串行锁。
 * 含义：同一账号同一时刻只跑一条流水线。不做「多 tab 并行刷多门课」，
 * 也不并发发答题请求 —— 同一 ut/enc 会话的多路并发是学习通风控最典型的脚本特征。
 */
function acquireLock(name = 'chaoxing-auto') {
  const lockPath = path.join(ROOT, 'state', 'run.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    let raw = '';
    try { raw = fs.readFileSync(lockPath, 'utf8'); } catch {}
    const info = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    const pid = info && info.pid;
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    if (alive) {
      throw new Error(`已有实例在运行（pid=${pid}，started=${info.started}）。单账号必须串行，先结束它：\n  taskkill /PID ${pid} /F`);
    }
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), name }), 'utf8');
  const release = () => { try { fs.unlinkSync(lockPath); } catch {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  return release;
}

/** 简易并发池（只用于「多个搜题请求」，并发上限默认 2，避免风控与被封） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const TMP = path.join(ROOT, 'state');
function saveJson(name, obj) {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}
function readJson(name, def = null) {
  try { return JSON.parse(fs.readFileSync(path.join(TMP, name), 'utf8')); } catch { return def; }
}

module.exports = { ROOT, sleep, randInt, makeLogger, loadConfig, acquireLock, mapLimit, saveJson, readJson, LOG_BUFFER };
