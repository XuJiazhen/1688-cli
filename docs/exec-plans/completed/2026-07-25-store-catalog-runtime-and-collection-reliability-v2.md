# Plan 1/2：1688 CLI 目录直采与采集可靠性修复

- 状态：`completed`
- 顺序：两阶段实施方案中的第一阶段，必须先于业务系统吞吐优化实施
- 建立日期：2026-07-25
- 适用范围：`1688-cli`、CLI Adapter、Browser Worker 的采集边界
- 基线任务：`62dab788-3a4b-4a8d-bfd2-255044d7578c`
- 后续方案：[Plan 2/2：业务系统增量规则、并行处理与完整准入优化](../../../../docs/exec-plans/active/2026-07-25-selection-pipeline-throughput-and-full-qualification.md)
- 阻断项：本方案未完成全部 Gate 前，不启动第三轮真实合格 SKU 采集任务

## 1. 执行授权与协作方式

实施本方案时，允许主执行者监督和调度 subagents 辅助完成相互独立的工作流，包括：

- Store Catalog MTOP Runtime 请求构造与捕获；
- checkpoint、分页和错误合同；
- Offer Detail 与 Store Qualification 失败复现；
- fixture、Playwright mock、Live Gate 和文档更新；
- 独立代码审查、测试结果复核和敏感信息检查。

主执行者对任务拆分、共享文件冲突、最终集成、线上验证和结论负责。subagent 不得自行改变公开 JSON 合同、风险控制边界或验收阈值；不得由实现者单独批准自己的变更。并行工作必须按模块划分，避免多个 agent 同时编辑同一文件。所有 subagent 必须汇报修改范围、假设、测试命令、测试结果和未解决风险。

## 2. 任务背景

2026-07-22 完成的第一版 Store Catalog 方案补齐了以下基础能力：

- `CollectionUnit -> CollectionBatch` 有界采集合同；
- 四类店铺目录、分类、店内关键词和排序的确定性解析；
- `offerCount`、分页、销量字段、资质和详情媒体事实；
- checkpoint、跨页去重、部分批次和 Profile 间恢复；
- 脱敏 fixture、请求关联和失败诊断。

这些能力证明“已得到响应后可以正确解析和归档”，但第二轮 300 SKU 正式任务证明，在线执行路径仍不足以支撑稳定的大规模目录采集。当前 Store Catalog 的主路径依赖：

```text
打开店铺页面
  -> 等页面组件加载
  -> 查找并点击筛选/排序/下一页控件
  -> 等待浏览器自己发出 MTOP 请求
  -> 按 memberId/pageNum/scope 关联响应
  -> 解析并返回 CollectionBatch
```

真实接口已经明确支持 `pageNum`，但 checkpoint 恢复第 N 页时，CLI 仍重新打开第一页并连续点击 N-1 次“下一页”。因此业务 checkpoint 能恢复数据状态，却不能直接恢复在线页面位置。页面模板、懒加载、控件可见性或响应时序中的任一波动，都会转化为重复失败和跨 Profile 重试。

本方案不是重新实现 Store Catalog 解析器，而是把已验证的协议能力变成稳定的在线采集能力，并同时收口 Offer Detail、Store Qualification、超时和错误分类缺陷。

## 3. 第二轮真实运行基线

权威原始材料：

- [300 SKU 正式任务性能报告](../../../../var/formal-300/62dab788-3a4b-4a8d-bfd2-255044d7578c/performance-report.md)
- [机器可读性能汇总](../../../../var/formal-300/62dab788-3a4b-4a8d-bfd2-255044d7578c/performance-summary.json)
- [300 SKU 正式任务书](../../../../docs/runbooks/300-sku-formal-collection-task.md)
- [1688 真实接口采集证据](../../../../docs/1688接口采集/README.md)

### 3.1 任务结果

| 指标 | 第二轮结果 |
| --- | ---: |
| 原始墙钟 | 11h 19m 51.432s |
| 目标 / 审核池 active / 唯一 SKU | 300 / 300 / 300 |
| 发现店铺 / SPU / SKU | 89 / 120 / 2620 |
| 当前 qualified SKU | 329 |
| 审核池资格不一致 / 重复 SKU | 0 / 0 |
| 跨任务 evidence provenance violation | 0 |
| 模型调用 | 0 |

任务最终达到目标，说明实体关联、结构化资格和精确准入不变量成立；它不证明采集路径已达到生产可靠性。

