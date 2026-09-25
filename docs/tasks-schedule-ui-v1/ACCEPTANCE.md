# TSUI 验收矩阵

本文件与 [开发计划](README.md)、[认可设计](DESIGN_REFERENCE.md) 一起使用。以下均是待实施的退出条件；现有原型、旧 CGR 的测试或本轮文档 PR 均不能代替新版生产证据。

## A. 产品与真实用户路径

| ID | 场景 / 操作 | 必须看见的结果 | 证据 |
|---|---|---|---|
| A01 | 打开 Web，遍历主导航 | 恰为今天/岗位库/日程；设置低频；Tell 是全局动作；无常显快捷键 | 每个主路由截图 + keyboard journey |
| A02 | 正常六项任务；只有一项任务 | 所有行同规格，首项无 hero、无单独字号升级；单项不拉成大卡 | 1440×900、1280×800 对照图 |
| A03 | 已知 daily 集合超过四项、含预算外硬截止/正在进行项 | 集合完整、计数准确，第五项以后真实可达；无未来全 backlog 混入 | selector oracle + production-path browser |
| A04 | 一岗位有多个行动、无关联岗位的手动任务 | 不按公司合并行动；具体动作可区分；无岗位项显示真实任务名 | dense/long fixtures |
| A05 | 点击公司岗位、打开操作、返回 | 详情完整身份和上下文；搜索/筛选/滚动/焦点不丢 | Today→detail→return；library→detail→return |
| A06 | 右栏 130 项、跨月且有 >30 天节点 | 可连续到底，ID 无重无漏；左列不移动；真实末尾才显示全部 | 逐批收集 IDs 与 canonical 全集比较 |
| A07 | 追加失败后重试；刷新期间改期 | 保留已有行/焦点；错误不当末尾；新 revision 不混旧游标 | fault injection + anchor assertion |
| A08 | 开放窗口昨天开始、明天结束；日期未知 | 仍在未来/进行中；时间待定可达；无伪造 23:59/时长 | shared projection temporal fixtures |
| A09 | 过去未确认 >6 项、决定 >4 项 | 总数准确且全部可处理；不自动完成；无隐形硬上限 | count/identity oracle + browser |
| A10 | 日程全部 / 接下来 / 已发生、月份定位、回今天 | 历史和未来都可达；首开定位今天附近；加载历史锚点不跳 | schedule screenshots + prepend journey |
| A11 | 同 snapshot/revision 的 Today 右栏与日程接下来 | 同 IDs、版本、顺序和状态；过滤只是视图 | cross-surface contract comparison |
| A12 | 命令、回执、Timeline 同时描述一次投递 | 主日程不重复三条；真实来源和完整原始记录仍可查 | provenance linkage tests |
| A13 | 迟到补录、未知完成日期、估算面试结束时间 | 发生与记录时间区分；未知不伪造；估算不当确定安排 | chronology/provenance fixtures |
| A14 | 岗位库全部/未投递/推进中/已结束及无匹配 | 单组筛选；字段最小化；已结束不误导投递；历史可找 | route/filter/detail journey |
| A15 | 同公司同名职位不同 exact posting URL | 保持独立 Opportunity；tracking variant 保持既有去重 | Hotfix identity regression + UI |
| A16 | 查看名额受限岗位/不可执行对象 | 关键限制在当前操作附近，不以简洁为由藏掉 | constrained-action journey |

## B. 权威写入与安全恢复

