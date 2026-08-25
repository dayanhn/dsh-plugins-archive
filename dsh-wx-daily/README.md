# dsh-wx-daily

微信公众号文章面板：通过**本机微信读书会话**（专用 Chrome + [weread-mp-fetcher](https://github.com/Pengyf04/weread-mp-fetcher)，**无第三方 relay，会话不出本机**）抓取每个配置公众号的文章，按 **当天** 或 **自定义时间段** 过滤（每次全量重采，**不做历史去重**），可选一次 LLM「今日要点」摘要，在 dsh web 侧边栏「📮 公众号」tab 聚合展示，点标题在新标签页打开原文。

- 模型工具 `wx_collect`（窗口过滤 + 可选摘要，零/一次 LLM 成本）
- 人工命令 `/wx`（当天采集 + 摘要，无需模型轮次）
- webServer 路由 `/wx-daily/*`（latest / collect / accounts / status）供侧边栏消费

默认清单来自 2026-06-16 的《2026 年，AI 公众号博主排行榜 TOP20》（20 个号），内置在 `accounts.default.json`。

## 架构

```
微信读书(weread.qq.com 官方接口)
   ↑ 页内 fetch(credentials:include)，请求发自本机 IP
专用 Chrome (screen 会话 wereadchrome, 调试端口 9333 只监听 127.0.0.1,
   独立 profile ~/.weread-mp-fetcher/chrome-profile, 只登录微信读书)
   ↑ CDP
weread-mp-fetcher (node bin/weread.mjs, 零 npm 依赖)
   stdout=JSON 结果 / stderr=进度, 内置每日配额闸门(默认 2 次/天, 40 请求/天)
   ↑ 子进程
dsh-wx-daily 插件(host: lib/index.js + collect.js)
   按 bookId 对号 → 窗口过滤 → LLM 摘要(可选) → dataDir/latest.json(每次覆盖)
   ↑  /wx-daily/*
dsh web 侧边栏「📮 公众号」tab (client: lib/client.js)
```

为什么走微信读书：搜狗微信对多数头部公众号不收录（公众号可关闭搜狗索引），
实测卡兹克/花叔等号几乎搜不到本人文章；微信读书把公众号当「书」收录
（`bookId = MP_WXS_<base64(__biz)>`），覆盖完整，文章链接是永久有效的
`mp.weixin.qq.com/s/<articleId>`。

为什么不用 wewe-rss：它依赖作者运营的闭源 relay（`weread.111965.xyz`），
扫码得到的微信读书会话 token 托管在作者服务器上；且 wewe-rss 仓库已
archived（2026-03-20 停止维护）。本方案把同一套微信读书接口改成本机专用
Chrome 直连，第三方托管与会话泄露面清零。wewe-rss 已于 2026-08-25 删除，
不要再引入。

## 部署（本机实际方式）

### 采集器 + 专用 Chrome

```bash
git clone https://github.com/Pengyf04/weread-mp-fetcher /home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher
# config.json 已建好（accounts 字段由插件每次采集时同步，手工改会被覆盖）
screen -dmS wereadchrome sh /home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher/start-chrome.sh
# 首次：在专用 Chrome 窗口打开 https://weread.qq.com/ 微信扫码登录
#（建议非主微信号：风控惩罚落在该微信读书账号上）
# 验证：node /home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher/bin/weread.mjs --shelf
```

重启机器后只需重新执行 `screen -dmS wereadchrome …` 一行（登录态在
profile 目录里长期保持）。同一 profile 同时只能有一个 Chrome 进程。

### 插件装进 web profile（与 dsh-inference-news 相同的方式）

`~/.dsh/profiles/web/package.json`：

```json
"dependencies": { "dsh-wx-daily": "link:/home/zzw/code/tool/dsh-plugins-archive/dsh-wx-daily" },
"dsh": { "profile": { "bundles": [ /* …现有… */ "dsh-wx-daily" ] } }
```

`~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-wx-daily
      name: 'dsh-wx-daily'
      config:
        summaryMaxTokens: 131072
```

然后 `cd ~/.dsh/profiles/web && pnpm install`，重启 dsh web。

## 使用

- **侧边栏**：选时间窗（今天 / 近 3 天 / 近 7 天 / 自定义日期段）→「⚡ 采集」；
  顶部 chips 按号过滤（✅n 条 / — 无更新 / ⚠ 未订阅 / ❌ 错误，hover 看错误）；
  勾选「含 LLM 摘要」时顶部显示要点块。
- **命令**：`/wx`（当天 + 摘要）。
- **工具**：`wx_collect { window|from,to, withSummary }`。
- **路由**：`GET /wx-daily/latest`、`GET /wx-daily/accounts`、
  `GET /wx-daily/status`（fetcher/专用 Chrome 连通性 + 已订阅号数诊断）、
  `POST /wx-daily/collect { window|from,to, withSummary }`。
- **配额**：每天 2 次采集（21 号 × 1 页 = 21 请求，预算 44 = 2 次 + 余量）。
  真正的闸门是 `maxRequestsPerDay`（请求预算）；`maxRunsPerDay` 只是次数上限。
  超配额时采集报「今日采集配额已用完」——是防风控闸门，不是故障。

## 增加公众号（两步，可批量）

1. **微信读书侧订阅**（不耗每日采集配额；可一次传多个链接/bookId）：

   ```bash
   cd /home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher
   node bin/weread.mjs --add https://mp.weixin.qq.com/s/<该号任意一篇文章>
   # → 解析成功:MP_WXS_xxx (号名)   ← 务必核对打印出来的号名
   # → 已加入书架:MP_WXS_xxx
   # 已知道 bookId 的可以直接传：--add MP_WXS_xxx MP_WXS_yyy …
   ```

   文章链接在微信里这样拿：打开该号任意一篇文章 → 右上角「···」→ 分享 → 复制链接。

2. **插件侧**：`dataDir/accounts.json`（默认 `/home/zzw/work/news/wx-daily/accounts.json`）的
   `accounts` 数组加一行：

   ```json
   { "name": "新号名", "bookId": "MP_WXS_xxx", "enabled": true }
   ```

   - `name` 是面板显示名；`bookId` 是采集对号的唯一键（第 1 步输出的值），不做名字猜测。
   - 下次「⚡ 采集」自动生效，无需重启 dsh。

验证：采集一次，新号 chip 应显示 ✅n 条或 — 无更新（⚠ 未订阅 = bookId 没填或第 1 步没做）。

## 删除 / 停用公众号

| 目的 | 操作 | 影响 |
| --- | --- | --- |
| 临时停用采集（保留订阅，随时恢复） | `accounts.json` 里该号 `"enabled": false` | 下次采集不再抓它；微信读书书架不受影响 |
| 从面板彻底移除 | `accounts.json` 里删掉该行 | 同上 |
| 从微信读书书架退订（可选） | fetcher 无退订命令，手动操作：专用 Chrome 窗口（或手机微信读书 App 同一账号）→ 书架 → 找到该公众号 → 移除 | 仅影响微信读书书架；插件采集由 `accounts.json` 决定，不退订也照常采集 |

注意：`enabled: false` / 删行**不会**自动从微信读书书架移除该号；反过来书架里有号、
`accounts.json` 没有，也不会被采集。两边互不联动，`accounts.json` 是采集的唯一开关。

## 配置（cordis.patch.yml / Config 覆盖）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `fetcherDir` | `/home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher` | 采集器源码目录 |
| `fetcherPages` | `1` | 每次每号翻几页（1 页 ≈ 70–80 篇）；调大消耗更多每日请求预算 |
| `dataDir` | `/home/zzw/work/news/wx-daily` | `accounts.json` / `latest.json` |
| `timezone` | `Asia/Shanghai` | 「当天」的时区 |
| `llmProvider` / `llmModel` | `''` | 摘要 LLM 路由，空 = 部署默认 |
| `summaryMaxTokens` | `16384` | 摘要输出预算（思考模型需要余量） |
| `summaryReasoningEffort` | `'off'` | 摘要是机械任务，off 更快 |
| `commandName` | `wx` | 斜杠命令名 |
| `collectTimeoutMs` | `300000` | 采集+摘要协同超时 |

采集器侧的传输/配额参数（`chromePort`、`maxRunsPerDay`、`requestIntervalMs`、
`maxRequestsPerDay` 等）在 `<fetcherDir>/config.json`，插件只同步其中的
`accounts` 字段，其它字段原样保留。

## 数据文件

- `dataDir/accounts.json` — 公众号清单（唯一需要日常编辑的文件）。
- `dataDir/latest.json` — 最近一次采集结果（**每次覆盖**，含 `summary` 与
  `summaryError` 字段；无 seen / 无去重状态）。
- `~/.weread-mp-fetcher/quota.json` — 采集器每日配额账本。

## 排障

| 症状 | 处理 |
| --- | --- |
| 面板「微信读书专用 Chrome 未运行」 | `screen -ls` 看 `wereadchrome`；重拉：`screen -dmS wereadchrome sh /home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher/start-chrome.sh` |
| 全部/某号 ❌ `errCode=-2010` | 微信读书登录失效 → 专用 Chrome 窗口重新扫码登录 weread.qq.com |
| 全部/某号 ❌ `errCode=-2041` | 请求未发在阅读器页上下文 → 专用 Chrome 里保持一个公众号阅读器标签页常开，必要时刷新该页 |
| 采集报验证码 | 专用 Chrome 窗口手动完成腾讯验证码后重跑（工具不代过人机校验） |
| 「今日采集配额已用完」 | 正常闸门：`node bin/weread.mjs --quota` 查账本，明天再采 |
| 白屏/打不开 weread.qq.com | 本机网络直连（勿带 socks 代理）；微信读书侧拦截 → 隔几小时再试 |
| 窗口内明明有文章没采到 | 该号在微信读书侧收录滞后（平台问题，个别号滞后数天）；或 1 页不够 → `fetcherPages` 调大 |
| 摘要「达到 max-tokens」 | 调大 `summaryMaxTokens`（本地大模型可给到 131072） |

## 测试

```bash
node --test test/collect.test.js test/summary.test.js
# 21 个单测：时间窗 / fetcher 输出解析 / 配置合并 / 退出码映射 /
# collect 管线（stub 子进程）/ 摘要
```
