# TSUI Canonical Status

Package: `PJSDAS-TASKS-SCHEDULE-UI-v1`  
Status: **TSUI-02 ENGINEERING_REVIEW / PACKAGE_AUTHORIZED**  
Plan: [README.md](README.md) · Acceptance: [ACCEPTANCE.md](ACCEPTANCE.md) · Design: [DESIGN_REFERENCE.md](DESIGN_REFERENCE.md)

## 授权与边界

2026-09-25 owner 授权连续执行 TSUI-01～TSUI-05。每批一个 writer / 一个当前 PR；普通工程收口后自行进入下一批。CGR 与 Reliability Hotfix 的业务、安全、事务、identity、MCP、receipt、Undo、account-isolation 不变量保持；不重开 UU-08/09。TSUI-05 后停止本包。

## 批次与已核验事实

| 批次 | 状态 | 证据 / 范围 |
|---|---|---|
| TSUI-00 | COMPLETE | 计划、设计边界、验收矩阵登记 |
| TSUI-01 | MERGED / EXACT_MAIN VERIFIED | PR [#154](https://github.com/haohongfei2001-png/pjsdas/pull/154)，head `84fe5597023016bb96dd0d21a7f70dae3f43bf5c`，main `04bf521023e06432be54032cc1135490e3f1a80f` |
| TSUI-02 | ENGINEERING_REVIEW | PR [#155](https://github.com/haohongfei2001-png/pjsdas/pull/155)；writer `tsui/02-three-entry-today`；immutable design reference first commit `28bfcab28141bd91a79f534bef0bc64f645e71a6`；实现 head `c469f14f73264900fae0d767b8a1b700bc283adf`，待文档收口 head gate / merge / exact-main |
| TSUI-03 | NOT_STARTED | 岗位库与完整详情 |
| TSUI-04 | NOT_STARTED | 完整日程、录入、设置 |
| TSUI-05 | NOT_STARTED | 消费级收敛与真实运行认证 |

TSUI-01 PR head 的 CI `36108428471`、Browser E2E `36108428457` 为 SUCCESS。merge main 的 CI `36108943632`、Browser E2E `36108943614`、Pages `36108943500` 为 SUCCESS；自动触发的 CGR/Hotfix/production self-test/release workflows 亦成功。这些是 GitHub Actions 工程证据，不冒充真人、设备或生产私有工作区验证。TSUI-01 压力样本结论：沿用权威快照加只读索引，暂无证据要求新服务端分页。

## 设计资产

用户上传的交接包内认可设计 ZIP SHA-256 `904cf1b0b48e5b6b14adec518e3a7991014ac81ba8d80b06451a922ae6be4901`、Prototype HTML SHA-256 `6e0a8f6b92c92ed885f7fb30e4ba8beb7e8248afdb7c0b1e51bcbe73ccd55636`，与 [DESIGN_REFERENCE.md](DESIGN_REFERENCE.md) 登记值一致。原样 21 个文件已在 TSUI-02 首 commit 纳入 [reference/](reference/)：Prototype HTML、DESIGN.md、VISUAL_REVIEW.md、MANIFEST.json、17 张最终 screenshots；未提交重复 ZIP。Git blob SHA 与原始字节逐一核对。reference 只作视觉和交互基准，原型模拟逻辑不得进入生产。

## TSUI-02 验证 frontier

实现 head `c469f14f73264900fae0d767b8a1b700bc283adf` 的 CI [36118999104](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36118999104) SUCCESS、Chromium Browser E2E [36118999130](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36118999130) SUCCESS（72 passed）。真实组件截图、失败批评、修改和复渲见 [TSUI02_VISUAL_REVIEW.md](TSUI02_VISUAL_REVIEW.md)。1440px 几何实测：任务面板左边 60px、节点面板右边 1380px、任务/节点宽度 753.78/546.20px；130 个已有未来节点全部可达。岗位库详情仍为旧抽屉，日程为共享流过渡页，分别留给 TSUI-03/04；这不是本包最终验收。PR 文档收口 head gate、merge 和 exact-main 尚待本批完成。真人理解、真实辅助技术、真实设备和私有生产工作区证据 DEFERRED，不伪造 PASS。
