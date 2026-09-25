# TodayAction 正式更名与品牌界面迁移计划 v1

Package: `TODAYACTION-BRAND-UI-v1`  
登记日期：2026-09-26  
品牌决定：**TodayAction**（T、A 大写；无空格）＋已选 **A 三段式抽象标志**。  
执行入口：[WORK_START.md](WORK_START.md) · 进度：[STATUS.yaml](STATUS.yaml) · 资产：[assets/](assets/)

> 本文登记产品 owner 的新决定，不表示生产版本已经更名。本次交接只增加本目录的计划与设计资产，不修改运行时代码，不改变 #164 的 head，也不触发真实邮箱或工作区操作。后续 Work 按下述顺序接续。

## 1. 已核验的现状，而不是聊天中的旧状态

基线来自 GitHub connector 读取的 remote main：`153d8ccb6201e33cd1c9a09a0d7bf84a7cf0f079`；tree：`8a1d0806c47c8fe13495c463c6358d269785e0dc`。以下是登记时快照，Work 开始时必须重新读取。

- `docs/tasks-schedule-ui-v1/STATUS.md`：TSUI-05 工程完成，后续 exact-live 技术验证完成，私有 canary/真人证据仍 deferred，本包停止。旧包关闭不等于此次品牌迁移已经完成。
- 该 main 的 `ci-build` SUCCESS，run `36159566822`；`chromium` SUCCESS，run `36159566451`。这些只是既有主线证据。
- open PR **#164**：`reliability/161-gmail-worker-recovery`，head `b67785ebb55b81a5c28e72eff303785a2b41249f`。它是有明确边界的 Gmail 热修复，描述记录仍需生产 migration 验证和有授权的真实运行/readback；不得因其 CI 成功而直接宣称生产恢复。
- 当前 `index.html` 的 title 是 PJSDAS，description 仍是求职系统英文全称，theme-color 是 `#f5f3ee`；head 未声明 favicon、apple-touch-icon 或 manifest。`public` 目录在这个 SHA 的 contents 查询返回 404。此结论不替代对服务端动态输出或未来新增资产的检查。
- `src/AppV8.tsx` 的顶栏仍显示 P、PJSDAS、`PJSDAS · Today` 和“告诉 PJSDAS”。`src/tsui02.css` 已使用蓝白体系：背景 `#F5F6F9`、正文 `#1B2540`、主色 `#3569D5`，品牌块 30px。
- `vite.config.ts` 使用 `PJSDAS_VITE_BASE`，未显式配置时 Vercel 是 `/`，其他情况是 `/pjsdas/`。必须同时验证 canonical 根路径与历史恢复路径，不能机械把 `/pjsdas/` 改成 `/todayaction/`。
- README 确认 canonical Web/API origin 为 `https://todayaction.com`，生产是 owner-only 的事务性工作区；Google Drive 是备份/导出，不是本次需要新建的账户或数据源。

**本轮定位决定：** TodayAction 的长期方向是 AI 辅助的综合每日事项管理。当前实际可用的求职工作流仍然保留。更名不得把“岗位库”假改为“项目库”，也不得用新文案声称尚未实现的通用自动规划、公开注册或原生 iOS 能力。

## 2. 必须保持的产品与工程边界

### 2.1 新品牌不重开已经完成的产品架构决策

沿用 TSUI 已冻结的 **今天 / 岗位库 / 日程** 三入口、顶栏、手机局部切换、完整任务集合与可持续浏览节点。**首项任务不特殊放大**；不得套用聊天中带巨型 Now 卡片、第二套侧栏、知识库、虚构统计的新展示图。那些是品牌探索，不是新的业务蓝图。

可以优化品牌区、间距、排版、对比度、按钮文案、空状态和窄屏适配；不删除任务、不收缩未来节点、不改排名/预算/时间精度、不新建一套可写日程表。保留 loading、stale、error、unknown、conflict、pending 和 Undo 的真实区别，不能用“都安排好了”掩盖来源异常。

