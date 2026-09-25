# PJSDAS 今天 / 岗位库 / 日程 — 开发计划 v1

Package: `PJSDAS-TASKS-SCHEDULE-UI-v1`（TSUI）  
计划登记日期：2026-09-25  
状态：**设计目标已确定；本轮仅登记开发计划，不授权开始运行代码实施。**

入口：[设计基准](DESIGN_REFERENCE.md) · [验收矩阵](ACCEPTANCE.md) · [当前状态](STATUS.md)

## 1. 要交付的产品，不是旧 UI 的换肤

以用户认可的 `PJSDAS-Tasks-Schedule-Prototype.html` 为界面基准，将生产 Web 改为三个平级入口：**今天 / 岗位库 / 日程**。今天左侧完整呈现当天行动，右侧是可持续向下浏览的节点；岗位库保存岗位身份和进展；日程统一过去实际发生的事情、过去待确认安排和未来节点。首项任务不再特殊放大。

本包替代旧 CGR 对“两主入口、单一 Now 主行动、右侧摘要 Agenda”的界面要求，不推翻已完成 CGR/Reliability Hotfix 的业务、安全和数据完整性成果。旧包的 COMPLETE 是历史认证状态，不是拒绝重做界面的理由；新 UI 也不能借旧包 COMPLETE 声称已经验收。UU-08/UU-09、原生 iPhone、来源扩展和自动投递不在本包。

**授权边界：** 用户本轮授权的是“制定计划并写入 GitHub”。文档提交或合并不自动授权 TSUI-01..05，不触发新的自动开发、真实账户操作、部署命令或发布。后续获得明确实施授权后，按本计划连续推进，不逐轮索取普通工程批准。

## 2. 核验基线与实际差距

### 2.1 仓库事实（登记时点，不代表未来实时状态）

- Remote main：`d0b0374ad6c965bb66591e7079a0e1299b04d9e0`；tree：`a570a9721a97da1df3b6d7dee08be7036418a0c8`。
- Open PR 查询结果为空。CGR canonical STATUS 已关闭；Reliability Hotfix STATUS 为 COMPLETE / writer released，PR #152 已合并。
- 此 main 的 CI `36102512172`、Browser E2E `36102512246` 均 SUCCESS。这是当前产品的基线证据，不是 TSUI 证据。
- Hotfix STATUS 记录已认证 production commit 为 `058bc6de04a5b08685505870860239b24648717f`。本计划没有用用户登录态读取生产工作区，不将该记录冒充本轮实时线上 SHA。
- main 相比设计审计时的 `51d3299ff5c984fc374037d0239b97d76d214f90` 新增可靠性热修复及认证 workflow。后续不得从旧设计时 SHA 开分支而丢掉这些修复。

主要源码证据均固定在上述 main，避免用聊天中的状态代替源代码：

