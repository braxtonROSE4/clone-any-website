# clone-website

[English](README.md)

一个 agent skill：只给一个 URL，就把线上网站 1:1 复刻出来（布局、排版、素材、滚动动效、有状态交互），并且用打分 benchmark 证明相似度，而不是嘴上说"差不多了"。

方法论一句话：把线上站当成可以查询的事实源，不是拿眼睛比对的图片。从运行中的页面里取出真实的 DOM、真实的 CSS token、真实的关键帧、真实的字体、真实的配置数据，照这些事实重建，然后用同一个探针跑原站和克隆站，对着数字差异改到收敛。

标准 Agent Skills 包：一个 `SKILL.md` 加上 `references/`、`scripts/`、`tools/`，没有任何 agent 特化代码。Claude Code、Codex CLI、Cursor、Gemini CLI、opencode 以及其他支持这套标准的 agent 都能直接用。

已实战验证的站点：arc.net、town.com、wisprflow.ai、landonorris.com、creativemarketing.peachweb.io。

## 安装

一行命令，任何 agent 通用：

```bash
curl -fsSL https://raw.githubusercontent.com/braxtonROSE4/clone-any-website/main/install.sh | sh
```

它把一份副本装到 `~/.agents/skills/clone-website`（Cursor、Gemini CLI、opencode 直接读这个厂商中立目录），再软链到已存在的 `~/.claude/skills/` 和 `~/.codex/skills/`，这样以后一次 `git pull` 所有 agent 同时更新。重复跑同一条命令就是更新。加 `--project [dir]` 则只装到某个项目的 `<dir>/.agents/skills/` 下，不动全机。

手动装同样可以，因为交付物就是一堆文件：

| Agent | 克隆到哪个目录 |
|-------|--------------|
| Claude Code | `~/.claude/skills/clone-website` |
| Codex CLI | `~/.codex/skills/clone-website`（或 `$CODEX_HOME/skills/`） |
| Cursor | `~/.cursor/skills/clone-website`，或 `~/.agents/skills/clone-website` |
| Gemini CLI | `~/.gemini/skills/clone-website`，或 `~/.agents/skills/clone-website` |
| opencode | `~/.config/opencode/skills/clone-website`（它也读 `~/.claude/skills` 和 `~/.agents/skills`） |
| 其他能读文件、能跑 shell 的 agent | 随便克隆到哪，把 agent 指向 `SKILL.md` |

```bash
git clone https://github.com/braxtonROSE4/clone-any-website.git ~/.agents/skills/clone-website
```

目标文件夹必须叫 `clone-website`：agent 是从文件夹名取 skill 名的，且要求和 frontmatter 里的 `name` 一致。项目级安装用同样的布局放在仓库里，目录换成 `.agents/skills/`、`.claude/skills/`、`.codex/skills/` 或 `.cursor/skills/`。

装好之后不用手动调用，你提复刻需求它自己会加载。触发说法包括"复刻这个落地页"、"1:1 复刻这个网站"、"这个站的滚动效果是怎么做的"。

## 运行时依赖

所有对活页面的操作都以 `ego-browser nodejs <<'EOF' ... EOF` 的形式跑，调用的是 ego lite 的 TaskSpace/Page 接口（`taskSpace()`、`task.pages()`、`page.goto()`、`page.evaluate()`、`task.finish()`）。开工前 agent 会先跑 `ego-browser skill`，拿到和本机 ego lite 版本对应的用法说明。已在 ego lite 0.6.3.12、用法说明 v2.2.1 上实测；如果 ego lite 太旧，`ego-browser skill` 会报 `Unknown command: skill`，先跑 `ego-browser upgrade` 升级。

ego lite 在 https://lite.ego.app/ ，支持 macOS 和 Windows。macOS 上 `scripts/install-ego-browser.sh` 负责下载安装；Windows 上从官网下载安装包，本 skill 的脚本在 Git Bash 里跑。装好后你在 app 里走完首次引导，`ego-browser` CLI 就注册好了。

这个运行时不能换成 Playwright 或裸 headless Chrome，skill 里写明了拒绝替换。三个原因：像素级对齐的循环要求两侧跑完全相同的探针、在完全相同的运行时里，否则差异数字没有意义；纠错循环要用 task space，agent 在自己隔离的 space 里探测，你同时在自己的 space 里浏览原站和克隆站，两边不抢浏览器；这个 skill 里每一段探针脚本和环境坑位都是对着这个运行时的实测行为校准的。

## 工作流做什么

