# A 路径 · 小程序内自然语言预约 · 需求说明文档

> 路径定义：A 路径 = 用户在小程序内用自然语言描述预约意图，由新增云函数 `aiReserve` 通过 function calling 抽取预约要素，复用现有 `createReservation` 完成下单；公众号侧维持既有通知通道（订阅消息 + 服务号模板消息），**不**接入服务号对话（B 路不在本期范围）。
>
> 关联方案：小程序成长计划 10 亿 token 额度、成本测算（见对话历史，本期不展开）。

---

## 1. 概述与目标

- **目标**：在小程序内提供「一句话预约」的自然语言入口，降低多步表单的操作成本，提升转化。
- **核心约束**：AI 只负责**意图理解与要素抽取**，最终落库**必须且只能**经由现有 `createReservation`（含事务防超卖、过期/满员/黑名单/每日上限/项目暂停校验、双线通知）。AI 不直写数据库、不复写业务规则。
- **范围**：仅限"创建预约"这一场景。审核、取消、改约、查询等维持现有页面/函数，不在本期。

## 2. 前置条件

| 类别 | 条件 | 现状核实 |
|---|---|---|
| 小程序基础库 | ≥ 3.7.1（支持 `wx.cloud.extend.AI`） | ✅ 当前 `libVersion` 3.17.0，满足 |
| CloudBase 环境 | 已开通 AI 能力（混元/Hunyuan 模型可调） | ⏳ 需在控制台确认 AI 资源点已开通 |
| 成长计划额度 | 10 亿 token 资源包已领取（**6 个月有效**）或资源点套餐/混元按量已就绪 | ⏳ 待确认领取状态；耗尽后按资源点/按量接续（历史已测算，月成本个位数~十几元） |
| 现有业务函数 | `createReservation` / `listProjects` / `getProject` 可用且接口稳定 | ✅ 已读源码确认入参契约（见 §5.4） |
| 设计系统 | 黑白极简 + 品牌色 `#7A5230` | ✅ 已对齐 `app.wxss` token，原型复用 confirm 视觉 |

## 3. 技术架构（简述，复用既有）

```
小程序 pages/ai 页 ──wx.cloud.extend.AI──▶ 云函数 aiReserve（agent 循环）
                                                  │ function calling
                                                  ▼
                                          现有 createReservation（含全部校验 + 通知）
```

- 端侧用 `wx.cloud.extend.AI` 流式对话（免额外 SDK、keyless、走云内部可信通道，**不触发出网白名单**，规避既有 412 坑）。
- 复杂澄清（缺要素、多轮）在云端 `aiReserve` 收敛，端侧只渲染。
- 模型默认 `hunyuan-turbos-latest`（省），复杂澄清/高准确要求切 `hunyuan-2.0-instruct-20251111`（强工具调用）。

> ⚠️ **as-built 修正（2026-09-21 实测，详见 §14）**：本节为设计稿，实际落地与它有 3 处偏差——
> ① 云函数端入口是 **`cloud.ai()`**（需 `wx-server-sdk ^4.0.2`），不是 `cloud.extend.AI`（那是小程序端形态）；
> ② 模型改为 **`hy3`**（`hunyuan-turbos-latest` / `hunyuan-2.0-instruct-20251111` 属一期模型，已于 2026-05-31 下线）；
> ③ 函数超时由 20s 实际配为 **60s**；provider 用 **`hunyuan-v3`**（非资源点套餐唯一可用）。

## 4. 配置内容

### 4.1 新增云函数 `aiReserve`

路径：`cloudfunctions/aiReserve/`（遵循 `_lib/index.js` 为唯一源、部署前 `cp` 到各函数 `lib.js` 的既有约定）。

- **`config.json`**（沿用既有权限声明风格）：
  ```json
  {
    "permissions": { "openapi": [] },
    "runtime": "Nodejs18.15",
    "timeout": 20
  }
  ```
  > 若需调用 `cloud.openapi`，按既有经验在 `permissions.openapi` 声明；无效会报 `-604101`，且有 ~10 分钟缓存。
- **`package.json`** 依赖：
  - `wx-server-sdk`（既有函数均已依赖，版本对齐）
  - 云函数侧 AI SDK：按 mp-skills 官方指引选用 `@cloudbase/ai-sdk` 或 `wx-server-sdk` 内置 AI 扩展（**以实际可装载的包为准**，部署前验证）。
