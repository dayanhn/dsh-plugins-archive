# dsh 本地插件安装与定制改造总结

> 机器：`/home/<用户名>`（Linux，Node v22.23.2 via nvm，pnpm 11.7.0 via corepack）
> dsh 源码：`/home/<用户名>/code/tool/deepseek-harness`（0.1.1-rc.1，`dsh` 全局命令 = `~/.local/bin/dsh` 包装脚本）
> 整理日期：2026-08-22

---

## 一、已安装的插件清单

所有插件都装在 **web profile**（`~/.dsh/profiles/web/package.json`），bundler 层栈为：
`@deepseek-ai/dsh-base → @deepseek-ai/dsh-web-app → dsh-remote → @yuxianglin/dsh-bridge-browser`

| 插件 | 版本 | 来源 | 作用 |
|---|---|---|---|
| `dsh-remote` | 0.8.7（**本地 fork**） | `~/code/tool/dsh-remote`（npm 社区包 flymysql 0.8.7 基线 + 修复/提速） | SSH 远程工作区：Web GUI 里把远端机器目录镜像成本地工作区，agent 的文件读写/命令执行发生在远端 |
| `@yuxianglin/dsh-bridge-browser` | 0.1.2（**本地 fork**） | `~/code/tool/dsh-browser`（上游 `Lum1104/dsh-browser`） | 浏览器桥接：dsh 侧 WebSocket 桥 + Chrome 扩展，agent 可读取/操作用户真实浏览器；扩展提供侧边栏聊天 |
| `dsh-better-sidebar` | 0.14.0（**本地 fork**） | `~/code/tool/dsh-better-sidebar`（npm 包 tarball 基线 + 嵌套仓库支持） | 侧边栏增强：文件/源代码管理/任务/终端/浏览器 tab；fork 增加「非仓库目录自动发现子仓库」 |

### 重要：npm 同名包陷阱

npm 上的 `dsh-browser@0.1.0`（ben7am1n）是**另一个项目**（Playwright 无头浏览器），与 Lum1104 的浏览器扩展**无关**。安装必须走 Lum1104 仓库的脚本/源码路径，不能 `dsh plugin add dsh-browser`。

### dsh-remote 配置（`~/.dsh/remote-workspaces/machines.json`）

两台机器，目标都是 `<目标机IP>`（<目标机主机名>，用户 <用户名>，key `~/.ssh/id_rsa`）：

| 名称 | 连接方式 | 前提 |
|---|---|---|
| 公司内网 · 经跳板机 | 插件原生单跳代理 → `<跳板机IP>` → 目标 | 在公司网络 |
| 在家 · 经本地隧道 <本地转发端口> | 直连 `127.0.0.1:<本地转发端口>` | 先跑 `ssh -N -o ExitOnForwardFailure=yes -L <本地转发端口>:127.0.0.1:22 <ssh别名>`（复用 `~/.ssh/config` 的三跳链：frpc 反隧道 <反隧道端口> → <中间跳板> → 跳板 → 目标） |

**插件架构限制**（读源码确认，决定了"在家"必须走本地隧道）：
- `proxy` 字段只支持**单层**跳板（跳板连接写死 `proxy: undefined`，不支持嵌套）
- 全局**只有一个** SshPool，切换机器 `setTarget()` 会断开当前连接
- 因此"跳板机 + 插件内部隧道"的组合不可行；三跳链交给 OpenSSH，插件只连最后一段本地端口

验证：`test-connect` 在家路径实测通过（1920ms 往返）；host key 按 TOFU 策略记录在 `~/.dsh/remote-workspaces/known_hosts.json`。

### dsh-browser 安装方式

- 源码 checkout：`~/code/tool/dsh-browser`（git 管理，含上游基线提交）
- dsh 侧：`pnpm dsh plugin --profile web add -w "@yuxianglin/dsh-bridge-browser@link:/home/<用户名>/code/tool/dsh-browser/packages/browser/bridge-browser"`（link 本地目录）
- 浏览器侧：构建产物同步到 `~/.dsh/browser-extension/`，Chrome `chrome://extensions` 以"已解压扩展"加载；本机回环零配置（自动探测端口 3080/3081/3090/14389 的 `/ext/bridge-config`）

---

## 二、改造：Chrome 页面选中文字右键问 dsh

### 需求

1. 选中网页文字 → 右键 → **"用 dsh 解释选中文本"**：只把选文（+来源 URL）发给模型解释，**不读整个页面**
2. 右键 → **"带着选中文本问 dsh"**：选文作为引用暂存，用户再输入自己的问题一起发出
3. 后续追加需求：回答要**流式输出**；流式输出时**允许上滚阅读**（不被强制拉到底）

