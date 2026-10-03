# 受控迁移技术核验：0/8，生产保持不动

2026-10-04。条件式授权固定源提交为 `9055fa21b1bffeed06bf18e69cf5511fa16c6f02`；八个 SQL 与 [校验清单](pending-migration-checksums.json) 的哈希全部一致。清单原始 `sourceCommit` 是文件最早审阅来源，不代替本次授权提交。没有修改生产 SQL，没有调用线上迁移接口。

## 已补齐的权限证据

检查覆盖本次变更涉及的对象、角色、角色继承、默认权限、列权限、RLS、策略、约束、触发器和函数定义。线上迁移记录中的两份旧管理 SQL 与仓库原文一致（平台版本分别为 `20261002174410`、`20261002174430`），不能因源文件时间戳不同而重放。

线上 `postgres` 在 public 下为 anon、authenticated、service_role 设置了广泛的默认对象权限。重建同样的默认权限后执行这两份旧 SQL，可复现现有对象权限：旧 grant 表保留 service_role 的全部表权限；旧 consent 审计表只保留 service_role SELECT/INSERT；普通角色均不可访问，相关函数均为 SECURITY INVOKER。这个差别来自原有默认权限及显式 REVOKE，不是未解释的权限漂移，不应擅自“修复”线上权限。

先前 PGlite 18 与线上 PostgreSQL 17 的原始目录比较出现过 NOT NULL 目录表示差异；验证每列非空性及对应约束后才规范化比较。该结果只证明当前相关对象符合重建基线，不声称所有历史中间状态均未变化。

## 仓库中的可重复验证

[完整链测试](../../tests/sql/consumer-migration-chain.mjs) 同时支持隔离 PGlite 与现有 CI 的 PostgreSQL 17。真实数据库路径只接受固定回环地址、固定测试库和测试凭据，不接受生产连接。

每个原始文件先校验 SHA-256，然后在同一个显式事务中设置并回读 `lock_timeout=2s`、`statement_timeout=15s`，执行完整 SQL，再写入测试迁移历史。故意在历史写入后制造错误，回滚后逐项比较表/列、约束、索引、触发器、RLS/策略、函数定义和 ACL、迁移历史及三个已有合成账号的全部相关行。随后在隔离测试中验证成功提交只增加一条准确历史记录，旧表权限和原有数据保持不变。

保留 v2 历史回执重放、新写入与撤销；独立 v7 的 A/B 跨授权证明与跨撤销拒绝；A 写入及撤权后 B/C 工作区、授权和回执不变。新增 scoped 审计表在广泛默认权限下仍只允许 service_role SELECT/INSERT，普通角色不可读写。

最初的除零故障注入不是实际超时测试；后续增加了真实 PostgreSQL 上的 2s 锁超时和 15s 语句超时。测试中的失败后成功路径不是生产重试策略。此测试证明显式事务方案及原始 SQL 的行为，**不能证明托管 Management API 内部把 SQL 和迁移记录放在同一事务中**。

## 仍未满足的生产前置条件

