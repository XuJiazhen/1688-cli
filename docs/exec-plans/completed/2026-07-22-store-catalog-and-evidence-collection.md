# Plan: Store Catalog And Evidence Collection

## 目标

补齐 `1688-cli` 面向 VS1 选品生产系统的事实采集能力，使业务系统能够把外部采集动作拆成有界、幂等、可恢复的采集单元，由 CLI 使用当前登录的 Playwright Profile 执行，并返回可入库、可审计的事实批次。

本计划交付的是 1688 采集适配能力，不是完整选品业务系统。最终链路为：

```text
SelectionTask + TaskSnapshot
  -> 业务系统证据需求规划器
  -> CollectionUnit 队列
  -> 1688 Browser Worker / CLI
  -> CollectionBatch 入库
  -> 结构化规则 / AI 语义规则 / 决策策略
  -> ReadyForReviewSKU
  -> 客户审核
  -> QualifiedSKU
  -> 未达目标时继续补量
```

例如任务“关键词帐篷、目标 300 个合格 SKU”中的 `300` 是业务系统的最终生产目标，表示客户审核通过的 `QualifiedSKU` 数量。它不是 CLI 的抓取上限，也不由 CLI 判断是否达成。CLI 只执行业务系统下发的下一批搜索、店铺目录、资质、商品详情或媒体清单采集单元。

本计划优先交付以下能力：

- 把现有一次性搜索结果扩展为按批次、游标和检查点执行的增量搜索协议。
- 采集店铺全部商品、店铺分类，以及分类、关键词和排序条件下的分页商品。
- 保留商品销量、类目、图片引用、店铺身份、采集范围和来源等可审计事实。
- 扩展店铺资质事实，重点采集工商登记经营范围。
- 提取主图、SKU 图和详情图 URL、角色及顺序，不在初始采集阶段永久下载图片。
- 为长任务提供有界批次、检查点、幂等恢复、部分成功和风控状态输出。
- 让业务系统可以基于字段新鲜度和完整度复用历史事实，只补采缺失或过期证据。

## 成功标准

完成本计划后，应满足：

- 业务系统能以稳定 `CollectionUnit` 接口下发一次有界的只读采集动作。
- CLI 返回的 `CollectionBatch` 可被业务系统幂等入库，不包含最终准入结论。
- 同一采集单元重试、换 Profile 或从检查点恢复不会重复计入商品或丢失来源。
- 搜索命中能够稳定关联 `offerId`、`memberId` 和规范化店铺链接。
- 四类店铺的目录响应能由统一解析入口处理，分页结果带完整度和来源元数据。
- 经营范围、原始销量字段和媒体 URL 的缺失、未采集、解析失败和真实空值可以区分。
- 登录或风控发生时停止当前单元，保留已提交批次并返回可供上层重新调度的动作要求。
- 原始证据和诊断输出不泄露 Cookie、token、sign、完整请求头或无关个人信息。
- 业务系统可以在不重新访问 1688 的情况下，用已入库事实重跑新的规则版本；只有事实缺失或过期时才重新采集。

## 架构边界

### CLI 负责

- 使用受控 Playwright Profile 访问 1688 页面和页面运行时接口。
- 执行搜索页、店铺目录页、店铺分类、店铺资质、商品详情和媒体清单等有界采集单元。
- 解析、规范化并返回原始事实、字段可用性、采集范围、完整度、检查点和错误。
- 在采集单元内部执行请求关联、分页上限、去重和输出整形等采集必需逻辑。
- 保持公开 JSON 合同可加字段兼容，并提供 fixture 回放验证。

### CLI 不负责

- 不保存 `SelectionTask`、规则集、规则快照、商品池、客户审核或最终合格状态。
- 不连接业务系统数据库，不自行决定缓存 TTL，也不把本地 CLI 缓存当成业务事实缓存。
- 不理解“品牌不超过 5”“关联品类组不超过 3”等准入规则，不输出 `QualifiedSKU`。
- 不决定是否继续补量、何时达到 300 个合格 SKU，或客户退回后如何整改。
- 不把 1688 当作规则查询数据库反复按业务条件过滤。业务过滤基于已入库事实执行。
- 不在初始采集阶段永久下载全店图片，也不调用文本、视觉或图片编辑模型。

### 业务系统负责

- 冻结任务采集参数、规则版本、规则参数、处置策略和计量配置。
- 根据启用规则的 `required_facts` 和 `completeness` 编译证据需求，并创建有界 `CollectionUnit`。
- 接收 `CollectionBatch`，幂等写入业务主库和受控证据存储。
- 按事实类型、采集范围、采集时间、解析器版本和完整度判断缓存是否可复用。
- 执行结构化规则、AI 语义规则、人工例外、客户审核、整改和最终生产计数。
- 根据最终合格数量、待审核在途量、漏斗通过率和供给状态继续补量或暂停。
- 在视觉规则真正需要图片时通过 Media Gateway 延迟抓取；进入审核或待上架阶段后再永久物化所需图片资产。