| 已有实现 | 已确认的差距 | 实施决策 |
|---|---|---|
| `src/AppV8.tsx` | Today/Opportunities 两主入口；机会详情是抽屉；路由、业务编排和多个 surface 混在一个模块；导入多层历史 CSS | 拆分壳、路由与 feature；三主入口；只有一个实际挂载的壳 |
| `src/todayBrief.ts` | `ordered.slice(0, 4)` 限制可见行动；默认 7 天、最多 30 天 Agenda；过去待确认截取 6 项；相关决定截取 4 项 | Web 新读模型不能从这些摘要字段假装得到完整列表；保留旧 brief 的对外兼容 |
| `src/decisionV3.ts` | 已处理流程结束、放弃机会、过去未解决固定事件、follow-up 过滤与 Prep 关联 | 复用既有 eligibility/ranking，不把所有未完成 Action 直接塞入 Today |
| `src/scheduleNodes.ts` | 已有 occurrence/version、时间精度、supersession 和 legacy projection | 复用身份/有效版本，不新建另一套可写日历；历史估算不能冒充雇主明确时间 |
| `src/TimelineView.tsx` | 是包含命令、来源、系统记录的审计视图；按 recordedAt 排序、按 occurredAt 分组 | 新用户日程独立投影真实业务事实；原审计移入低频设置，不直接改名成日程 |
| `src/OpportunityDecisionList.tsx` / `src/OpportunityDetailDrawer.tsx` | 多层状态/理由展示、重复视图筛选、长模态详情 | 简化列表；详情承接理由、来源、完整名字和操作上下文 |
| `src/TellPjsdasCapture.tsx` / `src/captureSession.ts` | 已有预览、账户草稿、session jitter、pending/unknown/conflict/Undo | 保留交互状态机与账户边界，重做呈现，不粘贴原型模拟保存逻辑 |
| `src/cloud/authoritativeReadModelClient.ts` | 通过权威 workspace 读入并保护本地待处理变更；不是现成的日程分页 API | 第一版在已验证账户/revision 的完整快照上做增量呈现，避免无依据的后端大改 |
| `src/domainCommands.ts` / `src/cloud/authoritativeCommandClient.ts` | 已有投递记录、行动状态、节点完成/取消/改期、决策解析、回执和补偿 | 所有 UI 写动作继续走这些命令，不新造全快照写回 |
| Reliability Hotfix v1 | exact posting identity、工具可见性、来源完成真实性、同步保护刚完成 | 列为防回归边界；不按公司/职位相似度合并岗位，不顺便启用 owner automation |

## 3. 冻结的产品决定

### 3.1 导航与路由

顶栏仅三个主目的地，设置为低频入口；Tell PJSDAS 是全局动作，不是第四个主页面。不暴露快捷键标签；已有快捷键可保留为非必需能力。Today 手机的“任务 / 节点”是局部切换，不是两套数据或额外主导航。

目标语义路由：`/today`、`/library`、`/library/:opportunityId`、`/schedule`、`/settings`。继续尊重当前部署 base path。

- `/opportunities` 和 `/opportunities/:id` 兼容到岗位库对应页面；不更改 Opportunity ID，不破坏已有 MCP deep links。
- `/today/agenda` 兼容到日程的未来视图；`/capture`、`/today/capture` 保留全局输入打开/关闭和返回语义。
- `/decisions/:id` 仍可直达具体决定；作为上下文处理页而非主导航。
- `/history` 保留审计入口或兼容到设置内审计，不能把审计日志冒充用户日程。
- 保留 URL query、signed proposal hash、OAuth 回跳和原有来源/授权回调；详情返回恢复原入口、搜索、筛选、滚动锚点和焦点。

### 3.2 “今天全部任务”的确定定义

“全部”指**当天应呈现集合的全部项**，不指整个工作区未来所有未完成任务。仅删除 CSS 或把前四项换成六项都不合格。

新 Web selector 从现有 `rankActions` 的有效集合出发，返回：

1. 现有 `buildTimePlan(...).planned` 和最新开工保护集合的完整并集，不做四项/六项截断；
2. 同一有效集合中正在进行、明确到期在本地今天、或已有结构化事实明确安排今天的行动，即使预算已满也不能被静默遗漏；
3. 需要用户决策且影响行动的 open DecisionRequest，以独立 `decision:<id>` 行承载，不冒充已写入的普通 Action；未解决的决定保有完整可达入口。

不新增手动日计划表、拖拽排程、智能排程算法或新的持久化排程字段。没有事实依据的“今天”归属不能从标题关键词或原型合成日期推断。`dueAt` 不等于用户承诺的工作开始时间。

固定面试/笔试本体主要出现在右侧节点；为它做准备是独立任务。过去时间已过但未确认的固定事件进入待确认入口，不继续当作可执行的未来任务。已结束/放弃机会、已完成/取消事项不重新推荐；沿用业务 eligibility，而不是为凑满清单恢复旧待办。没有岗位关联的手动任务保留真实任务名，不能生成虚构公司/岗位。

