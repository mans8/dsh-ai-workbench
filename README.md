# AI 工作台账 · AI Workbench

> 一份只留在本机的工作台账：**做过的事留得下、投入的工时算得清、交给领导的汇报报得出。**

一个 DSH 的个人工作台账插件，管好**两套互相独立的账**与一份汇报：

> **待办**是我每天要做的事；**工时**是月底按领导派发填报的考勤台账。
> 两者不挂钩 —— 完成一件事不会自动给你记工时，撤掉一条待办也不会动考勤数字。

| | 是什么 | 数据落在 |
|---|---|---|
| **待办 / 流水** | 每天要做的事，完成后写一条事实流水 | `todos[]` + `logs[]` |
| **工时台账** | 按月核算的考勤，**每条工时都来自一张工单** | `tickets[]` → `days{}` |

各自的入口也是分开的：待办在「今日 / 待办」页，工时在「工时」页。

| 模块 | 一句话 |
|---|---|
| **待办清单** | 今天没做完的，明天自动还在 —— 同一件事、同一条记录，只改计划日并累加顺延天数 |
| **工时管理** | 按月核算：法定工作日 × 每日工时 = 计划工时；计划 × 系数（默认 1.1，可在设置里改）= **必须工时** |
| **统计** | 日 / 月 / 年三个粒度的完成率、按时率、顺延、漏做、工时达成率，外加一张年热力图 |
| **报表（时间维度）** | 周报 / 月报 / 年报：按任意区间从真实流水汇总，生成草稿 → 润色 → 定稿 → **永久归档** |
| **报表（项目维度）** | 同一套引擎按项目切片，额外带项目概况与进度 |

数据全部在本机的 JSON 文件：`~/ai-workbench/state.json`。不联网、不上传。
如需改位置，设置环境变量 `AI_WORKBENCH_STATE_FILE` 指向任意绝对路径。

---

## 安装

适用于 DeepSeek Harness（DSH）桌面端与网页端。需要 DSH 自带 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 两个 bundle；Host 半体依赖宿主服务 `webServer`、`connection`、`tools`，Client 半体使用宿主提供的 `react`（无需自行安装）。

### 方式一：从 GitHub 安装（推荐）

```bash
dsh plugin --profile desktop add github:mans8/dsh-ai-workbench
```

网页端把 `--profile desktop` 换成 `--profile web`。也可以直接把这条命令交给 Agent 执行。

### 方式二：从 npm 安装

```bash
dsh plugin --profile desktop add dsh-ai-workbench
```

### 方式三：从 Releases 安装包（固定地址）

```bash
dsh plugin --profile desktop add https://github.com/mans8/dsh-ai-workbench/releases/latest/download/dsh-ai-workbench.tgz
```

### 手工改 profile（离线开发用）

在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加：

```jsonc
{
  "dependencies": {
    "dsh-ai-workbench": "link:<插件目录>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-ai-workbench"        // ← 追加这一行
      ]
    }
  }
}
```

然后在插件目录执行一次 `npm install`，**重启 DSH**。

> 本地 link 方式下，改 `client.js` 刷新页面即可；改 `index.js` / `lib/*.js` / `data/*.json` 需要重启 DSH（Host 侧 ESM 有缓存）。

---

## 开发与生效（本地 link 模式）

发布版通过 npm / GitHub 安装；本地开发时把 profile 里的依赖换成 `link:<插件目录>`，
DSH 直接读本目录的源文件 —— **源码即部署**，没有构建步骤。改完只差「让运行时重新加载」，
而方式取决于改了哪半边。

| 改动 | 生效方式 | 为什么 |
|---|---|---|
| `client.js` | **刷新页面**（关掉面板重开 / Cmd+R） | Client 半体按请求读盘，不需要重启 |
| `index.js`、`lib/*.js`、`data/*.json` | **重启 DSH** | Host 侧 ESM 按 URL 缓存，同一进程内不会重新加载 |
| 工具名 / 描述 / 参数 schema | 同上，必须重启 | 工具清单在启动时注册进 Agent，新会话拿到的才是新 schema |
| `package.json`、`cordis.patch.yml`、`icon.svg` | 插件管理器 remove → install，或直接重启 | 属于 bundle 结构，改了要重新挂载 |
| 新增 npm 依赖 | `npm install` 之后再重启 | 依赖不随 `link:` 自动装 |