### 2.2 可见名称和内部身份必须分开

**要改：** 网页与 App 展示名、站内自有文案、无障碍名称、HTML metadata、自有登录/同意页标题、帮助/关于、当前产品说明、静态分享图和安装图标。

**本轮不要改：** 仓库 slug `pjsdas`、历史 Git refs/tags、`PJSDAS_*` 环境变量与 secret 名、IndexedDB 名称/store、localStorage/sessionStorage key、备份文件内部 schema/type、持久化 JSON 字段、工作区/账户/岗位/occurrence ID、命令和回执 ID、OAuth client/redirect URI、MCP tool 的稳定名称与协议标识、数据库表/RPC、Cloudflare/Vercel/Supabase 项目标识。

内部名称保留是兼容性策略，不是漏改品牌。全仓 `PJSDAS -> TodayAction` 替换属于禁止操作。`package.json` 的 private package name 不是 UI 名称，默认保留；若确需更改，单独核验锁文件、脚本与部署引用后再做。版本号按现有 RELEASE_POLICY，不能借更名归零或随意宣布新正式版本。

历史 receipt、migration、原型 reference 和已认证截图不重写。当前 README 可说明“TodayAction，原 PJSDAS”，并标明当前求职场景与长期方向；不篡改历史认证。

## 3. 品牌规范：只落地 A，不再融合、不再发散

![已选 A 的参考裁切](assets/approved-A-reference.webp)

### 3.1 来源与状态

`assets/SOURCE.json` 保存原图 SHA-256、原尺寸和裁切坐标。参考 WebP 是原图裁切后的压缩预览；下载交接包另含原 PNG。原图上的 Todayaction 字样是旧拼写，**新字标必须是 TodayAction**。

随包 SVG 是按已选 A 做的**工程描摹候选**，不是原始矢量源文件，也不冒充已经通过真人或设备验收的最终资产。Work 对照参考完善几何与小尺寸表现；不得重新选择 Logo，不得添加日历、星光、对号、终端横线或额外字母。

参考原图 SHA-256：`33c6f1e93bcb6958d2bb0324675f7eaad92f3d152205559436eb54cf5cd9f417`。

### 3.2 必须保留的构形与允许的工程调整

保留三块分离构形：上方浅色横向结构、右侧浅色纵向结构、左下到右上的蓝色斜向主体。保留朝向、宽厚圆角、内部留白和主体/支撑层级。不把浅色两块连成实心箭头，不只保留一条蓝斜杠。

允许调节：小尺寸的浅色深度、亚像素对齐、部件间隙、视觉居中和安全区；幅度以保留参考辨识为限。大图采用克制的蓝色渐变；favicon 不依赖柔光、阴影或极浅细节。不要把宣传板的白底、外部阴影和大留白直接缩成 favicon。

### 3.3 文件矩阵

- `a-mark-primary.svg`：透明主标，供顶栏、登录、关于页；不含文字。
- `a-mark-small.svg`：相同构形的小尺寸强化版，供 16/24/32/48px；保持三块可辨。
- `a-mark-mono.svg`：单色版本，检查轮廓独立性与高对比场景。
- `a-app-master.svg`：不透明、正方形 1024 画布；浅底，图形居中。源文件不预裁 iOS 外圆角，不带画布外阴影。
- `a-app-maskable.svg`：独立安全区版本，不能把普通 icon 仅改名为 maskable。
- 生产导出：`favicon.svg`、包含 16/32/48 的 `favicon.ico`、`favicon-32.png`、180px `apple-touch-icon.png`、192/512px普通 PNG、512px maskable PNG、1024px归档母图。

建议最终存入 `public/brand/`，由一个可复现脚本从定稿 SVG 导出；新路径是实施目标，不是声称这些文件已在 main。无远程图片、字体或渲染服务依赖，不能为了 Logo 增加重型浏览器 runtime。