排序复用已有 domain ranking 和硬约束规则；当前工作可保持连续。视觉上每项同级。隐藏时间预算控件不等于删除预算/估时数据，也不能因此把硬截止过滤掉；只有真实容量/时间矛盾才出现简短提示，细节放详情。选择规则变化只限 Web 列表成员策略，不私改评分权重或旧 MCP TodayBrief v1 的兼容契约。

“今日已完成”由真实完成命令/业务事实的发生时间派生，可折叠。不能用任意 `updatedAt` 或浏览器里的一次点击伪造完成时间；旧数据没有完成时间时保留状态、标注时间未知，不补造历史。

### 3.3 节点和日程的一份事实来源

建立只读 `ScheduleStream` 投影，输入为同一个账户、workspace revision、时区和时钟下的 ScheduleNode、ProcessEvent、Action 及业务 TimelineRecord。不得新建可与它们独立写入的“日程表”。

- 未来：每个 occurrence 仅最新有效版本；保留固定时间、日期、开放窗口、截止、预计时间的区别。未结束的开放窗口即使昨天开始也必须可见；它不能被 `startDate >= today` 漏掉。
- 过去：实际投递、准备完成、招聘进展、节点结果、改期/取消等业务事实；系统同步、扫描计数、授权握手、command ID 默认只在来源/审计详情中出现。
- 未确认：已过时间但无结果独立标记；不自动写成成功、失败、取消或完成。Today 头部入口显示真实总数，不继承旧六项上限。
- 无明确时间：保留“时间待定”可达分组，不自动补 23:59、UTC 午夜或任意结束时间。legacy projection / estimated duration 必须区分于明确源时间；源记录没有结束时间就不能显示为确定的一小时时段。
- 已完成一次业务事件与其回执/命令日志按真实引用关系关联为一个主项；来源记录继续可查。禁止靠相同公司、相同标题或相同日期模糊去重。
- 改期以同一 occurrence 新版本成为唯一有效未来项；旧时间是历史变化，不是第二个仍生效安排。取消、Undo、跨客户端更新使用同样规则。
- Today 右栏 = 该投影的未来/进行中子集；日程“接下来” = 同一子集、同一排序和 ID，不允许分别手写两套筛选。

业务 `occurredAt` 与录入 `recordedAt` 分离；倒序补录不能打乱事件发生顺序。旧历史不够完整时明确范围，不把当前状态反推成没有证据的历史。原始记录不删除。

### 3.4 连续浏览与性能边界

“无限往下拉”意为**所有已存在的节点均可达**，不是生成无限数据，不是一次挂载全部 DOM。取消 7/30 天读取边界，但允许分批渲染。

第一版复用权威快照读取，在账户 + revision 的投影上建立一次排序索引，按稳定 key（时间分组/时间值/entryId）追加窗口。初始一批，接近底部追加；键盘和辅助技术有“继续加载”后备。追加只增加新项，不重建整列导致失焦；计数说明是总量还是已加载量。到真实末尾才显示“已显示全部”，错误不得显示成末尾。

桌面节点区独立滚动，左列不动；日程加载早先历史要保留原可见项锚点，默认定位今天附近。窄屏与大字优先页面滚动，避免触摸双滚动陷阱。长任务集合也不得因视图上限丢项。

跨 revision 更新不能复用旧游标盲目拼接；重建对应投影并按 entryId 恢复锚点，不重复/跳过项。换账户必须清空账户绑定索引、游标与视图状态。不要因每次滚动重新取完整 workspace 或重复全量排序。

**不默认新建服务端分页。** 若在固定压力样本中测得现有 snapshot 读取/索引确实超预算，再记录证据，增加最小只读分页能力；它必须同样绑定账户、权限、revision、过滤和排序，不能绕过权威边界。该方案评审在 TSUI-01 完成，不留到最后凭感觉换架构。

### 3.5 动作语义：简化 UI，不简化事实