> **不要指望热更新。** `dsh-hmr` / `dsh-client-hmr` 只在 DSH 源码 checkout 里跑
> `pnpm run dev:web` 时才会免刷新重载 Client 插件；本插件是 profile 里安装的本地 bundle，
> 走不到那条路。改 `client.js` 刷新页面即可；改了 Host 就别反复刷新页面了 —— 重启才是唯一可靠的办法。

### 改完先跑测试

没有构建期校验，`client.js` 一旦语法错，刷新后整个面板就是白屏或报错。所以顺序是**先跑测试，再刷新**：

```bash
cd <插件目录>
npm test        # host 153 项 + client 114 项断言（41 个渲染实例）
```

`test/host.test.mjs` 用伪造的 DSH 服务跑 api / 工具 / 报表，`test/client.test.mjs` 用 mini-React 垫片
真的把 `client.js` 里的组件树渲染一遍；这 264 项断言能挡掉绝大多数「一刷新就崩」。

### 多个 agent 一起改时

- **一次只让一个 agent 动这个目录**：没有文件锁，两个会话并行编辑会互相覆盖。
- 用插件管理器重装同一条路径会报 `already-installed`，要先 `remove_bundle` 再 `install_bundle`；
  但这**不等于热重载 Host** —— ESM 缓存该命中还是命中，最终仍以重启为准。
- 仓库自带 `.gitignore`（忽略 `node_modules/`、`.hallmark/`、`backups/`）。从源码开发时先 `git init` 再改。
- 数据在 `~/ai-workbench/state.json`（可用 `AI_WORKBENCH_STATE_FILE` 覆盖），改源码、重启都不会动它；状态文件损坏时插件会自动备份为 `state.json.corrupt-<时间戳>.bak` 再启动空白状态。动 `lib/state.js` 的 `normalizeState()` / `migrateState()` 之前仍建议手动备份。

---

## 五个模块怎么用

### 1. 待办清单（含跨日顺延）

> 这一页只管「事情做没做」，**完全不涉及工时**。完成或撤销待办都不会产生、也不会收回任何工时。

**核心机制**：不做定时任务、不依赖 DSH 常驻。任何一次读写之前先跑一次「惰性补算」，
把「上次处理到的那天」到今天之间的每一天依次补上：

```
未完成的待办 → plannedDate 前进一天，rolloverCount 加一
```

于是「昨天没做完今天接着做」在数据上**永远是同一条待办**，历史轨迹由事实流水承载。

- **可编辑**：行内 `⋯` →「编辑」打开弹层，改标题 / 备注 / 项目 / 优先级 / 顺延策略 / 计划日 / 截止日 / 预估工时 / 完成度。
  **已完成的条目也能改**（`本周完成` 那一节每行都有「编辑」），改完会同步到周报与统计。
- **完成 / 撤销只动流水**：完成写一条事实流水（供统计与报表），撤销把它软删 —— 工时台账原封不动。
- **优先级**：`P0` 紧急 → `P3` 低。新建表单的下拉里、每条待办的徽标上、以及悬浮提示里都能看到含义（Agent 工具描述里也写着同一套）。

  | | 含义 | 什么时候用 |
  |---|---|---|
  | `P0` | 紧急 · 立刻做 | 线上故障、阻塞别人的事、当天必须交付 |
  | `P1` | 高 · 尽快做 | 本周内要交付，或别人在等你的产出 |
  | `P2` | 中 · 正常排期（默认） | 按计划推进即可 |
  | `P3` | 低 · 有空再做 | 想做的优化、可延期的杂事 |

- **顺延策略**（可逐条覆盖）：`always` 一律顺延（默认）/ `backlog` 顺延但进「积压区」不进今日列表 / `never` 到期作废并计入「漏做」。
- **重复任务**：给待办配上 `repeat`（每天 / 每个法定工作日 / 周一至周五 / 每周几 / 每月几号）即成为模板，
  自动开出当天实例。规则是**一次只留一个未完成实例**：没做完的那条自己顺延，不会一周后堆出 5 条一模一样的「站会」。
- 逾期（有硬截止日且过了）、顺延天数徽标（≥3 天标黄、≥7 天标红）、积压区、放弃理由，都在列表里一眼看到。

