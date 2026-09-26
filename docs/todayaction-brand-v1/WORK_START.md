# 给 Work 的执行入口

接管 `haohongfei2001-png/pjsdas` 的 `TODAYACTION-BRAND-UI-v1`。先读取本目录 README.md、STATUS.yaml、assets/SOURCE.json 和已选A参考图。正式产品名为 **TodayAction**，只用A三段式标志；不混日历/星光/对号/终端，不再发散选标。

起点通过GitHub connector重新读取remote main、`docs/tasks-schedule-ui-v1/STATUS.md`及README、open PR、当前writer/head/CI。登记基线只作线索，不作为当前状态。当前线索为main `153d8ccb6201e33cd1c9a09a0d7bf84a7cf0f079`，Gmail热修复#164仍有生产门槛。已有writer时不抢写、不建平行产品实现；正常释放或可核验的串行交接后接续。不要把品牌改动塞进#164或因改名批准真实邮箱/DDL操作。

计划/资产PR不是第二个运行时writer。先将文档交接纳入当前事实源；只有writer协调完成后，按TA-01正式更名＋图标、TA-02既有TSUI界面收束、TA-03上线验证与receipt依次执行。普通工程判断、测试、CI、冲突自行处理，不逐轮询问。

所有自有可见名称统一TodayAction，包括title、favicon、桌面安装名、无障碍名称、顶栏、录入、设置和登录/授权页。保留repo slug、域名、内部key、环境变量、schema、MCP工具名、账户/工作区/命令/回执身份和OAuth回调。禁止全仓字符串替换。三主入口、完整任务与日程集合、首项不放大的TSUI产品决定继续有效；不套用聊天里的概念海报布局。

SVG是工程描摹候选而非原始矢量源，先对照参考完成几何和小尺寸检验，再可复现导出并接入真实代码。必须测试根路径和`/pjsdas/`、深链接、HTML初始title、icon MIME/真实字节、16px与32px、苹果180px和maskable安全区。图片不能是SPA fallback的HTML 200。

末尾交付exact-head、exact-main、部署/readback证据及STATUS/receipt；设备、第三方品牌控制面或法务不能验证则明确DEFERRED，不能冒充PASS。当前会话无后台持续执行保证，若只剩异步门禁或外部阻塞，记录准确frontier并正常结束，不空等或重复轮询。
