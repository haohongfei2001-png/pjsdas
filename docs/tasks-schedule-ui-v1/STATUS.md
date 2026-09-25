# TSUI Canonical Status

Package: `PJSDAS-TASKS-SCHEDULE-UI-v1`  
Version: `1.0`  
Status: **PLAN_REGISTERED / IMPLEMENTATION_NOT_AUTHORIZED**  
Plan: [README.md](README.md)  
Acceptance: [ACCEPTANCE.md](ACCEPTANCE.md)  
Design: [DESIGN_REFERENCE.md](DESIGN_REFERENCE.md)

## 授权与事实边界

- Owner request：按照最后认可的今天/岗位库/日程版，结合当前GitHub制定开发计划并写入GitHub；写入不可用则交付文档。
- 本轮仅文档登记。TSUI-01..05不自动开始；没有生产代码、schema、权限、真实数据、部署命令、Release或自动化授权。
- 登记writer：`docs/tasks-schedule-ui-v1-plan-20260925`；是否进入main以承载本文件的PR/commit实际状态为准，不从PLAN_REGISTERED推断已merge。
- 运行代码writer：本轮未创建；登记起点open PR查询为空。
- Baseline main：`d0b0374ad6c965bb66591e7079a0e1299b04d9e0`。
- Baseline CI：`36102512172` SUCCESS；Browser：`36102512246` SUCCESS。
- 已有Hotfix文档记录的certified production：`058bc6de04a5b08685505870860239b24648717f`；本轮不是实时production工作区读验收。
- CGR及Reliability Hotfix已关闭；保留其不变量，不重新打开旧包或自动接续UU-08/UU-09。

## 批次

| 批次 | 状态 | 依赖 / 完成定义 |
|---|---|---|
| TSUI-00 | 文档计划已登记，集成以PR事实为准 | 设计、边界、完整计划和验收标准 |
| TSUI-01 | READY — NOT_AUTHORIZED / NOT_STARTED | 明确实施授权；完整任务/共享日程投影 |
| TSUI-02 | NOT_STARTED | 01完成；三入口壳与真实Today纵切 |
| TSUI-03 | NOT_STARTED | 02完成；岗位库/详情与返回路径 |
| TSUI-04 | NOT_STARTED | 03完成；完整日程、录入及设置 |
| TSUI-05 | NOT_STARTED | 04完成；视觉/工程/生产收敛及旧UI退役 |

## 当前待实施项

任务完整集合、超30天节点可达、共享时间线、三入口导航、同级任务行、简洁岗位库、完整详情、生产录入/回执恢复视觉、旧入口去向、三轮实装截图和最终认证均未开始。

设计原型及最终截图属于已认可附件，摘要见DESIGN_REFERENCE。附带下载交接包保留原始设计ZIP；本次GitHub只登记文档，不声称参考HTML/图片已入Git。TSUI-01须取得并校验它们再做精确视觉对照。

## 后续执行更新规则

获得实施授权后，在本文件记录授权范围、唯一writer/PR/head、当前batch、engineering/production/human证据frontier。每次收口记录exact head、merge main、适用CI/截图/canary、限制和下一步；不把计划、原型或旧包证据登记为新版PASS。普通问题自治处理；外部证据缺失单独标明；本包结束后停止。