业务系统和 CLI 之间的 seam 固定为：

```text
CollectionUnit -> Collection Module -> CollectionBatch
```

CLI 命令是该 Module 的一个调用入口；未来云端 Browser Worker 可以先以子进程方式调用 CLI，稳定后再直接复用同一 TypeScript Module。fixture/replay adapter 与 Playwright adapter 必须满足相同接口，使测试不依赖在线 1688。

## 真实数据依据

`/Users/jiazhenxu/Codes/open-source/1688/1688tojd/1688 StoreCatalog Collector/` 是用户在已登录的真实 1688 页面中手动操作后保存的真实请求、响应和页面数据，不是推测性接口说明。本目录是解析器、受控探测和 fixture 的证据依据。

当前真实样本覆盖：

- 普通店铺、实力商家、源头旗舰、超级工厂四种店铺形态。
- 店铺首页商品列表、全部商品列表、指定分类列表和店内关键词搜索。
- `mtop.alibaba.alisite.cbu.server.ModuleAsyncService` 与组件 `Wp_pc_common_offerlist`。
- `offerCount`、店铺分类及分类商品数映射、分页参数、排序和商品条目。
- `vagueSaleQuantity`、`thirtySaleQuantity`、`bookedCount` 等原始销量字段。
- `userDefined` 店铺自定义分类；当前样本中该字段可能是字符串，解析器必须显式处理有效、空和非法字符串。
- 店铺资质页的工商登记经营范围及相关主体信息。
- 商品详情页 `offer_details.content` 中的详情图片数据。

已核验的全店第一页样本均为 30 条，`offerCount` 分别为 `199`、`96`、`67`、`33`，对应 `7`、`4`、`3`、`2` 页。第一页足以冻结字段解析，但不足以独立证明跨页请求关联和恢复行为，因此阶段 0 还要建立跨页 fixture：可先由真实结构构造脱敏的 page 2，再在受控在线验证中捕获至少一组真实 page 2。

这些原始文档可能包含 Cookie、MTOP token/sign、账号标识、电话、企业负责人等敏感信息，因此：

- 原始目录只作为本地证据保存，不纳入 `1688-cli` 版本控制，也不复制到测试输出。
- 单元测试只保存从真实样本派生的脱敏、裁剪最小 fixture。
- fixture 删除 Cookie、token、sign、完整请求头、账号身份、电话及与断言无关的个人信息。
- 增加自动秘密扫描和字段 allowlist，不能只依赖人工检查。
- 测试不回放签名或登录凭据；在线验证由当前浏览器会话生成请求。
- 若接口字段变化，先保存新的受控证据，再更新 fixture、解析器版本和兼容逻辑。

## 现有基础与已确认缺口

实施前以以下模块为基线：

- `src/commands/search.ts`：全站搜索、分页、排序和列表采集。
- `src/session/search-mtop.ts`：搜索结果映射，已保留 `memberId`、`loginId` 和 `shopAddition.shopLinkUrl`。
- `src/commands/offer.ts`：商品详情、SKU、店铺卡、代发卡、主图和 `detailUrl`。
- `src/commands/supplier-inspect.ts`：供应商身份和工厂卡检查入口。
- `src/session/response-capture.ts`：当前单响应捕获与诊断。
- `src/session/dispatch.ts`：命令分派和会话生命周期。
- `src/session/offer-evidence.ts`：商品页共享证据采集。
- `src/session/recovery.ts`：登录、风控、频控、网络和页面异常分类。
- `src/session/artifacts.ts`：失败页面、网络和响应诊断证据。

已确认缺口：

- 当前 `search` 一次返回完整结果，不提供业务系统可提交的显式下一游标和批次检查点。
- 当前 `startResponseCapture` 在第一个有效响应后结束，不适合多页、并行模块和请求元数据关联。
- CLI 尚无 `supplier catalog` 命令和店铺目录统一解析器。
- `supplier inspect` 尚未输出 `businessInfo.companyBusinessLine`。
- `offer` 尚未解析 `offer_details.content` 的详情媒体清单。
- 某些 SKU 缺失销量会被折成 `0`，必须改成可空并带可用性。
- 当前 daemon 调用五分钟超时并以单个 JSON 响应返回，不适合作为无界生产任务协议。
- 当前响应诊断和网络 artifact 可能保存完整 MTOP URL；在扩展采集前必须集中脱敏查询参数。

新代码优先加深共享采集 Module，不在多个命令中重复监听、轮询、请求关联或解释响应结构。

## 目标接口

### CollectionUnit