### 3.2 Profile 与 Attempt

| Profile | Attempt | Succeeded | 普通失败 | Lease Expired | Risk Control |
| --- | ---: | ---: | ---: | ---: | ---: |
| `default` | 179 | 88 | 88 | 2 | 1 |
| `collector-2` | 193 | 104 | 86 | 2 | 1 |
| `collector-3` | 174 | 77 | 94 | 2 | 1 |
| 合计 | 546 | 269 | 268 | 6 | 3 |

补充统计：

- 299 个 Work Unit 产生 546 个 Attempt，多出 247 个 Attempt；
- 45 个 Work Unit 发生 53 次正常 continuation，单个 Work Unit 最高 9 次；
- 107 个 Work Unit 有多个 Attempt；
- 98 个 Work Unit 发生 Profile 切换；
- 本轮登录失效 0 次、频控 0 次，平台风险不是主要失败来源。

### 3.3 CLI 失败分布

| Work Unit | 错误码 | 失败 Attempt | 占普通失败 |
| --- | --- | ---: | ---: |
| Store Catalog | `CATALOG_NEXT_PAGE_MISSING` | 132 | 49.3% |
| Store Catalog | `CAPTURE_TIMEOUT` | 102 | 38.1% |
| Store Catalog | `CLI_COLLECT_TIMEOUT` | 3 | 1.1% |
| Offer Detail | `OFFER_SKU_CAPTURE_INCOMPLETE` | 22 | 8.2% |
| Store Qualification | `CLI_COLLECT_TIMEOUT` | 9 | 3.4% |
| 合计 |  | 268 | 100% |

Store Catalog 三类普通失败合计 237 次，占全部普通失败 88.4%。三个 Profile 上的 `CATALOG_NEXT_PAGE_MISSING` 和 `CAPTURE_TIMEOUT` 分布相近，因此优先判断为共享实现缺陷，而不是单 Profile 健康问题。

### 3.4 最终 Work Unit 状态

| Work Unit | Succeeded | Failed / Cancelled | 完整成功率 |
| --- | ---: | ---: | ---: |
| Offer Detail | 118 | 2 | 98.3% |
| Store Catalog | 10 | 79 | 11.2% |
| Store Qualification | 88 | 1 | 98.9% |
| Search | 0 | 1 cancelled | n/a |

Store Catalog 终态失败不代表此前成功页全部丢失；本轮归档了 288 个 Store Catalog CollectionBatch，部分第一页和中间页事实仍被使用。但“已得到部分证据”不能替代“目录扫描可稳定完成”。

### 3.5 已知协调异常边界

6 个 `LEASE_EXPIRED` Attempt 的直接证据是：CLI 返回后的终态协调写入等待在长事务之后，900 秒 Work Unit lease 先到期。它属于 Browser Worker 与业务数据库协调问题，不应伪装成 1688 页面失败。本方案验证 CLI 取消和终态返回合同；事务锁和 Admission 拆分由 Plan 2 解决。

## 4. 问题定义与根因

### P1：checkpoint 恢复仍重演 DOM 导航

`createPlaywrightCatalogAdapter` 每次 CLI 调用都会创建新 Page，`currentCatalogPage` 从空开始。请求第 N 页时执行 `goto + N-1 次 next`。

对 P 页目录，跨 Batch 累计翻页动作是：

```text
1 + 2 + ... + (P - 1) = P(P - 1) / 2
```

7 页目录需要 21 次翻页动作，而直接页请求只需要 7 次目录请求。任何中间控件失败都会重试整个导航前缀。

### P2：协议解析稳定，在线触发脆弱

`startAlisiteModuleCapture` 只观察浏览器自己产生的签名请求，不构造请求。静态抓包已经证明 `componentKey + memberId + appdata.pageNum` 的请求形状，却没有被用于直接恢复指定页。

代码库已有可复用先例：Store Qualification 使用已加载页面的 `window.lib.mtop.request`，由 1688 页面 Runtime 负责 Cookie、token 和签名。Store Catalog 尚未使用同一模式。

### P3：错误分类不足以指导调度

当前大量不同故障汇总为 `CAPTURE_TIMEOUT`：

- 页面 Runtime 未加载；
- 页面操作未成功；
- 请求没有发出；
- 响应发出但 scope 不匹配；
- 响应匹配但解析失败；
- 页面进入登录、频控或风险状态；
- 捕获等待超时。

上层只能把它们统一当成 retryable process failure，导致确定性错误也跨 Profile 重试。

