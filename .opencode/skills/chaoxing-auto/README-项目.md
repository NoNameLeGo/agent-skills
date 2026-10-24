# chaoxing-auto — 学习通自动刷课 + 自动做题

零依赖（只用 Node 22 原生 `WebSocket` / `http`），通过 CDP 驱动一个**独立静音的 Edge 实例**，
完成：自动播放视频到任务点完成 → 遇到章节测验自动作答并提交 → 遇到作业自动作答但**只暂存**。

不依赖「大学搜题酱」插件的任何接口（该插件非 VIP 且不想用），搜题自己走四级降级链。

---

## 快速开始

1. **启动调试浏览器**（必须，Node 在本机不能 spawn 子进程）

   ```
   双击 edge-start.cmd
   ```

   首次会打开一个干净 profile，在里面登录学习通（扫码最快）。之后 cookie 常驻，不用再登。

2. **确认连接**

   ```
   node run.js status
   ```

3. **进课程页再跑**

   ```
   node run.js open "https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=<id>&clazzid=<id>&chapterId=<id>&enc=<enc>&cpi=<cpi>&mooc2=1"
   node run.js course
   ```

   `enc` 从课程卡跳转后的地址栏拿（`visit/stucoursemiddle` 会自动 302 到带 enc 的地址）。

---

## 命令

| 命令 | 作用 |
|---|---|
| `node run.js status` | 查端口、标签页、是否已登录 |
| `node run.js open <url>` | 在该浏览器里打开页面 |
| `node run.js probe` | 打印当前页所有 iframe 上下文的 DOM 计数（改选择器时用） |
| `node run.js list` | 列出课程目录，标出已完成 / 未完成 |
| `node run.js course [--max N]` | **主流程**：按目录顺序刷，视频自动过、测验提交、作业暂存 |
| `node run.js quiz [--submit] [--answers <file>]` | 只处理当前页面的题（默认只暂存）；`--answers` 可跳过出答案用现成答案 |
| `node run.js shot [out.png]` | 截当前页，用于人工/视觉核对 |
| `node run.js eval "<js>" [--all]` | 在页面里执行 JS（`--all` 含 iframe） |
| `node run.js probe-answer` | 不碰页面，只测答案链能不能用 |

---

## 答题：四级降级链

`config.json → answer.chain`，按顺序试，某级没解出来的题自动交给下一级。

| 级别 | 是什么 | 需要的配置 |
|---|---|---|
| `freeai` | 免费 AI，OpenAI 兼容接口 | `answer.freeai.baseURL / apiKey / model` ← **API key 填这里** |
| `webai` | 网页版大模型（千问 / 豆包），CDP 注入提问、读回复 | 在该 Edge 里登录一次；只在**同一个对话**里连续问，不新开会话 |
| `websearch` | 必应搜索 + 摘要启发式提取 | 无需配置 |
| `localllm` | 本地 Ollama / LM Studio | `answer.localllm.baseURL / model` |

未解出来的题**留空不猜**（宁可错一题也不乱填），日志会列出来。

命中过的题按题干哈希缓存在 `state/answer-cache.json`，同题下次直接复用。

### 填 freeai 的位置

```json
"freeai": {
  "baseURL": "https://api.xxx.com/v1",
  "apiKey": "sk-xxxx",
  "model": "xxx"
}
```

`baseURL` 留空则自动跳过本级。

---

## 静音：作用于整个浏览器，不是单个 video

- `edge-start.cmd` 带 `--mute-audio` → **整个 Edge 实例静音**，覆盖所有标签页、所有 iframe、WebAudio、动态插入的媒体。
- 页内再设 `video.muted = true` 做双保险。
- 两者都**不改变** `video.muted` 的对外语义之外的任何播放逻辑，`playbackRate` 与进度上报不受影响。

实测（2026-10-24）：视频 `paused=true` 时强制 `play()` 后 `currentTime` 正常前进，`rate=1`，`muted=true`，任务点进度正常累计。

---

## 单账号串行是什么意思

同一时刻**只允许一条流水线在动这个账号**：

1. 不做多标签页并行刷课 —— 同一 `ut/enc` cookie 的多路并发请求，是学习通风控最典型的脚本特征。
2. 不并发发答题请求 —— 并发会让「题面 → 答案 → 页面 DOM」三者错位。
3. 项目内用 `state/run.lock` 文件锁强制：第二个实例启动会直接报错退出，并提示先杀掉占用者。

要停就 `Ctrl+C`，锁会自动释放；异常残留时删 `state/run.lock`。

---

## 已验证的页面事实（2026-10-24 实测）

