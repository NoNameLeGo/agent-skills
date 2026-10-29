---
name: chaoxing-auto
description: "学习通/超星自动刷课与自动做题（CDP 版）。当用户要刷学习通网课、自动看视频、自动做章节测验/作业、或排查学习通自动化失败时使用。零依赖 Node + 独立静音 Edge 实例，支持防复制字体还原、多模型交叉校验答题、自动提交。"
version: 1.2.0
agent_created: true
metadata:
  author: WorkBuddy
  engine: cdp
  emoji: "🎬"
  project: D:\\Vibe-Coding\\chaoxing-auto
  repo: https://github.com/NoNameLeGo/agent-skills
---

# 学习通自动刷课 + 自动做题

实现位置：**`D:\Vibe-Coding\chaoxing-auto`**（本技能是 runbook，代码不复制）。
发布副本：`https://github.com/NoNameLeGo/agent-skills` → `.opencode/skills/chaoxing-auto/`（自带完整代码）。

---

## 一、触发条件

命中以下任一就加载本技能：

| 用户说 | 意图 |
|---|---|
| 刷学习通 / 刷课 / 挂课 / 看视频刷完 | 视频任务点自动过 |
| 学习通做题 / 课后习题 / 章节测验 / 作业 | 自动作答（默认提交） |
| 超星 / chaoxing / xuexitong | 同上 |
| 上次刷课卡住了 / 提交不了 / 题目乱码 | 排障 |

**不适用**：考试（`study.exam` 默认关闭）、需要真人监考的页面、其他平台（雨课堂/智慧树）。

---

## 二、全流程（按顺序，每步都有验收点）

### Stage 0 · 前置检查（必做，跳过会全线失败）

```bash
cd /d D:\Vibe-Coding\chaoxing-auto
node run.js status
```

| 结果 | 含义 | 处理 |
|---|---|---|
| `调试端口 9223: 存活` + `检测到学习通页面` | 就绪 | 去 Stage 1 |
| `调试端口 9223: 未响应` | 浏览器没起 | **让用户双击 `edge-start.cmd`**（或 `刷课.cmd`）；Agent 自己起会被连带杀掉 |
| 页面停在 `passport2.chaoxing.com/login` | 没登录 | 让用户在那个 Edge 窗口里扫码登录 |

> ⚠️ **端口必须是 9223**。9222 被 WorkBuddy 自己的 Electron 占着，连上去会连错浏览器。

### Stage 1 · 确认答案源（决定能不能做题）

```bash
node -e "const c=require('./config.json');console.log(c.answer.freeai.model, c.answer.crossCheck)"
```

- 有 `baseURL/apiKey/model` → 能做选择题、判断题、填空题
- 全空 → 只刷视频；题目会「留空不猜、不提交」，日志写 `未解 N 题`

首次配置：
```bash
cp config.example.json config.json   # 填 answer.freeai 三个字段
node run.js probe-answer             # 冒烟测试
```

### Stage 2 · 进入课程学习页（最容易卡的一步）

**不能**直接用 `open` 打开 `studentstudy` —— 会 `enc校验失败`，它需要 `openc` 参数，而 `openc` 只能从成功进入过的 URL 里拿。

二选一：

**A. 让用户手动进课程**（最稳）
用户在那个 Edge 窗口点进课程、停在任意一节 → Agent 跑：
```bash
node run.js list
```
能列出上百个条目就说明对了。

**B. 从历史 URL 拼**（用户之前进过的话）
格式：
```
mycourse/studentstudy?chapterId=<kid>&courseId=<cid>&clazzid=<clid>&cpi=<cpi>
  &enc=<enc>&mooc2=1&hidetype=0&fanyaVersion=0&openc=<openc>
```
`openc` 缺失时，改走 `visit/stucoursemiddle?courseid=&clazzid=&cpi=&ismooc2=1` 让它 302，再点页面上的「章节」标签。

### Stage 3 · 开刷

```bash
node run.js course --max 40          # 按目录顺序处理未完成节点
node run.js course --from-here       # 从用户当前节点之后开始，不动他正在看的
```

一节的处理逻辑：

