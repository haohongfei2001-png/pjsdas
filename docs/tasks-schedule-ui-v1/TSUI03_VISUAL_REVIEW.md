# TSUI-03 实渲视觉与交互评审

范围：生产组件岗位库和岗位详情，固定合成数据；认可参考为 [reference/](reference/) 的原样文件。这里的截图来自 GitHub Actions 内 Chromium 真正挂载组件，原型 HTML 只作基准，不参与生产逻辑。

## 初始实渲与问题

- 实现 head `97a1dc4cd7138fe85af4ec1596208513f5866327`，Browser E2E [36123837830](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36123837830)。夹具：300 个不同岗位 + 同公司同名不同 ID / 申请 URL 的 2 个岗位，固定创建时间 2026-09-20；视口 1440×900，Chromium，runner 时区以 Actions 环境为准。作证的是真实 `JobLibrary` 渲染而非设计原型。
- 首张岗位库图中，总数 302、单组状态筛选、搜索、白色容器与细分隔线符合参考结构；但公司名被推到容器中段，标记和名称之间留出过大空隙，破坏了认可设计的扫读顺序。
- 根因：过渡期间保留的旧 `.opportunity-decision-row` 类在旧全局 CSS 中重新指定了四列网格。修正是限定在岗位库的更具体网格规则，TSUI-05 再清理退役选择器和样式。修正后必须重新截取相同夹具图，不以静态 CSS 检查冒充复渲。

## 第二次实渲与修正

- 交互修正 head `1d194eb24cf2b8970de33edc799cf1de70e8e97c`，Browser E2E [36124909495](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36124909495)，真实 1440×900 详情与 390×844 岗位库/详情截图均已产生；302 岗位逐批读完、同名不同 posting 两条独立、打开申请地址不写投递事实、返回保留搜索/焦点的浏览器断言通过。此 head 的整个浏览器套件尚有 3 项待修，不把截图视为整批 PASS。
- 详情存在旧抽屉遗留的整块白色背景和阴影，文字过小，首屏缺少设计参考的公司标记与相关记录卡。已实施独立页面透明背景、可读字号、公司标记和相关记录/日程入口的修正；需要在下一 head 复渲确认。
- 手机岗位库可操作、无横向溢出，但两条同名岗位在一张白色容器中显得空疏；网格规则修复后复查对齐和触控目标。

## 第三次实渲与当前修正

- head `03e4dc88b86f65367dc67948cd66d846677b77b3` 的 Browser E2E [36126218325](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36126218325) 有 73 passed / 1 fixture failure。桌面复渲测得标记到公司身份文字的间距在 8–22px 断言内；之前的巨大空隙消失。详情整块旧抽屉背景和阴影已消失，相关记录卡出现；320px/200% 溢出断言通过。截图见该 run 的 playwright-report artifact。
- 这次截图还发现桌面详情头部继承旧 `justify-content:space-between`，使标记与公司名相距过远。改为靠左排列。随后为视觉夹具补上真实待投递 Action，使“我已投递”按钮在截图出现；打开申请地址仍需维持 Opportunity 阶段和 Action 状态不变。
- 唯一失败由夹具手工创建的 application deadline 使用了与既有投影不同的 occurrenceId：升级流程把它映射到 Opportunity deadline 后又派生 canonical legacy 节点，因此测试看见两个相同显示名。夹具改为只存 Opportunity date-only deadline，由既有投影生成唯一节点；不修改生产的 occurrence 去重规则。下一 head 必须验证该路径只出现一条。

## Ready 候选

- 候选代码 head `ae5cf9b1b586a70180257bb24b89b95dfc9c87b1` 修复桌面详情头部对齐，补齐待投递 Action 的实渲夹具，并只用 canonical deadline 派生单一节点。该 head 创建时 PR 仍为 draft，因此 Browser E2E 按现有 workflow 条件 skipped；这是未执行，不是 PASS。现已将 PR 转为 ready，下一次同步提交触发完整浏览器闭环。

## 最终复渲与收口

- exact-head `a9125a030cacbe06d89e2c23ff0373c5569dd87f` 的 Browser E2E [36127123251](https://github.com/haohongfei2001-png/pjsdas/actions/runs/36127123251) 74 passed；同一 run 生成真实组件的岗位库桌面/手机与详情桌面/手机四张最终截图。夹具仍为 302 岗位，其中两个同公司同名不同 posting ID 与申请 URL；Chromium、runner UTC、根字号 15px、桌面 1440×900、手机 390×844，并检查 320px 与 200% 字。
- 桌面岗位库标记到公司身份的实测间距 14px；四张复渲图的公司、职位、时间、动作顺序符合 Jobs-Desktop、Jobs-Mobile、Job-Detail reference。详情旧抽屉白板与阴影已消失，标记和公司左对齐，真实待投递 Action 的“我已投递”可见。
- 200% 检查中普通正文 14px 增至 32px；320px 无横向溢出。仅存 canonical deadline 派生一条节点；同名岗位及其独立 URL、打开链接不写投递事实、返回焦点/搜索/旧路由均由浏览器断言覆盖。仍有过渡旧 CSS 类待 TSUI-05 清理。
- PR [#158](https://github.com/haohongfei2001-png/pjsdas/pull/158) 合并 main `56aeec3e75628a81de4ad883a56b272817643236` 后，exact-main CI、Browser、只读回退与 Pages 均成功。真人、真实辅助技术和真实手机软键盘证据保持 deferred。