- **环境变量**：**无新增**。沿用既有 `MP_APP_ID` / `MP_APP_SECRET` / 短信密钥等（AI 调用走内部通道，不新增密钥）。
- **部署方式**：通过 **CloudBase MCP `manageFunctions`** 创建（`createFunction` + `updateFunctionCode`）；**勿用 tcb CLI**（已知不可靠）。HTTP 函数才需 `scf_bootstrap`，本函数为普通 Event 函数，不需要。

### 4.2 小程序端新增 `pages/ai`

- 新增页面目录 `miniprogram/pages/ai/`（ai.wxml / ai.wxss / ai.js / ai.json）。
- `app.json` 的 `pages` 数组注册该页；`ai.json` 沿用既有 `usingComponents` 绝对路径约定（如需复用 sessionCard 等组件）。
- 端侧 AI 调用骨架（mp-skills 原生，无需额外 SDK）：
  ```js
  const model = wx.cloud.extend.AI.createModel('hunyuan-exp')
  const res = await model.streamText({
    data: {
      model: 'hunyuan-turbos-latest',
      messages: [{ role:'system', content: SYS_PROMPT }, { role:'user', content: userText }],
      // tools: [ createReservation 工具声明 ] 见 §5.3
    },
    onText: t => render(t)
  })
  ```
- **入口形态（已确认，见 §9）**：首页与项目详情页采用可拖动球形浮窗，点击进入独立路由页 `pages/ai`；该页路径可被公众号菜单直达。卡信息默认复用已授权资料（微信昵称+手机号），**不展示可编辑表单**。

### 4.3 模型与工具参数

- `model`：`hunyuan-turbos-latest`（默认） / `hunyuan-2.0-instruct-20251111`（复杂澄清）。
- `temperature`：建议 `0.3`（低随机，保证 slot 抽取稳定）。
- `max_tokens`：建议 `1024`（含工具调用 JSON，足够；避免过大）。
- **tools 声明（function calling）**：声明一个名为 `createReservation` 的工具，参数 JSON Schema 严格对齐 §5.4 入参：
  - `projectId` (string)、`date` (string, `YYYY-MM-DD`)、`sessionId` (string)、`name` (string)、`phone` (string, 可选)、`partySize` (integer)、`note` (string, 可选)、`wechat/gender/age` (可选)、`subscribed` (object, 可选)。
  - **关键**：`sessionId` 与 `projectId` 必须先由模型调用 `listProjects` / `getProject`（或 `aiReserve` 预置当日可约场次）解析得到，不能凭空生成。

### 4.4 `createReservation` 入参契约（AI 必须对齐，源自源码）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `projectId` | string | ✅ | 项目 ID（由 listProjects/getProject 解析） |
| `date` | string | ✅ | `YYYY-MM-DD`，须在 `openDays` 且 ≤ advanceDays |
| `sessionId` | string | ✅ | 场次 ID（由 getProject 返回的 sessions[].id） |
| `name` | string | ✅ | 称呼；缺省用微信昵称 |
| `phone` | string | 选填 | 仅填时校验 `1[3-9]\d{9}` |
| `partySize` | int | ✅ | 默认 1，≤ `maxParty` |
| `note` / `wechat` / `gender` / `age` | 选填 | — | 透传 |
| `subscribed` | object | 选填 | 订阅开关 5 键布尔，缺省全订阅 |

> 源码已含：黑名单拦截、项目/日期/场次暂停、过期（cutoff 同源）、满员、每日上限、事务防超卖。**AI 层不重复这些校验**，仅在提交前做展示确认。

### 4.5 依赖项清单

- 云端：`wx-server-sdk`、AI SDK（见 §4.1）、Node 运行时（与既有函数一致）。
- 端侧：基础库 ≥ 3.7.1（已满足）、`wx.cloud.extend.AI`（原生）。
- **无新增第三方密钥、无出网需求**。

## 5. 约束与边界情况

