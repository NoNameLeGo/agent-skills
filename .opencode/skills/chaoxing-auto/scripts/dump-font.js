/**
 * 把页面里内联的 font-cxsecret 字体（base64 data URI）导出成 state/cxsecret.ttf
 * 学习通防复制方案：正文用自定义字体渲染，DOM 里的字符是打乱过的码位。
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('../src/cdp');

const GET_FONT_CSS = `(function(){
  for (const ss of document.styleSheets) {
    let rs; try { rs = ss.cssRules } catch(e) { continue }
    for (const r of rs || []) {
      const t = r.cssText || '';
      if (t.indexOf('font-cxsecret') > -1 && t.indexOf('base64') > -1) return t;
    }
  }
  return '';
})()`;

(async () => {
  const cdp = await connect({ port: parseInt(process.env.CDP_PORT || '9223', 10) });
  const rs = await cdp.evaluateAll(GET_FONT_CSS);
  let css = '';
  for (const r of rs) if (r.value && r.value.length > css.length) css = r.value;
  cdp.close();
  if (!css) { console.log('没找到内联字体'); process.exit(1); }
  const m = css.match(/base64,([A-Za-z0-9+/=]+)/);
  if (!m) { console.log('CSS 里没有 base64'); process.exit(1); }
  const buf = Buffer.from(m[1], 'base64');
  const out = path.join(__dirname, '..', 'state', 'cxsecret.ttf');
  fs.writeFileSync(out, buf);
  console.log('saved', out, buf.length, 'bytes');
  process.exit(0);
})();