| UI 行为 | 正确实现 | 明确禁止 |
|---|---|---|
| 投递 / 打开申请入口 | 打开已验证的申请地址；无地址时打开岗位上下文并如实说明 | 打开链接即标记已投递；虚构外部入口 |
| 我已投递 | `domain / record_application_submission`，绑定 exact opportunityId | 只改 Action.done，或调用真实代投接口 |
| 完成准备 / 普通待办 | `domain / set_action_status`，绑定 actionId | 顺带完成面试或结束招聘流程 |
| 确认参加/完成笔试或面试 | `domain / complete_occurrence`，绑定 occurrenceId | 仅凭时间过去自动完成 |
| 改期 / 取消安排 | `reschedule_occurrence` / `cancel_occurrence`，保留时间精度和历史 | 创建另一份独立日历事件；静默覆盖冲突 |
| 确认模糊岗位 | `resolve_semantic_decision`，保留 requestId/choiceId | 根据相似名字自动选择或提前移除待确认行 |
| 告诉 PJSDAS | 复用 Semantic Intake 的真实 preview/commit 与账户草稿 | 原型关键词判断、内存数组修改或 timeout 假保存进入生产 |
| 撤销 | `undoConnectedBusinessCommand` / 既有补偿路径，解释依赖冲突 | 用旧 snapshot 整体恢复；把无回执当成功 |

写入结果与本地交互分离；`COMMITTED` / `ALREADY_APPLIED` / `NO_WRITE` / `CONFLICT` 逐一映射，不能统一绿色“成功”。pending/unknown 只锁受影响对象；跨页/关弹窗后仍能恢复，未知结果先查询原操作，不生成新 commandId 重复提交。

## 4. 目标实现结构与保留 / 迁移 / 删除

建议生产结构如下，路径可小幅调整，但职责和单一事实边界不可取消：

```text
src/app/          AppShell, router, workspace/receipt orchestration
src/ui/           tokens, Button, Dialog, Status, ListRow, focus utilities
src/today/        TodayFeature, TodayTaskList, UpcomingNodes
src/jobs/         JobLibrary, JobDetail, contextual preparation
src/schedule/     ScheduleFeature, EventDetail, shared schedule projection/index
src/capture/      Tell PJSDAS presentation + existing intake state machine
src/settings/     account / connections / preferences / data / support
```

| 对象 | 处理 |
|---|---|
| `AppV8.tsx` 的壳、路由和巨型 surface composition | 拆出，不再新增 AppV9/V10；仅一个根挂载 |
| `today/TodayFeature.tsx`、`today/today.css` | 替换首项 hero 和摘要布局为同规格任务列表 + 节点区 |
| `todayBrief.ts` | 提取可复用私有计算或增设 Web complete selector；不破坏 `contractVersion: 1` 外部 brief |
| `OpportunityDecisionList` / `OpportunityDetailDrawer` | 替换呈现；保留 `opportunityDecisionRead` 领域结论和真实 IDs |
| `TimelineView` | 不直接复用为日程；保留为设置内低频审计及来源查证 |
| `TellPjsdasCapture` / `DecisionRequestsView` | 复用可靠行为，重做简洁呈现及上下文入口 |
| Prep / Application Group / Discovery Inbox | 从常态首页退场；准备和名额约束放对应详情，Inbox 保留岗位库的低频收件入口；不能变成无法进入的死功能 |
| Rules / Coverage / History / Recovery | 普通信息进入详情或设置；影响当前动作的风险仍可见 |
| 多层 `timeplan.css`、`surfaceConsolidation.css`、`interactionDetail.css`、`webConsole.css`、`ultimateWeb.css`、`cgr02Tokens.css` 等 | 按实际 import/selector 消费关系迁移；移除已无活跃消费者的层，不盲删仍服务保留路径的样式 |
| 账户、权威命令、CAS、receipt、Undo、source identity、授权、hotfix | 保留原路径及回归证据；出现真实缺陷再做最小修复 |

