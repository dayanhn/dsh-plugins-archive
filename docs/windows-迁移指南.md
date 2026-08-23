# Windows 10 安装 DeepSeek Harness + 插件迁移指南

> 目标：在 Windows 10 上复现 `/home/<用户名>`（Linux）的 dsh web 环境，含三个本地 fork 插件的全部定制功能。
> 整理日期：2026-08-23。对应 fork 提交：dsh-remote `02333b1` / dsh-better-sidebar `5230e3e` / dsh-browser `e20fd48`。

---

## 一、备份现状（Linux 侧）

| 内容 | 位置 | 说明 |
|---|---|---|
| dsh-remote fork | `~/code/tool/dsh-remote`（git，10 提交，HEAD `02333b1`） | 含全部定制：SFTP 泄漏修复、同步提速、软链、@ 引用、启动恢复、远程源码 tab、远程文件打开、右键菜单修复 |
| dsh-better-sidebar fork | `~/code/tool/dsh-better-sidebar`（git，4 提交，HEAD `5230e3e`） | 嵌套仓库、浏览器新标签页/外部应用打开、Office 转 PDF、弹窗兜底 |
| dsh-browser fork | `~/code/tool/dsh-browser`（git，5 提交，HEAD `e20fd48`） | 右键选中文本问 dsh、流式输出、智能滚动 |
| 文档 | `~/code/tool/<用户名>-docs/` | 本目录 |
| **整包备份** | `~/code/tool/plugin-forks-backup-20260823.tar.gz`（8.9MB） | 三个 fork 完整 git 历史 + <用户名>-docs，已解包 + `git fsck` 验证。**node_modules 不在包里**（平台相关、可再生） |

建议把 tarball 再传一份到网盘/U 盘作为机外备份。

## 二、Windows 前置安装

1. **Git for Windows**（git-scm.com）—— better-sidebar 的 git 面板和仓库复制都需要 `git.exe` 在 PATH
2. **Node.js ≥ 22.19**（LTS 22.x 即可；engines: `^22.19.0 || >=24.0.0`）
3. **pnpm 11.7.0**：`corepack enable`（仓库 `packageManager` 字段锁定版本，corepack 自动拉取）
4. **OpenSSH 客户端**：Win10 1809+ 自带（`ssh`/`scp`）；多跳链配置放 `C:\Users\<你>\.ssh\config`
5. **LibreOffice（可选但建议）**：Office→PDF 预览依赖 `soffice`。安装时勾选"命令行的 LibreOffice"选项让 `soffice.exe` 进 PATH，否则 Office 预览会报 "cannot run LibreOffice"
6. **Chrome 或 Edge**：加载 dsh-browser 扩展

## 三、拷贝与安装

```bat
:: 1) 拷贝（U 盘/网盘/scp 均可）：deepseek-harness 仓库（可不含 node_modules）、
::    三个 fork、<用户名>-docs。或直接用 Linux 侧的 tarball + 新 clone 一份 harness。

:: 2) harness 根目录
cd C:\code\tool\deepseek-harness
pnpm install

:: 3) 三个 fork 各自装依赖（link 包的依赖从自己的 node_modules 解析，缺一不可）
cd C:\code\tool\dsh-remote          && pnpm install
cd C:\code\tool\dsh-better-sidebar  && pnpm install
cd C:\code\tool\dsh-browser         && pnpm install
::    （dsh-remote 的 pnpm-workspace.yaml 已含 allowBuilds: ssh2/cpu-features/node-pty，
::      原生模块会自动为 win32 构建/下载预编译件）

:: 4) dsh 命令：Linux 上的 ~/.local/bin/dsh 就是 "cd 仓库 && pnpm dsh"。
::    Windows 等价物，放 %USERPROFILE%\dsh.cmd：
@echo off
cd /d C:\code\tool\deepseek-harness
call pnpm dsh %*
::    把 %USERPROFILE% 加进 PATH 即可全局使用

:: 5) 首次启动生成 C:\Users\<你>\.dsh（profile、会话存储等）
dsh web
```

## 四、链接插件（关键步骤）

```bat
cd %USERPROFILE%\.dsh\profiles\web
pnpm add "dsh-remote@link:C:/code/tool/dsh-remote"
pnpm add "dsh-better-sidebar@link:C:/code/tool/dsh-better-sidebar"
pnpm add "@yuxianglin/dsh-bridge-browser@link:C:/code/tool/dsh-browser/packages/browser/bridge-browser"
```

- 包名不变 → profile 的 bundles 层栈自动生效，不需要动 cordis.yml
- 路径用正斜杠（pnpm 在 Windows 接受）
- **不要**用 `dsh plugin add dsh-browser`（会指回托管目录）；dsh-browser 必须 link fork 里的 `packages/browser/bridge-browser`