### 3.4 字标、色彩和无障碍

字标文本 TodayAction 使用项目现有字体栈，T 和 A 大写。顶栏优先单色深蓝正文，标志承担蓝色识别；不得把一半品牌文字做得接近白底而难读。Logo 自身不承担“已完成/同步成功”状态语义。

沿用 `#3569D5` 强调色、`#F5F6F9` 页面、白色面板、`#1B2540` 主文案；图标局部可用浅蓝和青蓝，不将整个工作页面改为强渐变玻璃。正文/交互对比度独立验证；不能拿 Logo 的装饰豁免替代按钮和文字的可读性。

有文字的品牌按钮：图标 `alt=""` / `aria-hidden`，整个按钮只读一次“TodayAction，今天”。图标单独作为功能入口时提供相应可访问名称。CSS 给出固有宽高，加载前后不得挤动导航。

## 4. 实施文件地图与旧名审计

Work 先按路径与用途分类，再逐项修改。以下现状是已读源码；其余入口必须在当前 main 上扫描，不能假定覆盖完毕。

| 范围 | 已确认/待扫描的入口 | 实施要求 |
|---|---|---|
| HTML 名称与小图标 | `index.html`（已读） | title/description/theme-color/favicon/touch icon/manifest；HTML初始响应就正确，不等 React 挂载 |
| 顶栏 | `src/AppV8.tsx`（已读） | P 改为 A 标志；PJSDAS 和 aria-label 改 TodayAction；“告诉 TodayAction”保留原命令入口 |
| 品牌样式 | `src/tsui02.css`（已读） | 尺寸、间距、长名称与窄屏；检查后续级联覆盖，不再叠第 N 套全局主题 |
| 录入与状态文案 | `src/TellPjsdasCapture.tsx` 及其实际 lazy/heavy 实现、Today/Settings相关组件（需全量定位） | 改展示文字，不改状态机、draft key、account binding 或保存行为 |
| 授权与登录 | `src/aiAccess/OAuthConsentPage.tsx` 为 lazy 包装，实际 `OAuthConsentPageHeavy.tsx`；cloud登录/错误页需扫描 | 自有界面更名；provider/client身份、scope、redirect不变 |
| 公开说明 | 根 `README.md`、自有 help/about/privacy 文案、静态 OG/Twitter metadata（存在性逐项确认） | 当前说明与未来愿景分开；保留“原 PJSDAS”迁移说明，不宣称商标已清查 |
| 稳定契约 | `vite.config.ts`、`src/db.ts`、snapshot/command/gateway/release相关模块 | 建立允许保留旧名清单，默认不作更名写入 |
| 发布与回退 | `scripts/write-spa-fallback.mjs`、release identity流程、既有部署 workflow | 验证品牌资产随同一构建发布，404 fallback 与根页面一致，不删除 exact-SHA gate |

建立 `RENAME_AUDIT.md`：每个命中记录 path、性质（用户展示/内部契约/历史证据/第三方控制）、处理或保留原因、测试覆盖。扫描命令为起点，不是自动替换：

```sh
git grep -n -I -E 'PJSDAS|Pjsdas|pjsdas|Todayaction|todayAction|Personal Job Search Decision' -- . ':!package-lock.json'
git grep -n -I -E 'document.title|apple-touch-icon|manifest|favicon|serviceWorker|registerSW' -- .
```

对渲染后的所有自有关键路由另做可见文本与 accessible name 扫描。原始源代码中允许出现兼容名，界面里不允许无解释残留。用户自行录入的文字、已存在的历史记录不改写。页面 title 使用“今天 · TodayAction”等静态功能名，避免把私人公司/岗位/内容泄露到标签页或分享 metadata。

## 5. 浏览器 favicon 与手机桌面图标是独立验收项

### 5.1 Web 接入

在 `index.html` 中声明 favicon SVG、ICO/PNG fallback、apple-touch-icon 和 manifest；用 Vite 的 base-aware 引用，不从深链接相对到 `/library/brand/...`。头部示意需经当前构建验证：