| ID | 场景 | 必须成立 |
|---|---|---|
| B01 | 打开申请入口 | 不产生“已投递”业务命令；无链接不能伪装可投递 |
| B02 | 明确记录已投递 | exact opportunityId + record_application_submission；收到真实回执再更新列表/日程 |
| B03 | 完成准备 | 只完成对应 Action；面试节点和招聘流程仍在 |
| B04 | 完成笔试/面试 | complete_occurrence；不自动结束整个招聘流程 |
| B05 | 改期、取消、撤销 | 三个 surface 同步；新版本唯一有效、旧时间留历史；补偿不丢无关更改 |
| B06 | 同公司两岗位的模糊输入 | 不提前指定岗位；一个真实 DecisionRequest；选择后才更新正确目标 |
| B07 | pending save，关闭弹窗或切换页面 | 状态和稳定 commandId 持续存在；相关控件防重复；其他阅读不被阻断 |
| B08 | 服务端提交成功但响应丢失 | unknown 而不是错误重试新请求；先查原回执；最终只有一次业务效果 |
| B09 | 同对象冲突 | 显示已保存值/拟改值和后果；输入保留；不静默 last-write-wins |
| B10 | 无关对象并发更新 | 两个合法结果保留；不因全局 revision 改变制造不必要决定 |
| B11 | 离线、refresh failure、初次加载、无缓存读取失败 | 缓存不消失；不闪假空状态；草稿不冒充服务器保存；错误有恢复入口 |
| B12 | session jitter、过期、A退出后B登录 | 草稿与pending不丢/串号；旧账户索引/游标/行不泄漏；重试先核对原操作 |
| B13 | NO_WRITE、ALREADY_APPLIED、CONFLICT | 分别显示实际结果；无泛化“全部保存成功” |
| B14 | 授权不足、现有只读开关 | 无写入；呈现能力边界；不为UI演示增加grant或停用保护 |
| B15 | 原型退出生产 bundle | 无 SEED/NOW/演示场景选择器/timeout假保存/内存Undo；实际语义管线执行 |
| B16 | 日程重建/改名/旧路由 | 不新增独立日历 authority；不改 Opportunity IDs、不复制/清空用户历史 |

复用现有 authoritative-command、account-isolation、capture-session、source-identity、no-grant、安全和 Undo 回归。修改定位器不等于降低业务断言；安全 gate 不因纯视觉范围而被删掉。

## C. 视觉、可达性与压力样本

### 固定视口与内容

- Desktop：1920×1080、1440×900；Laptop：1280×800；过渡：1024×768、768×1024。
- 手机：390×844、320×640；在正常和实际 200% text 下分别运行。大字通过读取 computed font-size 证明约为正常两倍，不依赖一个CSS类名；另外验证浏览器缩放触发的布局转换。
- 标准合成工作区以认可截图的六任务与不同类型节点作构图参考；压力集至少 300 岗位、130 节点、500 行动、2,000 历史记录，包含同日同时间、跨月/年、闰日/时区边界、同公司多个posting和迟到补录。
- 这些数量是本包可复现的工程样本，不是声称已读取用户真实规模。实施起点可用不含隐私的实际规模统计补充更大样本，不得缩小上述冻结样本来通过。
- 长内容：中文公司名/角色名、英文长单词、完整中英文混排、相同公司多角色、没有公司关联的任务。正常允许两行摘要但全文一击可达；大字解除截断。不用小灰字替代重排。

### 必须真正检查的内容

| 范围 | 要求 |
|---|---|
| 第一眼层级 | 两个 Today 面板首部对齐；首任务与其他任务同字号/动作级别；无恢复的推荐宣言、预算、常态耗时和多余解释 |
| 密度 | 标准桌面六行共同可扫，内容决定高度，常规约88–100px；不固定高度裁内容；单项和空态不靠无功能空白撑满 |
| 正文字阶 | 认可基准：26/17/16/14/13px 对应页/节/公司/岗位按钮/时间辅助，rem实现，200%不缩字 |
| 表面/颜色 | 冷白背景、白内容面、少量蓝色交互；每列一容器、细线分行；warning/error/success仍有文字，不仅靠颜色 |
| 手机 | Today局部任务/节点切换；全局三入口不变；切换保留各自位置；大字/软键盘无底部操作遮挡 |
| 键盘 | skip link不改业务路由；导航、行操作、节点滚动、加载更多可达；Tab/Shift+Tab/ESC和dialog焦点恢复正确 |
| 语义 | 单main、合理heading/list/button/link；当前nav、tabpanel、状态和表单标签可感知；批次追加礼貌播报不读整份列表 |
| 弹层 | 最多一层modal；不在详情再叠多层抽屉；失去原opener时焦点回到安全邻近目标 |
| 动效 | 尊重reduced-motion；不靠动效/骨架制造不实完成；长滚动不反复重挂载 |
| 辅助技术 | 实际VoiceOver/Safari或NVDA/Chromium完成任务与节点检查；可访问性树/axe不冒充真人读屏走查 |
| 跨浏览器 | Chromium/Firefox/WebKit核心路径、滚动锚点和关键responsive状态；真实手机软键盘另记设备证据 |