### 总体架构

```
[Chrome 扩展 background (service worker)]
   │ chrome.contextMenus（selection 上下文）
   │ chrome.storage.session（跨进程交接载体）
   │ port 消息（chrome.runtime.connect，仅触发/状态）
[扩展 panel（侧边栏 React）]
   │ port → 同一 service worker
[service worker 内的 BridgeClient]
   │ WebSocket ws://127.0.0.1:<port>/ext/bridge（hello 帧认证；回环免 token）
[dsh 侧 bridge 插件]
   │ toFetchHandler(ctx.apiProxy) —— 与 Web GUI 完全同一条网关
[apiproxy 会话网关]  session.create / session.prompt / events.mux()
[agent loop + LLM]    （本地 qwen3.8 网关 127.0.0.1:9082）
```

关键事实（读源码确认）：
- bridge 的事件泵**无过滤**地转发所有会话事件，包括 token 级 `assistant/chunk`
- 面板原有的 `rowFromEvent` 只渲染完整 `user/message`、`assistant/message`，chunk 被丢弃 → **上游扩展从来就不流式**
- 面板 `onFrame` 对**非当前会话**的实时事件直接丢弃（`sessionId !== sessionRef.current → return`）
- 面板普通聊天路径：port `rpc` → background 先做"标签页绑定 + 整页快照注入"（`ensureInitialTabBinding` / `followedPageRefresh`）→ 再转发 `session.prompt`

### 实现方案（四个设计决策）

**① 选区提示词自带上下文 → 跳过整页快照（`bypassTabBinding`）**
背景侧 port 的 `case 'rpc'` 增加可选 `bypassTabBinding` 标志：为真时跳过标签页绑定与快照注入，直接转发。选文 + URL 就是全部上下文，整页快照多余且有隐私面。

**② "解释"流程：会话归面板所有，存储交接（解决一次性输出）**
最初版本是后台直接发 `session.prompt` 再通知面板切会话 → 面板切过去时流式事件已被丢弃，只能靠 `session.history` 快照一次性渲染。改为：

```
右键"解释"
 → openPanel（打开/聚焦侧边栏，顺带触发 bridge 连接）
 → waitBridgeConnected(20s)（失败 → 系统通知）
 → buildExplainPrompt(选文, URL, locale) 写入 chrome.storage.session[dshPendingExplain]
 → 广播 selection-ask（仅作触发器）
面板侧：
 → 会话就绪（auto-resume 或 create，由面板状态机独立完成，无竞争）
 → 发现暂存提示词（触发源：port 消息 / state→connected / 挂载时读存储，三路兜底）
 → send(prompt, { bypassTabBinding: true }) —— 走常规聊天路径 → 天然流式
 → 发送后清除暂存；60s TTL 防陈旧
```

选存储而非纯消息做交接的原因：面板刚打开时 React 监听器可能还没挂载，port 消息会丢；存储是确定性的。

**③ 流式渲染（`assistant/chunk`）**
- `text-delta` → 增量追加到"进行中"的 assistant 行（`appendChunkDelta`，`status:'running'`）
- 最终 `assistant/message` → **替换**流式前缀行（`mergeIncomingRow`，不重复）
- `tool/call` → 先收尾残留流式行（`settleStreamingRow`）再渲染工具卡片
- 复用 `status:'running'`：进度指示器以"最后一行是否在运行"为条件，文本增长期间"正在思考"自动隐藏
- `reasoning-delta`（推理内容）不渲染，由"正在思考"指示器表达（xhigh 推理档开头会先思考一段时间，属正常）
- 纯函数放 `events.ts`，历史重建（`mergeHistoryRows`）仍走 `rowFromEvent`，不受影响

**④ 智能跟随滚动（不再强拉底部）**
- 原实现每次 `rows` 变化都强制 `scrollTo(底)`
- 现实现：`stickToBottom` 状态 + `isNearBottom(scrollHeight, scrollTop, clientHeight)`（阈值 80px 纯函数）
- 贴底 → 跟随；上滚离开 80px → 放手，滚动条归用户
- 未跟随时底部中央浮出 ↓「滚动到最新」按钮，点击恢复跟随；手动滚到底同样恢复
- 重新贴底时机：发送新消息、切换会话（auto-resume / 历史选择器 / 审批聚焦）