### 2. 工时管理（按月，法定硬口径）

**这是一份独立的考勤台账，不是待办的副产品。**

**工时的唯一来源是工单** —— 月初到月末都一样：想在某个日期上体现工时，就在「本月工单」里记一条
带小时数的工单，它会自动落进当月台账。没有「逐条记工时」「整天填报」「月底批量填报」这些入口了。

- 工单可以带**类型**（售后 / 工时派发 / 新建项目）、链接（`https://issuetrack.example.com/issues/10001`）、项目、备注（比如「不改」）
- **小时数留空 = 无工时**：这类单照常记录，只是不计小时
- 改工单的小时数 / 日期 / 项目，台账会跟着重算，**不会叠加成两条**
- 删工单，连同它带的小时一起收回
- 不再有月历 —— 想知道某天记了什么，看工单表的日期列就行
- **按月记工单**：`本月工单` 表格按「项目 / 链接 / 问题·任务 / 小时」录入，带小时的工单**自动计入已录工时**
  （不会重复填），表格底部给出工单合计与当月缺口。无工时的单（比如临时工单）照常记录，只是不计小时。

```
当月法定工作日 W      = 该月周一~周五 − 落在工作日的法定节假日 + 调休上班的周末
当月计划工时 Plan     = W × 7.5
当月必须工时 Required = Plan × 1.1
达成率                = 已录工时 / Required
缺口 Gap              = max(0, Required − 已录)
日需工时 Need         = Gap / 剩余法定工作日（含今天）
```

**2026 年实算**（内置节假日数据，已与国务院放假安排核对）：

| 月份 | 法定工作日 | 计划工时 | 必须工时 |
|---|---:|---:|---:|
| 1月 | 21 | 157.5 | 173.25 |
| 2月 | 16 | 120.0 | 132.00 |
| 3月 | 22 | 165.0 | 181.50 |
| 4月 | 21 | 157.5 | 173.25 |
| 5月 | 19 | 142.5 | 156.75 |
| 6月 | 21 | 157.5 | 173.25 |
| 7月 | 23 | 172.5 | 189.75 |
| 8月 | 21 | 157.5 | 173.25 |
| 9月 | 22 | 165.0 | 181.50 |
| **10月** | **18** | **135.0** | **148.50** |
| 11月 | 21 | 157.5 | 173.25 |
| 12月 | 23 | 172.5 | 189.75 |
| **全年** | **248** | **1860.0** | **2046.00** |

> 以 2026-10 为例：10-01 ~ 10-07 国庆放假，10-10（周六）调休上班，所以全月 18 个法定工作日。

界面上的月历会把每一天标成 **工作日 / 法定节假日 / 调休上班 / 周末**。

**口径声明**（本机选择，可在设置里改）：

- **请假不扣减必须工时** —— 必须工时是「法定工作日 × 系数」的硬指标，请假天数单独统计展示。
- **上月盈亏不结转到下月** —— 每月独立考核。
- 加班照实计入总工时，同时单独统计加班时长。

**「日需工时」是这个模块存在的全部意义**：它告诉你按剩余工作日分摊、每天平均要投入多少。
一旦超过 7.5h 就标红 —— 说明按正常节奏已经补不回来了。

### 3. 统计（日 / 月 / 年）

同一套指标换三种粒度：完成数、新建数、完成率、按时完成率（首次计划当天就完成的比例）、
顺延次数、漏做数、放弃数、投入工时、工时达成率，外加按项目分布与年热力图。

完成相关的数字来自流水，工时相关的数字来自工时台账 —— 两套各自独立，所以「这个月完成了 4 项
但工时还没填」是很正常的一种状态。

口径：
- `完成` = 事实流水（logs）计数
- `计划` = 完成 + 顺延出去 + 漏做 + 放弃
- `工时` 只来自工时台账（days），**永远不来自流水**；流水里的 `hours` 恒为 0
- 单条工单的工时上限是 **300 小时**（一张「工时派发」单可能一次挂整个项目的额度），不是 24

### 4 & 5. 报表（时间维度 / 项目维度）

**两阶段设计**，这是整个报表模块的关键：

