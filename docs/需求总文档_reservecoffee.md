# 二曜路8号咖啡和清酒 · 微信小程序预约系统 — 需求总文档

> 文档版本：v1.0（整合版）
> 生成时间：2026-08-22 · 口径以**当前线上代码**为准（非早期文档）
> 适用范围：微信原生小程序 + 腾讯云开发 CloudBase；顾客端预约 + 管理端运营 + 店铺菜单/评价 + 多渠道通知
> 设计基调：黑白极简，品牌色暖咖棕 `#7A5230`
> ⚠️ 本文与 `docs/` 下早期《服务通知实现与配置》《订阅模板对照表》等文档存在**口径冲突**，以本文 + 代码为准（详见 §5.4）。

---

## 0. 决策摘要（给决策者先看）

1. **通知通道现状**：当前线上**仅「小程序订阅消息 + 短信」双通道生效**。微信「服务号模板消息」已于 2023-10-01 被微信官方下线（`45103` 失效），本项目于 **2026-08-23 整体移除**该能力（`sendMp` / `notifyAdminsMp` 已改为 no-op）。早期《服务通知实现与配置.md》描述的是移除前的临时方案，**已过时**，请勿按其中"服务号推送"做验收。
2. **统计口径以 `getVisitStats` 代码为准**：日粒度聚合 `visitUsers / newUsers / pv`，并叠加区间 `reservationCount`。写入侧（埋点）需确认是否已落地（见 §6.3）；当前未找到显式写入 `stats_daily` 的云函数，疑似仍在首页访问埋点阶段，列为**待核实项**。
3. **服务号自定义菜单挂小程序**：在公众平台把菜单项类型设为「跳转小程序」，填**小程序 AppID `wxb97578ed89c6e2c7`**，推荐页面路径 **`/pages/shareMenu/shareMenu`**（该项目专为此场景设计的"公众号专属只读菜单页"）。详见 §7。
4. **密钥分两处托管**：① 小程序/服务号 AppSecret 走 CloudBase「微信开发者凭证」/ 环境变量；② 短信密钥存于云数据库 `config_sms` 文档（接口返回**掩码**，不回显明文）。敏感，仅 owner 可见，详见 §8。
5. **两个云环境分工明确**：`cloud1-d8g9mhgxm32d2eac6` = 小程序业务环境（56 个云函数全在此）；`cloud1-d6g5g3oj234efe932` = 静态托管/历史网页授权页环境。部署与排查务必区分环境。

---

## 1. 项目概览

| 项 | 值 |
|---|---|
| 产品名 | 二曜路8号咖啡和清酒（预约小程序） |
| 形态 | 微信原生小程序 + 腾讯云开发 CloudBase（NoSQL） |
| 小程序 AppID | `wxb97578ed89c6e2c7` |
| 服务号 AppID | `wx4d8d957ee8af6073`（已停用推送，仅作 unionid 关联历史） |
| 业务云环境 | `cloud1-d8g9mhgxm32d2eac6`（56 个云函数部署于此） |
| 静态托管/网页授权环境 | `cloud1-d6g5g3oj234efe932` |
| 前端路由数 | 24（顾客端 7 tabBar/页面 + 管理端 12 + 分享 1 + 授权承载 1 + 隐私 1 + 菜单 1 + 评价相关） |
| 云函数数 | 56（不含 `_lib` 共享库） |
| 当前前端版本 | 6.5.24（已上传） |

### 1.1 技术栈
- 前端：微信小程序原生（WXML/WXSS/JS，glass-easel 组件框架）
- 后端：CloudBase 云函数（Node.js，wx-server-sdk），共享库 `cloudfunctions/_lib/index.js` 部署前 `cp` 到各函数 `lib.js`
- 数据库：CloudBase NoSQL（集合见 §4）
- 部署：① 前端 `deploy/sync.js`（miniprogram-ci，私钥 `deploy/private.wxb97578ed89c6e2c7.key`）；② 云函数经 CloudBase MCP（`updateFunctionCode`）

---

## 2. 角色与权限模型

| 角色 | 标识 | 能力 |
|---|---|---|
| 超级管理员 owner | `users`/`admins` 中 `role='owner'` | 全部管理功能 + 统计查看 + 短信/通知配置 + 管理员管理（支持**多个** owner） |
| 普通管理员 manager | `role='manager'` | 预约管理/审核/菜单/评价管理（无统计与全局配置） |
| 顾客 customer | 小程序 openid | 浏览项目/菜单、提交预约、写评价、查看"我的预约" |

