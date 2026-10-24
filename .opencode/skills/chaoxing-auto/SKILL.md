---
name: chaoxing-auto
description: 学习通/超星自动刷课与自动做题（CDP 版）。用户要刷学习通网课、自动看视频、自动做章节测验或作业、排查学习通自动化失败时使用。零依赖 Node + 独立静音 Edge，支持防复制字体还原、多模型交叉校验答题、自动提交。
version: 1.0.0
license: GPL-3.0
---

# 学习通自动刷课 + 自动做题

**本技能目录自带完整实现**（零依赖 Node），整个目录拷到本地任意位置即可用，无需 npm install。

```
.opencode/skills/chaoxing-auto/
├── SKILL.md
├── run.js                 CLI 入口
├── src/                   9 个模块（CDP / 抽题 / 字形还原 / 答案链 / 填答 / 流程）
├── scripts/               字体抓取与调试工具
├── edge-start.cmd         一键启动静音调试 Edge（Windows）
├── config.example.json    配置模板（复制成 config.json 填 key）
└── README-项目.md          完整页面事实表与限制
```

安装到各 Agent：
- **OpenCode**：把本目录路径加进 `opencode.json` 的 `skills`
- **pi**：`cp -r .opencode/skills/chaoxing-auto ~/.pi/agent/skills/`
- **WorkBuddy**：`cp -r .opencode/skills/chaoxing-auto ~/.workbuddy/skills/`

## 何时用

- 用户要「刷学习通 / 刷课 / 看视频 / 做课后习题 / 章节测验」
- 用户抱怨上次自动答题错、提交卡住、文字乱码
- 需要排查学习通页面结构（目录、视频、题目）

## 三条前置条件（缺一不可）

1. **浏览器必须是独立调试实例**（端口 9223）
   ```
   双击本技能目录下的 edge-start.cmd
   ```
   带 `--remote-debugging-port=9223 --mute-audio --user-data-dir=.cache/edge-profile`。
   9222 被 WorkBuddy 自己的 Electron 占着，**不要用 9222**。

2. **该实例里登录过学习通**（首次扫码，之后 cookie 常驻）

3. **`config.json` 存在且有答案源**
   - `answer.freeai`：OpenAI 兼容接口（baseURL/apiKey/model），实测 `agnes-3.0-flash` 5 题 3.6s
   - `answer.freeai.fallbacks[]`：备用模型，`answer.crossCheck=true` 时参与交叉校验
   - 两个都没配时会「留空不猜、不提交」，只刷视频

## 命令速查

```bash
cd /d <本技能目录>

node run.js status                    # 端口/标签页/登录态
node run.js open "<课程学习页URL>"     # 打开页面
node run.js list                      # 目录：已完成/未完成
node run.js probe                     # 打印所有 iframe 上下文的 DOM 计数
node run.js course [--max N]          # 主流程：视频自动过 + 测验作答提交 + 文档跳过
node run.js course --from-here        # 从当前节点之后开始，不动用户正在看的
node run.js quiz [--submit]           # 只处理当前页的题（默认只暂存）
node run.js submit                    # 提交当前页已填答案（不重新抽题）
node run.js shot out.png              # 截图
node run.js eval "<js>" [--all]       # 页面里执行 JS
```

## 硬约束（踩过坑，别改）

1. **Node 不能 spawn 子进程**（本机 `browser.launch()` 永久 EBUSY）→ 浏览器只能由 `edge-start.cmd` 或外部命令拉起。
2. **Edge 宿主进程一死，浏览器立刻被连带杀掉**。用 Bash 后台任务拉起时必须带长 `sleep`；给用户用请双击 `edge-start.cmd`。
3. **Edge 窗口不能最小化**，学习通判定离开页面会暂停计时。
4. **单账号串行**：`state/run.lock` 文件锁，禁止并行刷课/并行答题。
5. 连 127.0.0.1 用 `node:http` 而不是 `fetch`（本机有 `HTTP_PROXY`）。
6. `/json/new` 只接受 **PUT**。

## 页面事实（2026-10 实测，优先信这个）