```html
<title>TodayAction</title>
<meta name="application-name" content="TodayAction" />
<meta name="apple-mobile-web-app-title" content="TodayAction" />
<meta name="theme-color" content="#F5F6F9" />
<link rel="icon" type="image/svg+xml" href="%BASE_URL%brand/favicon.svg?v=ta-a-1" />
<link rel="icon" type="image/png" sizes="32x32" href="%BASE_URL%brand/favicon-32.png?v=ta-a-1" />
<link rel="icon" href="%BASE_URL%brand/favicon.ico?v=ta-a-1" />
<link rel="apple-touch-icon" sizes="180x180" href="%BASE_URL%brand/apple-touch-icon.png?v=ta-a-1" />
<link rel="manifest" href="%BASE_URL%manifest.webmanifest" />
```

确定一个实际优先级一致的声明顺序，并用浏览器验证选择结果，不只检查HTML字符串。icon URL 必须匿名可取、MIME正确、无认证跳转，不是 SPA fallback 返回的 HTML 200；还要检查 CSP。根 `/favicon.ico` 的兼容输出可作为后备。

每个稳定路由与 error/fallback 初次访问都有相同品牌图标。用版本化资产 URL 刷新缓存，但不改站点 origin、不清空业务缓存、不让用户为换图标丢失数据。收藏夹/已经安装的 Web Clip 更新可能滞后；如实记录设备结果，不承诺所有旧安装瞬时更新。

截图中显示 ChatGPT 标志的会话标签页属于第三方页面；本仓库只能控制 TodayAction 自己的网站和安装项，不能通过改 favicon 改变 ChatGPT 的标签页图标。

### 5.2 Manifest / iPhone

`name` 与 `short_name` 均为 TodayAction。先检查是否已有安装身份或动态 manifest；**保留既有 id**。若确实无历史 manifest，明确记录新的稳定 id、start_url、scope 及根/恢复路径行为；id 不要跟随品牌版本号变化。manifest 中图标路径相对 manifest URL 解析，必须对两种 base 做构建测试。

用全不透明 PNG 输出苹果桌面图标；不要仅供 SVG。maskable 关键图形在规范安全区内，并实测裁切。仅添加安装 metadata 不等于开发了原生 iOS App，不等于完成离线/PWA能力。本包不新增 service worker 缓存策略；如果已有 service worker，只做必要的品牌资产更新，认证页、token和私有 API不得新缓存。

## 6. 四个交付阶段（一个实施 writer，不逐轮请示）

### TA-00：登记与交接（本次交付）

交付计划、来源校验、A工程候选、状态和Work启动入口。diff限制在 `docs/todayaction-brand-v1/`，不声称运行时已改。此文档分支不是第二个产品实现 writer；禁止顺手把运行时代码塞进它与 #164 并行推进。

### TA-01：正式名称＋完整品牌资产接入

前置：当前 writer 已正常释放，或有仓库中可核验的明确串行交接。不夺取 #164，不往它的限定热修复分支添加品牌提交，不为了更名批准其私有生产动作。

一次 coherent batch 完成：旧名分类审计；工程SVG与导出脚本定稿；一个共享品牌组件/常量；全部自有可见名称；顶栏、HTML title、favicon、touch icon、manifest、about/help/README一致。不要新建一整套主题框架。对新品牌名字做所有入口检查，避免只改首页。

完成门槛：TA-01相关名称/图标/路由/兼容测试通过；真渲染有桌面和手机截图；既有完整CI/Browser gate通过后按原协议合并、核验exact-main。仅有本地预览不能标为线上完成。

### TA-02：跟随新品牌的界面收束

保持TSUI布局、三个入口和完整内容集合。优化：30px品牌区和字标间距、手机顶栏拥挤、键盘焦点、按钮/链接层级、文本对比度、长岗位名、录入弹层、设置分组、加载与失败恢复。