### 改动文件清单（fork 内，`extensions/dsh-browser/` 下）

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/background/selection-ask.ts` | 新增 | 右键菜单注册、两流程接线、提示词构造（`buildExplainPrompt`/`buildQuotedPrompt`/`truncateSelection`）、存储键 |
| `src/background/index.ts` | 修改 | `case 'rpc'` 支持 `bypassTabBinding`；`waitBridgeConnected`/`broadcastToPanel`/`notifySelection`；Boot 区接线 `initSelectionAsk` |
| `src/panel/App.tsx` | 修改 | chip UI 与状态、`send()` 的 opts 与 `canSendNow`、`onFrame` 处理 `assistant/chunk`、智能滚动（state/handler/按钮/重新贴底点）、暂存提示词交接 effect |
| `src/panel/api.ts` | 修改 | `selection-pending`/`selection-ask` 消息类型；`rpc()` 加 `bypassTabBinding` 选项 |
| `src/panel/events.ts` | 修改 | `appendChunkDelta`/`mergeIncomingRow`/`settleStreamingRow` 纯函数；`SessionEventView.data.chunk` |
| `src/panel/scroll.ts` | 新增 | `isNearBottom` + 阈值常量 |
| `src/panel/strings.ts` | 修改 | `selection.*`、`app.scrollToLatest` 中英文案 |
| `src/panel/styles.css` | 修改 | `.selection-chip*`、`.messages-wrap`、`.scroll-latest` |
| `manifest.json` / `manifest.firefox.json` | 修改 | `contextMenus` 权限 |
| `tests/selection-ask.spec.ts` | 新增 | 提示词构造/截断/存储键 单测 |
| `tests/panel-events.spec.ts` | 修改 | 流式行合并 5 个用例 |
| `tests/panel-scroll.spec.ts` | 新增 | `isNearBottom` 4 个用例 |
| `tests/panel-session-transition.spec.ts` 等 3 个 | 修改 | chrome mock 补 `contextMenus`/`storage.session`/新 PanelApi 方法 |

dsh 侧 bridge 插件（`packages/browser/bridge-browser/`）**一行未改**——所有改造都在浏览器扩展侧。

### 提交史（`~/code/tool/dsh-browser`）

```
e20fd48 feat(panel): smart follow-scroll during streaming
21446f4 feat(panel): stream assistant text via assistant/chunk events
2dfda0b fix(extension): stream the explain-selection answer
4e5da38 feat(extension): selection context menu — explain or ask with quoted text
cd35bec baseline: upstream main (Lum1104/dsh-browser) before selection-ask feature
```

`git diff cd35bec..HEAD` 即完整定制 patch（可提 PR 给上游）。

### 验证记录

- typecheck（tsc strict）通过
- 测试 **232/232**（39 个文件，含 23 个新增用例）
- 构建产物静态检查（菜单 id、bypass 标志、chip、流式函数均在 bundle 中）
- 运行时：临时实例 `/ext/bridge-config` 200 + 正确 wsUrl；dsh-remote `test-connect` 1947ms 通过
- 用户实测：右键两流程可用、流式输出正常、上滚阅读 + ↓ 按钮正常

---

## 三、dsh-remote fork：SFTP 会话泄漏修复 + 同步提速

### 问题

1. 浏览远程目录**频繁报错**：`browse failed: ssh sftp failed: Received unexpected SFTP session termination`，但 SSH 连接本身是好的
2. 远程文件同步（`rw_sync`）**很慢**：280 文件 / 17MB 冷同步 37s；第二次全量无变化仍要 11s（还要发 280 个远端 stat）

### 根因（读源码 + 真机实证）

- **泄漏**：`SshPool.sftp()` 每次调用都开一个**新的 SFTP 子系统会话**（`c.sftp()`），返回的适配器**没有 close** → 每个 `rw_*` 工具调用 / 目录浏览泄漏一个会话。真机实证：旧代码 30 次 `/dsh-remote/ls` 后目标机残留 **12 个 `sftp-server` 进程**，只能靠整条连接断开才清掉。
- **错误不被重试**：旧重试正则只认 `channel open failure|open failed`（通道打开被拒）。而用户看到的串来自 ssh2 `client.js:1603` 的 `onExit`——**会话建立阶段通道被对端关闭且无 exit code/signal**（服务端会话限额/中间 hop 清理），不在重试集里 → 直接抛给 GUI。
- **慢**：sync.js 并发写死 4；目录深度优先**串行**遍历（每目录 = 一次线上往返）；无变化文件也逐个远端 stat；`readFile` 整文件进内存 + 非原子落盘。

### 修复（fork 提交 `f220802` + `5f71089` + `fc2ae7f` + `4a3e4c2` + `e8c2c76`，改 `lib/index.js` + `lib/sync.js` + `lib/client.js`）

**SshPool（index.js）**
- **会话池化**：每条 SSH 连接只缓存**一个** SFTP 会话（`sftpSession`）；并发获取共享同一个 in-flight open；被抢占/迟到的通道主动 `end()`
- **两层透明重试（各一次）**：
  - 建立阶段：重试正则加入 `unexpected SFTP session termination` / `connection closed` / open 超时 → `invalidate()` + 换新连接重开（与 `exec()` 同模式）
  - 操作阶段：运行中的操作遇到服务端杀会话 → 丢缓存、重开会话、原操作重试一次（写类操作整文件重发，不会留半截文件）
- 传输类操作（fastGet/fastPut/readFile/writeFile）超时底线 **2 分钟**（旧 20s 命令预算在多跳链路上会误杀大文件）；会话 open 本身加超时
- 新增配置字段 `syncConcurrency`（默认 16，1–64），rw_sync / rw_push / auto-push 三处接线
- **启动自动恢复**（`fc2ae7f`）：旧版重启 `dsh web` 后 pool 一直是空默认 config（机器表里的 currentId 只在 GUI 切换时通过 `setCurrent → applyActiveMachine` 应用），侧边栏「远程文件」显示"未设置远程工作区"、浏览报 `no credentials`，每次都要手动重选目录。现在 `apply()` 启动时 `await applyActiveMachine()` 把持久化的当前机器应用到 pool；`setTarget` 是惰性的（不发起 SSH 连接），所以隧道还没起也 harmless——首次浏览会报真实连接错误，点 ↻ 即恢复

**sync.js（三向镜像）**
- **fast path**：直接复用 readdir 返回的 `{size,mtime}` 属性，快照匹配则**零**逐文件远端 stat（热同步 280 → 0）
- **流式**：pull 走 `fastGet` → 临时文件 → `rename`（原子落盘，传输中断不留残文件）；push 走 `fastPut`
- **并行**：文件传输 16 路；目录遍历改 BFS + 8 路 readdir（兄弟目录 mkdir 也并行）
- **硬上限**：并发下用 in-flight 计数保证 `maxFiles` 严格不超
- 三向 / conflict / force / dryRun / mtime 对齐语义完全保留（`test/sync.test.js` 14 个用例，带计数的 fake sftp，`node --test` 全过）

**软链接**（`5f71089`）
- 浏览：旧版用 `lstat()`（链接**自身**属性）分类软链 → 全部显示为文件，指向目录的软链进不去。改 `stat()`（跟随链接）：指向目录 → 显示为文件夹且可打开；指向文件 → 仍是文件；断链降级为文件；条目带 `symlink` 标记
- 镜像：软链**永不传输**。pull 直接从 readdir 属性判链（零额外 stat），跳过并计数；push 用 `lstatSync` 探测本地软链并拒绝——`fastPut` 若跟随链接会把远端文件写到**链接目标的路径**，破坏目标文件（`statSync` 跟随链接，永远报不出"是链接"，必须 lstat）。rw_sync/rw_push 输出含 `N symlink(s) skipped (not mirrored)`

**@ 文件/文件夹引用**（`3061064` + `6c267c8`，`lib/client.js`）
- 「远程文件」tab 文件树：鼠标悬停**文件行 / 目录行 / 工作区根行** → 行尾浮出 `@` 圆角按钮（hover-reveal 样式与 dsh-better-sidebar 的"文件"tab 一致），点击把 `@<相对远程工作区根的路径>` 追加进当前会话输入框草稿；根目录引用为 `@.`（better-sidebar `relativeTo` 的同款约定）；可连续 @ 多个，已有草稿保留；点文件夹的 @ 不会误触发目录展开/收起
- 机制完全照抄 better-sidebar：`sessions.scope(sessionId)` → `conversation.input.for(actx)` → `input.state.getSnapshot().draft` / `input.setDraft(...)`（`ui-conversation` 的 composer 服务）；为此 client 的 `dsh.client.inject` 新增 `@deepseek-ai/dsh-client-ui-conversation`
- headless Chrome + CDP 端到端验证过两轮：文件 `@temp/count_k26_params.py`、目录 `@temp`、根 `@.`，三次点击累积为 `@temp @. @temp/count_k26_params.py`，树状态不受影响

**🔀 远程源码 tab**（`4a3e4c2`，`lib/index.js` + `lib/client.js`）
- 场景：本地「源代码管理」tab 只对**本地**目录的 git 仓库生效；远端机器上的仓库（如 `/llm_infer_workspace/<用户名>/code/vllm-workspace` 下 npuslim/vllm/vllm-learning 等）看不到。新 tab 把整套 git 面板搬到远端：所有 git 命令经 SshPool **在远端执行**（`LC_ALL=C`、`--no-pager`、`-c color.ui=false`，路径一律 shell 单引号转义）
- host 侧 11 条路由：`git/repos`（`find -L` 工作区下最多 3 层找 `.git` 目录/文件，`-L` 才能发现 vllm 这类**软链目录**仓库）、`git/status`（porcelain v1 `-z --branch` 解析，含 rename 双记录跳读）、`git/diff`（staged/unstaged；untracked 文件走 SFTP 读全文，256KB 上限 + NUL 字节判二进制）、`git/stage` / `git/unstage` / `git/commit`（nothing-to-commit → 409）、`git/branches`（`for-each-ref --format` 的 `%(refname:short)` **必须加引号**，`()` 是 bash 元字符）、`git/checkout`、`git/log`（`\x1f` 分隔，分页）、`git/commit-diff`（`show --pretty=format:`，hash 白名单 `^[0-9a-f]{4,40}$`）
- client 侧 `RemoteGitTab`（注册 id `dsh-remote:git`，order 56，排在「远程文件」之后）：仓库下拉 + 分支下拉（detached HEAD 置灰）+ 已暂存/未暂存两区 + 暂存/取消暂存按钮 + 提交框（Ctrl+Enter）+ 历史分页（每批 20，加载更多）+ diff 面板（`+`/`−` 着色，二进制提示，untracked 显示全文）
- headless Chrome + CDP 端到端验证：仓库发现（含软链仓库）、status/diff/历史渲染、在 scratch 仓库上 暂存→提交 往返，远端 `git log` 与面板一致，未暂存文件不受影响

**远程文件打开**（`e8c2c76`，`lib/index.js` + `lib/client.js`）
- 「远程文件」树文件行右键新增两项（目录无）：
  - **🌐 在浏览器新标签页打开**：新路由 `GET /dsh-remote/file?path=<远程路径>` 经 SFTP 把单个文件流到浏览器，content-type 规则与本地侧边栏媒体路由一致（图片/PDF/HTML 按扩展名；未知扩展名嗅探头部 8KB，无 NUL → `text/plain` 满页显示；二进制下载）；大小上限 `config.maxFileBytes`（未配置时 50MB）；路径必须落在远程工作区内
  - **↗ 用外部应用打开**：新路由 `POST /dsh-remote/open {path}` —— SFTP 下载到**本地 tmp 目录**（`$TMPDIR/dsh-remote-open/<nonce>/`，保留原文件名）后由 host 拉起本机系统默认应用（xdg-open/open/start）。远端 .pptx 因此直接在本机 WPS 打开，原文件只读不碰
- E2E：远端 289KB 日志 → 新标签页 `text/plain` 满页 ✓；远端 `周报-20260727.pptx` → 下载至 tmp + WPS `wpp` 进程拉起并产生 WPS 锁文件 ✓

**远程右键菜单修复**（`508dafc`，用户反馈"右键完全没反应"，真机探针定位）
- **根因 1（主因）**：菜单是 `position:fixed` 的内联 div，但侧边栏 pane 祖先带 CSS `contain`——`contain`（和 transform 一样）会成为 fixed 后代的**包含块**，菜单被整体平移到 pane 偏移量之外（实测偏了 1010px，渲染在屏幕外）→ 看起来"右键没反应"。修复：菜单 div 的 ref 回调里从自身向上找第一个 transform/filter/perspective/contain/backdrop-filter 祖先，把视口坐标减掉它的 rect 重新锚定。（尝试过 `React.createPortal` 到 body——dsh 客户端运行时提供的 React **没有 createPortal**，不可用）
- **根因 2**：菜单关闭器监听 `document mousedown`，点菜单项的那一下 mousedown 先于 click 触发、瞬间卸载菜单 → **任何菜单项都点不中**（此前 E2E 只验证了菜单渲染、没点过项，漏掉了）。修复：忽略从菜单内部发起的 mousedown
- **附带**：切远程工作区后，旧工作区的持久化展开目录不再盲目重放（之前会在 console 刷一堆 `/dsh-remote/ls` 500 No such file），只回放当前工作区下的目录
- E2E（真实鼠标事件 + 元素探针）：菜单精确出现在光标处（in-viewport）✓、elementFromPoint 命中菜单项 ✓、mousedown 后菜单不消失 ✓、点「重命名」prompt 真实触发 ✓
- **菜单颜色主题适配**（`02333b1`）：菜单项文字原来写死 `#e4e4e7`（深色主题的浅色字），浅色主题下浅字浅底看不清；改用主题 token（`T.label`/`T.danger`，与整个 tab 一致），顺带给菜单项补了 hover 高亮（`T.hoverBg`，原来完全没有）