### P4：Offer Detail 与 Qualification 仍有长尾悬挂

- Offer Detail 有 22 次未捕获必需 SKU selector 模型；
- Store Qualification 有 9 次 600 秒进程级超时；
- Store Catalog 有 3 次 600 秒进程级超时；
- 被外部终止的 CLI 子进程无法写自己的 terminal event。

在没有可重复失败样本前，不能只延长 timeout。必须先基于归档 diagnostics/artifact 建立可判定的重放或 mock，再修复监听时机、Runtime 请求、页面状态或取消传播。

### P5：离线测试没有形成持续 Live Gate

现有 fixture 足以验证解析，却不能覆盖：

- 四类真实店铺当前页面 Runtime；
- 当前两个已授权 Profile 的登录会话；
- 首页、第二页和末页直接请求；
- Runtime 不可用时的 DOM 降级；
- 页面变化后的错误分类和 artifact。

没有 Live Gate 时，功能测试通过仍可能在正式任务中大面积失败。

## 5. 任务目标

### 5.1 核心目标

1. Store Catalog 使用页面 MTOP Runtime 直接请求指定页，不再依赖连续点击翻页作为主路径。
2. checkpoint 的 `nextPage=N` 能从新 Page 和任意健康 Profile 直接恢复第 N 页。
3. DOM 操作保留为显式、可观测、可关闭的降级路径。
4. 将请求、关联、解析、页面和外部进程失败拆成可行动的稳定错误码。
5. Offer Detail 与 Store Qualification 不再出现无诊断的 600 秒悬挂。
6. 保持 `CollectionUnit -> CollectionBatch`、字段可用性、完整度、证据和幂等合同兼容。
7. 建立四类店铺、当前两个已授权 Profile 的受控 Live Gate。

### 5.2 非目标

- CLI 不判断 SKU 是否合格，不执行规则中心或 AI；
- CLI 不决定任务目标、Evidence Plan、缓存 TTL、补量和停止条件；
- 本方案不拆分 Pipeline 大事务，不增加 Rule Worker；
- 不自动绕过登录、滑块、风险验证或频控；
- 不自动发送消息、操作购物车、下单或触发任何交易写操作；
- 不把原始 Cookie、token、sign 或完整请求头写入 fixture、日志或报告。

## 6. 目标设计

### 6.1 Catalog Transport

在 CLI 内建立单一的 Store Catalog 页面传输边界：

```text
CatalogPageRequest
  -> CatalogTransport(auto)
       -> RuntimeCatalogTransport
            -> window.lib.mtop.request
            -> correlated response capture
       -> DomCatalogTransport (fallback only)
            -> filter/sort/next UI action
            -> correlated response capture
  -> StoreCatalogParseResult
  -> executeCatalogBatch
  -> CollectionBatch
```

传输模式：

- `runtime`：只允许页面 Runtime 请求，失败时返回精确错误；
- `dom`：只运行现有 DOM 路径，用于诊断和回滚；
- `auto`：默认先 Runtime，只有满足允许降级的错误才尝试 DOM。

模式必须通过内部配置或 CLI 兼容选项选择，默认切换前先完成 Live Gate。公开合同保持可加字段兼容。

### 6.2 Runtime 请求

新增纯函数构造器，输入只包含：

- `memberId`
- `pageNum`
- `count`
- `catId`
- `keywords`
- `sortType`

目标请求形状：

```ts
{
  api: "mtop.alibaba.alisite.cbu.server.ModuleAsyncService",
  v: "1.0",
  type: "POST",
  dataType: "json",
  data: {
    componentKey: "Wp_pc_common_offerlist",
    params: JSON.stringify({
      memberId,
      appdata: { pageNum, count, catId, keywords, sortType }
    })
  }
}
```

具体字段以脱敏真实请求和 Live Gate 为准。构造器必须：

- 对 memberId、页码、页大小和可选字符串做边界验证；
- 不接收 Cookie、token、sign 或调用方提供的鉴权头；
- 使用页面已加载的 MTOP Runtime；
- 在发出请求前启动响应捕获，避免快速响应先于 listener；
- 同时校验 component、memberId、页码、分类、关键词和排序；
- 对 Runtime Promise、网络捕获和页面状态分别设定期限；
- 将返回值和网络响应都视为诊断信号，但只由统一解析入口产生事实。

### 6.3 checkpoint 直接恢复

第一阶段保留一个 Store Catalog Work Unit：