业务系统不把完整 `SelectionTask` 或“目标 300 个合格 SKU”交给 CLI，而是下发一次有界采集单元：

```ts
type CollectionKind =
  | "search-page"
  | "store-catalog"
  | "store-categories"
  | "store-qualification"
  | "offer-detail"
  | "offer-media-manifest";

type SupplierRef = {
  memberId?: string;
  shopUrl?: string;
  sourceOfferId?: string;
};

type CollectionUnit = {
  schemaVersion: 1;
  unitId: string;
  taskId?: string;
  kind: CollectionKind;
  subject: {
    keyword?: string;
    offerId?: string;
    supplier?: SupplierRef;
  };
  scope?: {
    requestedScope?: "page" | "bounded-pages" | "full-scan";
    categoryId?: string;
    storeKeyword?: string;
    sort?: string;
    cursor?: string;
    pageSize?: number;
    maxPagesPerBatch?: number;
    requestedFacts?: string[];
  };
  limits?: {
    maxItems?: number;
    deadlineMs?: number;
  };
};
```

`SupplierRef` 支持从 `offerId`、搜索结果中的 `memberId + shopLinkUrl` 或直接店铺链接进入。规范化优先级为稳定 `memberId`、经过校验的规范化店铺 URL、来源 `offerId`。名称和 `loginId` 不作为唯一店铺键；身份冲突返回警告或失败，不静默合并。

`maxPagesPerBatch` 限制一次外部动作的规模。是否继续下一批由业务系统在批次入库和规则执行后决定，CLI 不持有生产循环。

### CollectionBatch

```ts
type CollectionBatch = {
  schemaVersion: 1;
  batchId: string;
  unitId: string;
  kind: CollectionKind;
  status: "completed" | "partial" | "blocked" | "failed";
  startedAt: string;
  completedAt: string;
  subject: Record<string, unknown>;
  scope: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  completeness: {
    requestedScope: "page" | "bounded-pages" | "full-scan";
    state: "complete" | "truncated" | "unknown";
    observedPages: number[];
    failedPages: number[];
    expectedItems?: number;
    uniqueItems: number;
  };
  duplicateObservations: Array<{
    key: string;
    firstSource: string;
    duplicateSource: string;
  }>;
  warnings: CollectionWarning[];
  errors: CollectionError[];
  checkpoint?: CollectionCheckpoint;
  actionRequired?: {
    type: "login" | "risk-control";
    message: string;
  };
  rawEvidenceRefs: string[];
  metrics: Record<string, number>;
};
```

`partial` 是批次状态，不作为异常码。已经成功取得的观察事实必须返回并可入库；批次失败不删除此前已提交的批次。

### CollectionCheckpoint

```ts
type CollectionCheckpoint = {
  schemaVersion: 1;
  unitFingerprint: string;
  kind: CollectionKind;
  subject: Record<string, unknown>;
  scope: Record<string, unknown>;
  nextCursor?: string;
  nextPage?: number;
  completedPages: number[];
  seenKeys: string[];
  pendingKeys: string[];
  attemptCounts: Record<string, number>;
  updatedAt: string;
};
```

`unitFingerprint` 由会改变外部采集语义的字段计算。检查点与当前单元不兼容时拒绝恢复，不能猜测迁移。搜索和目录用 `offerId` 去重；媒体只保存 URL 引用，后续业务系统物化资产时使用内容哈希去重。

### Evidence

```ts
type EvidenceSource = {
  sourceType:
    | "search-payload"
    | "offer-payload"
    | "supplier-payload"
    | "store-catalog"
    | "page-dom";
  api?: string;
  componentKey?: string;
  fieldPath?: string;
  sourceRef: string;
  collectedAt: string;
  collectorVersion: string;
  parserVersion: string;
  rawRef?: string;
};

type Evidence<T> =
  | { availability: "available"; value: T; source: EvidenceSource }
  | {
      availability: "not-present" | "not-collected" | "failed";
      value: null;
      source: EvidenceSource;
      error?: { code: string; message: string };
    };
```

公开 `sourceRef` 只能是脱敏后的稳定引用，不包含完整 MTOP URL、token 或 sign。是否把 Evidence 包装放在规范化记录旁的字段证据表中，由业务系统存储设计决定；CLI 输出必须提供同等语义。

## 业务系统入库与缓存契约

本计划不实现业务数据库，但 `CollectionBatch` 必须支持以下数据模型：

- 稳定身份：`Store`、`Offer`、`SKU`、`RemoteMediaRef`。
- 不可变观察：`SearchSnapshot`、`StoreCatalogSnapshot`、`OfferSnapshot`、`QualificationSnapshot`。
- 执行事实：`CollectionUnit`、`CollectionBatch`、`Checkpoint`、失败 artifact 和成本/资源指标。
- 任务引用：任务绑定实际使用的 observation/snapshot，不把之后的新抓取静默覆盖进历史任务。
- 当前投影：业务系统可以查询最新可用观察，但不可覆盖或删除历史观察。

