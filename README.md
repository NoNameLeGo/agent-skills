# Agent Skills

一组可直接运行的 AI Agent 技能（skills）—— 面向 **WorkBuddy / pi / OpenCode** 等支持 skills 的 Agent，零依赖或低依赖，装上就能用，不含占位代码。

这些技能都来自日常真在用的事情（刷课、抓网页、造 Electron 包……），所以里面写满了**实测出来的坑**，不是从文档抄的。

---

## 现在有什么

| Skill | 干什么 | 依赖 | 状态 |
|---|---|---|---|
| [`chaoxing-auto`](.opencode/skills/chaoxing-auto) | 学习通/超星**自动刷课 + 自动做题**：视频自动播完、章节测验自动作答并提交、防复制字体还原、多模型交叉校验、阅读任务点自动处理 | Node 22+（**零 npm 依赖**） | 可用，长期维护 |
| [`browser-cdp`](.opencode/skills/browser-cdp) | Chrome DevTools Protocol 自动化：复用已登录的浏览器、执行 JS、提取 token、抓 DOM | Python 3.8+、`websocket-client` | 可用 |

> 每个技能目录里都有 `SKILL.md` —— 那是给 Agent 读的 runbook（触发条件、流程、验收点、排障表），人类的快速上手看本 README 就够。

---

## 安装

### 方式一：整仓克隆（推荐）

```bash
git clone https://github.com/NoNameLeGo/agent-skills.git
```

把要用的技能目录拷进对应 Agent 的技能目录：

| Agent | 技能目录 |
|---|---|
| WorkBuddy | `~/.workbuddy/skills/` |
| pi | `~/.pi/agent/skills/` |
| OpenCode | 在 `opencode.json` 的 `skills` 里指向仓库内路径 |

```bash
cp -r agent-skills/.opencode/skills/chaoxing-auto ~/.workbuddy/skills/
```

### 方式二：只取一个（省流）

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/NoNameLeGo/agent-skills.git
cd agent-skills
git sparse-checkout set .opencode/skills/chaoxing-auto
```

### 方式三：直接下载

GitHub 页面右上角 **Code → Download ZIP**，解压后取 `.opencode/skills/<name>/` 整个目录（**整个目录都要**，技能依赖里面的 `src/` 和脚本）。

---

## chaoxing-auto 快速开始

```bash
cd .opencode/skills/chaoxing-auto

# 1. 配置答案源（不填就只能刷视频，题目会留空不猜）
cp config.example.json config.json
#    编辑 config.json → answer.freeai 填 baseURL / apiKey / model（任意 OpenAI 兼容接口）
node run.js probe-answer          # 冒烟测试，不碰页面

# 2. 起浏览器：双击 edge-start.cmd（Windows）
#    它会拉起一个独立的静音 Edge（调试端口 9223），在里面扫码登录学习通

# 3. 进课程：在那个 Edge 窗口里点进要刷的课，停在任意一节

# 4. 开刷
node run.js status                # 确认端口/页面/登录态
node run.js list                  # 看目录：已完成 / 未完成
node run.js course --max 40       # 按顺序处理未完成任务点
```

一次 `course` 会处理：**视频**（1x 静音播到 ≥90%）、**章节测验**（抽题→字形还原→多模型作答→交叉校验→填答→提交）、**阅读任务点**（点「去阅读」→ 阅读器停留）、**文档/PPT**。

### 四个必须知道的约束

1. **浏览器必须外部拉起** —— 这台机器上 Node 不能 spawn 子进程，Playwright/Puppeteer 会永久 `EBUSY`。所以是 `edge-start.cmd` 而不是 `browser.launch()`。
2. **窗口不能被最小化，也不能被完全遮挡** —— 页面 `document.hidden=true` 时学习通判「离开页面」，计时不记。放旁边、缩小都行。
3. **端口固定 9223** —— 9222 常被 IDE/编辑器自己的 Electron 占用，连错浏览器会白忙。
4. **单账号串行** —— `state/run.lock` 文件锁，第二个实例会自己退出。

### 效果预期

- 视频：一节 20 分钟的视频就是 20 分钟，**不会更快**（1x + 90% 判定，加速容易触发风控）
- 测验：不保证满分。实测 100 分、80 分都有过；两个模型交叉校验只是把错误率压下来
- 抽题/填答异常时会**拒绝提交**（宁可少交，不交白卷），日志会写 `不提交，只暂存`

细节（页面结构实测表、font-cxsecret 防复制字体、iframe 上下文失效、确认弹层位置）全在 [`SKILL.md`](.opencode/skills/chaoxing-auto/SKILL.md)。

---

## 目录结构

```
agent-skills/
├── README.md
├── LICENSE                     # GPL-3.0
└── .opencode/
    └── skills/
        ├── chaoxing-auto/      # 自带完整实现，不依赖外部项目
        │   ├── SKILL.md        # Agent runbook
        │   ├── run.js          # CLI 入口
        │   ├── src/            # cdp / extract / fill / decode / answer / flow / study / reading
        │   ├── scripts/        # 字形表构建等辅助脚本
        │   ├── config.example.json
        │   ├── edge-start.cmd  # 起静音调试 Edge
        │   └── 刷课.cmd         # 一键：起浏览器 + 开始刷
        └── browser-cdp/
            └── SKILL.md
```

---

## 更新日志

- **2026-10-25** `chaoxing-auto`
  - 修：目录项缺 `onclick` 时切节静默失败，导致整章被误判「已批阅」而跳过（现在会兜底直接调 `getTeacherAjax`，切不动就报错停机）
  - 修：答案降级链里的网页版千问（`webai`）要等 3 分钟还读不到回复 —— 移出默认链，漏解题改交给备用 API 模型补答
  - 新：「阅读」类任务点自动点「去阅读」并停留；脚本点不开时明确提示手动点，并轮询完成状态
  - 新：诊断日志会提示页面被遮挡/最小化
- **2026-10** 仓库改名 `opencode-skills` → `agent-skills`（技能已同时用于 pi 和 WorkBuddy）。原 `chaoxing-autopilot`（纯选择器版、不自动提交）被 `chaoxing-auto` 取代，旧版仍可从 git 历史取回。

---

## License

[GPL-3.0](LICENSE)