删除的是重复入口、无价值常显信息和不再挂载的 UI，不是用户数据或有用能力。功能入口迁移必须有去向表及实际走通证据。旧数据、旧命令契约和历史回执不能为了更整洁而迁移清空。

## 5. 分批开发与依赖

采用一个运行代码 writer、一个当前批次 PR。下表是完整范围，不另造无限后续阶段。获得整个包的实施授权后，完成一批的必要 exact-head / merge / exact-main 收口即进入下一批；普通失败自行修复，不逐轮等用户。

### TSUI-00 — 计划与设计登记（本轮）

交付本计划、设计基准、验收矩阵和状态。只写文档；不改 runtime、依赖、workflow、schema、来源、部署配置或发布开关。文档登记不叫“UI 已完成”。

### TSUI-01 — 完整 Today 与统一日程读模型

依赖：TSUI-00 + 后续明确实施授权。

工作：获得并校验认可原型；核验最新 main/writer 一次；实现完整 daily selector、共享 ScheduleStream、时区/版本/历史关联、稳定索引与窗口读取。命令层不重写。验证现有 complete projection 能承受目标样本，决定是否确需只读分页。

主要落点：`todayBrief.ts`、`decisionV3.ts` 的可复用查询边界、新 Web selector / schedule projection，相关 unit fixtures。禁止为赶 UI 在组件中抄一份独立排序逻辑。

出口：今日第五项以后和所有受保护项可达；超过 30 天的已有节点可达；过去未确认不截为六项；跨日开放窗口不漏；同一 occurrence 不重复；日程与 Today 未来投影一致。无新的持久化业务表、无未授权写路径。

此批是短基础批，不做重型框架重构；完成后立即进入可见 UI。

### TSUI-02 — 三入口壳 + Today 可用纵切

依赖：TSUI-01。

工作：新 tokens/基础控件/顶部导航/路由；将真实 Today 接到完整 selector；同规格任务行；桌面右栏独立追加、手机任务/节点切换；接通真实查看、投递入口、准备、完成、决定和回执恢复；保留输入全局入口。

日程与岗位库导航不得指向空页：未完成新 composition 时暂接既有可用功能/最小共享流页面，并在批次记录为过渡，不当作最终验收。优先在 preview 验证完整纵切；不要用假数据页面占据生产入口。

出口：能从真实 production components 完成 Today 主路径；第 1 项与第 6 项同视觉级别；单任务不恢复 hero；130 个跨月节点实际滚到底；追加不影响左列/焦点；pending 不误报完成。完成第 1 轮真实截图→批评→修改，保存源 SHA/fixture/viewport。

### TSUI-03 — 岗位库和完整详情

依赖：TSUI-02。

工作：三/四字段清单、单组筛选、搜索、空结果和分批读取；完整页面详情；具体任务/节点的上下文入口；理由、来源、准备材料、名额限制、活动历史逐层展开；旧路由兼容与返回锚点。Discovery/Prep 等保留能力按去向表迁移，不新增主导航。

出口：公司/岗位/时间/操作一眼可扫；同公司不同 posting 不合并；长中英文不改变单行操作位置；从任意入口返回恢复原状态；已结束机会仍可找到但没有误导的投递按钮；无链接路径可用；详情中的关键约束不会被装饰性折叠隐藏到无法决策。

### TSUI-04 — 完整日程 + 简洁录入 / 设置

依赖：TSUI-03；共享流已经在 TSUI-01/02 使用，不到此时才重新设计数据。

工作：日程的全部/接下来/已发生和待确认上下文、今天定位、月份/日期定位、前向和历史追加；事件详情真实完成/改期/取消；全部视图按业务时间组织，审计另存。完成录入/设置的视觉收束，移除常显快捷键/工程解释；DecisionRequest 是任务和上下文处理，不是第四主导航。