| 项 | 值 |
|---|---|
| 学习页入口 | `mycourse/studentstudy?courseId&clazzid&chapterId&enc&cpi&mooc2=1&hidetype=0&fanyaVersion=0&openc=<课程openc>` |
| ⚠️ enc 校验 | 缺 `openc` 会「enc校验失败」；`openc` 只能从成功进入过的 URL 里抄 |
| 目录项 | `div.posCatalog_select`，`id="cur{kid}"`；章标题带 `firstLayer` |
| 已完成标记 | 项内 `.icon_Completed` |
| 章节切换 | `getTeacherAjax()` → GET `/mycourse/studentstudyAjax` → **整块重写 `#mainid`**，顶层 URL 不变 |
| 视频 | `iframe.ans-attach-online` → `ananas/modules/video/index.html`，内含 `<video>` |
| 任务点条件 | 观看 ≥ 总时长 90%；未完成前不可拖拽、不可离开 |
| 顺序解锁 | 前一任务点未完成时点后面的节点会被服务端退回原节 |
| 测验页 | `mooc-ans/work/doHomeWorkNew`，题目在 `#question{qid}` |
| 选项布局 A | `div.answerBg`（老版） |
| 选项布局 B | `li[qid][qtype] > span.num_option[data] + a.after` |
| ⚠️ 选项映射 | `span` 文本才是显示的 A/B/C/D，`data` 是提交码，**顺序被打乱**。必须按显示字母排序再映射 |
| 提交按钮 | `a.btnSubmit[onclick="btnBlueSubmit();"]`；暂存 `a.btnSave[onclick="noSubmit();"]` |
| ⚠️ 确认弹层 | 「确认提交？」在 **外层 studentstudy 文档**，不在题目 iframe。按钮是 `.jb_btn`，必须全上下文找 |

## 最大的坑：font-cxsecret 防复制字体

题干/选项 `class="font-cxsecret"`，字体是内联 base64 TTF；DOM 里是**打乱码位**（`人庡庩放军`），肉眼正常、复制全乱码。

`src/decode.js` 的做法：canvas 用 cxsecret 画乱码字 → 与 5348 个常用字在系统黑体下的字形做 20×20 灰度最近邻 → 结果存 `state/fontmap.json`。

- 首次 5–15 秒（分块，12 字一批），之后查表 0 秒
- **`state/fontmap.json` 是资产，别删**。认错的字手工改：`{"打乱字符":"真字符"}`
- `document.fonts.check('16px font-cxsecret')` 在 about:blank 也返回 true，**必须扫 `[...document.fonts]` 看 status**
- 一次性比对全部候选会阻塞主线程 2–3 分钟并**把渲染进程搞崩**，必须分块

## 答题链路

```
freeai（agnes-3.0-flash，3.6s/5题）
  └ crossCheck：把题再给 fallbacks[0]（dots3）复核
      └ 答案不一致 → 带双方答案裁决一次
          └ 仍不一致 → 用主模型答案
```

安全闸（都在 `src/flow.js`）：
- 选择/判断题选项 < 2 个 → **不送模型、不提交**（已批阅页没有选项列表）
- 填答异常 → 不提交，只暂存
- 整页没选项 → 放弃本页

实测分数：100 分、80 分各一次（**不保证满分**，两模型都会错题）。

## 排障

| 现象 | 修法 |
|---|---|
| `已有实例在运行（pid=...）` | 删 `state/run.lock`，或 taskkill 那个 pid |
| `enc校验失败` | URL 缺 `openc`，从历史成功 URL 里抄 |
| 提题 0 道 | 页面是「已批阅/结果页」，没有 `li[qid]`，换成可作答状态 |
| 字形匹配失败 | 当前上下文没加载 cxsecret（不在题目页），或渲染进程已崩 |
| 提交卡在弹层 | 确认探层在外层文档，用 `evaluateAll` 找 `.jb_btn` |
| `CDP timeout` | 渲染进程卡死，`/json/close` 关掉该标签重开 |
| 视频不动 | Edge 被最小化 / 平台暂停，脚本每 3 秒会自动 resume |

## 长跑建议

36 个节点、视频合计数小时。**让用户自己开终端跑**，不要依赖 Agent 会话里的后台任务（会话结束即停）：

```
双击 edge-start.cmd
cd /d <本技能目录>
node run.js course
```