业务系统判断缓存命中的键至少包含：

```text
tenant + subject identity + fact/scope + collectedAt/validUntil
+ collectorVersion + parserVersion + completeness
```

店铺身份、经营范围、目录、商品详情、价格、库存和媒体引用可以有不同新鲜度策略。CLI 不内置 TTL，只提供业务系统判断缓存所需的元数据。新的规则版本可以复用仍然有效的原始事实并重新执行规则；若新规则新增事实需求，证据需求规划器只创建缺失采集单元。

原始响应不直接塞入每条商品记录。小型规范化事实进入数据库，大型或敏感原始响应由业务系统放入受控对象存储，数据库只保存校验和、大小、脱敏状态和 `rawRef`。

## 媒体延迟物化

本计划把“采集图片引用”和“下载图片资产”分开：

- CLI 初始采集只输出主图、SKU 图、详情图的原始 URL、规范化 URL、角色、顺序、来源和采集时间。
- CLI 安全解析 `offer_details.content`，禁止 `eval`，不在目录或详情采集阶段批量永久下载图片。
- 业务系统的视觉规则需要图片时，通过独立 Media Gateway 延迟抓取，计算内容哈希并生成模型可访问的临时或签名 URL。
- 进入客户审核、待上架或用户触发去水印/上架时，业务系统再把所需原图永久物化到对象存储。
- 模型输入必须记录实际图片 URL 清单、抓取时间和可用时的内容哈希；只记录可能变化的远端 URL 不足以复现视觉结论。
- AI 已处理但最终淘汰的图片保留期限和永久归档策略由业务系统配置，不进入 CLI。

因此原计划中的 `downloadImages` 不再是 `1688-cli` 初始采集合同。后续确有需要时，可为 Media Gateway 增加独立的公共图片下载 adapter，但它不占用 1688 Browser Worker，也不进入本计划的 CLI 里程碑。

## 实施阶段

### 阶段 0：冻结合同、脱敏和 fixture

- 把 `CollectionUnit`、`CollectionBatch`、`CollectionCheckpoint`、`Evidence`、错误码和版本策略写入 `docs/JSON_CONTRACTS.md`。
- 从四类真实店铺样本各选取最小响应片段。
- 为全部商品、分类、分类过滤、关键词搜索和排序建立脱敏 fixture。
- 为资质经营范围和 `offer_details.content` 建立脱敏 fixture。
- 建立 page 1 + page 2 跨页 fixture，包含至少一个重复 `offerId`，验证检查点恢复和来源保留。
- 记录字段路径、空值语义、数据来源、样本观察时间和解析器版本。
- 增加 fixture 秘密扫描：拒绝 Cookie、`_m_h5_tk`、token、sign、完整 Authorization、电话和无关个人信息。
- 增加统一 URL/请求元数据脱敏器，先覆盖响应捕获诊断、network artifact 和错误详情。
- 先写解析器和合同测试，再接浏览器采集。

验收：合同能表达有界单元、部分批次、检查点、字段可用性和动作要求；fixture 不含可重放凭据或无关隐私；现有错误码兼容策略明确。

### 阶段 1：共享 Alisite 请求关联与采集 Module

新增共享 Module，例如 `src/session/alisite-module.ts`：

- 监听 Alisite 模块接口，以 API 名和 `componentKey` 匹配候选响应。
- 进一步解析脱敏请求元数据，核对 `memberId`、`pageNum`、`count`、`catId`、`keywords` 和 `sortType`，避免迟到响应或并行模块污染当前页。
- 解析 `Wp_pc_common_offerlist`，不依赖四类店铺首页 DOM 一致。
- 通过当前登录浏览器和页面运行时发起请求，不保存或手工复用 sign/token。
- 支持一次动作对应一个或多个目标响应，不修改现有单响应捕获器去承载所有语义。
- 接受 `AbortSignal` 或等价取消信号，统一处理超时、取消、页面关闭、登录失效和风控。
- 只把有限、脱敏的来源引用交给命令层，命令层不理解接口内部结构。

验收：四类店铺样本由同一解析入口得到稳定结果；不同页或不同组件的响应不会串批；未知组件、字段缺失和解析异常返回可诊断错误，不静默给出空列表。

### 阶段 2：增量搜索批次

在不破坏现有 `1688 search` 输出的前提下增加生产型搜索批次接口：