```text
page 1 success
  -> partial batch + checkpoint.nextPage=2
  -> release lease
  -> any healthy Profile claims
  -> direct request page 2
```

必须保证：

- 不重新请求 `completedPages`；
- 不需要保留前一 Attempt 的 Page 对象；
- `seenKeys` 和重复来源继续生效；
- 同一 checkpoint 重放得到幂等事实；
- 目录漂移继续作为 warning，不静默覆盖首个 `offerCount`；
- 单页失败只重试目标页，不重演此前页的 DOM 导航。

暂不默认把同一店铺的多个页面并行化。目录在扫描期间可能变化，串行页请求更容易解释 `offerCount` 和重复来源。是否拆成父 Scan 与 Page 子 Work Unit，由 Plan 2 在压力数据支持后决定。

### 6.4 错误合同

拟新增或明确以下错误码：

| 错误码 | 含义 | 默认上层动作 |
| --- | --- | --- |
| `CATALOG_MTOP_RUNTIME_UNAVAILABLE` | 页面未提供 MTOP Runtime | 重建 Page 一次；`auto` 可降级 DOM |
| `CATALOG_REQUEST_INVALID` | 目录请求 scope 不满足 Runtime 合同 | 修复 Work Unit；不得换 Profile 或降级 DOM |
| `CATALOG_REQUEST_REJECTED` | Runtime 请求同步或异步拒绝 | 保存诊断；仅瞬时分类可重试 |
| `CATALOG_RESPONSE_TIMEOUT` | 请求已发出但期限内无目标响应 | 退避后有限换 Profile |
| `CATALOG_RESPONSE_SCOPE_MISMATCH` | 看见响应但目标 scope 不一致 | 不盲目重试，保留匹配摘要 |
| `CATALOG_RESPONSE_SCHEMA_CHANGED` | 目标响应无法由已知 parser 处理 | 隔离样本，阻断该模板 Live Gate |
| `CATALOG_DOM_CONTROL_MISSING` | DOM 降级路径没有目标控件 | 不在多个 Profile 重复 DOM 尝试 |
| `OFFER_SKU_RESPONSE_TIMEOUT` | 详情页未出现 SKU 响应或有效页内模型 | 有限重试并保留 capture diagnostics |
| `QUALIFICATION_RESPONSE_TIMEOUT` | 资质 Runtime 请求无目标响应 | 有限重试，禁止等待到进程总超时 |

兼容原则：

- 已发布错误码不能无迁移说明地改变含义；
- CLI Adapter 必须保留 `retryable/category/actionRequired`；
- 登录、风险、频控仍使用现有稳定错误；
- `schema changed`、输入合同错误和确定性 scope 冲突不应被默认当作普通瞬时错误；
- 错误详情只保存脱敏计数、阶段和安全的 scope 摘要。

### 6.5 Offer Detail 与 Qualification 加固

先建立失败反馈回路，再决定修复：

1. 从本轮 22 次 Offer Detail 失败的 diagnostics/artifact 提取脱敏最小类别；
2. 区分未匹配、匹配未解析、空模型、页面内模型无效和页面状态异常；
3. 用 response mock 或裁剪 artifact 构造能够捕获原症状的回归测试；
4. 检查 listener 是否早于 navigation，懒加载是否需要确定性动作；
5. 保留网络模型与页面内模型的现有双来源，但统一完整度判定；
6. 对 Store Qualification Runtime Promise、response capture 和页面状态添加独立 deadline；
7. cancellation 必须关闭 Page、停止 listener 并使 CLI 在总进程 timeout 前返回结构化错误。

禁止以“把 600 秒改成更长”作为独立修复。

### 6.6 可观测性

每个目录页至少记录以下非敏感指标：

- `transport=runtime|dom`
- `targetPage`
- `catalogRequestCount`
- `runtimeReadyMs`
- `responseWaitMs`
- `parseMs`
- `fallbackReason`
- `seen/matched/parsed/failureCount`
- `memberScopeHash`，不得记录可重放身份材料
- parser/contract 版本
- terminal error code

CollectionBatch 继续保存 immutable `startedAt/completedAt`、scope、完整度、raw evidence ref 和 checkpoint。CLI event 与数据库 Attempt 的 requestId 关联必须可核对。

## 7. 实施阶段

### 阶段 0：冻结基线并建立失败反馈回路