### 性能退出目标（工程预算，不是当前测量结果）

在固定 Chromium/Node 版本、同一 runner/硬件和上述压力集上记录原始测量；本包新增 warm route/tab transition 的 P95 目标 ≤150ms、单次窗口追加 P95 ≤100ms。warm 指账户快照已取得，不含首次网络下载；冷启动另列网络/解析/索引/首屏阶段，不把它从端到端体验报告中藏掉。对当前 main 同 fixture 对照，预算外回退先修再评审。

不在 render/scroll 回调反复全快照升级/排序。批次 DOM 追加不替换已聚焦行。列表非常大需窗口化时保留键盘焦点/日期定位/读屏可达和显式更多入口；禁止虚拟化造成只能鼠标浏览。

## D. 三轮真实视觉闭环

1. TSUI-02：真实壳 + Today +节点，在 desktop/laptop/mobile 截图，检查任务密度、两栏比例和行动可辨识；记录修改并重新 render。
2. TSUI-03/04：岗位库/详情/日程/录入/设置，包括长混排、密集节点和跨页返回；记录修改并重新 render。
3. TSUI-05：200%文字、320手机、单项/空态/决定/pending/offline/unknown/conflict/refresh失败，苛刻评审并修正；输出修正后最终截图。

每轮至少包含 source SHA、fixture 摘要、时间/时区、浏览器/字体/viewport、截图、具体问题和实际修改。所有轮次必须来自实际生产组件渲染，不能复用独立原型截图作为新版实装证据。若仍像旧首项hero/工程dashboard，继续修，不以三轮次数作为停工理由。

## E. 五秒理解与最终分级

找未参与实现的目标用户，展示标准 Today 五秒后询问：今天有哪些要做的事、最近固定节点在哪里、如何打开申请、在哪里查看详情、如何告诉系统变化。不提前解释导航含义。不记录敏感求职信息。

真人理解验证是产品证据，不是自动测试可以保证的属性。未做时标记 HUMAN_VALIDATION_PENDING，不写“已证明五秒理解”。真实读屏/设备不可用时分别标记，不影响继续修复其他可做问题，但不能整体报PASS。

最终区分：

- DESIGN_REGISTERED：本轮文档和参考已登记；无产品实施证据。
- ENGINEERING_COMPLETE：真实组件、共享数据、核心读写和自动化/视觉工程检查通过。
- PRODUCTION_VERIFIED：同一 exact deployed frontend/backend 完成所需授权canary，截图确为该运行版本。
- PRODUCT_ACCEPTED：包括适用的真人理解/真实辅助技术证据；已知限制具体列明。

缺失证据逐项保留；仅用户明确接受其风险时才改变退出合同，并保留未验证标签，不改写历史为PASS。

## F. 最小最终交付

生产Today桌面/笔记本/手机、岗位库、日程、详情和录入截图；任务全集/节点全集与跨页一致性证据；关键保存/恢复/账户/身份走查；旧UI入口去向与删除清单；剩余UX限制；exact PR/head/main/CI/live SHA；前端回退验证。测试数量与代码行数不是主要完成证明。