空状态按真实情形区分：首次使用、没有今日行动、读取中、读取失败、来源过期、用户只读。首次使用应有明确的现有可行动入口；已同步且无行动时不得显示成尚未设置。内容少时可以合理压缩纯空白，但不得改坏桌面节点独立滚动、已加载锚点与长列表可达性。不能用演示数据装饰真实空工作区。

截图矩阵：宽度360/390/430/768/1280/1440，100%和200%文字缩放；至少覆盖Today有数据/空/过期或失败、岗位列表/完整详情、完整日程/事件详情、录入/设置、未登录/自有授权页。每类状态复用既有合成夹具，避免造第二套业务mock。给出before/after与具体发现，至少一次修正后复渲。

完成门槛：无水平溢出、名称截断或主要动作被遮挡；信息密度和完整集合不退化；与本轮文件相关的目标测试加末尾全量门禁。禁止为了“高级感”添加大横幅、强动效、成就积分、伪数据或新的首页主任务规则。

### TA-03：部署、外部登记与收口

沿用既有 backend/frontend exact-SHA、安全和部署流程；品牌包不需要的私有生产动作不要执行。部署后匿名检查canonical网页HTML、静态资产字节/类型、深链fallback、title和favicon；再检查同一部署身份。不要只凭Actions绿色声称图标已经在线。

更新当前README导航说明（根README与TSUI已存在差异）、品牌迁移说明、RENAME_AUDIT、资产校验和和receipt。外部登记逐项列出控制面与状态：Google OAuth应用展示名/Logo、第三方连接器卡片、仓库About/homepage、现有安装图标刷新、需要的原生渠道、图形/文字商标检索。没有实际权限或授权就DEFERRED，不伪造已完成，也不阻塞与其无关的Web自动化交付。

当前授权涵盖更名、图标、相关UI与普通工程修复；不额外授权付费、扩大账户权限、公开开放注册、真实邮箱消费、数据库DDL、商标申请或App Store上架。具体发布外部动作仍遵守当前canonical协议。

## 7. 验收矩阵：结果必须能复查

| ID | 必须证明的结果 | 证据 |
|---|---|---|
| N01 | 所有自有主要页面、顶栏、录入、设置、登录/授权、可访问名称统一TodayAction | 路由文本审计＋真实DOM截图 |
| N02 | HTML初始title/metadata正确；切页、刷新、深链和404 fallback一致；不泄露私人标题 | 构建产物断言＋浏览器导航 |
| I01 | A三段不缺失；16/24/32/48px在浅/深浏览器背景可辨 | 原尺寸截图＋单色对照，不能只看放大图 |
| I02 | 所有icon与manifest请求为真实文件、正确MIME、匿名可取、CSP允许 | HTTP/字节/解码检查，禁止只测200 |
| I03 | ICO包含预定尺寸；PNG实际尺寸与manifest一致；苹果图标全不透明 | 程序解码和像素检查 |
| I04 | PWA maskable关键内容在安全区；手机桌面名称和图标正确 | 自动裁切预览＋实际设备证据或明确DEFERRED |
| C01 | `/`与`/pjsdas/`两种base下资产、嵌套路由、OAuth返回保持正确 | 两套构建和深链集成测试 |
| C02 | 旧数据、draft、账户隔离、旧snapshot导入、原deep link仍可用 | 既有业务回归＋改名前存量夹具 |
| C03 | MCP/schema/内部ID/secrets/storage key没有品牌替换式变更 | diff审查＋RENAME_AUDIT保留清单 |
| U01 | 当前TSUI完整任务、岗位和日程集合不减少，排序与时间事实不变 | 同一夹具前后ID集合/排序核对 |
| U02 | 360px与200%文字缩放无功能丢失；对话框、焦点、滚动、返回位置稳定 | Playwright＋辅助技术相关既有门禁 |
| U03 | unknown/pending/stale/conflict/error没有被包装成成功；不能重复写入 | 复用现有命令/回执/Undo回归 |
| R01 | 候选head、merge/main、部署commit和上线资源证据能对应 | exact-head/main/production receipt |
| R02 | 所有未验证的设备、外部登记和法务项有明确DEFERRED，不混进PASS | 外部门槛表，禁止写“零侵权风险” |