| 项 | 值 |
|---|---|
| 目录项 | `div.posCatalog_select`，`id="cur{knowledgeId}"`；章标题带 `firstLayer`、无 `cur` 前缀 |
| 目录点击 | 内部 `span.posCatalog_name[onclick="getTeacherAjax(courseId,clazzid,knowledgeId)"]` |
| 已完成标记 | 项内存在 `span.icon_Completed` |
| 当前节 | 类名 `posCatalog_active` |
| 章节切换 | `getTeacherAjax` GET `/mycourse/studentstudyAjax`，**整块重写 `#mainid` 的 innerHTML**（顶层 URL 不变） |
| 知识页 iframe | `#iframe` → `mooc-ans/knowledge/cards?...&knowledgeid=` |
| 视频播放器 | `iframe.ans-attach-online.ans-insertvideo-online` → `ananas/modules/video/index.html`，内含 `<video>` |
| 任务点条件 | 观看时长 ≥ 总时长 90%；未完成前不可拖拽、不可离开/最小化 |
| 顺序解锁 | 前一个任务点未完成时，点后面的节点会被服务端退回原节（不是脚本 bug） |
| 章节测验页 | `mooc-ans/work/doHomeWorkNew?courseId=&workId=`，题目 `#question{qid}` 在里面 |
| 测验选项布局 | `li[qid][qtype] > span.num_option[data] + a.after`（**不是** `div.answerBg`） |
| ⚠️ 选项映射 | `span` 里的文字才是页面显示的 A/B/C/D，`data` 是提交用的答案码，**两者顺序常被打乱**（如显示 A 对应 data B）。必须按 `span` 文字排序后再映射 |
| 传测验的按钮 | `a.btnSubmit[onclick="btnBlueSubmit();"]`（暂无 `submitWork()`）；暂存是 `a.btnSave[onclick="noSubmit();"]` |
| 提交二次确认 | 弹层 `.Marking/.popDiv` 里的 `a.jb_btn`，文字「提交」；另有 `.AlertCon02` 未达及格线提示（`#submitBackOk`）。通用打法：找可见、文字为 确定/确认/提交/交卷、**排除底部 `.workBtnIndex`**、取层级最深的那个 |
| 提交结果判定 | 提交后 `#cur{kid}` 内出现 `.icon_Completed`，测验页显示「第N次作答 本次成绩X分」 |

## ⚠️ 防复制字体（font-cxsecret）——最坑的一环

章节测验/作业的题干与选项套了 `class="font-cxsecret"`，字体是一个内联 base64 TTF：
DOM 里取到的文字是**打乱过的码位**（如 `人庡庩放军`），肉眼正常，复制/`innerText` 全是乱码。

`srv/decode.js` 的处理方式：

1. 把打乱字符用 `font-cxsecret` 在 canvas 上画出来（字形是真的）；
2. 把 20902 个候选汉字用系统黑体（微软雅黑/黑体/等线）画出来；
3. 两者都裁到墨迹包围盒、等比归一化到 20×20 灰度，按像素差取最近邻；
4. 结果按字符缓存到 `state/fontmap.json`，同字下次直接查表（首次约 15–30s，之后 0s）。

实测：13/13 常见字一次命中；个别形近字（民/弓、西/酉）会认不准，**认不准的不猜**，记为原字符，
可以手工改 `state/fontmap.json` 修正（格式：`"打乱字符": "真字符"`）。

`document.fonts.check('16px font-cxsecret')` 在 `about:blank` 里也会返回 true，**不能**用它判断字体是否加载；
要扫 `[...document.fonts]` 里 family 与 status。

题目相关的 DOM 事实（`check_answer` / `#answer{qid}` / `UE.instants` 等）见 `src/extract.js` 与 `src/fill.js` 顶部注释。

---

## 已知限制

- **答案源必须先配好**：四个 tier 都没配时，题目会「留空不猜」并直接跳过，**不会提交空卷**。要真跑题，至少填 `answer.freeai`，或在该 Edge 里登录一次千问/豆包让 `webai` 可用。
- **Edge 窗口不能最小化**，学习通会判定「离开页面」并暂停计时。
- 视频固定 1 倍速。改倍速会被平台记录，不建议。
- 考试（`study.exam`）默认关闭，需要手动开。
- 作业（作业列表里的任务）只暂存不提交；刷课途经的章节测验按 `study.chapterQuiz.autoSubmit` 提交（默认开）。要改成只暂存就设 false。
- 文档/PPT 类任务点按「阅读时长」计，`study.readSeconds`（默认 60s）内模拟滚动停留；**这段逻辑未在真实文档节点上验证过**，可能仍需加长或人工滚动。
- 用 `run_in_background` 之类方式在脚本里拉起 Edge 时，宿主任务一结束 Edge 会被连带杀掉 —— 正常使用请双击 `edge-start.cmd`。

---

## 配置速查

```jsonc
"study": {
  "playbackRate": 1,
  "chapterQuiz": { "autoSubmit": true },   // 章节测验：做完提交并继续
  "work":        { "autoSubmit": false },  // 作业：只暂存
  "maxMinutesPerPage": 45
},
"humanize": { "minGap": 3000, "maxGap": 12000 }  // 答题间隔 3–12 秒随机
```