## 五、dsh-browser 扩展（右键选文问 dsh）

```bat
cd C:\code\tool\dsh-browser
pnpm --filter dsh-browser-extension run build
xcopy /E /Y extensions\dsh-browser\dist %USERPROFILE%\.dsh\browser-extension\
```

Chrome/Edge → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `%USERPROFILE%\.dsh\browser-extension`。本机回环零配置（扩展自动探测 3080/3081/3090/14389 端口）。

## 六、机器相关的重新配置（不可直接拷贝的部分）

| 项 | Linux 现状 | Windows 要做的 |
|---|---|---|
| **LLM provider** | 本地 qwen3.8 网关 `127.0.0.1:9082`（settings.yaml `llm-pi-ai` + `agent-default-model: local`） | 二选一：① Windows 上也起同款本地模型服务并保留配置；② 改用 DeepSeek API——`C:\Users\<你>\.dsh` 下 `.env` 写 `DEEPSEEK_API_KEY=...`，settings.yaml 把 `agent-default-model` 的 provider/model 改回 deepseek 系 |
| **远程机器多跳链** | `~/.ssh/config` 三跳链（frpc 反隧道 <反隧道端口> → <中间跳板> → 跳板 <跳板机IP> → <目标机IP>），本地 `ssh -L <本地转发端口>` 隧道 | `C:\Users\<你>\.ssh\config` 重写等价链路。**注意**：frpc 反隧道的本地端 <反隧道端口> 如果跑在这台 Linux 上，Windows 无法复用该段——需要在 Windows 重建 frpc 客户端或改用其他入口（取决于你的 frpc 部署位置） |
| **dsh-remote 机器表** | `~/.dsh/remote-workspaces/machines.json`（Linux 密钥路径） | 不用拷。dsh web 里打开 dsh-remote 设置界面重新添加机器，密钥填 `C:\Users\<你>\.ssh\id_rsa`；host key 走 TOFU 自动记录 |
| **Office 默认应用** | xdg-mime 已切 WPS | Windows：右键 .pptx → 打开方式 → 始终 → WPS 演示（docx/xlsx 同理） |
| **本地镜像** | `~/.dsh/remote-workspaces/...` | 自动生成，不用管 |

## 七、功能平台兼容性核对（逐项确认过代码）

| 功能 | Windows 表现 |
|---|---|
| 外部应用打开（本地/远程文件） | ✅ 代码里已写平台分支：win32 走 `cmd /c start <file>`，跟随 Windows 默认应用（WPS） |
| 浏览器新标签页打开（文本嗅探） | ✅ 纯 HTTP content-type 逻辑，平台无关 |
| Office→PDF 预览 | ⚠️ 依赖本机 LibreOffice（`soffice` 在 PATH）；`--headless --convert-to pdf` 在 Windows 版行为一致 |
| 嵌套仓库识别 / 远程源码 tab | ✅ git 命令本地 spawn（需 Git for Windows）/ 远端 Linux 上执行（`find` 等），均不受 Windows 影响；路径围栏 `isWithin` 自带 platform 参数 |
| @ 文件/文件夹引用 | ✅ 纯浏览器侧 JS（dsh-client-ui-conversation 服务），平台无关 |
| SFTP 同步/泄漏修复/软链 | ✅ ssh2 库跨平台；软链检测 `lstat` 语义由 ssh2 在远端（Linux）完成 |
| 右键选文问 dsh（扩展） | ✅ Chrome/Edge 扩展，跨平台 |
| 本地终端 tab | ⚠️ 依赖 node-pty（有 win32 预编译件，pnpm install 正常即可）；默认 shell 是 PowerShell/cmd |

## 八、验证清单（迁移完成后照抄）

1. `dsh web` 启动，浏览器打开 127.0.0.1:3080，侧边栏出现：文件/源代码管理/任务管理/终端/浏览器 + 🌐远程文件 + 🔀远程源码
2. 选一个非仓库多子仓库目录开会话 → 源代码管理 tab 出现仓库选择器 → 点选 → 状态/历史/diff 正常
3. 远程文件 tab：右键文件行 → 菜单在鼠标处弹出（颜色跟随主题、有 hover 高亮）→ 点「在浏览器新标签页打开」文本满页 → 点「用外部应用打开」.pptx 弹出 WPS
4. 远程源码 tab：仓库下拉出现远端仓库（含软链目录）→ 历史/diff 正常
5. 文件树悬停 @ 按钮 → 输入框出现 @ 引用 chip
6. Chrome 扩展：网页选中文字右键 → 「用 dsh 解释选中文本」→ 侧边栏流式回答
7. 浏览器 F5 刷新后以上全部保留（插件入口 URL 带 `?rev=` 内容哈希，刷新必新）