```
① 汇总（确定性，Host 算）            ② 叙述（生成性，人/Agent 写）
  区间 + 项目筛选                      拿到 facts + 默认草稿
  → 扫 logs / days                     → 润色成有叙述的正文
  → 冻结 facts 快照       ──────▶      → save 写回 content
  → 生成 Markdown 草稿                 → archive 归档
```

- **同一区间永远产出同样的 facts**，可复算、可审计。
- facts 在生成时**冻结进报表记录**，之后补录工时不会污染已经归档的历史周报。
- **归档后不可改、不可删**，只能「修订」出新版本（`v2` 指回 `v1`），
  这样「交给 leader 的那版」和「我后来美化过的版本」永远能区分开。
- 一键归档所有区间已结束的草稿；支持导出 `.md`。
- 「未完成」是按区间结束时点判断的，所以**补生成的历史周报不会被「后来终于做完了」篡改**。

---

## 让 Agent 也能用

插件注册了三个工具（按域拆分，而不是塞进一个巨型 action 枚举）：

### `workbench_todo`

```
「我明天要做什么？」                → action: today
「把『订单导出接口重构』标记完成」   → action: complete, task: 订单导出
「加一项每天 5 点的任务：站会」      → action: add, title: 站会, repeat: {freq:"workdays"}
「最近积压了多少？」                → action: rollover
「新建项目：对账系统」              → action: project_add
```

action：`today` / `list` / `add` / `update` / `remove` / `complete` / `undo` / `drop` / `restore` /
`reschedule` / `rollover` / `project_add` / `project_update` / `project_remove` / `project_list`。
`task` 可传标题（支持部分匹配）或 id。**`complete` 不接受 `hours`** —— 待办不记工时。

### `workbench_hours`

```
「这个月工时还差多少？」   → action: month
「把 10001 这张单记 8 小时」  → action: ticket_add, title: …, url: …, hours: 8
「把今天记 7.5 小时」      → action: log, hours: 7.5
「10-13 我请假了」         → action: mark, date: 2026-10-13, status: leave
「近半年工时趋势」         → action: trend, months: 6
```

action：`month` / `calendar` / `day` / `mark` / `trend` / **`ticket_add`（记工单，也是记工时的唯一方式）** / `ticket_remove`。

### `workbench_report`

```
「生成本周周报」                    → action: draft, type: weekly
「按上面这份写正式一点，然后归档」   → action: save, id → action: archive
「订单中台这个月的项目月报」        → action: draft, type: project, project: 订单中台
「今年每月完成情况」                → action: stats, dim: month, from, to
```

action：`draft` / `save` / `finalize` / `archive` / `revise` / `rerender` / `list` / `get` /
`remove` / `archive_stale` / `stats`。

> `draft` 会同时返回**结构化事实**和默认草稿。工具描述里明确要求模型只依据事实撰写，不许编造。

---

## 配置

`cordis.patch.yml` 里的 `config` **只在首次创建 state.json 时种入默认值**，
之后以面板 / 工具里的修改为准（所以改这里不会覆盖你已经调好的设置）：

```yaml
- insert:
    - id: ai-workbench
      name: 'dsh-ai-workbench'
      config:
        dailyHours: 7.5
        grade: standard
        gradeLabel: 标准
        gradeFactor: 1.1
```

运行时的设置项在面板右上角 **⚙️ 设置**：每日工时、职级名称与系数、两种顺延策略、
报表落款与署名、**自定义报表模板**、节日手工覆盖（额外放假 / 特殊作息）。

自定义模板留空时用内置版式；非空时覆盖全部报表类型（包括周报）。
可用占位符：`{{title}}`、`{{range}}`、`{{weeklyCompleted}}`、`{{nextWeek}}`、
`{{completed}}`、`{{byProject}}`、`{{hours}}`、`{{stats}}`、`{{footer}}` 等。

### 日历数据