出口：过去与未来都完整可达；未知日期有真实入口；同一改期/取消/Undo 在 Today、日程、岗位详情一致；读模型刷新失败仍保留当前内容；所有迁移能力找到对应入口。完成第 2 轮跨页面真实截图→批评→修改（包括笔记本、手机、混排与密集数据）。

### TSUI-05 — 消费级收敛、旧 UI 退役与真实运行认证

依赖：TSUI-04。

工作：第 3 轮实渲评审并修复；按 ACCEPTANCE 矩阵完成 failure/keyboard/large-text/真实辅助技术/跨浏览器检查；删除不再消费的旧组件与 CSS、清理过渡入口；独立集成 reviewer 核验 exact-head、真实产品截图、领域不变量、最小改动范围；完成 exact-main 和授权范围内的生产认证。

出口：三主入口和完整核心路径在真实部署版本可用；读写、安全、身份和恢复无退化；无挂载的旧 hero/双导航/兼容空页；生产截图与 exact deployed SHA 对应；诚实列出仍待真人理解或外部环境证据的项目。没有实际人测就不宣称“五秒理解已证明”。

仅工程证据通过时可记 ENGINEERING_COMPLETE；未跑生产则 PRODUCTION_PENDING，不得提前 COMPLETE。不得因截图“好看”跳过命令/账户安全，也不得因测试绿而停止视觉修正。

**关键路径：** 01 共享事实 → 02 可用 Today → 03 岗位上下文 → 04 完整时间线与全局操作 → 05 收敛。不并行造壳/读模型，不按文件数或测试数评价进度。本计划不承诺未经测量的工时；最大的未知量是历史事实质量和读投影性能，不是配色。

## 6. 验证、集成与执行纪律

- 每个 coherent batch 开始完整对账一次：remote main、TSUI STATUS、唯一 PR/head、相关 canonical docs、最新 CI。不要每个控件变动都重新拉全状态。
- 同一个 writer 连续保留上下文；已有 active writer 先确认关系，优先接续/安全交接。无关 PR 的存在不是做设计/写计划的阻塞理由，更不是自动关 PR 的授权。
- 小修改运行受影响 selector/命令/route tests；批次检查受影响 E2E；稳定候选再跑完整 CI/build/security/Browser。现有 CI 配置触发的必需 gate 保留，不为省测试改安全门槛。
- 复用 `e2e/cgr01AuthoritativeCommand.e2e.ts`、`e2e/cgr02TodayVerticalSlice.e2e.ts` 等行为证据。允许更新因设计改变失效的定位器和明确审批的新 visual baseline，不保留旧 DOM 只为通过快照。
- 原型预览和前几轮图片不是生产基线。新的 reviewed baseline 必须来自真实挂载组件、固定合成 fixture、相同字体/视口/时钟；每轮有“问题→修改→再渲染”记录。
- 只有 CI 尚未结束且无独立工作时记录 exact run 并结束，不循环 sleep/poll 假装开发。终态结果到来再继续，不启动本轮未授权的自动化。
- Merge 前重读 base/head，检查 scope 和 drift，绑定 expected head。普通实现、CI、冲突修复自行处理。Merge 后核验 exact main；PR 绿不等于 main 绿。
- 计划登记可以写入 docs-only PR；登记流程不得声称 UI 实施或认证完成。生产默认切换只能在实施授权与所需 gate 具备后进行。

## 7. 发布与回退

不修改 `.github/release-plan.json` 的发布授权，不创建新 tag/正式 Release，不擅自启用来源或扩大 OAuth。复用当前生产认证机制，选择一个稳定 integrated candidate 批量完成 UI 与既有命令 canary，不为每个设计/文档提交手动部署。

所有 exact runtime 身份必须重新从 `/api/health` 和 frontend release manifest 验证，不能把构建 commit、文档 commit、previous production receipt 当成同一个版本。真实用户工作区不作为破坏性测试夹具；使用现有授权的隔离合成账户与 cleanup，授权不足明确 PENDING。