- 支持显式页码或不透明 continuation cursor。
- 每批返回来源页、远端排序参数、原始排名、采集时间和下一检查点。
- 保留 `offerId`、`memberId`、`loginId`、`shopAddition.shopLinkUrl` 和规范化店铺链接。
- 按 `offerId` 幂等去重，但同一 offer 在不同页或不同时间的观察分别保留来源。
- 支持业务系统分批入库后决定是否继续，不要求一次返回整个搜索结果集。
- 保留现有命令作为兼容入口；新增 `search scan` 子命令或等价 `collect --kind search-page` 入口由实现时按 Commander 结构选择。

验收：从 page 1 检查点恢复 page 2 不重复计数；结果漂移和重复 offer 有确定输出；旧 `search` JSON 合同继续通过。

### 阶段 3：Store Catalog Collector

新增 `supplier catalog <target>` 命令和内部采集 Module。`target` 支持 offerId、`b2b-*` memberId 和店铺 URL，并规范化为 `SupplierRef`。

功能包括：

- 全部商品分页。
- 店铺分类和 `userDefined` 分类。
- 指定分类分页。
- 店内关键词搜索。
- 页面支持的排序方式，并保留实际请求参数。
- `pageNum`、`pageSize`、`offerCount`、`totalPages`、实际页数和完整度。
- 按 `offerId` 去重，记录重复观察、异常页和总数漂移。
- 按 `maxPagesPerBatch`、总页数、截止时间、取消或风险状态停止。
- 输出下一检查点，允许从最后成功批次恢复。

商品观察至少保留：

- `offerId`、标题、商品 URL、主图 URL 和类目相关字段。
- 原始价格、起批和列表可获得的 SKU 摘要。
- `vagueSaleQuantity`、`thirtySaleQuantity`、`bookedCount` 及其他观察到的销量字段，互不覆盖。
- 店铺 `memberId`、规范化店铺 URL、身份标签和来源 offer。
- 查询、分类、排序、页码、页内位置和采集时间。

店铺目录快照至少保留：

- `memberId`、店铺 URL 和身份标签。
- 全店 `offerCount`。
- 分类树、分类 ID、各分类商品数映射和 `userDefined` 原始值/解析结果。
- 计划范围、实际抓取页、唯一商品数、失败页、开始/结束时间和完整性状态。
- `offerCount`、分类计数和唯一商品数不一致时的证据告警，不擅自修正。

CLI 不计算“至少 5 个销量大于 0”“商品总数不超过 1500”“品牌不超过 5”或“关联品类不超过 3”。业务系统在批次入库后执行这些规则，并决定是否继续下发下一目录批次或取消不再需要的下游采集。

验收：目录事实足以支持规则中心计算活跃商品数、商品总数、分类/行业、品牌证据和同店相似候选；CLI 输出中没有准入布尔值。

### 阶段 4：店铺资质证据

扩展 `supplier inspect` 或增加共享 qualification collector：

- 采集并结构化 `businessInfo.companyBusinessLine`。
- 区分工商登记经营范围、店铺自述、生产服务、认证图片、证书列表和平台标签。
- 保留主体名称、统一社会信用代码等业务判断确实需要的字段，同时对日志、fixture 和调试输出脱敏。
- 明确 `certList=[]` 是“该列表没有证书项”，不是“没有经营资质”。
- 返回来源、采集时间、可用性和解析告警，不返回“允许销售”结论。
- 资质证据可以独立刷新，不强制重抓仍然新鲜的全店目录。

验收：业务系统可把经营范围与目标品类、商品属性或专项规则交给语义规则；字段缺失、空值和采集失败不会混淆。

### 阶段 5：Offer 事实与媒体清单

扩展商品详情采集：

- 把 SKU 销量、价格、库存等缺失值改为可空并附带可用性，不再把未知折成 `0`。
- 保留主图、SKU 图、详情图各自角色和顺序。
- 安全解析 `offer_details.content`，禁止 `eval`。
- 提取详情图片原始 URL、规范化 URL、出现顺序、来源字段和采集时间。
- 单个媒体 URL 解析失败不丢弃整个商品，返回逐项告警和可恢复项。
- 不在该阶段下载图片字节，不计算只有下载后才能得到的内容哈希、MIME、尺寸和字节数。
- 保持现有 `offer` JSON 合同可加字段兼容。

验收：真实样本中观察到的详情图数量和顺序可稳定复现；主图、SKU 图、详情图可分别查询；媒体 URL 不可用不伪装为商品规则失败。

### 阶段 6：统一 Collection 入口与 Worker 集成合同

在前述采集 Module 稳定后增加统一 `collect` 入口：

- 接收单个版本化 `CollectionUnit`，而不是完整业务选品任务。
- 校验 `schemaVersion`、`unitId`、subject、scope、limits 和 checkpoint fingerprint。
- 调用相应搜索、目录、资质、详情或媒体清单 Module。
- 输出单个 `CollectionBatch`，支持 JSON 和写入指定结果文件；大批记录可以使用 JSONL/manifest，stdout 只返回摘要和引用。
- 每批完成后由调用方入库；CLI 不维护跨批次业务数据库。
- 默认有界执行。可能超过 daemon 五分钟限制的采集入口使用 inline/no-daemon 路径或由 Browser Worker 直接调用 Module，不通过一个无界 daemon 请求承载完整任务。
- 支持 Profile 级串行和 Profile 间并行；账号租约、角色池和换号由业务系统负责。

