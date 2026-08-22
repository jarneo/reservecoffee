# 二曜路8号咖啡和清酒 · 预约小程序

微信原生小程序 + 腾讯云开发 CloudBase 的可运行项目。黑白极简设计，一抹品牌色（暖咖棕 `#7A5230`）点缀。

> 设计基线见 `design/design-system.html` 与 `design/DESIGN_SYSTEM.md`。
> 部署与平台配置见 `DEPLOY.md`；服务号/订阅/短信通知细节见 `docs/服务通知实现与配置.md`。

## 项目定位

咖啡/清酒门店的**预约小程序**：顾客端选日期/场次/填信息下单，管理端运营项目、日程、场次、审核、菜单、评价、通知。多渠道通知（微信订阅消息 + 服务号模板消息 + 短信）覆盖预订人与管理员两端。

## 目录结构

```
reservecoffee/
├── miniprogram/              # 小程序前端（wx.cloud）
│   ├── app.js / app.json / app.wxss   # 入口 + 设计令牌
│   ├── utils/                # cloud(调用封装) / util(工具) / subscribe(订阅模板)
│   ├── components/           # adminGuard(行为) / sessionCard / calendar
│   ├── pages/                # 顾客端 7 页 + 管理端 12 页 + 分享/授权承载
│   └── mp-auth.html          # 服务号网页授权页（静态网站托管）
├── cloudfunctions/           # 55 个云函数（wx-server-sdk）+ _lib 共享库
│   ├── _lib/index.js         # 共享库（初始化/数据库/角色/响应/订阅/服务号）
│   └── <name>/index.js + lib.js + package.json(+config.json/sms.js)
├── deploy/                   # sync.js(升版本上传体验版) + 私钥 + version.txt
├── design/                   # 交互原型与规范（非运行代码）
└── docs/                     # 通知实现、模板对照、需求文档
```

## 环境信息（实际）

| 项 | 值 |
|---|---|
| CloudBase 环境 ID | `cloud1-d8g9mhgxm32d2eac6` |
| 小程序 AppID | `wxb97578ed89c6e2c7` |
| 服务号 AppID | `wx4d8d957ee8af6073` |
| 小程序静态网站域名 | `cloud1-d8g9mhgxm32d2eac6-1468614423.tcloudbaseapp.com` |
| 当前体验版 | `6.4.x`（见 `deploy/version.txt`，由 `deploy/sync.js` 自增） |

## 数据库集合（NoSQL，云开发控制台创建）

| 集合 | 说明 |
|---|---|
| `config_homepage` | 首页配置，单文档 `_id: homepage` |
| `projects` | 预约项目（`openDays`/`advanceDays`/`useSlotTemplate`/`paused`/`cutoff`/`needReview`/`mpNotify`/`smsEnabled`/`smsNotice` 等） |
| `schedules` | 按项目+天的场次（`sessions[].capacity/booked/paused`、`closed`） |
| `reservations` | 预约记录（双轴 `status` + `review`、`reminded`/`ended` 提醒标记） |
| `admins` | 微信授权管理员（`owner`/`manager`） |
| `users` | 顾客资料（`name`/`phone`/`unionid`/`mpOpenid` 等，以小程序 openid 为主键） |
| `stats_daily` | 访问统计（按日） |
| `products` | 菜单/菜品（`status`/`sort`/`image`） |
| `reviews` | 顾客评价（`productId`/`status`/`top`/`avatar`） |
| `config` | 全局配置（子文档 `store`/`sms`/`subscribe`/`mp`） |

权限规则统一：**读 = 所有用户；写 = 仅云函数（后台）**。所有写操作经云函数，前端不直接写库。

## 云函数（共 55 个）

**顾客端**：`getHomepage` `getProject` `createReservation` `listMyReservations` `cancelReservation` `getMyProfile` `saveProfile` `getPhoneNumber` `getMenu` `getProduct` `getNotifyConfig` `saveNotifyConfig`

**管理端**：`getRole` `updateHomepage` `listProjects` `createProject` `updateProject` `publishProject` `getSchedule` `setDaySessions` `setOpenDays` `setDayStatus` `copyDaySessions` `setSession` `listSessionReservations` `reviewReservation` `markCompleted` `listAdmins` `addAdmin` `removeAdmin` `updateAdminNickname` `getProjectAdmin` `getVisitStats` `listVisitors` `exportData` `listReviews` `addReview` `setReview` `reviewAdmin` `adminProducts` `saveProduct` `deleteProduct` `listProducts` `menuAdmin` `smsConfig`/`getSmsConfig`/`saveSmsConfig` `notifyConfig`/`getNotifyConfig`/`saveNotifyConfig` `templates`/`listTemplates`/`saveTemplate`/`deleteTemplate` `cover`/`deleteProjectFile`

