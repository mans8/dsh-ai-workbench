# AI 工作台账 · AI Workbench

> 一份只留在本机的工作台账：**做过的事留得下、交给领导的汇报报得出。**

一个 DSH 的个人工作台账插件：把待办按项目管好、没做完的事一直留在今日列表里，再从真实流水生成统计与报表。
数据全部留在本机，不联网、不上传。

| 模块 | 一句话 |
|---|---|
| **待办清单**（含今日页） | 今天没做完的，明天还在 —— 同一件事、同一条记录，不需要改日期 |
| **项目** | 把待办按项目归类，报表按项目切片；项目可设名称、分类（个人/工作）、代号、负责人、说明、状态与起止日期 |
| **统计** | 日 / 月 / 年三个粒度的完成数、完成率、漏做、放弃，外加一张年热力图 |
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
npm test        # host 119 项 + client 100 项断言（27 个渲染实例）
```

`test/host.test.mjs` 用伪造的 DSH 服务跑 api / 工具 / 报表，`test/client.test.mjs` 用 mini-React 垫片
真的把 `client.js` 里的组件树渲染一遍；这 222 项断言能挡掉绝大多数「一刷新就崩」。

### 多个 agent 一起改时

- **一次只让一个 agent 动这个目录**：没有文件锁，两个会话并行编辑会互相覆盖。
- 用插件管理器重装同一条路径会报 `already-installed`，要先 `remove_bundle` 再 `install_bundle`；
  但这**不等于热重载 Host** —— ESM 缓存该命中还是命中，最终仍以重启为准。
- 仓库自带 `.gitignore`（忽略 `node_modules/`、`.hallmark/`、`backups/`）。从源码开发时先 `git init` 再改。
- 数据在 `~/ai-workbench/state.json`（可用 `AI_WORKBENCH_STATE_FILE` 覆盖），改源码、重启都不会动它；状态文件损坏时插件会自动备份为 `state.json.corrupt-<时间戳>.bak` 再启动空白状态。动 `lib/state.js` 的 `normalizeState()` / `migrateState()` 之前仍建议手动备份。

---

## 四个模块怎么用

### 1. 待办清单（含今日页）

> 这一页只管「事情做没做」：完成写一条事实流水，撤销把它软删，仅此而已。

**核心机制**：不做定时任务、不依赖 DSH 常驻。**今日待办 = 所有未完成待办**，
没做完的事不需要任何日期动作，下一天打开就还在列表里 —— 同一件事、同一条记录。
任何一次读写之前先跑一次「惰性补算」，把「上次处理到的那天」到今天之间的每一天依次补上，
补算只做一件事：

```
检查重复任务模板 → 该到期且没有未完成实例时，开出当天这一条
```

历史轨迹由事实流水承载，所以「昨天没做完今天接着做」在数据上本来就是同一条待办。

- **可编辑**：行内 `⋯` →「编辑」打开弹层，改标题 / 备注 / 项目 / 优先级 / 截止日 / 完成度。
  **已完成的条目也能改**（`本周完成` 那一节每行都有「编辑」），改完会同步到周报与统计。
- **完成 / 撤销只动流水**：完成写一条事实流水（供统计与报表），撤销把它软删。
- **优先级**：`P0` 紧急 → `P3` 低。新建表单的下拉里、每条待办的徽标上、以及悬浮提示里都能看到含义（Agent 工具描述里也写着同一套）。

  | | 含义 | 什么时候用 |
  |---|---|---|
  | `P0` | 紧急 · 立刻做 | 线上故障、阻塞别人的事、当天必须交付 |
  | `P1` | 高 · 尽快做 | 本周内要交付，或别人在等你的产出 |
  | `P2` | 中 · 正常排期（默认） | 按计划推进即可 |
  | `P3` | 低 · 有空再做 | 想做的优化、可延期的杂事 |

- **重复任务**：给待办配上 `repeat`（每天 / 每个法定工作日 / 周一至周五 / 每周几 / 每月几号）即成为模板，
  自动开出当天实例。规则是**一次只留一个未完成实例**：没做完的那条一直留在列表里，不会一周后堆出 5 条一模一样的「站会」。
  其中「每个法定工作日」按内置节假日日历判断（见下方「日历数据」）。
- 逾期（有硬截止日且过了）、放弃理由，都在列表里一眼看到。截止日可以不填，默认空。

### 2. 项目

待办可以挂到项目下；项目本身记录**名称 / 分类（个人或工作）/ 代号 / 负责人 / 说明 / 状态 / 起止日期**。
新建与修改都在「项目」页右上角的「新增项目」弹窗里完成。
报表的项目维度切片也读同一份项目数据。

### 3. 统计（日 / 月 / 年）

同一套指标换三种粒度：完成数、新建数、完成率、漏做数、放弃数，外加按项目分布与年热力图。

数字全部来自事实流水（logs）。

口径：
- `完成` = 事实流水（logs）计数
- `计划` = 完成 + 漏做 + 放弃

### 4. 报表（时间维度 / 项目维度）

**两阶段设计**，这是整个报表模块的关键：

```
① 汇总（确定性，Host 算）            ② 叙述（生成性，人/Agent 写）
  区间 + 项目筛选                      拿到 facts + 默认草稿
  → 扫 logs                            → 润色成有叙述的正文
  → 冻结 facts 快照       ──────▶      → save 写回 content
  → 生成 Markdown 草稿                 → archive 归档