1. **AI 仅辅助，最终以 `createReservation` 为准**：任何抽取结果在调用前必须经业务函数校验；AI 不得直写库。
2. **确认前置**：AI 抽取到要素后**必须先展示结构化确认卡**（复用 confirm 视觉），用户点「确认预约」才提交；禁止"说完即下单"。
3. **工具返回裁剪**：`listProjects`/`getProject` 回传 AI 的字段只留决策必需（项目名/可选日期/场次时间/剩余名额），避免整表回灌导致单次 token 破万。
4. **额度有效期**：10 亿 token 资源包 **6 个月有效、到期清零**；需把"AI 额度到期"纳入运营日历，到期前重新领/购，避免静默停服。
5. **服务可用性降级**：`aiReserve` 超时/不可用时，端侧捕获异常 → 展示降级提示 → 提供「进入常规预约」按钮跳 `booking` 流程，**不阻断用户**。
6. **隐私与授权**：称呼默认微信昵称、手机号沿用现有 `getPhoneNumber` 授权 + 手动覆盖；订阅通知仍走微信原生弹窗（≤3 项），AI 不改变授权链路。
7. **多轮澄清防循环**：缺要素追问上限 5 轮（云函数环境变量 `AI_MAX_ASK_ROUNDS`，缺省 5），超出则引导用户改用常规填写或给出可选项。
8. **幻觉/错填兜底**：AI 抽取的 `projectId`/`sessionId` 必须是真实存在值（由 `getProject` 实查），若解析不到有效场次，不得编造，应澄清或改荐。
9. **基础库下限**：端侧调用前检测 `wx.cloud.extend.AI` 是否存在，旧版基础库用户走常规预约降级。
10. **合规**：订阅消息授权、隐私声明维持现有合规口径；AI 不扩大数据收集范围。

## 6. 验收标准

- [ ] 输入"明天下午3点法兰绒深烘两人位" → 正确解析 4 要素 → 展示确认卡 → 确认后生成真实预约 + 双线通知触发。
- [ ] 缺要素输入（如"想约清酒品鉴"）→ AI 多轮澄清，不臆造场次。
- [ ] 满员/过期场次 → AI 主动告知并改荐其他可约场次（调用 getProject 实查）。
- [ ] `aiReserve` 不可用 → 端侧降级提示 + 跳常规预约，流程不中断。
- [ ] 黑名单/项目暂停用户 → 经 createReservation 校验返回失败，AI 友好提示（不绕过）。
- [ ] 真机验证：体验版真实下单一次，预约创建 + 通知成功。

## 7. 风险与规避

| 风险 | 规避 |
|---|---|
| 工具返回过大致 token 飙升 | §5.3 严格裁剪回传字段；System prompt 启用缓存 |
| AI 臆造 sessionId | 由 getProject 实查映射，解析失败即澄清 |
| 误下单（未确认即提交） | §5.2 强制确认卡前置 |
| 额度 6 个月到期清零 | 运营日历提醒 + 到期前续领 |
| 旧基础库不兼容 | §5.9 运行时检测 + 降级 |
| 出网/密钥触发 412 | AI 走内部可信通道 keyless（已规避） |

## 8. 工作量估算（结论先行）

- **新增 1 个云函数 `aiReserve`** + **1 个小程序对话页 `pages/ai`** + 1 套 tools 声明 + 1 份 system prompt。
- 复用：现有 `createReservation`/`listProjects`/`getProject`、通知体系、设计系统。
- 复杂度：**低~中**（无算法/架构改动，机械集成）；公众号 B 路为可选增强，本期不做。
- 真实风险集中在：AI 额度开通确认、工具字段裁剪、降级链路，均已在上文约束中覆盖。

---

## 9. 入口形态（已确认 · 2026-09-20）

> 决策：球形浮窗为全局常驻入口，点击进入独立路由页；卡信息默认复用已授权资料，不展示可编辑表单。

### 9.1 球形浮窗（全局常驻）
- 位置：首页右下角 + 项目详情页右下角，**可拖动**（仅记忆位置，不改业务逻辑）。
- 形态：圆形品牌色 `#7A5230` 浮标，内显「✦ AI」或对话气泡；常驻显示，进入对话页后自动隐藏。
- 降级：基础库 `< 3.7.1` 不渲染浮窗，首页/详情页保留既有「预约」常规入口，**不阻断**。

### 9.2 独立路由页 `pages/ai`
- 路径：`/pages/ai/ai`，独立路由，可被**公众号菜单**（小程序跳转 `appid + path=pages/ai/ai`）与分享卡片直达。
- 公众号菜单配置：菜单类型选「跳转小程序」，填小程序 AppID `wxb97578ed89c6e2c7` 与路径 `pages/ai/ai`（无需 web-view）。
- 页内结构复用原型：navbar + 对话流 + 快捷 chips + 确认卡 + 成功覆盖层 + 降级卡。