- [x] 将本方案中的统计与机器可读报告逐项核对；
- [x] 为“请求第 2 页却必须点击下一页”增加红色回归测试；
- [x] 为 Runtime 未加载、目标响应迟到、scope 不匹配、parser 失败增加 response mock；
- [x] 为 Offer Detail 和 Qualification 归档失败建立脱敏分类，不复制凭据；
- [x] 记录现有 DOM 路径在 fixture 和受控页面上的请求次数。

退出条件：至少有一条快速、确定、可由 agent 无人值守运行的测试能在旧实现上捕获重复导航问题。

### 阶段 1：实现 Runtime Catalog Transport

- [x] 新增 Store Catalog Runtime Request 类型和纯构造器；
- [x] 复用 Qualification 的页面 Runtime 调用模式；
- [x] 捕获先于请求，关联使用现有 Alisite matcher；
- [x] Runtime 返回、网络响应和 parser 统一进入 `CatalogPageAdapter`；
- [x] 加入 `runtime/dom/auto` 传输选择；
- [x] 维持 fixture adapter 与 Playwright adapter 同形合同；
- [x] 更新 JSON 合同、命令说明、可靠性和 MTOP playbook。

退出条件：离线测试证明请求第 N 页只构造一次 page N Runtime 请求，且不调用 next-page locator。

### 阶段 2：checkpoint 与降级路径

- [x] checkpoint 从新 Page 直接恢复 `nextPage`；
- [x] 验证换 Profile 后不依赖前一浏览器内存；
- [x] 降级只对允许错误发生，并记录原因；
- [x] DOM 降级保留现有分类、关键词和排序动作；
- [x] 防止 Runtime 已成功后又执行 DOM，造成重复请求；
- [x] 校验取消、deadline 和 Page 清理。

退出条件：7 页 fixture/replay 只产生 7 次目录页请求，重放 checkpoint 不采已完成页。

### 阶段 3：Offer Detail、Qualification 与进程终态

- [x] 复现 `OFFER_SKU_CAPTURE_INCOMPLETE` 的主要类别；
- [x] 修复已证明的 listener、页面模型或懒加载问题；
- [x] Qualification 不再依赖 600 秒进程级 timeout 结束；
- [x] CLI Adapter 在取消和 timeout 后能生成权威结构化终态；
- [x] Browser Worker 能区分 CLI 失败与终态数据库协调失败；
- [x] 验证所有 listener、Page 和子进程在结束后释放。

退出条件：相关回归测试先红后绿，且没有通过延长总 timeout 掩盖问题。

### 阶段 4：错误映射与上层兼容

- [x] CLI 错误码、category、retryable 和 actionRequired 完整测试；
- [x] CLI Adapter 对新增错误保持结构化解析；
- [x] Browser Worker 将错误原样提交业务调度层；
- [x] 不在 CLI 内实现无限重试或跨 Profile 调度；
- [x] 更新本方案与后续 Plan 2 的错误矩阵。

退出条件：每个新增错误都有确定性的 CLI、Adapter 和 Browser Worker 合同测试。

### 阶段 5：受控 Live Gate

使用仍有效、已授权的两个 Profile。开始前执行 doctor；遇到登录或风险验证按现有人工边界处理，不静默循环。

实现后的只读入口为仓库根目录的 `pnpm live-gate:plan1`。默认在请求间
等待 1500 ms，并把脱敏 Batch、`summary.json` 和 `report.md` 写入
`var/live-gates/`；可用 `PLAN1_LIVE_GATE_DELAY_MS` 增加间隔，不得用它
关闭 CLI 自身的有界 deadline。

测试矩阵：

- 店铺形态：普通、实力商家、源头旗舰、超级工厂；
- Profile：`default`、`collector-2`；
- 页：第一页、第二页、末页；
- scope：默认、分类、关键词、至少一种排序；
- 路径：Runtime 主路径、一次受控 DOM 降级；
- 恢复：同 Profile checkpoint、跨 Profile checkpoint。

退出条件：

- 正常 Runtime 路径 `CATALOG_NEXT_PAGE_MISSING=0`；
- 每个目标页恰好一次 Catalog Runtime 请求；
- 受控矩阵首 Attempt 成功率不低于 95%；
- 至多一次允许的瞬时重试后成功率为 100%；
- 四类店铺完整扫描均能结束或返回正确的、可解释的业务完整度；
- `offerCount`、页数、uniqueItems 和重复来源与 fixture/现场观察一致；
- 无 Cookie、token、sign、完整请求头或无关个人信息进入日志和 fixture。