**通知/定时**：`remindReservation`（每 15 分钟触发，开场前提醒 + 结束提醒）、`mpAuth`（服务号 openid 采集）、`mpCallback`（关注事件占位，详见 DEPLOY 服务号章节）

> `_lib/index.js` 是共享库源，部署前 `cp` 到各函数 `lib.js`（全量已统一）。改 `TPL`/`MP_TPL` 等只需改 `_lib/index.js` 一处。

## 核心业务模型

### 预约状态（双轴）
- `status`：`pending`（待审）/ `confirmed`（成功）
- `review`：`pending`（待审）/ `none`（免审）/ `rejected`（驳回）
- 需审项目（`needReview`）下单进入 pending/pending，管理员审核后转 confirmed/none 或 rejected。

### 三级暂停 + 过期
- **项目级** `projects.paused`：整体停约
- **日期级** `schedules.closed`：某天整体停约（`setDayStatus` 设置）
- **场次级** `sessions[].paused`：单场停约
- **过期** `project.cutoff`（`{mode:'before'|'after', minutes}`）：截止时刻 = 场次开始 ± minutes，未配置/非法则永不过期。顾客端 `utils/util.isSessionExpired` 与服务端 `createReservation.sessionExpired` 同源。

### 事务防超卖
`createReservation` 用云数据库事务占额，校验 published/paused/openDays/advanceDays(1~30)/dailyLimit/closed/场次 paused/expired/名额/每日上限/同场次去重，再写记录。

## 多渠道通知（已启用真实模板 ID）

| 通道 | 模板 | 说明 |
|---|---|---|
| 微信订阅消息 | 7 个（`_lib.TPL`：reserveSuccess/reserveCancel/reminder/reminderEnd/adminNew/adminCancel/adminReview） | 免 AppSecret，需用户授权订阅 |
| 服务号模板消息 | 4 个（`_lib.MP_TPL`：adminNew/reserveSuccess/reserveCancel/adminReview） | 走 `cloud.openapi.templateMessage.send`，凭据由云环境绑定服务号托管；`touser` 须服务号 openid（`users.mpOpenid`） |
| 短信 | 单条留座模板 | 仅发预订人，须 `config_sms` 或环境变量 |

**双层开关**：服务号 = 项目总开关 `projects.mpNotify` && 单模板开关 `config.mp[key]`（缺省开）。

> ⚠️ **服务号推送当前状态（重要）**：后端代码已部署、模板 ID 已填、openapi 权限已声明（`config.json`），但**顾客端"服务号 openid 采集"链路存在缺陷**（见 `docs/服务通知实现与配置.md` 第七章与 `DEPLOY.md` 服务号章节）。即"已具备发送能力，但缺目标 openid"。此项正在修复中，详见对应文档的"待办"。

## 菜单/产品 + 评价

`products`/`reviews` 集合 + `getMenu`（公开只读，供公众号菜单/分享进入，不在小程序内导航）、`shareMenu`（分享承载页）、`menuAdmin`/`reviewAdmin`（管理端）。

## 本地工程配置（两处占位需替换）

1. `miniprogram/app.js` 的 `ENV_ID` → 已填 `cloud1-d8g9mhgxm32d2eac6`。
2. `project.config.json` 的 `appid` → 已填真实 AppID `wxb97578ed89c6e2c7`（非 touristappid）。

> 微信开发者工具「导入项目」：目录选仓库根，`miniprogramRoot` 指向 `miniprogram/`，`cloudfunctionRoot` 指向 `cloudfunctions/`。

## 初始化数据

部署后，店主微信首次进入管理端自动成为 `owner`（`_lib.ensureOwner`）。调用 `seedData` 写入首页文案 + 3 个种子项目（法兰绒深烘咖啡 / 清酒品鉴 / 法兰绒研习社）。

## 部署

- **云函数**：通过 CloudBase MCP 连接器 `updateFunctionCode`/`createFunction` 部署（tcb CLI 在本环境不可用）。新建函数须带 `package.json` 声明 `wx-server-sdk ^2.6.3`。
- **前端**：`deploy/sync.js`（miniprogram-ci）自动升版本 + 上传体验版，私钥 `deploy/private.wxb97578ed89c6e2c7.key`。受微信「代码上传 IP 白名单」约束须设「允许所有 IP」。
- 详细步骤与平台配置见 `DEPLOY.md`。

## 已知限制 / 后续

- 爽约释放规则本期未实现（架构已预留）。
- 服务号 openid 采集链路待修复（见上"⚠️ 服务号推送当前状态"）。
- 头图/图标上传走云存储，需另配上传权限与 CDN。