### 9.2.1 快捷 chips 后台可配置（v6.6.30）
- 数据：`config/ai` 文档新增 `quickReplies: [{ label, text }]`，最多 6 条；`label` ≤ 8 字（按钮上显示的短文字），`text` ≤ 60 字（点击后**实际发送**的话术）。
- 读取：`getAiConfig` —— 顾客端 AI 页需渲染该数据，故本函数**不再限定 owner**（返回内容仅为开关与引导话术，无敏感信息）；写入仍由 `saveAiConfig` 严格限定 owner。
- 回落：后台未配置或条目全空时返回内置默认三条（`明天·法兰绒` / `清酒品鉴` / `到店引导`），保证「不配置也和以前一样」。
- 写入：`saveAiConfig` 新增 `quickReplies` 参数，服务端过滤空项、按上限截断（`label` 8 字 / `text` 60 字）。
- 入口：管理台 → AI 设置（`pages/admin/aiConfig`）新增「快捷短语」编辑区，支持增删、上下移排序、逐条完整性校验，与总开关同页保存。
- 顾客端：`pages/ai` 的 `onLoad` 调 `getAiConfig` 拉取后 `wx:for` 渲染；拉取失败静默沿用内置默认，不阻断进入 AI 页。

### 9.3 入口形态评估与补充（详见 §13）
球形浮窗适合"常驻、低打扰、随手唤起"，但首屏可见性弱、易被忽略。建议并存以下补充入口：
- 首页独立「智能预约」卡片位（与浮窗并存，提升首屏可见性）。
- 项目详情页正文区「✦ 问 AI 助理」按钮（除浮窗外，详情页也提供显式入口）。
- 交互模式不止纯对话框：**语音输入**（咖啡馆场景、年长客群友好）+ **快捷 chips**（原型已有）+ **确认卡结构化回显**（降低纯自然语言出错率）。

## 10. 知识库与 AI 接待内容规划

### 10.1 AI 职责边界
| 职责 | 内容 | 数据来源 |
|---|---|---|
| 店铺介绍 | 品牌故事、位置、营业时间、环境、招牌 | 静态知识 |
| 预约答疑 | 怎么约、退改规则、人数/费用、提前量、停车 | 静态知识 + 实时工具 |
| 到店引导 | 怎么走、停车/地铁、到了找哪、期待什么 | 静态知识 |
| 菜单/知识 | 法兰绒深烘、清酒品鉴、研习社、店铺菜单；咖啡/清酒小知识 | 静态知识 |
| 预约下单 | 一句话抽取要素 → 确认卡 → `createReservation` | 实时工具 + 业务函数 |
| ❌ 不负责 | 直写库、绕过校验、编造场次、扩大授权收集 | — |

### 10.2 知识库三层架构（小店无需重 RAG）
1. **角色设定（system prompt）**：人设（温和、懂行的店员）、语气、硬性规则（不臆造、先确认后下单、降级话术）。
2. **静态知识（注入/可检索）**：店铺信息 + FAQ + 菜单，体量小（预计 < 3k 字），直接放入 system prompt 或独立 knowledge 段；后续扩张再上检索。
3. **实时工具（function calling）**：`listProjects` / `getProject` 提供真实可约场次/余量，**绝不用静态写死**。

### 10.3 内容准备清单（上线前需补齐）
- [ ] `kb/store.md`：店名、地址、营业时间、交通/停车、联系方式、环境一句话。
- [ ] `kb/faq.md`：预约规则（提前量、人数上限、是否收费/定金、改约/取消政策）、到店（迟到、带小孩/宠物）、常见疑问。
- [ ] `kb/menu.md`：4 个项目介绍 + 招牌 + 适宜人群；咖啡/清酒科普短文（客服答疑用）。
- [ ] 实时数据接入：确认 `getProject` 返回含 `sessions[].start/end/remaining/paused/expired`，供 AI 实时判断可约性。
- [ ] 话术库：欢迎语、追问模板、满员/过期改荐模板、降级模板（原型 4 场景已覆盖）。

## 11. 自动化 / 批量测试策略

目标：把"人工一句句试"变成"用例库一键回归"，只在真机冒烟阶段保留人工。