- 权限判定：`getRole(openid)` 统一返回角色；敏感操作（统计、`getSmsConfig`、`saveSmsConfig`、`sendSms`、`listVisitors`、`addAdmin` 等）均校验 `role==='owner'`。
- 管理员入口：`pages/admin/hub/hub`（管理台首页），由 `adminGuard` Behavior 守护，`this.guard(['owner'])` 限制部分页。

---

## 3. 核心业务流程

### 3.1 顾客预约链路
首页 `pages/index` → 选项目 `pages/booking` → 选日期/场次 → 确认 `pages/confirm`（授权手机号 `getPhoneNumber` 或服务填）→ 提交 `createReservation`（事务占额防超卖）→ 订阅消息 `reserveSuccess`（免审）或 `adminReview`（待审）→ 管理台审核（如需）→ `reserveSuccess`（通过时补发顾客）。

### 3.2 业务状态模型（三级暂停 + 过期）
- 项目级 `projects.paused`：整体停约
- 日期级 `schedules.closed`：某天整体停约
- 场次级 `sessions[].paused`：单场停约
- 场次级过期 `expired`：由 `project.cutoff` 决定（双端同源：`utils/util.isSessionExpired` ↔ `createReservation.sessionExpired`）

### 3.3 预约提交规则（`createReservation`）
- 校验：`published` / `paused` / `openDays` / `advanceDays`(1~30) / `dailyLimit`
- 双轴状态：`status`(pending/confirmed) + `review`(pending/none/rejected)
- 手机号**非必填**：填才校验 `^1[3-9]\d{9}$`；新增 `wechat/gender/age`；`getPhoneNumber` 走 `cloud.openapi.phonenumber.getPhoneNumber({code})`（依赖 `WX_APP_SECRET`，见 §8.4）

### 3.4 管理运营链路
项目管理 → 场次模板 → 首图/介绍 → 店铺菜单（菜品） → 评价审核 → 预约管理（当日） → 审核 → 顾客名录/黑名单 → 管理员管理 → 全局通知配置。

---

## 4. 数据模型（集合与字段口径 · as-built）

| 集合 | 用途 | 关键字段 |
|---|---|---|
| `projects` | 预约项目 | `name,icon,image,intro,published,paused,deleted,needReview,dailyLimit,advanceDays,openDays[],cutoff,smsEnabled,smsNotice,ownerOpenid` |
| `schedules` | 日期/场次 | `_id=YYYY-MM-DD, closed, sessions[{start,end,paused,booked,capacity}]` |
| `reservations` | 预约单 | `projectId,date,sessionId,name,phone,partySize,note,openid,status,review,createdAt` |
| `users` | 顾客资料 | `_id=openid, openid, name, phone, avatar, unionid, mpOpenid(休眠), updatedAt` |
| `admins` | 管理员 | `openid, role(owner/manager), nick` |
| `products` | 菜品 | `name,price,desc,image,onSale, sort` |
| `reviews` | 评价 | `productId,name,rating,text,status(normal/hidden),reviewStatus(pending/approved/rejected), createdAt` |
| `config` | 全局配置 | 子文档 `store`(店铺名) / `sms` / `subscribe` / `mp` |
| `config_sms` | 短信密钥 | `_id='sms'`: `signName,smsSdkAppId,secretId,secretKey,noticeTemplate,templates{success,approaching,expired}, visitors{}` |
| `config_homepage` | 首页配置 | 首页可配置项（per-item description 等） |
| `stats_daily` | 日统计 | `_id=YYYY-MM-DD`: `visitUsers,newUsers,pv`（详见 §6） |

---

## 5. 通知体系（现状口径）

### 5.1 双通道总览
| 通道 | 状态 | 触发 | 接收人 |
|---|---|---|---|
| 小程序订阅消息 | ✅ 生效 | 下单/取消/审核/开场前/结束后（定时） | 顾客 + 管理员 |
| 短信（腾讯云 SMS） | ✅ 生效（需配置密钥） | 下单成功留座（项目 `smsEnabled`） | 顾客 |
| 服务号模板消息 | ❌ 已移除（2026-08-23） | — | — |

### 5.2 订阅消息 7 模板（ID 与代码 `TPL` 一致）