| 页面类型 | 行为 |
|---|---|
| 视频 | 固定 1x + `--mute-audio` 静音，自动 resume 掉线暂停，播到 ≥90% 即完成任务点 |
| **视频内弹题** | 播放中弹出的 `.ans-videoquiz` 覆盖层。**作答期间绝不能再强制 `play()`**（会把模块自己按下的暂停顶回去，弹题被直接冲过去 = 等于没答）。脚本检测到就出答案 → 勾选 → 点 `#videoquiz-submit` → 点 `#videoquiz-continue` |
| **节内章节测验**（`.prev_ul li` 的「2章节测验」标签） | 一节常是「1视频 + 2章节测验」两个任务点，**只播视频目录不打勾**。视频播完脚本自动点标签 → 等题目 → 抽题 → 答题 → 填 → 复核 → 提交 |
| 章节测验（整页） | 抽题 → 字形还原 → 多模型答题 → 交叉校验 → 填答 → 复核 → **提交** |
| 阅读（`readjobv2/show`） | 页面只有入口，**必须点「去阅读」跳进阅读器**才计时；停留/滚动无效。脚本自动点 → 等阅读器（新标签页或就地跳转）→ 停留 `readOpenSeconds`（默认 120s）。**点不开时会在日志里让你手动点**，然后轮询任务点状态 `readManualWaitSeconds`（默认 300s） |
| 文档/PPT | `study.readSeconds=0` 时只等 3 秒；设 30–60 会滚动停留并尝试标完成 |

### Stage 4 · 验收

```bash
node run.js list          # 剩余未完成数是否在减少
tail -20 state/course*.log
```

日志里应出现：`本节视频播放结束` / `[n/m] qid=... → ABCD` / `交叉校验`（不一致时有 `裁决为`）/ `复核不符 0 / N` / `本次成绩XX分`。

**看到 `不提交，只暂存` 是安全闸生效，不是 bug** —— 说明有题缺选项或填答异常，去看 `state/*-questions.json`。

---

## 三、命令速查

```bash
node run.js status                    # 端口/标签页/登录态
node run.js open "<URL>"              # 打开页面
node run.js list                      # 目录：已完成/未完成
node run.js probe                     # 所有 iframe 上下文的 DOM 计数（改选择器用）
node run.js course [--max N] [--from-here]
node run.js quiz [--submit] [--answers f.json]
node run.js videoquiz                 # 只处理当前可见的视频内弹题
node run.js submit                    # 只提交当前页已填答案
node run.js shot out.png              # 截图
node run.js eval "<js>" [--all]       # 页面里执行 JS
node run.js probe-answer              # 不碰页面，只测答案链
```

---

## 四、硬约束（踩过坑，别改）

1. **Node 不能 spawn 子进程** —— 本机 `browser.launch()` 永久 EBUSY，Playwright/Puppeteer 不可用，浏览器只能外部拉起。
2. **Edge 宿主进程一死，浏览器立刻被连带杀掉**。Agent 用后台任务拉起时，任务结束（含对话轮次结束）Edge 就没了 → 长跑必须让用户双击 `刷课.cmd`。
3. **Edge 窗口不能最小化，也不能被别的窗口完全遮挡** —— `document.hidden=true` 时学习通判「离开页面」，视频会频繁自动暂停、计时不记。日志里会打 `页面处于隐藏状态…`。放旁边/缩小都行，别盖住。
4. **单账号串行**：`state/run.lock` 文件锁，第二个实例直接退出。
5. 连 127.0.0.1 用 `node:http` 而非 `fetch`（本机有 `HTTP_PROXY`）。
6. `/json/new` 只接受 **PUT**，GET 会 405。
7. **永远不要对「没有 onclick 的目录项」调 `getTeacherAjax`** —— 服务端会给「提交失败」页，`#mainid` 被打坏后整页作废（`#iframe` 消失）。目标不可点 → 只能刷新页面等权限下发。
8. **视频内弹题出现时不能强制 `play()`** —— 模块靠 `pause()` 等作答，强行播放会把弹题顶过去，等于没答（任务点仍算完成，但弹题正确率是 0）。

---

## 五、页面事实（2026-10 实测）

