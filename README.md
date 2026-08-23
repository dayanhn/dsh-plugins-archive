# dsh 插件本地 fork 归档（个人维护）

DeepSeek Harness（dsh）web 环境使用的三个插件本地定制 fork，集中归档于此。
**个人备份/维护用途，非公开分发**（上游均 MIT，公开亦无法律障碍）。

环境基线：dsh `528c682`（2026-08-23），Node 22，pnpm 11.7.0，Linux；Windows 迁移见 `docs/windows-迁移指南.md`。

## 目录

| 目录 | 上游 | 基线提交 | 定制提交（基线→HEAD） | 功能 |
|---|---|---|---|---|
| `dsh-remote/` | [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote) npm 0.8.7 | `988629b` | `f220802`→`5f71089`→`3061064`→`6c267c8`→`fc2ae7f`→`4a3e4c2`→`e8c2c76`→`508dafc`→`02333b1` | SFTP 会话泄漏修复、同步提速 5.7×/10.4×、软链接支持、@ 文件/文件夹引用、重启自动恢复机器、**远程源码 tab**（远端 git 全功能）、远程文件浏览器打开/外部应用打开、右键菜单修复（包含块/mousedown/主题色） |
| `dsh-better-sidebar/` | [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) npm 0.14.0（⚠️ 上游已到 0.15.2） | `f1fcd70` | `6b87e9e`→`13467fd`→`5230e3e` | **嵌套仓库识别**（非仓库目录列出子仓库+切换）、文件右键"浏览器新标签页/外部应用"打开、**Office→PDF 预览**（headless LibreOffice+缓存）、文本嗅探 content-type、弹窗拦截兜底 |
| `dsh-browser/` | [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) main | `cd35bec` | `4e5da38`→`2dfda0b`→`21446f4`→`e20fd48` | 网页右键"用 dsh 解释选中文本"、侧边栏流式输出、智能滚动 |

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

## 文档

- `docs/dsh-插件安装与右键改造总结.md` — 全部改动的根因、实现、验证记录、维护方法
- `docs/windows-迁移指南.md` — Windows 10 复现环境的完整步骤