| # | 模板 | 角色 | 模板 ID | 触发函数 | 接收人 |
|---|---|---|---|---|---|
| 1 | reserveSuccess | 顾客 | `ShNSAxZvFsDgyZhFfi3OTbofXCzjsM5P1-sSD8ZU2e4` | createReservation / reviewReservation | 预订人 |
| 2 | reserveCancel | 顾客 | `Y1VIDe6Y_DiQqzE_FaaBzvNyD2nErGogF5pCbLed_u8` | cancelReservation | 预订人 |
| 3 | reminder | 顾客 | `OTbjHkCiDnS2a5r0-6AIf2ze41-M2flVKAKbt6LWe6c` | remindReservation(定时) | 预订人 |
| 4 | reminderEnd | 顾客 | `ShNSAxZvFsDgyZhFfi3OTUoYqm5khLVJkhCnqI1IEeo` | remindReservation(定时) | 预订人 |
| 5 | adminNew | 管理员 | `AJ8iCZgYFaNoSmwmrwwivnRTnJ3BvFu5sOeg4Wa-3aM` | createReservation | 全部 owner+manager |
| 6 | adminCancel | 管理员 | `TpTXSsqC4i8F_GtN_boeKh4TXjVI-1rXUwA01AIdO5Q` | cancelReservation | 全部 owner+manager |
| 7 | adminReview | 管理员 | `UQJ5AfBWVUTQO-upC-3_W-UeDu_BgPPGoyj11Ei5Py8` | createReservation(待审) | 全部 owner+manager |

- 前端授权分组：`BOOKER_TPLS=[reserveSuccess,reserveCancel,reminder,reminderEnd]`（提交手势内授权）；`ADMIN_TPLS=[adminNew,adminCancel,adminReview]`（管理台 hub「开启管理推送」按钮授权，**不点则 `43101` 静默失败**）。
- 字段映射与触发时机详见 `docs/订阅模板对照表.md`（与代码已对齐）。
- 管理员自订会双发（A 线成功 + B 线新预约），如需去重可加排除参数。

### 5.3 短信（腾讯云 SMS）
- 配置入口：管理台 `pages/admin/smsConfig/smsConfig` → `saveSmsConfig`（仅 owner）；读取 `getSmsConfig` **返回掩码**（`secretId` 前 4 位 + `****`，`hasSecret` 布尔）。
- 三模板（无参数，全明文）：`success`（下单成功）/ `approaching`（开场前）/ `expired`（过期）。`sendReservationSms` 发送。
- 开关：`config_sms` 全局 `smsnotify` 三开关 + 项目 `smsEnabled` 双重控制。
- 手动补发：`sendSms`（owner，按 `reservationId` 或指定 `phone/name/date/time/seats`）。

### 5.4 ⚠️ 服务号模板消息已移除（重要更正）
- 微信自 2023-10-01 下线公众号「模板消息」接口（`45103` 失效），替代「订阅通知」授权链路在「小程序 web-view」场景无法落地（需服务号 JS-SDK 签名，工程量过大）。
- 经确认，本项目于 2026-08-23 **整体移除**服务号通知：`cloudfunctions/_lib/index.js` 中 `sendMp` / `sendMpSubscribe` / `notifyAdminsMp` 一律 no-op（仅留日志）；`MP_TPL` 常量保留仅作历史参考。
- `users.mpOpenid` 现为**休眠数据**，不再写入/使用。请勿恢复 `sendMp*`。
- 结论：顾客/管理员通知**只走订阅消息 + 短信**；如需"服务号触达"，应改用服务号「订阅通知」重新申请模板（当前未做）。

### 5.5 提醒定时（`remindReservation`，每 15 分钟扫描）
- `confirmed` 且未提醒 → 开场前 ≤60 分发 `reminder`（仅顾客）
- 已结束且未发 → 发 `reminderEnd`（仅顾客）
- `reminded` / `ended` 标记防重发

---

## 6. ★ 统计口径（补充一 · 各数据的统计定义）

> 口径定义以 `cloudfunctions/getVisitStats/index.js` 实际读取逻辑为准；未单独实现聚合的维度给出"建议口径"。

### 6.1 核心指标定义表

| 指标 | 来源集合 | 口径 | 去重/聚合方式 |
|---|---|---|---|
| `visitUsers`（访问用户数） | `stats_daily` | 当日**访问过小程序**的去重用户数 | 按 `_id=YYYY-MM-DD` 日文档存储；区间 = 各日 `visitUsers` 求和（**非区间去重**，是日值累加） |
| `newUsers`（新用户数） | `stats_daily` | 当日**首次进入**的小程序用户数 | 同上，区间 = 各日求和 |
| `pv`（页面访问量） | `stats_daily` | 当日页面打开次数（含重复） | 同上，区间 = 各日求和（不去重） |
| `reservationCount`（预约数） | `reservations` | 预约日期 `date` 落在 `[from,to]` 的**预约单总数** | **直接对 reservations 按 date 范围 count()**，不经 stats_daily；区间 = count 总数 |
| `visitors`（最近访问者） | `config_sms.visitors` | 每个访问者 openid → 最近访问时间戳；管理台用于一键授权 | `listVisitors`：取 `visitors` 映射，排除已是 `admins` 的 openid，按 `lastSeen` 倒序 |