## 8. 测试、审查与自检

### 8.1 必须执行的 CLI Gate

在 `1688-cli` 目录执行：

```bash
pnpm typecheck
pnpm test:unit
pnpm build
pnpm agent-context
pnpm docs-check
pnpm agent-map-check
pnpm agent-verify
```

若 `pnpm agent-verify` 因 live doctor 或环境条件失败，必须报告具体命令、错误和是否与本次变更相关，不得省略。

### 8.2 根仓库集成 Gate

在仓库根目录执行：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
git diff --check
```

重点测试：

- CLI Adapter 错误解析和 timeout；
- Browser Worker continuation、Profile Gate、heartbeat 和终态写入；
- Work Unit checkpoint、失败预算和 Profile handoff；
- CollectionBatch 幂等归档；
- Pipeline normalizer 对 Store/Offer/SKU identity 的现有不变量。

### 8.3 独立审查

完成实现后至少安排以下独立审查：

1. 协议与安全审查：确认没有自行签名、凭据持久化或绕过风险验证；
2. 并发与资源审查：确认 listener、Page、进程和 Profile lease 无泄漏；
3. 合同审查：确认公开 JSON 与错误语义向后兼容；
4. 测试审查：确认测试能在旧实现上失败，不是只验证新代码自洽；
5. 现场结果审查：由未实现主路径的 reviewer 核对 Live Gate 原始事件与汇总。

### 8.4 主执行者自检

- [x] 没有未解释的 timeout 增大；
- [x] 没有在同一 Profile 内增加并行浏览器操作；
- [x] 没有把技术失败写成业务 `needs_evidence` 或拒绝；
- [x] 没有改变 Store/SPU/SKU 规范身份；
- [x] 没有重复请求已完成 checkpoint 页；
- [x] 没有在成功 Runtime 请求后重复执行 DOM；
- [x] 没有泄露原始敏感接口材料；
- [x] 所有新错误在 Plan 2 中都有明确调度策略；
- [x] 所有验证结果和残余风险已回填本计划。

## 9. 验收指标

### 9.1 正确性

- `CollectionUnit` 和 `CollectionBatch` schema 兼容；
- page N 响应必须与请求 memberId/pageNum/scope 一致；
- checkpoint 重放不重复商品，不丢失来源；
- Store Catalog 全量目录仍不自动成为任务候选；
- Offer Detail SKU 仍使用显式 `offerId + skuId`；
- 所有 Profile 结果继续由业务系统按稳定身份合并。

### 9.2 可靠性

- Runtime 正常路径下一页控件错误为 0；
- Catalog 页面请求放大系数从 O(P²) 降为 O(P)；
- 受控矩阵首 Attempt 成功率不低于 95%；
- Offer Detail 和 Store Qualification 不出现只能靠 600 秒总进程 timeout 结束的等待；
- 确定性 schema/scope 错误不会在多个 Profile 上盲目重复。

### 9.3 性能

本方案不预设外网固定延迟，但要求：

- 同一页不因恢复重复执行前置页；
- Runtime page request P50/P95 与网络捕获分开报告；
- DOM 降级比例单独报告；
- CLI 页面阶段、进程协议开销和业务队列等待不混为同一指标；
- 相同四类店铺矩阵与第二轮结果形成可比报告。

## 10. 发布、回滚与兼容

发布步骤：

1. 先以 `runtime` 显式模式运行受控测试；
2. 通过后以 `auto` 运行完整 Live Gate；
3. 根仓库 CLI Adapter 和 Browser Worker 集成测试通过；
4. 默认模式切换到 `auto`；
5. 保留 `dom` 模式至少一个发布周期作为诊断回滚；
6. 将版本、parser 版本和 Live Gate 结果交付 Plan 2。

回滚原则：

- Runtime 路径异常时可切回 `dom`，但不得宣称方案验收通过；
- 数据合同迁移必须可加字段兼容；
- 不删除旧错误证据和不可变 CollectionBatch；
- 不使用回滚掩盖 Live Gate 中的店铺模板缺口。

## 11. 向 Plan 2 的交付合同

Plan 2 开始前，本方案必须交付：

- 稳定的指定页 Runtime 请求能力；
- 可跨 Profile 恢复的 checkpoint；
- 新错误码、retryable 和 actionRequired 矩阵；
- `transport/page/requestCount/latency` 观测字段；
- `requestedFacts` 的兼容保留；
- 四类店铺和两个已授权 Profile 的 Live Gate 原始结果；
- CLI 版本、变更说明、测试报告和残余风险。

Plan 2 不得依赖 DOM 下一页作为正常证据采集路径，也不得在上层重新实现 MTOP、页面定位器或 CLI 内部重试。

## 12. 完成定义

只有以下条件全部成立，本方案才可从 `active` 移入 `completed`：

1. 阶段 0-5 全部完成；
2. 默认 CLI Gate 和根仓库集成 Gate 通过，或环境阻断有完整证据；
3. 四类店铺、两个已授权 Profile 的 Live Gate 达标；
4. Store Catalog Runtime 主路径已启用且可回滚；
5. Offer Detail、Qualification 长尾失败已有复现、修复和回归测试；
6. 错误合同已被 CLI Adapter 和 Browser Worker 接收；
7. 独立审查和主执行者自检完成；
8. 文档、generated context 和版本信息同步；
9. Plan 2 接口依赖已冻结；
10. 没有启动第三轮真实 SKU 任务。

## 13. 进度记录

- [x] 2026-07-25：根据第二轮正式运行报告建立方案和基线。
- [x] 阶段 0：反馈回路与红色回归测试。
- [x] 阶段 1：Runtime Catalog Transport。
- [x] 阶段 2：checkpoint 直接恢复与 DOM 降级。
- [x] 阶段 3：Offer Detail、Qualification 和进程终态。
- [x] 阶段 4：错误合同与上层兼容。
- [x] 阶段 5：四类店铺、两个已授权 Profile Live Gate。
- [x] 独立审查与离线自检。
- [x] 完成归档。

2026-07-25 实施记录：

- 红色回归覆盖新 Page 请求第 N 页时的单次 Runtime 调用、7 页只发
  7 次请求、checkpoint 不重采完成页，以及 Runtime Promise 不结束但
  网络响应已关联的情形；
- 历史 Offer artifact 的脱敏分类为 57 个 bundle：37 个英文
  `Captcha Interception` 页面，20 个有效详情页上的显式空
  `skuInfoMap`；两类均已有回归修复；
- Qualification 的 Playwright timeout 参数位置和永不结束的 Runtime
  Promise 已复现，现由独立 deadline 返回结构化错误；
- CLI、Adapter、Worker、Attempt 与 CollectionBatch 的 requestId
  已贯通；同一 WorkUnit Attempt 的普通采集、人工干预和登录恢复复用
  同一 requestId；冻结错误矩阵见
  [Collection CLI Error Matrix](../../../../docs/runbooks/collection-cli-error-matrix.md)；
- 三路独立审查已完成。审查发现的 checkpoint 跨批基线丢失、Batch
  诊断丢失、requestId 目录逃逸、顽固后代进程、悬挂 heartbeat、
  排队取消、Runtime fulfillment 丢弃和 Live Gate 默认路径缺口均已
  修复并加入回归测试。第二轮复核补充的 checkpoint `pageCeiling`
  跨字段约束、heartbeat 服务端 statement timeout、悬挂 Runtime
  上下文释放、capture 结束后的迟到 parser、Worker 动态 retryable
  矩阵和 Live Gate 策略自测也已收口；
- Live Gate runner 现先执行两个已授权 Profile 的 `doctor --no-launch`，
  再执行四店 Runtime smoke、默认 `auto` 全扫描/scope/跨 Profile
  矩阵和显式 DOM rollback；敏感诊断在写盘前阻断，且只对
  `errors[0].retryable=true` 的瞬时错误重试；
- 第一轮 Live Gate 原始输出位于
  `var/live-gates/plan1-2026-07-25T15-32-58-724Z/`。普通店铺和实力商家
  在三个 Profile 上完成 6 次完整扫描，共 33 个目标页、33 次 Runtime
  请求，`responseWaitMs` P50/P95 为 446/601 ms，
  `CATALOG_NEXT_PAGE_MISSING=0`，且 `offerCount=uniqueItems`
  分别闭合为 98 和 199；
- 同一轮后半段三个 Profile 均收到 MTOP
  `FAIL_SYS_USER_VALIDATE / RGV587_ERROR`。该响应最初暴露了
  Runtime Promise 悬挂和错误误分类，现已修复为网络响应优先并返回
  `RISK_CONTROL`，不再当成 schema/request failure。最终矩阵按人工
  边界完成验证后恢复，没有静默循环；
- 离线最终 Gate：CLI `agent-verify` 通过 48 个文件、396 个测试，
  CLI build 通过；根仓库 typecheck/build 通过，完整测试通过 26 个文件、
  254 个测试并按配置跳过 78 个集成测试；PostgreSQL 集成套件在本地
  VS1 数据库单独通过 20 个测试，包含 heartbeat 行锁超时与连接恢复。
  根仓库 `docs:check` 仍只报告变更前已存在的 14 个失效链接，本次新增
  文档和链接不在失败列表中；两个仓库的 `git diff --check` 均通过。
- 最终受控 Live Gate 输出位于
  `var/live-gates/plan1-final-two-profiles-pass/`。`default` 与
  `collector-2` doctor 均正常；四类店铺、完整扫描、分类、关键词、
  排序、跨 Profile checkpoint、显式 Runtime 和一次 DOM rollback
  共 51 个用例全部首 Attempt 成功，首 Attempt/最终成功率均为 100%。
  其中 46 个 `auto` 用例全部走 Runtime，4 个显式 Runtime 页的请求数
  与目标页数均为 4，`CATALOG_NEXT_PAGE_MISSING=0`；
- 两个 Profile 上的 8 次完整扫描分别闭合为普通店 98/98、实力商家
  199/199、源头旗舰 67/67、超级工厂 34/34。51 个目标页的
  `catalogResponseWaitMs` P50/P95 为 412/567 ms；52 个 JSON 结果经
  结构化敏感字段扫描与查询串扫描，未发现 Cookie、token、sign、
  验证 URL 或完整请求头；
- 当前严格 runner 复验输出位于
  `var/live-gates/plan1-final-verified/`，复用并重新校验上述 51 个
  已通过用例，doctor、矩阵覆盖、CLI / schema / parser 版本、
  Profile、transport、page、requestId 和 checkpoint 约束均通过；
- 最终离线 Gate 在加入 headed MTOP 风控恢复与 Live Gate resume
  覆盖后重新执行：CLI `agent-verify` 通过 48 个文件、407 个测试并
  完成 build；根仓库 typecheck/build 通过，完整测试通过 26 个文件、
  258 个测试并按配置跳过 78 个集成测试；PostgreSQL 集成套件再次
  通过 20 个测试。根仓库 `docs:check` 仍仅报告同一组变更前已存在的
  14 个失效链接，两个仓库的 `git diff --check` 通过。

## 14. 决策记录

- 2026-07-25：真实接口证据被判断为足够支撑 Runtime 请求构造；主要缺口是在线触发与恢复，而不是 JSON 字段解析。
- 2026-07-25：优先保留单 Store Catalog Work Unit 的串行 checkpoint，不立即并行同店铺页面。
- 2026-07-25：页面 MTOP Runtime 负责登录态、Cookie 和签名；CLI 不接受或保存调用方提供的可重放凭据。
- 2026-07-25：DOM 翻页降级保留用于回滚和诊断，但不再作为生产主路径。
- 2026-07-25：第三轮真实任务被本方案与 Plan 2 的共同 Gate 阻断。
- 2026-07-25：Runtime Promise 与已关联网络响应分离；网络响应先完成时
  不等待可能永不结束的页面 Promise。有效 Runtime fulfillment 与网络
  响应都进入同一 parser，事实解析仍保持单一入口。
- 2026-07-25：MTOP `FAIL_SYS_USER_VALIDATE / RGV587_ERROR` 属于
  `RISK_CONTROL`，只保存 ret code 与 payload key 摘要，不持久化验证 URL。
- 2026-07-26：用户确认当前只有两个账号；Live Gate 的授权 Profile
  冻结为 `default` 和 `collector-2`。四类店铺、scope、完整扫描、
  Runtime/DOM 与跨 Profile checkpoint 的覆盖不缩减，`collector-3`
  不再作为 Plan 1 或 Plan 2 的前置条件。
- 2026-07-26：headed 模式收到 MTOP 风控响应时，只在内存中使用经
  1688/淘宝/天猫/阿里域名白名单校验的验证 URL，等待人工完成后重建
  页面并对同一目录页重试一次；URL 和可重放凭据不得进入 Batch、
  diagnostics 或 Live Gate 结果。
- 2026-07-26：Live Gate 允许从版本、parser 和 Profile 完全一致的
  先前结果中复用已成功用例；复用前重新校验 requestId、unitId、
  transport、目标页和敏感字段，从而避免人工风控解除后重复请求已经
  完成的 checkpoint 页。