```

- **同一区间永远产出同样的 facts**，可复算、可审计。
- facts 在生成时**冻结进报表记录**，之后补录流水不会污染已经归档的历史周报。
- **归档后不可改、不可删**，只能「修订」出新版本（`v2` 指回 `v1`），
  这样「交给 leader 的那版」和「我后来美化过的版本」永远能区分开。
- 一键归档所有区间已结束的草稿；支持导出 `.md`。
- 周报默认区间是**本周一 ~ 本周五**，日期可随时改。
- 「未完成」是按区间结束时点判断的（建账日期 ≤ 区间结束，且在结束时仍未了结），
  所以**补生成的历史周报不会被「后来终于做完了」篡改**。
- 周报的「下周待办」= 所有未完成待办，按创建顺序排，不写百分比。

---

## 让 Agent 也能用

插件注册了两个工具（按域拆分，而不是塞进一个巨型 action 枚举）：

### `workbench_todo`

```
「我明天要做什么？」                → action: today
「把『订单导出接口重构』标记完成」   → action: complete, task: 订单导出
「加一项每天 5 点的任务：站会」      → action: add, title: 站会, repeat: {freq:"workdays"}
「看看这周做了哪些事」              → action: list, from: 2026-10-19, to: 2026-10-23
「新建项目：对账系统」              → action: project_add
```

action：`today` / `list` / `add` / `update` / `remove` / `complete` / `undo` / `drop` / `restore` /
`project_add` / `project_update` / `project_remove` / `project_list`。
`task` 可传标题（支持部分匹配）或 id。`list` 的 `from` / `to` 表示「与区间有交集」：
未完成看创建时间、已完成看完成日、已放弃看放弃日。

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
        # 额外放假 / 特殊作息（供日历日期性质标签使用）：
        # holidayOverrides:
        #   "2027-02-08": holiday
```

运行时的设置项在面板右上角 **⚙️ 设置**：报表落款与署名、
**自定义报表模板**、节日手工覆盖（额外放假 / 特殊作息，用于日历日期性质标签）。

自定义模板留空时用内置版式；非空时覆盖全部报表类型（包括周报）。
可用占位符：`{{title}}`、`{{range}}`、`{{weeklyCompleted}}`、`{{nextWeek}}`、
`{{completed}}`、`{{byProject}}`、`{{stats}}`、`{{footer}}` 等。

### 日历数据

`data/china-holidays.json` 内置 2004–2026 年中国大陆法定节假日与调休上班日
（来源 [chinese-days](https://github.com/vsme/chinese-days)，MIT，数据源自国务院办公厅历年通知）。
这份日历**只用于判断日期性质**：重复任务的「每个法定工作日」是否生成实例，以及
工作日 / 法定节假日 / 调休上班 / 周末这类日期标签；不参与任何其他核算。

- 新旧年份安排发布后，替换这个文件即可。
- 未覆盖的年份按「周一~周五 = 工作日」处理，可通过 `isCovered()` 检测并在需要时提示用户，
  绝不把数据缺失当成已确认的安排。

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
| `settings` | 节假日覆盖、报表模板、周报汇总文件、署名 |
| `cursor.rolledThrough` | 补算游标：重复任务补算已推进到哪一天（幂等的关键） |
| `projects[]` | 项目 |
| `todos[]` | 计划层：待办与重复任务模板（`plannedDate` 等旧字段只读兼容，不再写入） |
| `logs[]` | **事实层**：只追加的待办流水（撤销用 `voided` 软删） |
| `reports[]` | **叙述层**：报表快照 + 正文 |
| `rolloverLog{}` | 历史兼容字段：每天开出的重复任务数（面板不再展示） |

---

## 开发与测试

```bash
node test/host.test.mjs     # Host 半体：119 项断言
node test/client.test.mjs   # Client 半体：mini-React 渲染 + api 契约，100 项断言
```

两套测试都不依赖真实 DSH：

- `host.test.mjs` 伪造 `webServer / connection / tools` 三个服务，把 HTTP 路由当被测接口驱动，
  并用 `today` 参数做「时钟木偶」模拟跨日，覆盖跨日补算、重复任务、统计、报表归档、
  项目引用边界、脏数据容错。
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
| `index.js` | 插件入口：串行化状态仓库 + `/ai-workbench/api` 路由 + 两个工具注册 |
| `lib/util.js` | 日期与数值工具（day key 一律本地时区 `YYYY-MM-DD`） |
| `lib/calendar.js` | 中国法定节假日 / 调休日历与日期性质判断（供重复任务「每个法定工作日」与日期标签使用） |
| `lib/state.js` | 状态模型、规范化、原子持久化、**惰性补算引擎** |
| `lib/domain.js` | 派生视图：今日 / 待办 / 项目 / 统计 |
| `lib/reports.js` | 报表 facts 聚合与 Markdown 渲染 |
| `lib/actions.js` | 全部写操作（面板与工具的唯一入口） |
| `lib/tools.js` | 两个 Agent 工具 |
| `client.js` | 浏览器面板：四个分页 + 设置弹层 |
| `test/browser/` | 真实浏览器复现环境（真 Host + 真 React + 真 DOM） |
| `design.md` | **设计规范**（配色/字号/间距/组件/布局）；改 UI 前必读 |
| `DESIGN-LOG.md` | 设计决策日志（A1–A51 的取舍与回退记录） |

**单一权威**：Host 是唯一事实来源。面板与 Agent 调用完全相同的领域函数，
不存在「面板能做的工具做不了」或者两边口径不一致。
Client 只负责画图，不自己算任何百分比。

### 两个容易踩的约定

- **`today` 与 `date` 是两个东西**：`today` 是「现在是哪一天」，驱动跨日补算；
  `date` 是「要看/要操作哪一天」。分开之后才能做到「翻着别的日期的待办，补算仍只推进到今天」。
- **时钟被调早时不回退游标**：宁可让补算停摆到时钟追上，也不重复记账。