### 真机 A/B（三跳链，280 文件 / 17MB 合成数据；新旧两份镜像 `diff -r` 逐字节一致）

| 指标 | 旧（0.8.7 npm） | 新（fork） |
|---|---|---|
| 冷同步 | 37.0s | **6.5s**（5.7×） |
| 热同步（全量无变化） | 11.3s（280 次远端 stat） | **1.1s**（0 次远端 stat） |
| 30 次目录浏览后目标机 sftp-server 残留 | 12 个（泄漏，靠整连重连才清） | **1 个**（唯一缓存会话，空闲 90s 后仍存活可复用） |

### 安装方式（已生效）

```sh
# profile 里 npm 0.8.7 → 本地 link（包名不变，bundles 条目无需动）
cd ~/.dsh/profiles/web && pnpm add "dsh-remote@link:/home/<用户名>/code/tool/dsh-remote"
# link 包的依赖在 link 目标自己的 node_modules 里解析 —— fork 目录必须自己装过
cd ~/code/tool/dsh-remote && pnpm install   # ssh2 原生构建由仓库内 pnpm-workspace.yaml 的 allowBuilds 放行
# 重启 dsh 实例生效
```

---

## 四、dsh-better-sidebar fork：本地「源代码管理」识别嵌套仓库

### 问题