优先通过临时、单一 presentation rollout 开关在 preview 验证；生产一次只挂载一个 shell/一条写路径，不能复制 workspace 或并行写入。开关不新增用户设置，最终移除过渡代码。

回退选择包含最新可靠性修复的、已验证的上一运行版本/展示配置，**不能为了回旧视觉部署到 hotfix 之前的老 SHA**。只回退前端呈现/匹配的兼容运行版本，不回滚数据库、不恢复旧 snapshot、不抹掉新回执。既有 read-only 安全开关须在新界面仍可生效。存在命令兼容风险时先进入只读恢复，而不是强制旧客户端写入。

## 8. 风险、非目标与停点

主要风险及处理：

1. **“全部”成为仅前四项换样式。** 先冻结 daily membership、节点总数和集合一致性测试；不能用可见条数代替全集。
2. **用审计噪音填充日程。** 以真实业务发生时间/引用映射投影；旧原始记录留详情。没有证据的历史不补造。
3. **新旧流程混写。** 所有交互经同一个权威客户端；禁止原型 demo 状态进入生产。
4. **隐藏信息隐藏掉风险。** 时间冲突、共享名额、错误身份、失去写权限、unknown/pending 必须就地可见；评分/命令 ID 等才移入详情。
5. **无限滚动漏页或失焦。** 完整源集合 + revision-bound cursor + 锚点恢复 + 显式继续加载；追加错误与到底不同。
6. **简化顺手丢掉现有可用功能。** 入口去向表逐项实际走通；只删 UI，不删除业务记录/命令能力。
7. **把 latest main 当成 certified production。** 分别记录 head、integrated main、live frontend/backend、receipt，禁止混用。

不做：重写 Supabase/Postgres、改评分体系、岗位自动搜索扩展、自动投递/招聘邮件、日历外部同步、付费模型、新权限、原生 App、通用项目管理看板、UI 无关历史数据修复。

真正停点只有新费用、权限/隐私/安全扩展、不可逆真实数据动作、外部招聘动作、根本产品方向冲突。普通技术问题不升级。真人理解和真实辅助技术没有可用环境时如实分级，不冒充 PASS，不反复等待消耗工作。

## 9. 每批收口应报告什么

先报告用户能完成的路径、真实截图、实际修复和剩余 UX 限制；后报告 exact head/main/CI/production。保留失败场景证据与回退验证。完成 TSUI-05 后停止本包，不自动进入其他产品线。

## 核验源索引

所有路径均相对于本仓库，可在登记 baseline commit 下查看：

- `docs/consumer-grade-refoundation-v1/{STATUS,TARGET_EXPERIENCE,TECHNICAL_ARCHITECTURE,VALIDATION,EXECUTION_PROTOCOL}.md`
- `docs/reliability-hotfix-v1/{README,STATUS}.md`；PR #152；base/main compare `51d3299...d0b0374`。
- `src/AppV8.tsx`、`src/today/TodayFeature.tsx`、`src/todayBrief.ts`、`src/decisionV3.ts`。
- `src/scheduleNodes.ts`、`src/TimelineView.tsx`、`src/OpportunityDecisionList.tsx`、`src/OpportunityDetailDrawer.tsx`。
- `src/TellPjsdasCapture.tsx`、`src/captureSession.ts`、`src/domainCommands.ts`、`src/cloud/authoritativeCommandClient.ts`、`src/cloud/authoritativeReadModelClient.ts`。
- `.github/workflows/ci.yml`、`.github/workflows/browser-e2e.yml`、`playwright.config.mts`、现有 CGR/Hotfix production canaries。

未核验的信息：本轮用户 live workspace 内容、当前所有来源的授权/处理进度、生产分页能力的实际性能、新版在生产中的人类理解/辅助技术结果。计划中的新模块和 gate 是待实施要求，不是现有能力陈述。
