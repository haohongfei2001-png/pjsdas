# TSUI-02 真实组件视觉评审第 1 轮

状态：工程截图评审完成；PR merge / exact-main 另见 STATUS。参考资产保持原样，不把原型逻辑并入生产。

## 基准与可重复条件

- 认可参考：`reference/screenshots/Today-Desktop.png`、`Today-Mobile.png`、`Today-320-200-percent.png`、`Nodes-Mobile.png`；原始 HTML SHA-256 `6e0a8f6b92c92ed885f7fb30e4ba8beb7e8248afdb7c0b1e51bcbe73ccd55636`。
- 生产组件源码 SHA：初评 `0a0f25debe4fd758d47034a055dde7c1b13baf30`；修正后 `c469f14f73264900fae0d767b8a1b700bc283adf`。
- 合成且无隐私的浏览器 fixture：固定时钟 `2026-09-25T04:00:00.000Z`，8 项独立任务、130 个跨月 date-only 面试节点，节点时区 `Asia/Shanghai`。Chromium GitHub Actions headless；视口 1440×900、390×844、320×640；最后一个视口将根字体设为 200%。该 fixture 不代表用户真实工作区。
- 修正后截图及 Playwright 报告：[Browser E2E 36118999130](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36118999130) 的 [playwright-report artifact](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36118999130/artifacts/10855754772)，包含 `test-results/tsui02/today-desktop.png`、`today-mobile.png`、`today-mobile-nodes.png`、`today-320-large-text.png`。同一运行日志有供评审读取的合成 JPEG。CI [36118999104](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36118999104) SUCCESS；浏览器 72 passed。

## 截图批评与实改

| 观察 | 修改与复核 |
|---|---|
| 桌面内容左右比参考各多内缩约 50px，面板宽只有 1220px | 找到旧 `.main-panel > section` 的内容上限并只对新 Today/日程 composition 解除。复渲 1440px：左边 60px，右边 1380px，双栏 753.78/546.20px，比例 1.38。浏览器断言锁定边界和比例。 |
| 手机局部任务切换后仍重复显示“今日任务”面板标题 | 手机隐藏面板标题；局部切换成为唯一标题，节点入口仍在全局“日程”。复渲 390px 无重复标题。 |
| 320px/200% 时日期跑到“今天”上方，日期格式带英文式斜线 | 标题先于日期堆叠，并由本地日期部分明确组合 `9月25日 · 周五`。复渲大字无遮挡且无横向溢出。 |
| “查看”用于无岗位独立任务时实际只是开始，且次要完成操作和主操作同样显眼 | 明确改为“开始”；完成保留权威命令和可访问名称，在普通字号下用 44px 次要图标，大字下显示文字。复渲任务行同规格，第 1 项与第 6 项没有 hero。 |

Today 从完整 Web selector 读取；右栏与 `/schedule` 使用同一个 ScheduleStream，浏览器逐批加载并确认 130/130 节点。全局 Tell 仍接既有语义预览、权威命令、receipt 和 Undo；截图不把操作模拟当作保存证据。

## 边界

本轮截图以 8 项独立任务验证列表层级和响应式，未声称已覆盖认可图的六个有岗位任务之长中英文混排。TSUI-03/04 将用真实岗位库、详情、日程 composition 继续做跨页密集数据评审；TSUI-05 完成 320px/200%、失败态、跨浏览器与真实辅助技术的最终矩阵。缺少真人、设备和私有生产工作区证据分别 DEFERRED。