会话工作目录本身**不是** git 仓库、但下面有多个仓库时（如 `~/code/tool` 下 6 个源码仓库），内置「源代码管理」tab 只显示"当前目录不是 git 仓库"，没有任何入口。

### 实现（fork 提交 `6b87e9e`，改 `lib/index.js` + `lib/client.js`）

npm 包只发 `lib/` 产物，无 src，直接改编译后的 ESM（与 dsh-remote fork 同款做法）。

**host（`lib/index.js`）**
- `status()` 非仓库分支新增 `nestedRepos` 字段：`discoverNestedRepos(cwd)` 同步遍历根下**最多 2 层**子目录，含 `.git`（目录或文件——worktree/submodule 是文件）即收录（cwd 相对路径，排序返回）；跳过 `node_modules`/`.git`/隐藏目录；**跟随软链目录**（用 `statSync`，断链跳过）；总访问目录数硬上限 **2000**，大目录树不会卡住 status 轮询
- `cwdOf(payload)` 新增 `repoPath` 覆盖：只接受 cwd 相对的纯段列表（拒绝绝对路径、`..`、空段），`resolve(base.cwd, repoPath)` 且必须以 `base.cwd + sep` 开头才生效，否则静默回退到原 cwd（客户端内部契约，防目录穿越）