⚠️ **口径差异提醒**：`visitUsers/newUsers/pv` 来自**预聚合的日文档**（需写入侧按日 upsert）；`reservationCount` 是**实时按日期区间 count**，两者数据源不同，做"访问转化=预约/访问"时分母分子口径不一致，需注意。

### 6.2 读取函数与权限
- `getVisitStats({from,to})`：仅 owner 可调用；返回 `{ days:[{date,visitUsers,newUsers,pv}], total:{...}, reservationCount }`。
- `listVisitors()`：仅 owner；返回最近访问者 openid + lastSeen 列表（已排除管理员）。

### 6.3 写入侧现状（待核实）⚠️
- 当前**未发现**显式 `db.collection(COL.stats).set/update` 写入 `stats_daily` 的云函数（仅 `getVisitStats` 读取）。
- 合理实现位：应在「首页/任意页面 onShow 或 `getRole` 访问埋点」中对当日文档 `db.command.inc` 累加 `pv`，并对新 openid 累加 `visitUsers/newUsers`。
- **行动项**：确认埋点是否已上线；若未上线，`getVisitStats` 读到的 `stats_daily` 将长期为空（visitUsers/newUsers/pv 全 0），仅 `reservationCount` 有值。

### 6.4 其他可统计维度（建议口径，暂无专用聚合函数）
| 维度 | 建议口径 | 数据源 |
|---|---|---|
| 预约状态分布 | `status`(pending/confirmed) 分组 count | `reservations` |
| 审核分布 | `review`(pending/none/rejected/approved) 分组 count | `reservations` |
| 取消率 | `cancelReservation` 次数 / 总预约数 | `reservations` + 取消标记 |
| 各项目预约量 | 按 `projectId` 分组 count | `reservations` |
| 场次上座率 | `booked` / `capacity` 均值 | `schedules.sessions` |
| 评价分布 | `rating` 1~5 分布 + `status`/`reviewStatus` | `reviews`/`products` |

---

## 7. ★ 菜单路径与跳转配置（补充二）

### 7.1 服务号自定义菜单挂小程序（推荐路径）
在**微信公众平台（服务号 `wx4d8d957ee8af6073`）→ 自定义菜单**添加菜单项：
- 菜单类型：**跳转小程序**
- 小程序 AppID：`wxb97578ed89c6e2c7`
- 备用小程序 AppID：可不填
- 页面路径（推荐）：**`/pages/shareMenu/shareMenu`**
  - 该页 `pages/shareMenu/shareMenu` 是项目专设的"**公众号专属：店铺菜单 + 顾客评价（只读）**"页，不在小程序底部 tab 出现，适合从服务号菜单进入。
- 备选页面路径：`/pages/index/index`（小程序首页，含全部预约入口）

> 配置位置：公众平台 → 功能 → 自定义菜单 → 添加菜单 → 选择"跳转小程序" → 填 AppID 与页面路径 → 保存发布。

### 7.2 小程序内分享路径（分享卡片）
- 首页分享：`/pages/index/index`
- 项目分享：`/pages/booking/booking?projectId=<id>`
- 菜单分享：`/pages/menu/menu?projectId=<id>`
- 菜品分享：`/pages/product/product?productId=<id>`
- 公众号菜单页分享：`/pages/shareMenu/shareMenu?projectId=<id>`

### 7.3 网页授权页（历史，服务号移除后已废弃）⚠️
- 原用途：采集服务号 openid（`mp-auth.html` 静默 `snsapi_base` 授权 → `mpAuth` 云函数换 openid）。因服务号推送已移除，**此链路不再需要**。
- 历史地址（静态托管环境 `cloud1-d6g5g3oj234efe932`）：
  `https://cloud1-d6g5g3oj234efe932-1472887487.tcloudbaseapp.com/mp-auth.html`
- 当时需配：① 服务号网页授权域名；② 小程序业务域名（均指向上述静态托管域名）；③ `MP_APP_SECRET` 环境变量。现全部可忽略。

