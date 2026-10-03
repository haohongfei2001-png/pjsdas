# Exact consumer migration plan — not applied

Read-only inspection of Supabase project `yyrzwpoxlxpafdlbkdtg` on 2026-10-03 used migration history, actual function bodies/signatures, role privileges, RLS, columns and grant constraints. [Machine-readable schema evidence](production-schema-2026-10-03.json) contains no workspace data or grant rows. Source reference: PR237 head `0b98402519cd4ddea0997835ed759f028cdf9352`.

## Already present: do not reapply

| Source file | Platform history | Structural evidence |
| --- | --- | --- |
| `20261002123812_consumer_management_atomic_grants.sql` | `20261002174410_consumer_management_atomic_grants` | Grant table columns/RLS and v2-only constraints match; trigger function body MD5 `6b4bdd6aae253333bbed6c87327c27bd`; commit wrapper body MD5 `cd0a9332d6210a7786acabbc4bb225af` exactly match source. |
| `20261002143625_owner_management_consent_audit.sql` | `20261002174430_owner_management_consent_audit` | Owner audit table columns/RLS match; consent function body MD5 `f1331355132980d02d2cc6cd5c34bcdd` exactly matches source. |

All three inspected baseline functions are SECURITY INVOKER with `search_path=public, pg_temp`; service_role can execute, anon/authenticated cannot. The current grant constraints permit only `workspace.manage` / version 2. The scoped-consent table and all consumer v3–v7/bootstrap entry functions are absent.

## Pending: apply only this ordered chain after explicit authorization

| Order | Exact repository file | Missing structure / change |
| --- | --- | --- |
| 1 | `20261002175431_opportunity_management_v3.sql` | Expand exact capability/version constraint; opportunity commit wrapper. |
| 2 | `20261002195807_planning_management_v4.sql` | Planning capability/version and commit wrapper; depends on v3. |
| 3 | `20261002211312_discovery_profile_management_v5.sql` | Discovery-profile capability/version and wrapper; depends on v4. |
| 4 | `20261002220516_private_reminder_management_v6.sql` | Private-reminder capability/version and wrapper; depends on v5. |
| 5 | `20261002234255_opportunity_management_raw_boundary.sql` | Exact compact evidence byte verifier and replacement v3 raw-preservation wrapper. |
| 6 | `20261003083410_scoped_management_consent_batch.sql` | Scoped-consent audit table and atomic multi-domain consent function. |
| 7 | `20261003091106_consumer_bootstrap_audience.sql` | Consumer empty-workspace initialization with locked audience verification. |
| 8 | `20261003104723_consumer_business_scoped_access.sql` | Distinct business v7 constraint/wrapper, five-choice consent replacement and v2/v7 replay fence in the existing v2 wrapper. |

There is no `db push` step. Timestamp mismatch alone is not a missing migration. Before application, re-read history and schema, compare the exact reviewed files, and halt on unexpected drift. Apply each reviewed migration through the platform migration mechanism in dependency order, recording the returned platform version and source SHA-256. Do not issue grants or mutate snapshots as part of schema application. If a later migration fails, preserve its error and leave consumer flags off; do not blindly replay the whole chain.

After application, recheck table columns, RLS, constraints, exact function signatures/bodies and role privileges against the reviewed chain. Replacing the v2 wrapper in step 8 is expected; it adds cross-family receipt refusal and an explicit workspace row lock before receipt lookup; old valid v2 operations remain supported, but lock contention and brief DDL blocking must be assessed. Do not claim schema installation from the source-derived health migration list.

## Separate operator decisions

The current user authorized engineering/merge/deployment but explicitly reserved live flags, audience, OAuth credentials and persistent permission expansion. Obtain concrete authorization for this migration chain and the following controlled test inputs before executing them:

- Keep `PJSDAS_AUDIENCE_MODE=allowlist`; identify exact synthetic test accounts to admit as beta. No public/legacy audience expansion.
- Enable `PJSDAS_CONSUMER_ONBOARDING=enabled` and `PJSDAS_CONSUMER_SCOPED_MANAGEMENT=enabled` only in the approved deployment. Owned revocation remains available independently of every admission flag; do not enable unrelated owner flags.
- Use the verified existing plugin/OAuth client and existing resources. Do not create credentials, reconnect real users, modify paid plans or add external delivery.
- Each approved test user must explicitly choose scopes in the first-party page. Database migrations and operator activation never imply user consent. No direct grant insertion.