**client（`lib/client.js`，真正的客户端入口；`lib/client-registry.js` 是 `dsh-external` 变体，未动）**
- `scopePayload` 透传 `repoPath`
- `GitView` 新增 `selectedRepo` 状态 + `effScope = {...scope, repoPath}`：全部 git 调用（status/branch/log/stage/unstage/commit/checkout/discard/revert/cherryPick）走 `effScope`；切换会话/目录时 `selectedRepo` 重置为 null
- "不是 git 仓库"占位替换为**仓库选择器**：列出 `nestedRepos`（点击即选中）；选中后面板顶部出现 `<仓库路径> + 返回目录` 横幅，其余（分支下拉、暂存区、提交框、历史）与单仓库完全一致
- diff 标签记录携带 `repoPath`（`DiffTab` 据此构造 scope），untracked 文件的 `fs.read` 也因此落在正确仓库；worktree diff 的 tab id 加仓库前缀防跨仓库撞 id
- 右键菜单"打开文件/复制路径"选中仓库时用 `<repoPath>/<文件>` 形式（git 操作本身仍用仓库相对路径——host 的 `resolveGitPath` 会按仓库根 join）
- 中英文案 `nestedRepos`（目录下的仓库：）/ `backToRoot`（返回目录）

### 验证（headless Chrome + CDP + API 直测）