验收：fixture adapter 和 Playwright adapter 对相同单元返回同形合同；业务系统可以按 `unitId + batchId` 幂等入库；CLI 进程重启后可由 checkpoint 恢复。

## 风控、失败与恢复

沿用现有稳定错误语义：

- `NOT_LOGGED_IN`，退出码 `3`。
- `RISK_CONTROL`，退出码 `4`。
- 新增或统一 `PAGE_CLOSED`、`CAPTURE_TIMEOUT`、`RESPONSE_SCHEMA_CHANGED`、`COLLECTION_CANCELLED`。
- 网络、频控和页面变化继续交给现有 recovery 分类器处理。

不新增 `LOGIN_REQUIRED`、`RISK_CONTROL_REQUIRED` 与现有代码并存。`actionRequired.type` 使用 `login` 或 `risk-control` 表达上层动作，错误码仍保持仓库现有合同。

恢复规则：

- 风控或登录失效时立即停止当前 Profile 的新请求，返回已完成观察和检查点。
- CLI 不自动绕过验证，不在同一账号上静默循环重试。
- 业务系统结束账号租约后，可以把同一幂等单元交给同角色健康账号继续。
- 检查点记录查询范围、最后成功页、已见键、待补项和尝试次数。
- 技术失败不写成业务淘汰、规则 unknown 或客户退回。
- `PAGE_CLOSED` 等瞬时故障可按现有 recovery 策略有限重试；重试仍失败时返回可重新调度状态。
- 批次已经成功入库后，即使后续批次失败也不得回滚已入库事实。

## 测试与验收

### 单元与合同测试

- 四类店铺的 `Wp_pc_common_offerlist` 都能被统一解析。
- 全店样本的总量与分页计算一致：199/7 页、96/4 页、67/3 页、33/2 页。
- page 1 检查点恢复 page 2，不重放已提交页，不重复计入重叠 offer，并保留重复来源。
- 请求关联校验 API、`componentKey`、memberId、页码、分类、关键词和排序。
- 分类商品数映射与 `offerCount` 的差异作为告警，不假设分类层级可简单求和。
- 分类、关键词、排序和页码参数原样进入采集元数据。
- `vagueSaleQuantity`、`thirtySaleQuantity`、`bookedCount` 不互相覆盖，缺失不折成 0。
- `userDefined` 的有效字符串、空字符串和非法字符串都有确定输出。
- `businessInfo.companyBusinessLine` 在 `certList` 为空时仍能输出。
- 详情图片样本分别复现 14 张和 19 张，顺序稳定。
- 响应缺字段、未知结构、重复商品、总数漂移和部分页失败都有确定输出。
- checkpoint fingerprint 不匹配时拒绝恢复。
- 同一 `unitId + batchId` 重放可由示例 ingestion fake 幂等处理。
- fixture 和诊断 URL 通过秘密扫描，不含可重放凭据。
- 旧 `search`、`offer`、`supplier inspect` JSON 合同继续通过。

### Module 与命令测试

- fixture/replay adapter 不启动浏览器即可完成搜索、目录、资质、详情和媒体清单单元。
- Playwright response mock 能模拟并行组件、迟到响应、页面关闭和取消。
- `supplier catalog` 的 offerId、memberId 和店铺 URL 输入规范化一致。
- bounded batch 达到页数、条数或 deadline 后返回 checkpoint，而不是挂起。
- `collect` 输出摘要、JSONL/manifest 引用和完整批次合同。
- 可能超时的多页命令不依赖五分钟 daemon 单请求完成。

### 受控在线验证

- 开始在线验证前运行 `1688 doctor --no-launch --json`。
- 使用当前登录 Playwright Profile 对四类店铺各执行一次有限页验证。
- 至少对一个店铺捕获真实 page 1 + page 2，验证检查点恢复。
- 验证全部商品、分类过滤、店内搜索和一种非默认排序。
- 验证一条资质经营范围和两条商品详情媒体清单。
- 不在自动测试中回放 Cookie、token 或 sign。
- 返回退出码 `3` 时停止并提示用户执行 `1688 login`，不循环登录。
- 返回退出码 `4` 时停止并请求用户使用 headed 模式完成验证，不扩大请求量。

### 业务系统集成验收

本计划不实现规则引擎，但提供最小 fake ingestion/consumer 验证：

