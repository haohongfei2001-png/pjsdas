# TSUI Canonical Status

Package: `PJSDAS-TASKS-SCHEDULE-UI-v1`  
Status: **TSUI-04 CLOSED; TSUI-05 ACTIVE / PACKAGE_AUTHORIZED**  
Plan: [README.md](README.md) · Acceptance: [ACCEPTANCE.md](ACCEPTANCE.md) · Design: [DESIGN_REFERENCE.md](DESIGN_REFERENCE.md)

## 授权与边界

2026-09-25 owner 授权连续执行 TSUI-01～TSUI-05。每批一个 writer / 一个当前 PR；普通工程收口后自行进入下一批。CGR 与 Reliability Hotfix 的业务、安全、事务、identity、MCP、receipt、Undo、account-isolation 不变量保持；不重开 UU-08/09。TSUI-05 后停止本包。

## 批次与已核验事实

| 批次 | 状态 | 证据 / 范围 |
|---|---|---|
| TSUI-00 | COMPLETE | 计划、设计边界、验收矩阵登记 |
| TSUI-01 | MERGED / EXACT_MAIN VERIFIED | PR [#154](https://github.com/haohongfei2001-png/pjsdas/pull/154)，head `84fe5597023016bb96dd0d21a7f70dae3f43bf5c`，main `04bf521023e06432be54032cc1135490e3f1a80f` |
| TSUI-02 | MERGED / EXACT_MAIN VERIFIED | PR [#155](https://github.com/haohongfei2001-png/pjsdas/pull/155) merged；closure PR [#157](https://github.com/haohongfei2001-png/pjsdas/pull/157) merged；exact main `ec73f433ba6c842d68deba340381b8fb1b547b67` |
| TSUI-03 | MERGED / EXACT_MAIN VERIFIED | PR [#158](https://github.com/haohongfei2001-png/pjsdas/pull/158)，head `a9125a030cacbe06d89e2c23ff0373c5569dd87f`，main `56aeec3e75628a81de4ad883a56b272817643236`；岗位库、完整详情及入口迁移已收口 |
| TSUI-04 | MERGED / EXACT_MAIN VERIFIED | PR [#160](https://github.com/haohongfei2001-png/pjsdas/pull/160)，head `fcd0b45b9be44f3caea2a33aacc3ceea788299bb`，merge main `0e01458d23d59b4e483e4e9bf7787ed85fe15009`；完整日程、事件详情、录入与设置已完成工程收口 |
| TSUI-05 | ACTIVE | 唯一 writer `tsui/05-consumer-certification`；第三轮真实界面评审、跨浏览器、旧 UI 退役和最终认证 |

TSUI-01 PR head 的 CI `36108428471`、Browser E2E `36108428457` 为 SUCCESS。merge main 的 CI `36108943632`、Browser E2E `36108943614`、Pages `36108943500` 为 SUCCESS；自动触发的 CGR/Hotfix/production self-test/release workflows 亦成功。这些是 GitHub Actions 工程证据，不冒充真人、设备或生产私有工作区验证。TSUI-01 压力样本结论：沿用权威快照加只读索引，暂无证据要求新服务端分页。

## 设计资产

用户上传的交接包内认可设计 ZIP SHA-256 `904cf1b0b48e5b6b14adec518e3a7991014ac81ba8d80b06451a922ae6be4901`、Prototype HTML SHA-256 `6e0a8f6b92c92ed885f7fb30e4ba8beb7e8248afdb7c0b1e51bcbe73ccd55636`，与 [DESIGN_REFERENCE.md](DESIGN_REFERENCE.md) 登记值一致。原样 21 个文件已在 TSUI-02 首 commit 纳入 [reference/](reference/)：Prototype HTML、DESIGN.md、VISUAL_REVIEW.md、MANIFEST.json、17 张最终 screenshots；未提交重复 ZIP。Git blob SHA 与原始字节逐一核对。reference 只作视觉和交互基准，原型模拟逻辑不得进入生产。

## TSUI-02 验证 frontier

实现 head `c469f14f73264900fae0d767b8a1b700bc283adf` 的 CI [36118999104](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36118999104) SUCCESS、Chromium Browser E2E [36118999130](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36118999130) SUCCESS（72 passed）。真实组件截图、失败批评、修改和复渲见 [TSUI02_VISUAL_REVIEW.md](TSUI02_VISUAL_REVIEW.md)。1440px 几何实测：任务面板左边 60px、节点面板右边 1380px、任务/节点宽度 753.78/546.20px；130 个已有未来节点全部可达。岗位库详情仍为旧抽屉，日程为共享流过渡页，分别留给 TSUI-03/04；这不是本包最终验收。PR #155 exact-head CI [36119521273](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36119521273) 与 Browser E2E [36119521457](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36119521457) SUCCESS 后合并。main `d19d850ec262e31949b6de09c9a3da0703eda541` 的 CI [36119835307](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36119835307)、Pages [36119835363](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36119835363)、自动生产自检及认证 SUCCESS；只读回退 [36119835321](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36119835321) 因退役 DOM 断言失败，随后由 closure 修正。只读回退 closure PR #157 修正退役 DOM 的断言，保留零业务命令、禁用输入与直达路由保护。closure head `f2b7c09b7a874d826bf85e59a1245aa9f64f08d2` 的 CI/Browser/rollback 成功；exact main `ec73f433ba6c842d68deba340381b8fb1b547b67` 的 CI [36120794799](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36120794799)、Browser [36120794750](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36120794750)、只读回退 [36120794748](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36120794748)、Pages [36120794687](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36120794687) 及自动生产自检/认证/发布工作流成功。真人理解、真实辅助技术、真实设备和私有生产工作区证据 DEFERRED，不伪造 PASS。


## TSUI-03 工程与视觉收口

PR #158 从 TSUI-02 exact main `ec73f433ba6c842d68deba340381b8fb1b547b67` 创建；diff 仅 22 个 TSUI-03 实现、回归与状态文件，未修改 immutable reference。真实岗位库读取同一权威 OpportunityDecision 模型，默认全部、单组状态筛选、搜索与每批 40 项追加；`/library/:opportunityId` 是完整页面，旧 `/opportunities/:id` 深链保留。302 岗位夹具证明同公司同名不同 posting 仍按 exact ID 分立。打开 HTTP(S) 申请地址不写入；“我已投递”继续走原有权威命令，已结束或无链接路径如实呈现。

Exact-head `a9125a030cacbe06d89e2c23ff0373c5569dd87f` 的 CI [36127123203](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127123203)、Browser E2E [36127123251](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127123251)（74 passed）、只读回退 [36127123238](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127123238) SUCCESS。桌面/手机真实组件截图、具体批评与三次修正见 [TSUI03_VISUAL_REVIEW.md](TSUI03_VISUAL_REVIEW.md)。

PR merge main `56aeec3e75628a81de4ad883a56b272817643236` 的 CI [36127620828](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127620828)、Browser E2E [36127620835](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127620835)、只读回退 [36127620925](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127620925)、Pages [36127621017](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127621017)、自动生产自检 [36127773116](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127773116)、CGR/Hotfix 生产认证和 verified release 工作流均 SUCCESS。这些是 Actions 工程及部署门槛；真人理解、真实辅助技术、真实设备和私有生产工作区验证仍 DEFERRED，不伪造 PASS。

## TSUI-04 工程与视觉收口

PR #160 从 TSUI-03 closure exact main `a7dcdb355f331f4489b75059cb1b559def80fc55` 创建，reference 目录 0 变更。日程现有全部/接下来/已发生、待确认/时间待定、今天/月定位、历史与未来追加；事件详情的完成、改期、取消及 Undo 使用既有 exact-occurrence 权威命令、receipt recovery 和原时间精度。录入和设置只收束呈现，账户、事务和来源状态机不变。夹具覆盖 80 条真实发生时间的历史、130 条未来节点、待确认和未知时间事实，以及连接态 exact ID 操作。

Exact-head `fcd0b45b9be44f3caea2a33aacc3ceea788299bb` 的 CI [36133041104](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133041104)、Browser E2E [36133041027](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133041027)、只读回退 [36133040988](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133040988) SUCCESS。浏览器为 75 passed + 1 flaky：既有 CGR-05 同步保护用例首次未找到退出保护文案，自动重试通过；未弱化其业务断言。此前 head `00edf3052c1b75e3b3a31c19cb8875a4b0383cd5` 的完整浏览器回归 76 passed。真实截图、具体批评和修正见 [TSUI04_VISUAL_REVIEW.md](TSUI04_VISUAL_REVIEW.md)。

Merge exact main `0e01458d23d59b4e483e4e9bf7787ed85fe15009` 的 CI [36133481700](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133481700)、Browser E2E [36133481728](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133481728)（76 passed）、只读回退 [36133481659](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133481659)、Pages [36133481677](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133481677)、生产自检 [36133640945](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133640945)、CGR/Hotfix 生产认证及 verified release 均 SUCCESS。合并 main 的 CGR-02 VoiceOver [36133481713](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36133481713) 因旧录入/岗位/设置 selector 失败。closure PR [#162](https://github.com/haohongfei2001-png/pjsdas/pull/162) 保留真实 VoiceOver 遍历与权威保存断言，迁移旧 selector、切页后重新定位读屏游标，并让相关 PR 运行该工作流。macOS 26 runner 两次在 Guidepup 的“勿扰模式”环境准备步骤失败；仅将 VoiceOver job 固定至 macOS 15 后，closure head `7f8140aa907786841153bab33790bf292e031079` 的 VoiceOver [36136077591](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36136077591) 2 passed、CI [36136077607](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36136077607)、Browser E2E [36136077821](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36136077821) 76 passed，均 SUCCESS。自动读屏是 macOS CI 的真实 VoiceOver 工程证据，不等于独立真人体验评估。自动部署与自检不等于用户私有生产工作区 canary；真人五秒理解、真实设备软键盘和私有工作区验证仍 DEFERRED。

## TSUI-04 closure exact-main handoff

Closure PR [#162](https://github.com/haohongfei2001-png/pjsdas/pull/162) merged to exact main `4ca549b91927a985adcf9e7678bafd42efbc2a48`. This main's CI [36137028482](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36137028482), Browser E2E [36137028493](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36137028493), and macOS 15 real VoiceOver [36137028532](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36137028532) are SUCCESS (76 browser tests, 2 VoiceOver tests). Pages [36137028565](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36137028565) was still waiting for exact matching production backend at TSUI-05 branch point; TSUI-04 implementation main `0e01458d23d59b4e483e4e9bf7787ed85fe15009` previously passed Pages and production certification. Do not report closure SHA as deployed until that gate completes. Human comprehension, real device keyboard, and private production workspace canary remain DEFERRED.