- UI（真实目录 `/home/<用户名>/tmp/profile`，非仓库、含 msinsight/vllm-learning 两个仓库）：选择器列出两仓库 → 点选 vllm-learning → 分支 main + 6 条未暂变更 + 20 条历史渲染正常 → 打开 `start_ep.sh` diff 标签（真实 diff 着色渲染）→ 选择状态 8 秒内稳定、`返回目录` 回到选择器
- API（`/tmp/e2e-multi` 夹具：repo-a/repo-b + 2 层深 group/inner-repo + plain-dir + node_modules）：根 status 返回 3 个嵌套仓库（node_modules/plain-dir 正确排除、2 层深的被找到）；repo-a 上 stage→status(`A `)→unstage(`??`)→stage all→commit 往返，`git log` 与本地 CLI 完全一致、工作树干净；untracked 文件 fs.read 返回全文；`repoPath: '../etc'` 与 `'/etc'` 均被忽略（回退根目录，不越界）

**文件打开方式**（`13467fd`，`lib/index.js` + `lib/client.js`）
- 场景：侧边栏 pane 太窄，文件预览挤在小窗里不好浏览；Office 文件（pptx/docx/xlsx）完全没法看
- 「文件」tab 文件行右键新增两项：
  - **在浏览器新标签页打开**：`window.open` 媒体路由 URL，全页浏览。为此媒体路由对未知扩展名做**文本嗅探**——头部 8KB 无 NUL 字节 → 按 `text/plain; charset=utf-8` 返回（代码/配置/日志文件直接满页显示，不再被浏览器当下载）；含 NUL 的真二进制保持 `octet-stream` 下载。图片/PDF/HTML 走原有 content-type 不受影响
  - **用外部应用打开**：浏览器起不了桌面程序，改由 **host 进程**（与文件同机）launch 系统默认应用：新增 `fs.open` 接口，Linux 用 `xdg-open`（缺 xdg-utils 时报错提示）、macOS 用 `open`、Windows 用 `cmd /c start`，`detached + unref` 即发即忘；路径与媒体路由同款围栏（必须落在会话 cwd 内，防越界）
- 本机配套：`.pptx/.docx/.xlsx` 等 6 个 Office MIME 的默认应用已从 LibreOffice 切到 **WPS**（`xdg-mime default wps-office-wpp/wps/et.desktop …`；切换前旧默认备份在 `/tmp/xdg-defaults-backup.txt`）
- **Office 文件在新标签页里转 PDF 显示**（`5230e3e`）：浏览器没有 Office 渲染器，原来新标签页打开 pptx 只会触发下载。媒体路由现在对 12 种 Office 扩展名（pptx/ppt/docx/doc/xlsx/xls/odp/ods/odt/pptm/docm/xlsm）按需调 **headless LibreOffice**（`soffice --headless --convert-to pdf`）转 PDF 再返回：每个文件独立 `UserInstallation` profile 目录、3 分钟超时、转换在 promise 链上串行（避免 soffice 实例互抢锁）、按 `路径+mtime+size` 做 sha1 缓存（`$TMPDIR/dsh-sidebar-office-cache/`），源文件 300MB 上限。实测 300KB pptx 首转 2.6s、缓存命中 6ms
- **弹窗拦截兜底**（`5230e3e`）：`window.open` 被浏览器拦截（返回 null）时自动退回"在侧边打开"+ 提示文案，不再点了没反应
- 踩坑：菜单图标必须用**当前版本 primitives 真实导出**的组件——`IconGlobeOutline16` 在 0.1.0-rc 系列里不存在，渲染出 `undefined` 触发 React invariant #130 整片白屏；核对方法 `grep "const IconXxx" <primitives>/lib/index.js`
- E2E：右键菜单两项渲染 ✓；点「浏览器新标签页」开出真实标签页，`content-type: text/plain` 全文显示 ✓；`fs.open` 对 pptx 拉起 WPS（`wpp` 进程实证）✓；`/etc/passwd` 越界 403 ✓；含 NUL 二进制保持下载 ✓

### 安装方式（已生效）

```sh
# fork 目录：npm tarball 基线提交 f1fcd70 + 6b87e9e + 13467fd；npm 包只发 lib/，改完重启实例即可
cd ~/code/tool/dsh-better-sidebar && pnpm install   # link 依赖需自装
cd ~/.dsh/profiles/web && pnpm add "dsh-better-sidebar@link:/home/<用户名>/code/tool/dsh-better-sidebar"
# 重启 dsh 实例生效
```