- 一个搜索批次写入后可以按稳定店铺身份归并命中。
- 同一店铺的新鲜完整目录快照可以被第二个任务复用，不触发 CLI。
- 新规则要求经营范围而缓存缺失时，只产生 qualification 单元。
- 目录过期时插入新快照，历史任务仍引用旧快照。
- 规则层能从数据库事实计算结论，而不是要求 CLI 返回准入判断。
- 客户退回或合格数量变化只影响业务系统补量，不改变 CLI 单元合同。

### 工程验证

```bash
pnpm typecheck
pnpm test:unit
pnpm agent-context
pnpm docs-check
pnpm agent-map-check
pnpm agent-verify
```

## 可观测性

每个批次记录但不泄露凭据：

- `unitId`、`batchId`、kind、Profile、店铺/offer 脱敏标识、接口组件、页码、尝试次数和耗时。
- 请求成功、空响应、解析失败、超时、风控、登录和页面关闭次数。
- 已观察 SPU、SKU、店铺、媒体引用和去重数量。
- 请求页数、唯一商品数、失败页、`offerCount` 漂移和完整度。
- CPU、进程常驻内存、系统可用内存和磁盘占用快照。
- 部分结果路径、检查点、恢复来源和恢复结果。
- 解析器版本、collector 版本和 raw evidence 引用数量。

CLI 只记录采集阶段物理用量。最终合格 SKU、漏斗通过率、AI/图片成本、人工例外和客户退回成本由业务系统账本记录。

日志、事件和 artifact 不包含完整请求头、Cookie、token、sign、未脱敏 MTOP URL 或无关主体隐私。截图和页面 HTML 属于受控失败证据，不进入普通公开输出，并遵守业务系统的保留策略。

## 里程碑

- [x] 阶段 0：冻结 CollectionUnit/Batch/Checkpoint/Evidence 合同、脱敏器和 fixture。
- [x] 阶段 1：实现共享 Alisite 请求关联与采集 Module。
- [x] 阶段 2：实现增量搜索批次和搜索检查点。
- [x] 阶段 3：实现 Store Catalog Collector 和分页恢复。
- [x] 阶段 4：补齐店铺资质经营范围证据。
- [x] 阶段 5：补齐 Offer 字段可用性和媒体清单，不做初始图片下载。
- [x] 阶段 6：实现统一 Collection 入口和 Worker 集成合同。
- [x] 完成离线、在线、集成和工程验证。
- [x] 更新 JSON 合同、命令文档、架构图、功能清单和 generated context。

## 决策记录

- 2026-07-22：CLI 定位为原始事实采集器和有界采集单元执行器，不承载最终准入规则、商品池或生产调度。
- 2026-07-22：任务目标以客户审核通过的最终 `QualifiedSKU` 计数；目标数量不进入 CLI 停止语义。
- 2026-07-22：业务系统从规则快照的事实要求和完整度生成 CollectionUnit；CLI 不读取或解释规则中心配置。
- 2026-07-22：采集事实必须可入库，但业务数据库、缓存 TTL 和事实复用由业务系统负责，CLI 不直接连接业务库。
- 2026-07-22：同一主体的新观察以不可变快照追加，历史任务绑定实际使用快照，不用最新值覆盖历史。
- 2026-07-22：品牌上限默认 5、关联品类组上限默认 3 等参数由业务规则中心配置，不硬编码进 CLI。
- 2026-07-22：`certList` 为空不阻断资质采集，经营范围以 `businessInfo.companyBusinessLine` 为主要事实。
- 2026-07-22：初始采集只保存媒体 URL、角色和顺序；AI 需要时延迟抓取，进入审核/待上架或触发图片动作时再永久物化。
- 2026-07-22：将 `1688 StoreCatalog Collector/` 认定为真实线上抓取证据，但因登录态和主体隐私只保留在本地；版本库只保存脱敏最小 fixture。
- 2026-07-22：优先使用页面实际使用的 `Wp_pc_common_offerlist`，通过 API、`componentKey` 和请求元数据关联响应，避免绑定某一种店铺首页 DOM。
- 2026-07-22：沿用 `NOT_LOGGED_IN`、`RISK_CONTROL` 和退出码 3/4，不引入第二套登录/风控错误名。
- 2026-07-22：一次 CLI 调用执行有界 CollectionUnit；完整选品任务和持续补量循环由业务系统编排。
- 2026-07-23：真实 Alisite MTOP 请求把模块 `data` 放在 POST form body，而不是 URL；关联器同时解析 URL 与 `postData`，但只持久化脱敏来源引用。
- 2026-07-23：店铺页面不保证读取 URL 中的分类、关键词和排序参数；Playwright adapter 必须操作页面控件，再用浏览器实际生成的请求元数据确认范围。
- 2026-07-23：恢复到店铺第 N 页时从新页面按 UI 顺序重放第 1 至 N 页导航；不手工构造或重放 MTOP sign/token。
- 2026-07-23：资质接口通过已加载页面的 `window.lib.mtop.request` 发起，由页面运行时生成认证参数；CLI 不在 Node 侧拼装签名请求。
- 2026-07-23：资质接口的 `memberId` 参数同时接受安全的 `b2b-*` 身份、店铺登录式 member key 和纯数字 member key；不得把接口参数错误收窄为仅 `b2b-*`。CollectionUnit 已提供安全 member key 时直接使用，缺失或非法时才从店铺页面请求解析。
- 2026-07-23：详情脚本在线结构同时出现 `content:` 与 JSON 风格的 `"content":`；安全解析器兼容两者且继续禁止 `eval`。
- 2026-07-23：商品详情只有在确认取得 SKU selector model 后才能标记采集完成；网络响应优先，缺失时使用同页 SSR `window.context` 中的 SKU model，两个来源都缺失则返回可重试技术失败。已捕获但没有稳定 `skuId` 的空 model 仍作为完成事实交给业务系统处理。

