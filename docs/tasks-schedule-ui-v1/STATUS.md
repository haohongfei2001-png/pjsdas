# TSUI Canonical Status

Package: `PJSDAS-TASKS-SCHEDULE-UI-v1`  
Version: `1.0`  
Status: **TSUI-01 ENGINEERING_REVIEW / PACKAGE_AUTHORIZED**
Plan: [README.md](README.md)  
Acceptance: [ACCEPTANCE.md](ACCEPTANCE.md)  
Design: [DESIGN_REFERENCE.md](DESIGN_REFERENCE.md)

## 授权与事实边界

- Owner request：按照最后认可的今天/岗位库/日程版，结合当前GitHub制定开发计划并写入GitHub；写入不可用则交付文档。
- 2026-09-25 owner 明确授权连续执行 TSUI-01～TSUI-05；TSUI-00 已完成。当前唯一运行代码 writer 为 TSUI-01；每批单 PR，完成验证及收口后进入下一批。
- 登记writer：`docs/tasks-schedule-ui-v1-plan-20260925`；是否进入main以承载本文件的PR/commit实际状态为准，不从PLAN_REGISTERED推断已merge。
- 运行代码 writer：`tsui/01-complete-read-model`（当前批次）。2026-09-25 核验 main `7f852fe585431672998133925013907c2c614456`，open PR 为空；TSUI-01 PR/head 以 GitHub 实际记录为准。
- Baseline main：`d0b0374ad6c965bb66591e7079a0e1299b04d9e0`。
- Baseline CI：`36102512172` SUCCESS；Browser：`36102512246` SUCCESS。
- 已有Hotfix文档记录的certified production：`058bc6de04a5b08685505870860239b24648717f`；本轮不是实时production工作区读验收。
- CGR及Reliability Hotfix已关闭；保留其不变量，不重新打开旧包或自动接续UU-08/UU-09。

## 批次

| 批次 | 状态 | 依赖 / 完成定义 |
|---|---|---|
| TSUI-00 | 文档计划已登记，集成以PR事实为准 | 设计、边界、完整计划和验收标准 |
| TSUI-01 | ENGINEERING_REVIEW | 完整任务/共享日程投影；targeted tests 与压力样本；待 GitHub PR/CI/exact-main 收口 |
| TSUI-02 | NOT_STARTED | 01完成；三入口壳与真实Today纵切 |
| TSUI-03 | NOT_STARTED | 02完成；岗位库/详情与返回路径 |
| TSUI-04 | NOT_STARTED | 03完成；完整日程、录入及设置 |
| TSUI-05 | NOT_STARTED | 04完成；视觉/工程/生产收敛及旧UI退役 |

## TSUI-01 当前工程证据与未决项

- 已建立不截断的 Web Today selector，保留 TodayBrief v1 的四项/30天兼容契约；覆盖预算内计划、最新开工保护、进行中、当天到期、明确安排当天和全部 open DecisionRequest。固定事件本体仍在节点。
- 已建立同账户/revision/时区/本地日期绑定的只读 ScheduleStream。未来节点没有 30 天上限；过去未确认没有六项上限；开放窗口跨日仍在 future；每 occurrence 只取最新版本；历史按 occurredAt 排列，原始引用留存。窗口游标跨账户/revision 不可复用。
- 本地针对性验证：`npx tsc -b --pretty false` PASS；`npx vitest run tests/tsui01ReadModel.test.ts tests/todayBrief.test.ts tests/scheduleNodes.test.ts` 24/24 PASS。完整 CI/浏览器验证留给 GitHub PR gate 和稳定切片。
- 固定合成压力样本 300 岗位/130 节点/500 行动/2000 历史，Node v26.8.2 / darwin arm64：旧 TodayBrief p95 19.48ms，完整 Today p95 8.57ms，共享 ScheduleStream 构建 p95 87.90ms，30 行索引追加 p95 0.01ms（10 个 warm samples）。这仅是该机器工程测量，不是跨浏览器或生产承诺；当前无证据需要服务端分页。
- 原型 HTML/设计 ZIP 未随当前任务或 GitHub 仓库出现；精确 checksum/视觉对照 **DEFERRED**，已请求重新附上。TSUI-01 的独立读模型工作继续；后续视觉认证不得冒充完成。
- GitHub PR exact head、CI、merge main、production、真人/设备证据仍待本批后续记录；以上本地结果不算这些 gate 的 PASS。

## 原计划登记时的待实施项（历史）

任务完整集合、超30天节点可达、共享时间线、三入口导航、同级任务行、简洁岗位库、完整详情、生产录入/回执恢复视觉、旧入口去向、三轮实装截图和最终认证均未开始。

设计原型及最终截图属于已认可附件，摘要见DESIGN_REFERENCE。附带下载交接包保留原始设计ZIP；本次GitHub只登记文档，不声称参考HTML/图片已入Git。TSUI-01须取得并校验它们再做精确视觉对照。

## 后续执行更新规则

获得实施授权后，在本文件记录授权范围、唯一writer/PR/head、当前batch、engineering/production/human证据frontier。每次收口记录exact head、merge main、适用CI/截图/canary、限制和下一步；不把计划、原型或旧包证据登记为新版PASS。普通问题自治处理；外部证据缺失单独标明；本包结束后停止。