---

## 五、日常使用

```sh
# 在家用 dsh-remote 前（公司网络不需要）
ssh -N -o ExitOnForwardFailure=yes -L <本地转发端口>:127.0.0.1:22 <ssh别名> &

# 启动 dsh web（任意目录）
dsh web            # 默认 127.0.0.1:3080
dsh web --port N   # 自定义端口（扩展自动探测 3080/3081/3090/14389）
```

**改了插件代码后**：重启 dsh 实例 **+ 浏览器页面刷新（F5）** 两步都要。dsh 核心给插件入口 URL 带 `?rev=<内容 sha1>`，刷新即拉到新代码；但已打开的 SPA 页面不会自己换 JS——只重启实例不刷页面，旧浏览器里跑的还是旧插件（这正是"Chrome 里没生效、Firefox 里生效"的常见原因：Firefox 那个标签页恰好刷新过）。

浏览器里：
- 选中文字 → 右键 → 「用 dsh 解释选中文本」/「带着选中文本问 dsh」
- 侧边栏输入框上方出现引用 chip 时，输入问题回车即"选文 + 问题"一起发出，✕ 可移除
- 右键菜单项依赖 Chrome 扩展加载状态：`chrome://extensions` 确认启用

## 六、维护

```sh
# 改了 fork 源码后重建 + 部署扩展（bridge 未改时只需扩展这步）
cd ~/code/tool/dsh-browser
pnpm --filter dsh-browser-extension run build
rsync -a --delete-after extensions/dsh-browser/dist/ ~/.dsh/browser-extension/
# 然后 chrome://extensions 点"重新加载"

# 上游更新：重新下载 Lum1104 main 到临时目录，与 fork 合并（git diff 可当 patch 重放），
# 重建 bridge + 扩展后重跑上述部署。不要直接跑上游 install.sh —— 它会把
# plugin link 指回托管目录 ~/.dsh/dsh-browser，覆盖 fork 注册。

# dsh-remote fork：改 lib/*.js 后无需重建（npm 包直接发产物，实例直读 lib/），重启实例即可；
# 在 fork 目录 pnpm install（依赖变化）后同样重启实例。
# 上游更新：解压新 npm tarball 做新基线，重放 fork patch（git diff 988629b..02333b1 -- lib）。

# dsh-better-sidebar fork：同 dsh-remote——npm 包只发 lib/，改完重启实例即可。
# 上游更新：新 tarball 做基线，重放 patch（git diff f1fcd70..5230e3e -- lib）。
# 注意 lib/client.js 与 lib/client-registry.js 是两份客户端（后者是 dsh-external 变体），
# 本 fork 只改了 client.js + index.js（host）。

# 卸载扩展功能：chrome://extensions 移除扩展 + 删除 ~/.dsh/browser-extension
# 卸载 dsh-remote：dsh plugin --profile web remove dsh-remote（reconcile 自动摘除 bundles 条目）
# 换回官方 npm 版：cd ~/.dsh/profiles/web && pnpm add "dsh-remote@0.8.7"（覆盖 link）
# 换回官方 better-sidebar：cd ~/.dsh/profiles/web && pnpm add "dsh-better-sidebar@0.14.0"
```

## 七、已知边界

- dsh-remote fork 只改 `lib/`（npm 包不带 src）：上游若重构 SshPool/sync.js，patch 需要重新核对后再合并
- dsh-remote 的修复在**在家三跳链**实测；公司单跳代理路径同一套池代码、同样生效，但公司网络环境未实测
- "解释"提示词发往**面板当前会话**（auto-resume 恢复的或用户正在看的），不新建独立会话
- 选文上限 20000 字符（超出截断并标注）；暂存提示词 60 秒 TTL
- 推理过程文本（reasoning-delta）不展示，只显示"正在思考"
- 扩展改完必须手动"重新加载"才生效；dsh 实例改 profile 后要重启才加载新插件
- 流式渲染中 markdown 是增量重排的，未闭合代码块会短暂"裸奔"到闭合为止（与主流聊天 UI 相同）
- 嵌套仓库选择器只扫会话目录下 **2 层**（且最多 2000 个目录）：更深的仓库点不到，可先 @ 该目录或把工作目录设浅一层；选中某个仓库后，暂存/提交/diff 等操作都作用于**那个仓库**（横幅显示当前仓库），`返回目录` 回到选择器
- 「远程源码」tab 的 diff 对 untracked 文件有 256KB 上限、二进制只提示不展示；`git/log` 历史分页每批 20 条