1. 当前 Supabase 连接不暴露备份列表或恢复权限查询；未取得可用恢复点、该恢复点的恢复方法及实际操作权限的完整证据。未创建付费备份或新增资源。
2. [官方 MCP 固定版本源码](https://github.com/supabase-community/supabase-mcp/blob/4602ee9ebf025611741cc127cee2a3c6a4f73854/packages/mcp-server-supabase/src/platform/api-platform.ts) 只转发完整 SQL 到 Management API，未提供服务端事务与历史记录边界。CLI 的实现不能替代该接口的保证。没有在生产执行试探性迁移，也不把本地事务测试当作接口保证。

资料不完整不等于权限漂移，也不等于平台没有备份或接口必然不原子。现阶段仅能确认执行条件尚未全部满足。

## 明确处理方案

保留原条件式授权，线上维持 0/8、消费级关闭。继续隔离开发和测试，不新建测试账号、不授予用户权限、不改 OAuth、不发布政策、不新增费用。当前不要求用户截图或手工 SQL。

恢复执行前必须取得可核验的现有恢复能力及可控制事务边界的执行通道，再由执行方重新只读核对固定提交、文件哈希、线上结构及完整相关权限。任何错误、超时或漂移立即停止，不自动扩大超时或重放整链。取得这些条件之前，不把未经证明的通道当作可用方案。

运行时合并/部署、真实插件宿主验收和线上启用分别记录；隔离测试通过不等于任何一项已经发生。本次仅测试及文档变更，不需要生产部署。

## 最短可执行路线：现有连接、逻辑备份、原生事务

继续核验已确认组织为 Free 套餐，数据库大小约 25 MB。Free 不应假定有可选的每日备份；[官方建议自行逻辑导出](https://supabase.com/docs/guides/platform/backups)。不升级套餐、不购买 PITR/IPv4、不新建云项目；复用免费 [Session pooler 的 5432 端口](https://supabase.com/docs/guides/database/connecting-to-postgres)。现有 MCP 连接不提供数据库密码，不能冒充为已取得的数据库连接。

执行方已准备哈希固定的八个事务文件。原生 `psql -X -w --single-transaction --set ON_ERROR_STOP=1` 将同一个文件的超时设置、完整 SQL 和历史 INSERT 放在同一显式事务内；文件中的保护检查拒绝自动提交方式及重复历史。每项执行后重新读取再决定下一项，网络断开或提交结果不明时仅查询、不自动重放。原始八个 SQL 不变。

PR241 新增原生命令验证：一致性快照下 `pg_dump`，用 `pg_restore` 解码归档，再以 `psql --single-transaction --set ON_ERROR_STOP=1` 向新建隔离数据库恢复，准确比较 schema/owner/ACL、函数、策略、索引、默认权限、数据和历史；然后对八项原生事务验证成功提交、历史写入后的故障回滚及重复执行拒绝。生产备份不进入 GitHub CI。首次本地恢复因目标空库已有 public schema 失败；首次云端再验证发现移除默认 schema 会丢失 initdb 的 PUBLIC USAGE（pg_dump 按此默认值记录权限差异）。修复为保留新建目标的空默认 schema，只省去归档中唯一的重复 CREATE，保留所有 ALTER OWNER 和 ACL 语句，通过 psql 单事务恢复；仍逐项严格比较原始 ACL，不忽略恢复错误、不使用 CASCADE、不删除源数据。两次原始失败记录保留。

生产备份门槛仍然是**实际备份实际恢复成功**，而非上述合成测试。取得现有连接后，先验证 TLS、账号、只读基线和备份/恢复所需的既有对象权限；在一致性快照中导出本次涉及的全部业务数据、授权、审计、历史和完整结构/ACL，并包含 auth 依赖。备份置于本机私有目录并加密，在无外网服务的独立 PostgreSQL 17 实际恢复和比对，再出具时间点、源库、哈希、范围及恢复权限证据。不能为了恢复成功跳过缺失扩展、剥离 ACL、忽略错误或擅改源权限。未验证的对象或权限会阻止迁移。

这是本次 DDL 的逻辑恢复方案，不是整项目 PITR。Storage 文件、OAuth/JWT/服务配置不在逻辑数据库归档内，本次迁移也不修改它们。恢复演练只在隔离库；禁止把旧快照整库覆盖到仍有其他用户写入的生产库。生产发生意外后先停止，由备份提取需要恢复的对象并保留迁移后合法写入；不自动删除数据或回滚整链。若需要超出本次 DDL 范围的灾难恢复权限，必须另行确认。

唯一用户步骤：从指定项目的 Connect 面板安全录入**已有** Session pooler 连接信息和已有数据库密码。专用录入器不回显、不放聊天或命令参数，只保存权限 0600 的本地机密文件，不运行 SQL。如果原密码已遗失，不擅自重置。执行方负责此后的备份、恢复演练、门槛核验和原授权范围内逐项迁移。

这条路线不增加 Supabase 服务订阅费；逻辑导出仍消耗现有网络/流量额度，不承诺“零流量”。若现有额度或访问条件不够，不创建付费替代资源。PITR 是另外的付费选项（官方 7 天约 $100/月，另有付费套餐/计算要求），不是本方案必需项。

## 生产只读备份工具

`scripts/consumer-management/capture-private-backup.mjs` 已准备为后续安全录入后的只读捕获入口：参数只有私有连接配置目录、PostgreSQL 工具目录及新的私有备份目录，密码不进入参数或日志。只接受固定项目及现有 postgres 连接，要求 TLS 校验，使用只读一致性事务及导出快照。输出为 AES-256-GCM 认证加密的完整归档和加密元数据，包含逐表内容 SHA-256、角色/继承、扩展与历史。目录 0700、文件 0600，拒绝写入 Git 或交付附件目录，不覆盖旧恢复点。

捕获工具不运行迁移、不授予权限、不恢复生产。它明确将恢复状态标为未验证：即使导出成功、加密完整性成功，也仍须在隔离库实际恢复、逐项核验对象/数据和既有恢复权限后才能迁移。加密、错误密钥/篡改拒绝，以及相同快照的逐表指纹恢复比对使用现有云端合成 PostgreSQL 验证，不向 CI 传生产凭据或备份。

## Clickable private handoff and fixed existing connection

The next preparation step no longer requires the user to copy a connection string or choose a pooler. The existing project's authoritative metadata supplies `db.yyrzwpoxlxpafdlbkdtg.supabase.co`. The existing local network proxy on loopback port 7895 can reach this IPv6 destination. A fixed-destination temporary loopback tunnel transports the original end-to-end PostgreSQL TLS connection; it does not terminate TLS, accept arbitrary destinations, change system proxy settings, expose a listener beyond loopback, or run SQL.

A credential-free PostgreSQL SSLRequest/TLS handshake passed with TLS 1.3, the pinned official Supabase production CA, and original hostname verification. Prior direct transport was reset; a Python system-root-only attempt through the existing proxy correctly rejected the untrusted CA. Neither failure was bypassed. `certs/README.md` records the official CA source and hash. The capture client now supplies the same verified CA and hostname to node-postgres and native libpq. Native password files remain private, temporary translated port entries are removed at the end, and original credentials are not placed in process arguments.

`prepare-access.py` is a loopback-only private input page. Project/host/database/port/CA/transport are fixed. The only database input is the existing password, saved privately without echo/logging or production execution. A separate explicit form records two user-controlled dedicated identities and narrowly bounded business-v7 test permission; it does not insert grants, admit accounts, enable flags, register clients, or send OTPs. A/B UUIDs, original client ownership and first-party domain consent still require actual verification. Duplicate or cross-origin submissions and overwriting existing configuration are rejected. No original plugin-specific install URL is fabricated: the host directory link remains a directory link until the private plugin is identified.

Preparation page checks cover exact origin/host/CSRF, secret handling, private file modes, replay/overwrite rejection, explicit two-account confirmation, and separate pending approval status. Headless desktop/mobile interaction passed after the first browser launch was blocked by macOS sandbox IPC; the authorized headless retry used only a synthetic private directory and no real credentials. This is preparation UI validation, not actual plugin installation, production backup/restore, or consumer acceptance. The final source still preserves all eight SQL files and the approved migration checksum manifest unchanged.
