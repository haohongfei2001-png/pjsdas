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

## 待补的本轮闭环

- 再渲岗位库桌面、手机与详情桌面/手机，对照 Jobs-Desktop、Jobs-Mobile、Job-Detail。
- 检查 320px、实际 200% 正文字号、长混排与横向溢出，确认公司、职位、时间和动作的顺序与位置。
- 对记录的具体问题实施修正并再渲。完整工程/命令门槛与 exact-main 结论以 STATUS 为准；真人、设备与真实辅助技术证据仍 deferred，不写 PASS。