### 11.1 用例库（自然语言 → 期望 slots）
每条含：`input` / `expectedSlots` / `expectedAction`（confirm|clarify|recommend|degrade）。分桶：
- 完整：明天下午3点法兰绒深烘两人位 → {project, date+1, 15:00, sess, 2} / confirm
- 缺要素：想约清酒品鉴 → clarify(date, time, size)
- 满员：今晚7点清酒品鉴一位 → recommend(其他场)
- 过期/非营业日：去年今天 / 周一闭店 → unavailable
- **时段间隙**：14:30（场 14:00 / 16:00）→ snap 最近场 + 告知调整
- 同义/口语：后天上午、大后天、这周六、俩人、三人位
- 黑名单/暂停：返回校验失败 → 友好提示
- 幻觉防护：虚构项目名 → 澄清不编造

### 11.2 云函数层断言（主力，避开 UI 成本）
- 脚本调用 `aiReserve`（经 CloudBase MCP `invokeFunction` 或本地 Node 直连），传 `messages`，断言返回 `tool_calls[0].function.arguments` 与期望 slots 一致（宽松匹配：项目名归一、时间容差）。
- **不真正落库**：用例以 `dryRun` 标志只走到"抽取 + 确认卡"层，不调用 `createReservation`（保护真实数据）。
- 回归：每次改 system prompt / tools 声明，跑全用例库，输出"解析准确率"报告。

### 11.3 指标与监控
- 要素解析准确率、确认卡触发率、改荐命中率、降级率、平均轮次、单次 token / 耗时。
- 日志落盘：每次对话写 `aiLogs` 集合（input/output/slots/tokens/cost/耗时/结果），供复盘与知识库自学习。
- 成本告警：日 token 超阈值（如资源包 10 亿的 1%）经企业微信/服务号提醒。

### 11.4 真机冒烟（唯一保留人工）
- 体验版真机：浮窗 → 对话 → 确认卡 → 真实下单一次，验证通知双线。
- 降级链路手测一次（断 AI 或超时）。

## 12. 时间不可约 / 时段间隙处理策略

### 12.1 通用流程（任何含时间的输入）
```
解析 (projectId, 期望日期, 期望时间)
  → getProject(date) 取 sessions[]
  → 过滤：去除 paused / expired / 满员 / 超 advanceDays
  → 匹配：① 时间落在某场 [start,end] → 命中
          ② 落在间隙（无场包含）→ 最近邻匹配，标注"已为您调整"
          ③ 全部不可约 → 不可约话术 + 改荐其他日
```

### 12.2 不可约话术（满员/过期/闭店/超提前量）
> "✦ 法兰绒深烘 **9/21 15:00** 这一场已经约满啦 🙈
> 为你查到其他可约场次：
> · 9/22（周一）15:00–17:00 · 剩 4 位
> · 9/23（周二）10:00–12:00 · 剩 6 位
> 要帮你约 **9/22 这场**吗？回复「好」即可～"
- 规则：共情在前 → 给 2–3 个最近可约 → 默认推荐第一个，等用户确认。

### 12.3 时段间隙话术（用户说的时间不在任何场次内）
- 策略 A（推荐）：自动吸附到**最近且合适**的场次，明确告知调整：
> "14:30 我们暂无对应场次，离得最近的是 **14:00–16:00 法兰绒深烘**，已为你按这场预约，可以吗？"
- 策略 B（可选/多场接近）：给出 ±最近两场让用户选：
> "14:30 介于两场之间，你想早点（14:00 场）还是晚点（16:00 场）？"
- **铁律**：绝不编造 sessionId；任何推荐来自 `getProject` 实查；吸附偏差建议 ≤ 60 分钟，超出则改走"选项/改天"。

### 12.4 防循环
- 澄清上限 5 轮（环境变量 `AI_MAX_ASK_ROUNDS`）；间隙吸附只做一次，用户仍不满意则引导常规页。

## 13. AI 能力延展建议（分阶段，本期外）

- **改约 / 取消 / 查询**：自然语言"改到明天""取消周六的""我约了啥" → 复用现有函数 + 新增对应 tool。
- **智能提醒**：预约前 N 小时 AI 主动推送（借服务号模板/订阅消息）"明天清酒品鉴，记得来~ 需要路线吗"。
- **个性化推荐**：结合 roster/customer notes 推荐偏好项目/时段（"你常约研习社，新一期已开"）。
- **候补 Waitlist**：满员时登记，有空位 AI 主动通知。
- **到店服务**：到店扫码 → AI 引导点单/会员积分/评价收集。
- **知识自学习**：高频未覆盖问题沉淀进 `kb/faq.md`，降低人工答疑。
- **数据看板**：AI 接待量、转化率、高频问题 TOP，反哺运营。
- **多语言**：外宾英文/日文接待（清酒客群）。