| 项 | 值 |
|---|---|
| 目录项 | `div.posCatalog_select`，`id="cur{kid}"`；章标题带 `firstLayer` |
| 已完成 | 项内存在 `.icon_Completed` |
| 章节切换 | `getTeacherAjax()` → GET `/mycourse/studentstudyAjax` → **整块重写 `#mainid`**，顶层 URL 不变；实测 **15–25s** 才生效（轮询要给 40×700ms） |
| ⚠️ 切换失效（根因） | 侧栏**只有「当前节 + 下一个未完成节」挂 `onclick`**（顺序解锁），其余全是裸 `span`；而 `getTeacherAjax` **只重写 `#mainid`、不刷新侧栏** → 一节做完后下一节永远拿不到 onclick。硬调 `getTeacherAjax` 请求未解锁节点 → 服务端返回「提交失败」页，把 `#mainid` 打坏（`#iframe` 消失、body 只剩「章节未开放」）。**正解：`Page.reload` 刷新学习页**让服务端重新下发目录权限，最多重试 4 次 |
| 节内任务点 tab | `.prev_ul li`，`onclick="changeDisplayContent(num,totalnum,kid,cid,clazzid,'',crossid)"`；cards 的 `num = 标签序号-1`。文本形如「1视频 / 2章节测验」 |
| ⚠️ 节内顺序解锁 | **视频没播完时测验 tab 是空的**（点进去白屏，不是加载慢）→ 节内测验只能放在视频之后处理 |
| 视频 | `iframe.ans-attach-online` → `ananas/modules/video/index.html`（2026-09 版 `?v=2026-0920-1154`），内含 `<video>` |
| **视频内弹题** | `div.ans-videoquiz#videoquiz-<n>`：`.tkTopic_title` 题型、`.tkItem_title` 题干、`li.ans-videoquiz-opt > label > input`（文本「A、对」）、`#videoquiz-submit` 提交、`#videoquiz-continue` 继续学习、`#rightNum` 已答对数。**视频模块自己会暂停等作答**，脚本的 `play()` 会把它顶回去 → 必须先答再放行 |
| 任务点条件 | 视频观看 ≥ 总时长 90%；一节可能是「1视频 + 2章节测验」两个任务点，**都做完目录才打勾**，只有视频不做测验下一节不解锁 |
| 顺序解锁 | 前一任务点未完成时点后面的节点会被服务端退回原节（不是 bug）→ 以页面真实 kid 为准 |
| 阅读任务点 | `mooc-ans/coursedata/readjobv2/show`，页面只给一句「点击去阅读」+ 入口（`a.readTitleText` 无 href / 文本为「去阅读」的 span 无 onclick，由内联 JS 绑定）。**停留不计时，必须点进阅读器** |
| 测验页 | `mooc-ans/work/doHomeWorkNew`（未作答）/ `mooc-ans/work/selectWorkQuestionYiPiYue`（已批阅，页头有「第N次作答 本次成绩XX分」，可核对分数），题目 `#question{qid}` |
| 选项布局 A | `div.answerBg`（老版） |
| 选项布局 B | `li[qid][qtype] > span.num_option[data] + a.after` |
| **选项布局 C**（2025-10 新版章节测验） | 容器 `div.TiMu.newTiMu.ans-cc#question{qid}`；题干 `.Zy_TItle .qtContent`（首个子元素 `span.newZy_TItle` 是「【多选题】」）；选项 `ul.Zy_ulTop.qtDetail > li.clearfix > i.fl("A、") + a(文本)`。**没有 li[qid] / span.num_option / .answerBg**，字母在 `<i>` 里，勾选靠给 `li`（和里面的 `a`）发 click |
| ⚠️ 选项映射 | `span` 文本才是显示的 A/B/C/D，`data` 是提交码，**顺序被打乱**。必须按显示字母排序再映射 |
| 提交按钮 | 布局 A/B：`a.btnSubmit[onclick="btnBlueSubmit();"]`；布局 C：文字按钮「提交」（暂存是「暂时保存」）→ 需按 innerText 兜底找 |
| ⚠️ 确认弹层 | 「确认提交？」在**外层 studentstudy 文档**，按钮 `.jb_btn`。必须 `evaluateAll` 全上下文找 |
| ⚠️ 上下文失效 | 视频播完 / 提交前 iframe 会重渲染，旧 contextId 立刻失效 → 必须重新定位 |

---

## 六、最大的坑：font-cxsecret 防复制字体

题干/选项套 `class="font-cxsecret"`，字体是内联 base64 TTF；DOM 里是**打乱码位**（`人庡庩放军`），肉眼正常、复制乱码。

`src/decode.js`：canvas 用 cxsecret 画乱码字 → 与 5438 个常用字在系统黑体下的字形做 20×20 灰度最近邻 → 存 `state/fontmap.json`。

- 首次 5–15 秒（12 字一块），之后查表 0 秒
- **`state/fontmap.json` 是资产，别删**。认错的字手工改 `{"打乱字符":"真字符"}`，改完立即生效
- `document.fonts.check('16px font-cxsecret')` 在 about:blank 也返回 true，**必须扫 `[...document.fonts]` 看 status**
- 一次性比对全部候选会阻塞主线程 2–3 分钟并**把渲染进程搞崩**（标签页直接消失），必须分块
- 形近字会认错（民/弓、国/冋），所以 prompt 里要允许「可能有形近错字，按上下文理解」