| 阶段 | 做什么 |
|------|--------|
| Phase 0，准备 | 建 `reference/{dom,css,js,screenshots}/` 收侦察产物，后台起固定端口 dev server。探测克隆站前先断言 `document.title` 对得上：curl 通不等于浏览器 tab 里显示的就是你的页面 |
| Phase 1，静态抓取 | 一次调用抓完 DOM、section 轮廓、CSS/字体/JS 资源清单和 scroll-0 全页截图。design token 从下载下来的 CSS 里 grep，绝不从截图估。`@font-face` 常由 JS 运行时注入，所以字体只能在活页面上用 `document.fonts` 加 `document.styleSheets` 走查取。产品 UI 里的假数据来自编译后 JS chunk 里的 config 对象 |
| Phase 2，动效逆向 | 从最便宜的手段开始：先 grep CSS 找 `animation-timeline`，再用 `getAnimations({subtree:true})` 拿关键帧和 timeline 类型，再上 MutationObserver 配真实滚轮滚动，最后对 sticky 状态机做多深度双向采样 |
| Phase 3，重建 | 按站点类型选路线。Webflow、Framer 这类静态导出站做成 raw-HTML 镜像，骨架取水合前的服务端 HTML；Next.js、Remix 这类框架站按 section 拆组件重建 |
| Phase 4，验证加跑分 | 用探针迭代到收敛，然后跑打分 eval。八个维度对固定阈值，总分低于 90 或任一维度不及格就不算完成 |
| Phase 5，整站模式 | 爬 nav/footer 链接加 sitemap 拿页面清单，公共骨架只侦察一次，然后逐页复刻逐页打分 |
| Phase 6，发布 | `reference/` 下的东西全部不进仓库，README 写归属声明，任何公开推送都要先警告商用字体和下载素材的再分发风险 |

## 打分 benchmark

```bash
bash scripts/run_eval.sh https://original.example http://localhost:3400 ./eval-out [taskSpaceId]
```

同一个探针跑原站和克隆站，产出 `scorecard.json` 和 `report.md`，八个维度打分：几何、排版、颜色、素材、字体、动画、mock 内容、视觉相似度。退出码 0 代表通过。前置条件是 `ego-browser` 在 PATH 上、有 `python3`、克隆站 dev server 在跑、本机有一个装了 Pillow 的 Python。脚本会按 `python3`、`python`、`/usr/bin/python3` 的顺序找第一个能用 Pillow 的来打分，都没有就跳过视觉维度并重新归一总分。Homebrew 的 `python3` 不允许直接 `pip install`，macOS 上可以用自带的 `/usr/bin/python3`，或者建一个装了 Pillow 的虚拟环境再激活。页面高度超过 Chromium 单张截图上限 16384px 时，会分段截图再拼成一张，长落地页也能参与视觉维度打分。

两条测量纪律写死在协议里。原站每天都在漂，所以跑分只对当天探到的那份 `original.json` 有意义；回归掉分时先查原站动没动，再去怀疑克隆站。另外无限时间轴动画（GSAP `repeat:-1`、跑马灯、自动滚动轮播）采样前必须做相位归一化，否则两侧各停在随机循环相位上，探针的时序抖动会被报成位置误差（在 wisprflow.ai 上实测到 50-2879px）。

## 仓库结构

| 路径 | 内容 |
|------|------|
| `SKILL.md` | 主工作流：执行模型纪律、六个阶段、可证伪的 correctness rules、探针环境坑位表 |
| `install.sh` | 跨 agent 安装器：`~/.agents/skills/` 放一份，软链到机器上已有的各个 agent |
| `references/probes.md` | 每个阶段的 ego-browser 探针脚本，换个 URL 就能直接跑 |
| `references/eval.md` | 打分协议：八个维度的算法、阈值、测量条件 |
| `references/install.md` | ego lite 安装引导 |
| `references/tool-design-template.md` | 往 `tools/` 里加新工具时的设计模板 |
| `tools/` | 类型化工具层，`manifest.json` 注册 capture_static、full_page_screenshot、inventory_animations、sample_scroll_states、eval_probe |
| `scripts/` | `run_eval.sh` 跑分入口、`eval_score.py` 打分器、`slice.py` 按 DOM rect 切全页截图、`install-ego-browser.sh` |
| `learnings/<site>/` | 具体站点的复刻笔记（选择器、坑、config 对象在哪），下次复刻同一个站直接热启动 |
| `agents/openai.yaml` | Codex 的展示元信息，可选，其他 agent 会忽略 |

## 用之前先想清楚的事

复刻出来的东西里，设计、文案、图片、字体的权利都还在原站作者手上。这个 skill 的用途是研究实现方式、做技术研究、重建你本来就有权利的页面。公开发布克隆站之前：`reference/` 里抓下来的 DOM/CSS/JS 一律不要进仓库，README 里写清楚归属，商用字体要么换成开源近似字体、要么和原站的图片视频一起 gitignore 掉。字体是最现实的 DMCA 风险点，仓库或帖子在给产品导流时，"非商用"不构成保护。
