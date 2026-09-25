# TSUI-05 第三轮实渲、压力与退役评审

认可基准为 [reference/](reference/) 的原样设计文件和最终 screenshots；以下截图均来自 GitHub Actions 在真实生产组件 AppV8/TodayFeature/JobLibrary/ScheduleFeature/TellPjsdasCapture/SettingsSurface 上渲染。原型的 SEED、NOW、假保存和内存 Undo 没有进入产品路径。此轮仅用无隐私的合成工作区，不能代表用户的私有生产数据。

## 环境与夹具

- 评审日：2026-09-25 UTC；合成页面时钟固定为 2026-09-23T08:00:00Z（连接态/异常态）和 2026-09-25T04:00:00Z（日程）。Linux GitHub Actions、Node 22.23.2、Playwright 1.63.0；Chromium、Firefox、WebKit。macOS 15 的 WebKit + 系统 VoiceOver 单列为辅助技术证据；第三轮稳定源 SHA `a3ca47f25470d21d6b06efb774460f0c7770dc94` 的 [CI](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36146442448)、[Browser E2E](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36146442494)、[Matrix](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36146442446)、[只读回退](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36146442424) 和 [VoiceOver](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36146442442) 均 SUCCESS。
- 日程夹具：一个 exact 岗位、80 条有实际发生时间的历史、130 条未来节点、1 条过去待确认节点、1 条完成时间未知任务；浏览器断言 211 条主日程 ID 无重无漏。连接态夹具覆盖真实 DecisionRequest、pending、unknown、offline、conflict、读取失败后的有效缓存。
- 响应式截图：1920×1080、1440×900、1280×800、1024×768、768×1024、390×844、320×640 的实际 ScheduleFeature，390/320 另以根字号 200% 渲染；根字号由 computed style 测量约为正常的两倍。今天/录入/设置另有 320/200% 实图。截图与 trace 在对应 Actions run 的 `test-results` artifact 中，关键状态另由日志中的 `TSUI05_VISUAL_*` / `TSUI04_VISUAL_*` 编码截图人工检查。

## 截图 → 批评 → 修正 → 复渲

| 循环 | 实图与问题 | 修正及复验 |
|---|---|---|
| 1 | 初始 [Browser E2E 36138184914](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36138184914) 的 quiet Today/决定/pending/unknown/offline/conflict/refresh failure 截图表明：单项和空态面板留下过多空白；决定行暴露内部 `ambiguous_target`；320/200% 的岗位上下文被截断，录入文字未随根字号完整放大。 | 稀疏面板改为内容高度；决定行只展示真实问题与处理入口；任务上下文在大字时换行；录入及设置的活跃字号改用 rem。随后 [Chromium 36139936849](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36139936849) 中这些真实状态可读，输入/保存按钮和设置卡片实际字号被断言。 |
| 2 | Firefox/WebKit 核心路径仍在 320/200% 的日程页横向溢出 82/89px；同根因复现两次。诊断 [Matrix 36140247873](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36140247873) 输出越界元素：三枚日程标签的最小内容宽度及 `type=month` 的原生内在宽度。 | 三标签在窄屏内等宽换行，月份标签/输入可缩到容器内，320px 时月份与“今天”纵向排布。修正后的 [Matrix 36140761891](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36140761891) Firefox/WebKit 10/10 通过；[Chromium 36140761954](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36140761954) 77/77，通过后实图确认 320/200% 标签、月份控件和待确认入口均可见。 |
| 3 | 七档视口、手机两档字号和系统读屏检查新增到真实组件旅程。[Browser 36141148064](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36141148064) 与 [Matrix 36141148208](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36141148208) 检查各视口无页面横向溢出，截图随 run artifact 保存。首次新增 VoiceOver 用例的测试顺序先将游标移回 web 滚动区，未读到已聚焦的节点；修正为先进入 web，再聚焦节点并移动游标。[VoiceOver 36141793253](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36141793253) 三条真实读屏路径通过，包括今天任务、权威回执、岗位详情、设置，以及日程节点和详情。 |

实图评审后的主要层级：桌面今天首项仍与其余行同规格；一个任务和无任务时容器不会恢复旧 hero 的空白；待决策显示用户问题而不是内部枚举；手机大字保留三入口、任务上下文、节点与回执；警告、离线、未知和冲突各有文字状态，没有用颜色伪造成功。录入 320/200% 为可滚动单层对话框，顶端标题/关闭和末端保存按钮均可到达。

## 压力与性能证据边界

固定合成样本为 300 岗位、500 行动、130 节点和 2,000 历史。Node 22.23.2 Linux x64 的早期 [Matrix 36140761891](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36140761891) 测得日程全投影 P95 205.41ms，超过 150ms 预算；根因是每条历史日期重复建立时区格式器。缓存同一时区格式器后，[Matrix 36141650190](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36141650190) 同夹具全投影 P95 38.59ms、完整 Today selector 17.88ms、索引 30 行追加 0.02ms。它们是读模型/索引测量，不等同完整页面切换或冷启动。浏览器端 warm 路由/标签切换在相同规模夹具的优化生产构建中分别测得 P95 42ms / 43ms，20 个原始样本及 Chrome 153、1280×720、Node 22 环境见 [Matrix 36146442446](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36146442446)。测量包含 React 交互提交后两帧；不包含冷启动网络下载。此前生产构建 Today 回程 P95 343ms 的瓶颈不是列表数量（实际 9 条任务、首批 30 节点），而是“今日已完成”遍历 2,000 历史时逐条新建日期格式器；改为计算一次当日日期键后通过相同门槛。

## 旧入口与文件去向

- 三个顶层入口为今天、岗位库、日程；Tell 为全局动作，设置为低频入口。旧 `/opportunities`、`/opportunities/:id`、`/today/agenda`、`/history`、`/capture`、`/decisions/:id` 的兼容路由和入口迁移在前几批保留；岗位详情与旧深链、日程和录入由 browser journey 走通。审计保留在设置，岗位详情/来源与名额限制仍可查。
- 已删除无活跃消费者的 `AttentionView.tsx`、`OpportunityDecisionList.tsx`、`attention.css`、`timeplan.css`；对应旧渲染静态测试改测现行岗位库。仍服务实际路径的 `surfaceConsolidation.css`、`interactionDetail.css`、`webConsole.css`、`ultimateWeb.css`、`opportunityDecision.css`、`cgr02Tokens.css` 保留。没有删除业务记录、receipt、Undo、identity 或账户隔离能力。
- PR #163 对 immutable `docs/tasks-schedule-ui-v1/reference/` 无改动。实际保留单一生产壳；原型代码没有被导入。

## 尚待外部证据

真人五秒理解、真实用户设备软键盘、私有生产工作区 canary、独立于实现者的人工集成评审均未取得，标为 DEFERRED。macOS CI 系统 VoiceOver 走查是实际辅助技术自动证据，不冒充真人访谈。新增的云端 Live Visual 工作流仅在 Pages exact release gate 成功后核对线上 frontend manifest SHA，并在真实 Pages 前端用合成工作区渲染今天、岗位库和日程截图。工程 exact main `21f247aca2d0801c3df6ad8a99264784098179e0` 的 Pages [36148717592](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36148717592) 因 Vercel 免费构建限流、后端不匹配同 SHA 而失败，未发布、未触发 live 截图；具体见 [TSUI05_RECEIPT.md](TSUI05_RECEIPT.md)。本文件中的合成截图不冒充线上私有工作区截图。