Then run the [real-host acceptance](plugin-delivery.md#real-host-acceptance-after-controlled-activation). Rollback means disabling the new runtime/onboarding flags and stopping new admission while retaining grants/audit/workspace/history for investigation. Do not drop tables, delete receipts or rewrite historical snapshots. Preserve a first-party path for owned revocation; do not leave users unable to revoke during an incident.


## 本轮八项完整 SQL 审阅

完整原文在仓库 `supabase/migrations/`，审阅附件包含八个完整文件，校验值见 [pending-migration-checksums.json](pending-migration-checksums.json)。SQL 未为本次准备修改；哈希与 PR237 版本一致。以下逐项审阅包含函数内部的写入行为，不只是文件头和名称。

| 项 | 审阅结论与现有账号影响 |
| --- | --- |
| 1 v3 | 将已有 capability/version 检查扩展为精确 v2/v3 配对，保留 v2。新增 service_role-only 机会提交 wrapper，检查 user/client/grant id/revision，持 grant SHARE 锁，通过既有事务提交。安装时不发 grant、不写工作区。 |
| 2 v4 | 在前项约束基础保留 v2/v3，加入规划 v4；限定决策规则、时间偏好、补偿和指纹，不接受整份快照覆盖无关字段。新增函数普通登录角色无执行权。 |
| 3 v5 | 保留旧配对，加入发现偏好 v5；限定发现偏好变动及恢复，拒绝改写其他数据和来源；不授予付费发现、外部抓取或消息权限。 |
| 4 v6 | 保留旧配对，加入私人提醒 v6；验证提醒意图/投影和精确变更/恢复，保留其他事实与排序；不接通邮件/短信/日历。 |
| 5 raw boundary | 新增精确 compact JSON 证据大小计算 helper，替换 v3 wrapper，验证受控字段/前后值和数组原始元素，保留未知字段、来源、顺序、旧格式。未替换 v2 函数，不对存量快照批量规范化。 |
| 6 scoped consent | 新建 RLS 审计表；普通角色不可读写，service_role 仅 SELECT/INSERT，无 UPDATE/DELETE/TRUNCATE。新增原子多领域决定函数，锁账号/当前受众/授权、CAS 证明、不可变请求回执。重复批准只返回历史结果，不恢复撤权；部分失败整批回滚。外键跟随未来 auth.users 删除级联，迁移本身不删账号；最终保留规则须考虑该行为。 |
| 7 bootstrap | 新增第一方空工作区 wrapper，校验明确标记、空集合、schema 4 和体积，锁 allowlist 受众，委托原有 UNIQUE(user_id) 初始化。已有工作区原样返回，不做 reset。底层兼容 owner/beta/legacy，不代表新网关开放它们；本轮网关只允许精确 A/B beta + onboarding。 |
| 8 business v7 | 保留 v2–v6，加入独立 v7 capability、业务提交 wrapper和五领域 consent 函数替换。v7 限定准备事项/手动行动/申请分组的原始变更与补偿；不借用 v2 grant。现有 v2 wrapper 被替换：仍要求 v2 当前 grant，先持 workspace 锁再查回执，拒绝 v7 同名执行/撤销回执。保留真实同家族重试/旧回执，不批量改 ledger 或 grant。 |

这条链安装了 v3–v6 的数据库结构依赖，并不开放其消费者运行时，也不构成领域同意。不能跳过中间约束/函数依赖后只执行第 8 项。

### 运维影响与停止条件

约束 DROP/ADD 与校验会对 grant 表取得强锁，存量较多时检查需时；函数替换同样不是承诺完全无阻塞。每项使用平台迁移机制原子执行，在 SQL 前附加 `SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '15s';`（单独记录该执行 envelope；原始文件哈希不变）。每项锁/语句超时即整项回滚并停止，不循环重试、不自动扩大阈值；前面已成功项保留结构，消费级保持关闭。若平台机制不能保证该项事务和 timeout，在执行前停止，不能临时换成无保护的全量 push。

第 8 项的新 v2 workspace 锁改变争用路径；保留真实 PostgreSQL 并发、双向家族碰撞、撤权优先/写入优先、撤权后重放拒绝测试。即使合成验证通过，也不能保证现场零延迟。已存在的迁移时间戳错位须按结构/函数核实，不以文件名重新应用旧 v2。

安装前检查实际约束、RLS、service_role 权限、函数签名/正文及已应用迁移，确认现有备份/恢复能力；安装后逐项回读并保存平台版本与源哈希。不要用删除新表、回执或快照做 rollback。若现有资源恢复能力不能核实，先保留关闭状态提交该具体阻塞。

### 对已有账号的结论与证据边界

八项顶层 DDL 不给任何既有账号新增业务授权、不调整其 beta/owner 角色、不创建/清空工作区、不改数据 schema version、不批量改历史回执。函数内有经验证的 INSERT/UPDATE，只有后续合法调用才发生；不能把“迁移没有回填”误读为“函数不能写”。新撤权页允许已有第一方账号查看本人授权元数据和撤权；不开放业务数据。

新增完整链测试逐项比较已有三账号的 workspaces/grants/audience/ledger/owner-consent 审计行，含活动/撤销 v2、未知字段、数组顺序和旧回执；执行后再验证 v2 历史重放、新写入/撤销、普通角色拒绝、A/B 跨证明/跨撤销拒绝及 B/C 不变。PGlite 通过不能替代真实 PostgreSQL 并发或真实插件宿主验收；各层结果单独记录。

具体 A/B、关闭后撤权、线上分阶段执行及本人操作见 [controlled-v7-review.md](controlled-v7-review.md)。本轮不批准线上迁移或开关；全部线上动作待明确确认。
