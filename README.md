# dsh 插件 fork 归档（个人维护）

DeepSeek Harness（dsh）web 环境使用的三个插件定制 fork，集中归档于此。
**个人维护的非官方版本**——功能与差异见下文；上游的官方版本与更新以上游仓库为准。
另含一个**原创插件** `dsh-inference-news/`（大模型推理日报），见文末专节。

## 来源与许可（重要）

本仓库**不是原创插件**，而是对下列三个 MIT 许可上游项目的 fork + 增量修改。
所有基础代码版权归原作者，各自的 `LICENSE`（MIT）文件保留在各目录内；
本仓库新增的改动（下表"定制提交"）在同样的 MIT 许可下发布，并完整署名为上游项目。
上游项目的文档、issue 与后续更新以其官方仓库为准。

| 目录 | 上游项目（原创） | 原作者/组织 | 许可 | 上游最新版（2026-08-23） |
|---|---|---|---|---|
| `dsh-remote/` | [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote) | flymysql | MIT | npm 0.8.7（= 本 fork 基线） |
| `dsh-better-sidebar/` | [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | omdsh-dev（huanlin、menghuan1918 等） | MIT | npm 0.15.2（本 fork 基线为 0.14.0） |
| `dsh-browser/` | [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) | Lum1104 | MIT | main（持续更新中） |

环境基线：dsh `528c682`（2026-08-23），Node 22，pnpm 11.7.0，Linux；Windows 迁移见 `docs/windows-迁移指南.md`。

## 目录

| 目录 | 上游 | 基线 → HEAD | 一句话定位 |
|---|---|---|---|
| `dsh-remote/` | [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote) | `e0e6d18` (npm 0.8.7) → `f91a72e` | SSH 远程工作区：agent 的文件/命令操作发生在远端机器 |
| `dsh-better-sidebar/` | [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | `f1fcd70` (npm 0.14.0，⚠️ 上游已到 0.15.2) → `5230e3e` | 侧边栏底座：文件/Git/终端/任务/浏览器面板 |
| `dsh-browser/` | [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) | `d7da845` (上游 main) → `846d80e` | 浏览器扩展：dsh 直接操作用户真实浏览器 |

## 插件功能与增强

### 📡 dsh-remote — SSH 远程工作区

**上游基础功能**（flymysql/dsh-remote）
- SSH 连接远端机器（密钥/密码），多机器档案与代理跳板
- 选定远端工作区目录，经 SFTP 镜像为本地 DSH 工作区
- 向 agent 提供 `rw_*` 工具组：文件读写、命令执行、目录管理全部发生在远端
- Web 侧边栏「🌐 远程文件」树：浏览、展开、下载到本地镜像、重命名、删除

**本归档增强**
- `ba864f4` **SFTP 会话泄漏修复 + 同步提速**：原实现每次调用新开一个 SFTP 子系统通道且从不关闭，远端最终会断开（`unexpected SFTP session termination`）；改为每连接一个缓存会话 + 失败重试。同步新增 readdir-attr 快路径（未变更的重同步 0 次远端 stat）、16 路并行流式传输、BFS 目录遍历、`syncConcurrency` 配置——280 文件/17MB 真机实测：冷 37.0s→6.5s（5.7×），热 11.3s→1.1s（10.4×）
- `76c74d2` **软链接支持**：浏览时链接指向的目录按目录展开；镜像时从不复制链接本身（防止写入跟随链接覆盖目标文件）
- `0010bc0` + `2e1f6be` **@ 引用**：「远程文件」行悬停出现 @ 按钮，文件/子目录/工作区根（`@.`）均可引用进对话输入框，直接让 agent 处理"那个远端文件"
- `7c2f379` **重启自动恢复**：dsh 实例重启后自动应用上次选择的机器，不再每次显示"未设置远程工作区"要求手动重选
- `a0946a0` **🔀 远程源码 tab**：面向远端仓库的完整 git 面板——仓库自动发现（`find -L`，含软链目录仓库）、分支切换、暂存/取消暂存、提交（Ctrl+Enter）、分页历史（每批 20）、diff 查看（untracked 走 SFTP 读全文 256KB 上限、二进制探测）；所有 git 命令在远端执行
- `286d6d4` **远程文件打开**：文件行右键 →「在浏览器新标签页打开」（SFTP 流式 + 文本嗅探，代码/日志满页显示）/「用外部应用打开」（下载到本地 tmp 后由系统默认应用打开，远端 Pptx 直接在本机 WPS 呈现，原文件只读不动）
- `745ad84` + `f91a72e` **右键菜单修复**：菜单因 pane 的 CSS `contain` 包含块偏移到视口外（表现"右键没反应"）；全局 mousedown 关闭器导致菜单项永远点不中；切工作区后旧展开目录盲目重放刷 500；菜单颜色不随主题、无 hover 高亮——全部修复

### 🗂 dsh-better-sidebar — 侧边栏底座

**上游基础功能**（omdsh-dev/DSH-better-sidebar）
- 文件树：渲染、编辑、下载
- 源代码管理 tab（本地 git：状态/暂存/提交/分支/历史/diff）
- 终端、侧边对话、任务管理（子代理）、浏览器面板
- 开放注册 API，支持三方扩展添加侧边栏页面

**本归档增强**
- `6b87e9e` **嵌套仓库识别**：会话工作目录本身不是 git 仓库、但下面有多个子仓库时（常见的工作区目录），源代码管理 tab 不再只显示"当前目录不是 git 仓库"，而是列出其下子仓库（最多 2 层、2000 目录上限、跟随软链、跳过 node_modules/隐藏目录）；点选切换后全部操作（状态/暂存/提交/diff/历史）作用于所选仓库，顶部横幅 + 「返回目录」
- `13467fd` **文件打开方式**：文件行右键 →「在浏览器新标签页打开」（满页浏览；未知扩展名嗅探头部 8KB——无 NUL 按 `text/plain` 直接显示，二进制下载）/「用外部应用打开」（host 进程拉起系统默认应用：Linux `xdg-open`、Windows `start`、macOS `open`）
- `5230e3e` **Office 文件预览**：12 种格式（pptx/docx/xlsx + 旧版 doc/xls/ppt + ODF）经本机 headless LibreOffice 按需转 PDF，浏览器内可缩放查看（缓存键 = 路径+mtime+size；300KB Pptx 实测首转 2.6s、缓存命中 6ms；源文件 300MB 上限）；`window.open` 被浏览器弹窗拦截时自动退回"在侧边打开"并提示

### 🌐 dsh-browser — 浏览器操控扩展

**上游基础功能**（Lum1104/dsh-browser）
- Chrome/Edge 侧边栏扩展：DeepSeek Harness 直接操作用户真实浏览器（读页面、操作元素），无需视觉模型
- 扩展自带侧边栏聊天面板

**本归档增强**
- `a0c3146` **右键选文提问**：任意网页选中文字 → 右键 →「用 dsh 解释选中文本」或自定义提问（自动引用所选文本），回答出现在侧边栏
- `2abafb5` + `5a16025` **流式输出**：回答逐词流式呈现（此前需等整段响应完成才一次性显示），扩展侧与面板侧链路配套打通
- `846d80e` **智能跟随滚动**：流式输出时自动滚动跟随新内容；用户手动上滚即停止跟随，回到底部后恢复

每个目录的完整提交历史都保留在本仓库中（git subtree 导入）。**查某个项目的原始历史**：
`git log --oneline <该项目的 HEAD SHA>`（导入时路径从根改成了前缀，`git log -- <目录>/` 会因路径简化只显示合并点）。
某项目的全部改动 patch：`git diff <基线提交> -- <目录>/`。

**构建产物不在 git 里**（上游 .gitignore）：dsh-browser 的 `packages/browser/bridge-browser/lib/` 和 `extensions/dsh-browser/dist/` 需从本归档克隆后执行 `cd dsh-browser && pnpm install && pnpm build` 再生成（一条命令同时构建 bridge 插件和扩展）。

## 本地安装方式（dsh web profile）

```sh
# 三个 fork 各自装依赖（link 包的依赖从自己的 node_modules 解析）
cd dsh-remote          && pnpm install
cd ../dsh-better-sidebar && pnpm install
cd ../dsh-browser      && pnpm install

cd ~/.dsh/profiles/web
pnpm add "dsh-remote@link:<本仓库路径>/dsh-remote"
pnpm add "dsh-better-sidebar@link:<本仓库路径>/dsh-better-sidebar"
pnpm add "@yuxianglin/dsh-bridge-browser@link:<本仓库路径>/dsh-browser/packages/browser/bridge-browser"
# 重启 dsh 实例 + 浏览器 F5
```

dsh-browser 的插件 `lib/` 与扩展 `dist/` 是构建产物（不在 git 里）：`cd dsh-browser && pnpm install && pnpm build` 一次生成两者；扩展 `dist` 拷到 `~/.dsh/browser-extension` 后在浏览器加载已解压扩展。

## 更新同步（日常开发在本地工作 fork 里做）

工作副本在 `~/code/tool/{dsh-remote,dsh-better-sidebar,dsh-browser}`（与本归档同内容）。
工作副本有新提交后，在本仓库执行：

```sh
git subtree pull --prefix=dsh-remote         /home/<用户名>/code/tool/dsh-remote         master --squash=false
git subtree pull --prefix=dsh-better-sidebar /home/<用户名>/code/tool/dsh-better-sidebar master --squash=false
git subtree pull --prefix=dsh-browser        /home/<用户名>/code/tool/dsh-browser        master --squash=false
git push
```

## 原创插件

### 📰 dsh-inference-news — 大模型推理日报

- **原版插件**（非 fork）：39 个数据源——arXiv（cs.LG/CL/DC/AR）、HF Daily Papers（镜像 API）、23 个 GitHub release 源（vLLM、**vLLM-Ascend**、SGLang、TensorRT-LLM、LMDeploy、TGI、MLC-LLM、llama.cpp、Ollama、LightLLM、NVIDIA Dynamo、Mooncake、LMCache、llm-compressor、DeepSeek-V3；华为昇腾系 **MindIE-LLM / MindIE-Motor / MindSpeed-LLM / torch_npu / CANN 容器镜像 / Triton-Ascend / SGLang-Ascend / MindSpore**）、11 个分级 RSS 博客（vLLM 官方博客、美团技术、Interconnects、HF、NVIDIA Developer + 量子位/InfoQ/OpenAI/Azure/Databricks/NVIDIA 公司博客）、5 组 Hacker News 查询
- **管线**：确定性采集（并发+重试+源级失败隔离+`https_proxy` 自动/直连回退）→ 推理关键词打分 → seen.json 去重（14 天窗口）→ release 洪水折叠 → 一次辅助 LLM 结构化筛选 → 确定性 Markdown 渲染 → `digests/YYYY-MM-DD.md`
- **四个使用面**：模型工具 `news_collect`/`news_digest`、`/news` 命令、webServer 路由 `/inference-news/*`、侧边栏「📰 日报」tab（历史列表 + 全文安全渲染 + 一键生成）
- **安装**：`cd ~/.dsh/profiles/<web|headless> && pnpm add "dsh-inference-news@link:<本仓库路径>/dsh-inference-news"`，并把 `dsh-inference-news` 追加到该 profile `package.json` 的 `dsh.profile.bundles`，重启 dsh 实例
- **定时**：`0 9 * * * /home/zzw/work/news/news-daily.sh`（headless profile 跑 `news_digest` 工具）
- 已知限制（out-of-tree 插件无法注册自定义会话事件 → 无聊天流内嵌卡片；GitHub 直连在本机间歇受干扰等）见 `dsh-inference-news/README.md`

## 文档

- `docs/dsh-插件安装与右键改造总结.md` — 全部改动的根因、实现、验证记录、维护方法
- `docs/windows-迁移指南.md` — Windows 10 复现环境的完整步骤