---

## 七、答题链路与分数预期

```
freeai（agnes-3.0-flash，5 题 1.5–10s）
  ├ crossCheck：同一批题交给 fallbacks[0]（dots3）复核
  │   └ 答案不一致 → 带双方答案裁决一次 → 仍不一致用主模型答案
  └ 主模型漏解的题 → 备用模型（dots3）直接补答（API，秒级）
```

默认链 `answer.chain = ['freeai','websearch']`。
**`webai`（网页版千问）已移出默认链**：实测要等 188s 还读到空回复，且会新开标签页。`localllm` 也默认不启用（本机无 ollama）。

**不保证满分**。实测：100 分、80 分各一次。两个模型都会错题，交叉校验只是把错误率压下来。

安全闸（`src/flow.js`）：
- 选择/判断题选项 < 2 个 → 不送模型、不提交
- 填答有异常 → 不提交，只暂存
- 整页没选项（已批阅页）→ 放弃本页

布局 C 没有隐藏 `#answer{qid}` 真值字段，`verify()` 改成从「选中的 `li`」反解字母；提交后 iframe 会立刻重渲染，`复核失败: Cannot find context` 属正常（提交已成立，用已批阅页的成绩核对即可）。

---

## 八、排障

| 现象 | 修法 |
|---|---|
| `已有实例在运行（pid=...）` | 删 `state/run.lock`，或 taskkill 那个 pid |
| `enc校验失败` | URL 缺 `openc`，走 Stage 2 |
| 提题 0 道 | 页面是「已批阅/结果页」没有 `li[qid]`，或还没加载完 |
| 字形匹配失败 | 当前上下文没加载 cxsecret（不在题目页），或渲染进程已崩 |
| 提交卡在弹层 | 用 `evaluateAll` 找 `.jb_btn`，不能只在 iframe 里找 |
| `Cannot find context` | 页面重渲染，`relocalCtx` 重定位（已自动处理） |
| `CDP timeout` / 标签页消失 | 渲染进程崩溃，`/json/close` 关标签重开 |
| 视频不动 | Edge 被最小化 / 被完全遮挡 / 平台暂停，脚本每 3 秒自动 resume；日志有 `页面处于隐藏状态` 就是遮挡 |
| 整章被「已批阅，跳过」连续吞掉 | 切节没生效（目录项缺 onclick）。看日志有没有 `服务端退回待完成节点` / `章节切换未生效`；新版会**自动刷新学习页解锁**，不再兜底 `getTeacherAjax`（那条路会拿到「提交失败」页） |
| 日志 `目标节点尚未解锁（第 N/4 次检查），刷新学习页重试` | 正常自愈路径：说明上一节刚做完、侧栏还没下发下一节权限，刷新即可；连刷 4 次仍不解锁才是真问题（前一个任务点确实没完成） |
| 视频播完目录却不打勾 / 下一节点一直锁着 | 这节还有「章节测验」任务点没做（`.prev_ul li` 第二个标签）。日志应有 `本节有「2章节测验」标签，切换过去作答`；没有就是 tabs 没抓到，手动点一下标签再跑 |
| 日志 `本节无测验标签：1视频` | 该节只有视频，正常跳过 |
| 视频内弹题被「冲过去」没答 | 弹题出现时模块会 `pause()`，脚本的 `play()` 会顶回去。新版每 3 秒先查 `.ans-videoquiz`，有就停止强制播放并作答；单测用 `node run.js videoquiz` |
| 阅读节点停 60s 也不完成 | 这类节点必须点「去阅读」进阅读器，光停留不计时；脚本点不开时会提示你手动点，然后轮询完成状态 |
| 阅读任务点等很久不变 | 学习通阅读时长是**当天累计、次日更新**，页面显示 `0.0分钟` 属正常；任务点图标通常要点进阅读器读够时间才会亮 |

---

## 九、维护

改了工作区 `D:\Vibe-Coding\chaoxing-auto\src\*` 之后，同步到发布仓：

```bash
cp src/*.js <clone>/.opencode/skills/chaoxing-auto/src/
git -C <clone> commit -am "fix: ..." && git push
```

发布前脱敏：`config.example.json` 里的 key 一律换占位符。