测试命令以当前repo为准。登记时存在 `npm test`、`npm run build`；没有已确认的 `npm run test:e2e`，不要编造。既有 Browser E2E 使用 `npx playwright test --config=playwright.config.mts --project=chromium`；测试runner安装方式/版本跟随该workflow。内循环优先目标测试，稳定head再跑全套CI、Browser和受影响的只读回退/VoiceOver门禁；不得弱化历史断言求绿。

## 8. Writer、发布安全与回滚协议

1. Work开始做一次完整reconcile：remote main、TSUI状态、open PR、当前writer/head/CI、本包状态。已存在本包writer就接续，禁止另开平行实现。
2. #164若仍拥有writer且被外部门槛阻塞，保留它的状态；只做计划/资产检查等非生产准备，不轮询等待、不批准真实邮箱动作。只有可核验的正常释放或明确串行交接后才领取品牌实现writer。热修复阻塞不等于品牌方向被撤销。
3. 文档登记可保持独立draft PR供Work读取；合入本包文档之前核对diff全在docs、遵守保护规则，不偷推main。运行时另开实施PR前必须完成writer协调；不要让文档PR长期演变成第二条实现。
4. 一个batch一个实施PR；push后处理结果、exact-head门禁、合并、exact-main closure，再进入下一阶段。普通实现错误/CI/冲突自行处理。事实未变化时不重复重建上下文，不长时间sleep或重复全量测试。
5. 回滚使用受审查的revert或原发布机制，仅撤回品牌/UI变更；不回滚账户、workspace或schema，不清IndexedDB。若已建立新的安装identity，后续回滚保持该identity稳定，不能靠改id制造第二个安装项。
6. receipt分别列：已实现、已合并、已部署、自动验证、设备验证、外部待办、已知缺陷。未完成品牌上线不得写COMPLETE；可用 `ENGINEERING_COMPLETE / EXTERNAL_DEFERRED` 如实收口。

## 9. 本轮不做的事情

不重命名GitHub仓库、不迁移域名、不新建数据库、不扩大provider权限、不开启自动投递/新增私有消费、不重开UU-08/09、不开发原生iOS、不以品牌迁移名义做通用事项数据模型重构。综合每日管理是长期方向；其业务范围、来源、权限和数据模型应单独规划，而不是把求职实体改几个名字冒充完成。

商标/著作权正式清查尚未完成。采用A是产品owner的设计决定，不是法律无风险证明。工程发布记录不得引用聊天中的“比较原创”作为权利担保。

## 10. 事实源与技术参考

仓库基线及源文件均在以下固定commit下读取：

- https://github.com/haohongfei2001-png/pjsdas/tree/153d8ccb6201e33cd1c9a09a0d7bf84a7cf0f079
- `docs/tasks-schedule-ui-v1/README.md`、`STATUS.md`；`README.md`；`index.html`；`src/AppV8.tsx`；`src/tsui02.css`；`vite.config.ts`；`package.json`；`.github/workflows/ci.yml`、`browser-e2e.yml`。
- 当前writer：https://github.com/haohongfei2001-png/pjsdas/pull/164
- 基线CI：https://github.com/haohongfei2001-png/pjsdas/actions/runs/36159566822
- 基线Browser：https://github.com/haohongfei2001-png/pjsdas/actions/runs/36159566451

技术参考（2026-09-26查阅；只支撑平台接入，不是本项目验收证据）：

- Vite静态资源：https://vite.dev/guide/assets.html
- Manifest icons与maskable：https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons
- Manifest稳定安装身份：https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/id
- Apple Web应用桌面图标/名称：https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