### 7.4 静态托管域名（两个环境）
- 业务/部署环境：`cloud1-d8g9mhgxm32d2eac6`（云函数在此；早期 `mp-auth.html` 曾误传至此，域名后缀 `-1468614423`）
- 静态托管环境：`cloud1-d6g5g3oj234efe932`（当前 `mp-auth.html` 实际地址后缀 `-1472887487`）

---

## 8. ★ 各应用 Token / 密钥（补充三 · 敏感）

> 🔒 **敏感信息**：以下密钥仅 owner 可见，禁止写入代码仓库、禁止外发。接口返回均做掩码。本文记录其**存放位置**与**取值（如已掌握）**供备份。

### 8.1 微信小程序
| 项 | 值 / 位置 |
|---|---|
| AppID | `wxb97578ed89c6e2c7` |
| AppSecret | 存于 CloudBase 控制台 → 环境 `cloud1-d8g9mhgxm32d2eac6` → **环境设置 → 微信开发者凭证**（填小程序 AppID 的 AppSecret）。用于订阅消息/内容安全 `cloud.openapi.*` 凭证托管。**未以明文环境变量形式存在**。 |
| 代码上传私钥 | `deploy/private.wxb97578ed89c6e2c7.key`（本地，miniprogram-ci 上传用，勿提交到公开仓库） |

### 8.2 微信服务号（推送已停用，仅留作历史）
| 项 | 值 / 位置 |
|---|---|
| AppID | `wx4d8d957ee8af6073` |
| AppSecret | `e801153f4189298c66112b7316a2388d`（曾存为环境变量 `MP_APP_SECRET`，用于 `mpAuth` 换 openid；服务号推送移除后已无意义，建议从环境变量移除） |

### 8.3 腾讯云短信 SMS
| 项 | 值 / 位置 |
|---|---|
| 存放集合 | `config_sms` 文档 `_id='sms'`（`saveSmsConfig` 写入，`getSmsConfig` 掩码读出） |
| `smsSdkAppId` | 腾讯云 SMS 应用 ID（存于 `config_sms.smsSdkAppId`） |
| `secretId` | 腾讯云密钥 ID（接口仅回显前 4 位 + `****`） |
| `secretKey` | 腾讯云密钥 Key（接口不回显） |
| `signName` | 短信签名（默认「打开咖啡馆」） |
| 模板 ID | `templates.success` / `templates.approaching` / `templates.expired`（全明文无参数模板） |

### 8.4 CloudBase 环境变量
| 变量名 | 用途 | 所在环境 |
|---|---|---|
| `WX_APP_SECRET` | `getPhoneNumber` 解密手机号（`cloud.openapi.phonenumber.getPhoneNumber`） | `cloud1-d8g9mhgxm32d2eac6` |
| `MP_APP_SECRET` | 历史：服务号 `mpAuth` 换 openid（已废弃） | `cloud1-d8g9mhgxm32d2eac6`（或服务号环境） |

### 8.5 保管须知
- AppSecret / 短信密钥**不进代码、不进 Git**；改密钥只通过 CloudBase 控制台或 `saveSmsConfig` 云函数。
- 前端/云函数读取密钥一律走环境变量或 `config_sms` 文档，禁止硬编码。
- 接口层（`getSmsConfig`）已做掩码，owner 之外的角色拿不到明文。

---

## 9. 验收要点 / 待办

- [ ] 顾客预约链路：项目→场次→确认→提交→订阅消息，全链路可走通
- [ ] 管理员审核（如需）：`reviewReservation` 通过后顾客收到 `reserveSuccess`
- [ ] 开场前/结束后提醒：定时 `remindReservation` 正确触发 `reminder` / `reminderEnd`
- [ ] 短信：项目 `smsEnabled` + 全局开关开启后，下单成功收到留座短信
- [ ] 统计：`getVisitStats` 区间返回 `visitUsers/newUsers/pv/reservationCount`；**确认 `stats_daily` 写入侧已上线**（§6.3 待核实）
- [ ] 服务号菜单：自定义菜单「跳转小程序」配置到 `/pages/shareMenu/shareMenu` 并发布
- [ ] 密钥：小程序 AppSecret 已填微信开发者凭证；短信密钥已通过 `saveSmsConfig` 入库；`MP_APP_SECRET` 可清理
- [ ] 文档一致性：早期《服务通知实现与配置.md》标注为"已过时"，以本文 §5.4 为准

---

> 本文由对话上下文 + 当前线上代码（`cloudfunctions/_lib/index.js`、`getVisitStats`、`saveSmsConfig`、`app.json`、`mpAuthWeb.js` 等）整合而成，凡与早期文档冲突处以本文为准。