## 14. CloudBase AI 配置（已联调验证 · 2026-09-21 运行时实测）

> 结论：**不需要切换资源点套餐**，成长计划赠送额度可直接使用。以下为运行时实测证据（云函数 `aiProbe` 探针）。

### 14.1 最终可用配置
| 项 | 值 | 依据 |
|---|---|---|
| SDK 入口 | `wx-server-sdk` → **`cloud.ai()`** | ⚠️ `cloud.extend.AI` 是**小程序端**（`wx.cloud.extend.AI`）形态，云函数端不存在 |
| SDK 版本 | **`wx-server-sdk ^4.0.2`**（≥3.0.5-beta.1） | 旧版 `^2.6.3` 实测解析为 2.7.2，无 `cloud.ai()` |
| provider | **`hunyuan-v3`**（体验模型路径） | 官方对比表：非资源点套餐仅可用它；仅耗免费额度、无需开模型开关 |
| 模型 | **`hy3`** | 二期赠送模型；`hy3-preview` 亦将下线 |
| 函数超时 | **60s**（原为 3s） | AI 生成耗时远超 3s，原值必然超时 |
| 环境变量 | 无新增密钥；`AI_MODEL` / `AI_PROVIDER` 可覆盖 | 走内部可信通道，免出网、不触 412 |

### 14.2 实测结果（`aiProbe` × provider/model 矩阵）
```
wxServerSdk: 4.0.2 | entryWxSdk: wx-server-sdk:cloud.ai()
✔ wx-server-sdk:cloud.ai() + provider=hunyuan-v3 + model=hy3 → ok  "正常" (22 tokens)
✔ wx-server-sdk:cloud.ai() + provider=cloudbase  + model=hy3 → ok  "正常" (22 tokens)
✘ @cloudbase/node-sdk:app.ai() + * → 404（该路径在本环境不可用）
```

### 14.3 三个已修复的真因（原代码不可用的原因）
1. **SDK 入口用错**：服务端写成了小程序端的 `cloud.extend.AI`；且 `wx-server-sdk ^2.6.3` → 实装 2.7.2，`cloud.ai()` 尚不存在。
2. **模型已下线**：`hunyuan-turbos-latest` 属**一期**赠送模型，已于 **2026-05-31 全部下线**（官方已下线模型列表，自动切换目标 = `hy3`）。
3. **函数超时 3s**：AI 生成不可能在 3s 内完成，即使前两项修好也会超时。

### 14.4 关于控制台「当前环境不是资源点计费环境，切换后支持在套餐中抵扣」
- 该提示**只针对「套餐资源点抵扣 Token」这一种结算方式**，**不阻断 AI 调用**——实测非资源点环境下两种 provider 均可正常调用（走成长计划免费额度）。
- 本环境确为**非资源点计费**（`EnvDeductionMode=normal`、`PointsTime` 未生效），故按官方口径选 `hunyuan-v3`。
- 若日后切换为资源点套餐（**不可逆**），可设环境变量 `AI_PROVIDER=cloudbase` 以获得「免费额度 → 套餐资源点」逐级抵扣与全模型（DeepSeek/GLM/Kimi/MiniMax）支持。

### 14.5 剩余待办
- [ ] **真机冒烟**：`wxCtx().OPENID` 在 MCP 直调时为空，故 AI 端到端必须在**小程序上下文**（体验版）验证。
- [ ] 额度监控：`hy3` 免费额度 6 个月有效、到期清零；控制台「AI 模型用量」达 80%/90%/100% 会公众号提醒。
- [ ] `aiProbe` 为临时探针，联调结束后可删除。

---

## 15. 管理后台 AI 总开关（新增需求 · 2026-09-20）

### 15.1 需求
管理后台可一键开启/关闭 AI 智能预约。关闭时：首页与项目详情页的 AI 浮窗、AI 入口卡片、相关文案**全部隐藏**，等同于"AI 不存在"；常规预约不受影响。

### 15.2 配置存储（复用 config 集合分文档模式）
- 新增 `config` 集合文档 `ai`：`{ enabled: true }`（**缺省 true**，未配置视为开启，保证灰度/存量安全）。
- `_lib/index.js` 新增 `loadAiSwitch(db)`（与 `loadSubscribeSwitch`/`readMpSwitch` 同构）：读 `config.ai`，返回 `{ enabled }` 或 `{}`（缺省开启）。