`data/china-holidays.json` 内置 2004–2026 年中国大陆法定节假日与调休上班日
（来源 [chinese-days](https://github.com/vsme/chinese-days)，MIT，数据源自国务院办公厅历年通知）。

- 新旧年份安排发布后，替换这个文件即可。
- **超出覆盖范围的年份会明确告警**（面板顶部与工时页都会提示「按周一~周五估算」），
  **绝不静默估算** —— 工时算错比算不出来更糟。

---

## 数据与重置

```
~/ai-workbench/state.json            # 全部数据，原子写入（写临时文件再 rename）
<插件目录>/data/china-holidays.json  # 只读日历资产
```

可用环境变量 `AI_WORKBENCH_STATE_FILE` 改路径。删掉当前 `state.json` 即可从零开始。

状态结构（`version: 1`）：

| 字段 | 含义 |
|---|---|
| `settings` | 每日工时、职级系数、顺延策略、节假日覆盖、报表模板、周报汇总文件、署名 |
| `cursor.rolledThrough` | 顺延游标：补算已推进到哪一天（幂等的关键） |
| `projects[]` | 项目 |
| `todos[]` | 计划层：待办与重复任务模板 |
| `logs[]` | **事实层**：只追加的待办流水（撤销用 `voided` 软删），不带工时 |
| `days{}` | **工时台账**：考勤数字的唯一来源，只由 `hours_*` 动作写入 |
| `reports[]` | **叙述层**：报表快照 + 正文 |
| `rolloverLog{}` | 每天被顺延出去的任务数，供统计使用 |

---

## 开发与测试

```bash
node test/host.test.mjs     # Host 半体：153 项断言
node test/client.test.mjs   # Client 半体：mini-React 渲染 + api 契约，114 项断言
```

两套测试都不依赖真实 DSH：

- `host.test.mjs` 伪造 `webServer / connection / tools` 三个服务，把 HTTP 路由当被测接口驱动，
  并用 `today` 参数做「时钟木偶」模拟跨日，覆盖顺延、重复任务、工时口径、工单、
  两套台账互不写入、统计、报表归档、顺延策略、项目引用边界、脏数据容错。
- `client.test.mjs` 用一个约 120 行的 mini-React 垫片（真的实现 `createElement` / `useState` / `useEffect`）
  执行 `client.js` 的组件树，数据来自**真实 Host** 跑出来的视图 JSON；
  其中 `1b` 那组用**插件真正暴露的 api** 断言面板契约（白屏回归）。

还有一套**真实浏览器复现环境**（`test/browser/`）：把 Host 半体真的挂在 HTTP 上，
把 `client.js` 交给真 React + 真 DOM 去跑。真机问题（白屏、跨分页崩溃）只有它能抓住。
用法见 [`test/browser/README.md`](test/browser/README.md)。

> 为什么要两套：mini-React 垫片测不出 React 的真实行为；而单元测试里的**假 api** 是照着
> 「我以为面板需要什么」手写的，会恰好补齐插件漏掉的方法。凡是主机与客户端之间的契约，
> 都必须用真实的那一份去验证。

### 目录结构

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：串行化状态仓库 + `/ai-workbench/api` 路由 + 三个工具注册 |
| `lib/util.js` | 日期与数值工具（day key 一律本地时区 `YYYY-MM-DD`） |
| `lib/calendar.js` | 中国法定工作日日历与「这月有几个工作日」算法 |
| `lib/state.js` | 状态模型、规范化、原子持久化、**惰性顺延引擎** |
| `lib/domain.js` | 派生视图：今日 / 待办 / 项目 / 工时 / 统计 |
| `lib/reports.js` | 报表 facts 聚合与 Markdown 渲染 |
| `lib/actions.js` | 全部写操作（面板与工具的唯一入口） |
| `lib/tools.js` | 三个 Agent 工具 |
| `client.js` | 浏览器面板：六个分页 + 设置弹层 |
| `test/browser/` | 真实浏览器复现环境（真 Host + 真 React + 真 DOM） |
| `design.md` | **设计规范**（配色/字号/间距/组件/布局）；改 UI 前必读 |
| `DESIGN-LOG.md` | 设计决策日志（A1–A51 的取舍与回退记录） |

**单一权威**：Host 是唯一事实来源。面板与 Agent 调用完全相同的领域函数，
不存在「面板能做的工具做不了」或者两边口径不一致。
Client 只负责画图，不自己算任何百分比。

### 两个容易踩的约定

- **`today` 与 `date` 是两个东西**：`today` 是「现在是哪一天」，驱动顺延补算；
  `date` 是「要看/要操作哪一天」。分开之后才能做到「翻着上个月的工时页，顺延仍只推进到今天」。
- **时钟被调早时不回退游标**：宁可让补算停摆到时钟追上，也不重复记账。
