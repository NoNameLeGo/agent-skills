# Agent Skills

个人 AI Agent 技能集合 —— 面向 OpenCode / pi / WorkBuddy 等通用，全部零依赖或低依赖，拿到就能跑。

## Skills

| Skill | 说明 | 依赖 |
|-------|------|------|
| [`chaoxing-auto`](.opencode/skills/chaoxing-auto) | 学习通/超星**自动刷课 + 自动做题**：视频自动播完、章节测验自动作答并提交、防复制字体还原、多模型交叉校验。**自带完整实现** | Node 22+（零 npm 依赖） |
| [`browser-cdp`](.opencode/skills/browser-cdp) | Chrome DevTools Protocol 自动化：连已有调试端口、复用登录态、执行 JS、提取 token | Python 3.8+ / `websocket-client` |

## 安装

### 方式一：克隆整仓（推荐）

```bash
git clone https://github.com/NoNameLeGo/agent-skills.git
```

把需要的 skill 目录拷进对应 Agent 的 skills 目录：

| Agent | 目标目录 |
|-------|----------|
| OpenCode | 在 `opencode.json` 的 `skills` 里写本仓库中的路径 |
| pi | `~/.pi/agent/skills/` |
| WorkBuddy | `~/.workbuddy/skills/` |

```bash
# 例：装到 pi
cp -r agent-skills/.opencode/skills/chaoxing-auto ~/.pi/agent/skills/
# 例：装到 WorkBuddy
cp -r agent-skills/.opencode/skills/chaoxing-auto ~/.workbuddy/skills/
```

### 方式二：只取一个 skill

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/NoNameLeGo/agent-skills.git
cd agent-skills
git sparse-checkout set .opencode/skills/chaoxing-auto
```

## chaoxing-auto 快速开始

```bash
cd .opencode/skills/chaoxing-auto
cp config.example.json config.json     # 填 answer.freeai 的 baseURL / apiKey / model
# 双击 edge-start.cmd 启动独立静音 Edge（端口 9223），在里面登录学习通
node run.js status                     # 确认连通与登录态
node run.js list                       # 看课程目录：已完成 / 未完成
node run.js course                     # 开刷：视频自动过 + 测验作答提交
```

细节、页面结构实测表、已知限制见 [`SKILL.md`](.opencode/skills/chaoxing-auto/SKILL.md) 与 [`README-项目.md`](.opencode/skills/chaoxing-auto/README-项目.md)。

**要点**：
- 本机 Node 不能 spawn 子进程时，浏览器必须由 `edge-start.cmd` 外部拉起（Playwright/Puppeteer 会 EBUSY）
- Edge 窗口**不能最小化**，否则学习通判定离开页面暂停计时
- 单账号串行，`state/run.lock` 文件锁
- 不保证满分：实测 100 / 80 分各一次，两模型交叉校验只是降低错误率

## 历史

原仓库名 `opencode-skills`，因为技能已同时用于 pi 和 WorkBuddy，2026-10 更名为 `agent-skills`。
原 `chaoxing-autopilot`（纯 DOM 选择器版，不自动提交）已被 `chaoxing-auto` 取代，旧版可从 git 历史取回。

## License

[GPL-3.0](LICENSE)
