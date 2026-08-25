# dsh-inference-news — 大模型推理日报插件

DeepSeek Harness 插件（原版，非上游 fork）：每天聚合大模型**推理**方向资讯并生成排版美观的中文 Markdown 日报。

- **数据源**（39 个，全部实测可达/可代理）：arXiv（cs.LG/CL/DC/AR）、HF Daily Papers（镜像 API）、23 个 GitHub release 源（vLLM、**vLLM-Ascend**、SGLang、TensorRT-LLM、LMDeploy、TGI、MLC-LLM、llama.cpp、Ollama、LightLLM、NVIDIA Dynamo、Mooncake、LMCache、llm-compressor、DeepSeek-V3；华为昇腾系 **MindIE-LLM / MindIE-Motor / MindSpeed-LLM / torch_npu / CANN 容器镜像 / Triton-Ascend / SGLang-Ascend / MindSpore**）、11 个分级 RSS 博客（专用：vLLM 官方博客、美团技术、Interconnects、HF、NVIDIA Developer；泛：量子位、InfoQ 中文、OpenAI、Azure、Databricks、NVIDIA 公司博客）、5 组 Hacker News 查询
- **管线**：确定性采集（并发 + 重试（429 加长退避）+ 源级失败隔离 + https_proxy 自动/直连回退）+ web 搜索补充（2 组查询，弥补中文媒体/PR/厂商博客等确定性源覆盖不到的料）→ 推理关键词打分 → 同仓库 release 洪水折叠 → **一次辅助 LLM 调用**（结构化 JSON 筛选，默认走部署默认模型）→ 确定性 Markdown 渲染。**两种模式都不做历史去重**（seen.json 只留作历史日志）
- **两种模式**：
  - `daily`（默认，cron/「⚡ 生成今日日报」）：**当天 00:00 → 现在**的全量，写 digests/YYYY-MM-DD.md（同一天重复调用只增不减），记录 seen 历史
  - `full`（时间窗选择器 +「🔍 全量」）：按所选时间窗（24h/48h/72h/7 天）全量采集，**存档到唯一文件名** digests/<日期>_full-<窗>h-<时刻>.md（互不覆盖、不更新 seen），tab 内展示
- **四个使用面**：
  - 模型工具 `news_collect`（只读候选 + 各源状态，零 LLM 成本，可传 ageHours）/ `news_digest`（全流程；`mode: 'daily' | 'full'`、`ageHours`）
  - 人类命令 `/news`（GUI 一键生成日报，无需模型轮次）
  - webServer JSON 路由 `/inference-news/{digests,digests/<文件名>,generate}`（列表含全量档案；generate 接受 `{mode, ageHours}`）
  - 侧边栏「📰 日报」tab（经 dsh-better-sidebar 注册 API）：历史列表（日期 + 要点预览）→ 全文渲染（安全 markdown 渲染器，createElement 构建，无 innerHTML）→「⚡ 生成今日日报」（daily）/ 时间窗选择器（24h/48h/72h/7 天）+「🔍 全量」（full，tab 内展示）

## 安装（web profile，本归档约定）

```sh
cd ~/.dsh/profiles/web
pnpm add "dsh-inference-news@link:<本仓库路径>/dsh-inference-news"
```

然后把 `dsh-inference-news` 追加到该 profile `package.json` 的 `dsh.profile.bundles` 数组，重启 dsh web 实例 + 浏览器 F5。

headless profile（cron 用）同理：`cd ~/.dsh/profiles/headless && pnpm add ...` + bundles 追加。

## 配置

行配置缺省即可运行（全部字段有默认值）；profile patch 层可以只写要覆盖的字段，未写字段走插件默认值。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| outputDir | /home/zzw/work/news/digests | 日报目录（YYYY-MM-DD.md） |
| stateFile | /home/zzw/work/news/seen.json | 采集历史日志（只记录、不参与候选过滤，30 天清理） |
| cacheFile | /home/zzw/work/news/.cache/candidates.json | 最近一次采集的候选 JSON |
| ageHours | 72 | full 模式与 news_collect 的缺省时间窗（小时）；daily 固定为「当天 00:00 → 现在」，不用此值 |
| maxItems | 120 | 候选上限（前 N 条送筛选） |
| timezone | Asia/Shanghai | 日报日期时区 |
| llmProvider / llmModel | 空 | 筛选 LLM 路线；空 = 部署默认（agentDefaultModel.currentSelection） |
| curationMaxTokens | 16384 | 筛选调用的**输出** token 预算（上下文窗口 ≠ 输出预算；thinking 模型的推理 token 也计入该预算） |
| curationReasoningEffort | off | 筛选调用的推理强度。off = 零思考，快且稳定，但点评深度下降（27B 实测）；空串 = 沿用部署默认（如 xhigh），此时 curationMaxTokens 需相应加大（思考 token 与正文共享输出预算） |
| commandName | news | 斜杠命令名 |
| generateTimeoutMs | 600000 | news_digest / 生成端点协作超时 |

数据源/关键词列表在 `lib/collect.js` 顶部常量（v0.1 未配置化，M2 候选）。

## 每日定时（cron）

```cron
0 9 * * * /home/zzw/work/news/news-daily.sh >> /home/zzw/work/news/logs/cron.log 2>&1
```

`news-daily.sh` 以 headless profile 运行一个 agent 轮次调用 `news_digest`（需 `DSH_PERMISSION_MODE=danger-full-access`，cron 无人应答审批）。

## 限制

- **无自定义会话事件**：out-of-tree 插件无法注册会话事件类型（持久化读取路径会拒绝未标 ignorable 的未知事件，而公开 append API 无法标记该字段）。因此日报不在会话日志里——GUI 读文件（经 webServer 路由）；聊天流内嵌卡片需 in-tree 化后才有。
- **GitHub 直连在本机（中国大陆）间歇性被干扰**：脚本自动走 https_proxy（本机 127.0.0.1:7897），代理未启动时部分 release 源可能失败，日报脚注如实标注。
- 昇腾社区（hiascend.com）技术文章是 Nuxt SPA + 私有 gateway API，无公开 RSS；当前由 web_search 兜底（DeepSeek 搜索已索引其页面），确定性抓取留待后续。
- 微信公众号矩阵（阿里技术/字节技术/腾讯技术/美团技术）无 RSS，同样由 web_search 兜底。