### 15.3 管理端入口
- 新增 `pages/admin/aiConfig/aiConfig`（与 smsConfig/notifyConfig 同构），**仅 owner 可见**（全局开关，避免 manager 误操作影响全店）。
- `hub.js` 的 owner 菜单追加 `{ t:'AI 智能预约', u:'/pages/admin/aiConfig/aiConfig' }`。
- 写入：复用既有 config 写入函数（参考 notifyConfig 的保存逻辑），校验 `adminGuard` 后写 `config/ai`。

### 15.4 端侧读取与渲染
- **关键约束（已核实）**：客户端**从不直读 `config` 集合**（全站统一走云函数），故 `aiEnabled` 绝不能在前端 `wx.cloud.database().collection('config')` 读取，必须由云函数返回。
- `getHomepage` 云函数：返回体追加 `aiEnabled`（由 `loadAiSwitch` 读取，缺省 true）。首页据此控制浮窗与 AI 卡片显隐。
- `getProject` 云函数：返回体同样追加 `aiEnabled`（详情页浮窗依赖；支持深链/分享直入详情页场景，globalData 可能未初始化）。
- 浮窗抽成共享组件 `components/aiFab/aiFab`（可见文案「AI预约」），`index` 与项目详情页 `booking` 均引用，`aiEnabled` 为显隐 prop，`projectId` 为可选预选项目（从详情页进入预选该项目，AI 解析缺项目时回退到此）；同时缓存 `app.globalData.aiEnabled` 减少重复拉取。
- **与降级链路（§5.5）正交**：总开关=false → 整块隐藏；总开关=true 但 `aiReserve` 异常 → 走降级提示 + 常规预约，互不干扰。

### 15.5 验收
- owner 关闭 → 首页/详情页浮窗与 AI 入口消失，常规预约正常。
- owner 开启 → 浮窗出现，可进入对话。
- 开关即时生效（下次加载），无需发版。

---

## 16. 实现状态（A 路径编码落地 · 2026-09-21）

### 16.1 云函数（经 CloudBase MCP manageFunctions 部署）
| 函数 | 状态 | 说明 |
|------|------|------|
| `getHomepage` / `getProject` | ✅ 已部署 | 返回体追加 `aiEnabled` |
| `getAiConfig` / `saveAiConfig` | ✅ 已部署 | owner 读写 `config/ai` 总开关 |
| `aiReserve` | ✅ 已部署（2026-09-21 修复后） | 对话+抽取+真实校验（只读）；**运行时 AI 调用已实测调通**（`cloud.ai()` + `hunyuan-v3` + `hy3`，见 §14），密钥/超时已按实测修正 |

### 16.2 前端（已上传体验版）
- 2026-09-21 经 `deploy/sync.js`（miniprogram-ci）直接上传体验版 **6.6.26**（用户授权出网 + 微信「代码上传 IP 白名单=允许所有」）。
- `pages/ai/ai`：对话页（确认卡复用资料 + 调 createReservation + 降级跳 booking）。
- `components/aiFab/aiFab`：可拖动浮窗（标签「AI预约」，`aiEnabled` 显隐），已接入 `index` + `booking`。
- `pages/admin/aiConfig/aiConfig`：owner 总开关页，`hub` 菜单已加。

### 16.3 部署结论
- 用户授权后已直接部署全部 5 个云函数（含 `aiReserve`），前端体验版 6.6.26 已上传。
- **2026-09-21 联调修复**：发现并修复 3 处使 AI 不可用的真因（SDK 入口/版本、模型下线、函数超时 3s）；修复后经 `aiProbe` 探针运行时实测，`cloud.ai()` + `hunyuan-v3` + `hy3` 返回正常（22 tokens）。**无需切换资源点套餐**。
- 真机冒烟验证须待：在小程序上下文（体验版）里走完整对话 → 确认卡 → `createReservation`。MCP 直调因 `OPENID` 为空只能触发身份守卫，无法覆盖此路径。

---

*本文件为规划交付物。决策（§9 入口形态 / 卡信息复用 / §14 AI 配置）已确认；§15 管理后台总开关已落地；全部云函数已部署，前端体验版 6.6.26 已上传。**§14 AI 配置已于 2026-09-21 运行时实测调通（provider=hunyuan-v3 / model=hy3）**，剩余为真机端到端冒烟。*