## 进度记录

- 2026-07-22：完成真实样本目录盘点和初始实施边界确认。
- 2026-07-22：结合最新 PRD、规则目录和合格 SKU 生产漏斗，补齐采集 seam、入库/缓存边界、媒体延迟物化、增量搜索、错误兼容和分阶段验收方案。
- 2026-07-23：完成协议、检查点指纹、集中脱敏、秘密扫描和四类店铺/跨页/资质/搜索/媒体最小 fixture；14 张与 19 张详情图 fixture 顺序均有确定测试。
- 2026-07-23：完成 Alisite 统一解析与请求关联、增量搜索、`supplier catalog`、资质事实、Offer 可空字段、媒体清单和统一 `collect` 入口；fixture 与 Playwright 使用同一 `CollectionRuntime` 合同。
- 2026-07-23：完成受控在线验证。`doctor --no-launch --json` 登录态健康；四类店铺目录均成功，分类过滤返回 2/2、店内关键词加销量排序返回 3/3，真实 page 1 + page 2 检查点恢复累计 60 个唯一商品，资质经营范围可用，两条商品媒体清单分别得到 17 和 16 个媒体引用。
- 2026-07-23：完成“帐篷”真实搜索页采集，单批 60 个唯一 offer，搜索观察保留供应商 `memberId` 和规范化店铺链接；全程未出现登录失效或风控动作要求。
- 2026-07-23：完成工程收口：类型检查、构建、generated context、文档新鲜度、Agent Map、发布元数据和 `git diff --check` 均通过；离线套件 45 个文件/296 个测试通过，含 live doctor 的完整套件 46 个文件/298 个测试通过，构建产物的 `collect`、`supplier catalog` 帮助和 fixture 冒烟均通过。
- 2026-07-23：业务系统有界 live 回归发现部分详情页未观察到 SKU 接口却被误记为完成；新增网络/SSR 双来源 SKU model、缺失硬门和脱敏回归测试。离线套件现为 46 个文件/306 个测试，完整 `agent-verify` 通过。
- 2026-07-23：业务系统单 Profile 有界闭环归档 6 个完成详情批次并形成 94 个稳定 SKU 候选，结构化规则精确准入 1 个 SKU，模拟客户批准后进入待上架池。该回归同时发现一个店铺使用登录式 member key；移除资质请求仅允许 `b2b-*` 的错误限制后，原失败单元在线复测为 `completed`，经营范围、经营模式和证书清单均可用。离线套件现为 46 个文件/321 个测试。

## 开始实施前检查

以下事项已经由本计划给出默认决策，不阻塞 CLI 实施：

- 最终合格 SKU 计数、待审核缓冲和客户退回补量属于业务系统。
- 历史合格 SKU 是否可再次计费属于业务规则，不影响事实采集合同。
- 各事实 TTL、图片保留期限和原始响应保留期属于业务系统可配置策略。
- 初始媒体采集只返回引用，永久图片存储不属于本计划。
- CLI 采用当前仓库错误码、安全规则和 Profile 会话模型。

阶段 0 可以立即开始。进入受控在线验证前只需要当前 Profile 处于登录状态；如出现登录失效或滑块，再由用户按现有安全流程处理，不需要用户预先提供 Cookie、token、sign 或手工准备 page 2 响应。

## 回滚

- 各阶段保持独立提交；合同、脱敏器、解析器、命令入口、fixture 和文档可按阶段回退。
- JSON 合同只做可加字段扩展；新增 `collect` 或 `supplier catalog` 回滚时不改变既有命令语义。
- 检查点包含 schema 版本和 unit fingerprint；不兼容变更拒绝静默恢复旧检查点。
- 业务系统入库以不可变批次为单位，回滚 CLI 版本不删除已经采集的历史事实。
