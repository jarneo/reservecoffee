# 部署指南 · 二曜路8号咖啡和清酒 · 预约小程序（CloudBase）

微信原生小程序 + 腾讯云开发 CloudBase。本文覆盖：云平台/AppID 准备、CloudBase MCP 配置、数据库初始化、云函数部署、前端上传、通知（订阅/服务号/短信）配置。

> 设计基线：`design/design-system.html`。通知细节见 `docs/服务通知实现与配置.md`。
> 代码规模（实测，非旧文档的"27/44 函数"）：**云函数 55 个**，**数据库集合 10 个**，订阅/服务号模板 ID **已申请真实值并启用**。

---

## 0. 环境信息（实际）

| 项 | 值 |
|---|---|
| CloudBase 环境 ID | `cloud1-d8g9mhgxm32d2eac6` |
| 小程序 AppID | `wxb97578ed89c6e2c7` |
| 服务号 AppID | `wx4d8d957ee8af6073` |
| 小程序静态网站域名 | `cloud1-d8g9mhgxm32d2eac6-1468614423.tcloudbaseapp.com` |
| 体验版 | 见 `deploy/version.txt`（由 `deploy/sync.js` 自增） |

---

## 1. 云平台（CloudBase）准备

1. **开通云开发**：登录[云开发控制台](https://console.cloud.tencent.com/)，与小程序 AppID 同主体新建环境，记录环境 ID。
2. **环境套餐**：个人版即可支撑本预约系统。
3. **关联小程序**：云开发控制台「设置 → 环境」确认已绑定小程序 AppID（同主体自动关联）。
4. **首次进入即店主**：店主微信打开小程序管理端，首个进入者自动成为 `owner`（`_lib.ensureOwner`）。

---

## 2. 配置 CloudBase MCP（让 AI 部署/建库）

> MCP 让 WorkBuddy / 主流 IDE 直接调用 CloudBase（建集合、部署云函数、发短信），免去手动控制台点击。

### 方式 A（推荐，在 WorkBuddy 内）
在工作区右侧「连接器」面板找到 **CloudBase（腾讯云 CloudBase）**，点击**连接**并授权登录腾讯云。连接后告诉我「已连接」。

⚠️ **面板"已连接" ≠ 工具已注入会话**：若 `ToolSearch` 查不到 `mcp__cloudbase__*` 工具，直接用 `DeferExecuteTool` 调 `mcp__cloudbase__manageFunctions`（action: `createFunction`/`updateFunctionCode`/`invokeFunction`/`updateFunctionConfig`/`createFunctionTrigger`/`deleteFunction`）。仍不行则断开→重连并点「信任/授权」。

### 方式 B（手动 MCP 配置，适用于 Cursor / VS Code）
```json
{
  "mcpServers": {
    "cloudbase": {
      "command": "npx",
      "args": ["@cloudbase/cloudbase-mcp@latest"],
      "env": {
        "CLOUDBASE_API_KEY": "<环境级 API Key>",
        "CLOUDBASE_ENV_ID": "<环境 ID>"
      }
    }
  }
}
```

---

## 3. 本地工程配置（两处占位）

**① `miniprogram/app.js`** — `ENV_ID` 已改为 `cloud1-d8g9mhgxm32d2eac6`。
**② `project.config.json`** — `appid` 已改为 `wxb97578ed89c6e2c7`（非 `touristappid`）。

微信开发者工具「导入项目」：目录选仓库根，`miniprogramRoot` 已指向 `miniprogram/`，`cloudfunctionRoot` 已指向 `cloudfunctions/`。

---

## 4. 数据库初始化（10 个集合）

| 集合 | 说明 |
|---|---|
| `config_homepage` | 首页配置，`_id: homepage` |
| `projects` | 预约项目（`openDays`/`advanceDays`/`useSlotTemplate`/`paused`/`cutoff`/`needReview`/`mpNotify`/`smsEnabled`/`smsNotice`） |
| `schedules` | 按项目+天的场次（`sessions[].capacity/booked/paused`、`closed`） |
| `reservations` | 预约记录（双轴 `status`+`review`，`reminded`/`ended` 标记） |
| `admins` | 管理员（`owner`/`manager`） |
| `users` | 顾客资料（小程序 openid 主键，`name`/`phone`/`unionid`/`mpOpenid`） |
| `stats_daily` | 访问统计（按日） |
| `products` | 菜单/菜品（`status`/`sort`/`image`） |
| `reviews` | 顾客评价（`productId`/`status`/`top`/`avatar`） |
| `config` | 全局配置（子文档 `store`/`sms`/`subscribe`/`mp`） |

权限统一：**读 = 所有用户；写 = 仅云函数（后台）**。

**种子数据**：部署后调 `seedData`（owner 身份）写入首页文案 + 3 个种子项目。也可控制台手动给 `config_homepage` 写 `_id:'homepage'`。

---

## 5. 云函数部署

**55 个函数**（见 README 列表）。每个目录含 `index.js` + `lib.js` + `package.json`，运行时 **Nodejs18.15**。

部署方式：
- **CloudBase MCP**：`updateFunctionCode`（存量）/ `createFunction`（新建），`functionRootPath` 传 `cloudfunctions` 父目录，勿传多余顶层字段。
- **CLI**：`tcb fn deploy --all`（本环境 tcb CLI 不可靠，优先用 MCP）。
- `wx-server-sdk` 部署时按 `package.json` 自动安装。**新建函数必须带 `package.json` 声明 `wx-server-sdk ^2.6.3`**，否则云端报 `Cannot find module`。

> **`createFunction` 后立即 `updateFunctionCode` 可能不替换代码**：workaround = `deleteFunction` → 重新 `createFunction`。

---

## 6. 前端上传（体验版）

`deploy/sync.js`（miniprogram-ci）自动升版本 + 上传体验版：
```bash
# 在 managed Node 环境执行（miniprogram-ci 装到 workspace node_modules）
NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules \
  /Users/mac/.workbuddy/binaries/node/versions/22.22.2/bin/node deploy/sync.js
```
私钥 `deploy/private.wxb97578ed89c6e2c7.key`。受微信「小程序代码上传 IP 白名单」约束须设「允许所有 IP」。

---

## 7. 通知配置

### 7.1 微信订阅消息（已启用真实模板 ID）
`createReservation`/`reviewReservation`/`cancelReservation` 已接入 `cloud.openapi.subscribeMessage.send`（`_lib.TPL`，7 个真实 ID）。顾客端 `confirm` 页 `submit` 内已 `requestSubscribe` 请求授权。无需额外平台配置。

### 7.2 服务号模板消息（⚠️ 当前待修复，发送能力已就绪但缺目标 openid）
**已具备的能力**：
- 4 个服务号模板 ID 已填（`_lib.MP_TPL`）。
- 后端 `create`/`cancel`/`review` 已接入 `cloud.openapi.templateMessage.send`，凭据由**云环境绑定服务号**托管——**代码不需要 AppSecret**。
- 三个函数 `config.json` 已声明 `permissions.openapi:["subscribeMessage.send","templateMessage.send"]`（否则报 -604101；权限缓存 ~10 分钟）。

**关键认知**：
- 服务号模板消息的 `touser` 必须是**用户在服务号下的 openid**（`users.mpOpenid`），≠ 小程序 openid，≠ unionid。
- 你已在**微信开放平台**绑定服务号+小程序（共享 unionid），这解决了"两边身份能对应"，但**不会自动把服务号 openid 灌进 `users.mpOpenid`**。
- 当前"采集服务号 openid"的链路有缺陷（见下方「待修复」），因此**下单不报错，但 `sendMp` 因找不到 mpOpenid 自动跳过，用户收不到服务号消息**。

**待修复（代码层，需连 CloudBase 部署）**：
- `cloudfunctions/mpAuth/index.js` 方案自相矛盾（前端 `mp-auth.html`+`mpAuthWeb` 是 postMessage+Event 调用，后端却写成 HTTP 云函数），且残留 `cloud.callContainer` 死代码会直接崩溃。需重写为纯 Event 函数（`exports.main(event)` 读 `event.code/event.openid`），或用 unionid 关联替代网页授权。
- 顾客端缺少"开启服务号通知"入口（当前仅管理员 `notifyConfig` 页有按钮）；需增加顾客端授权引导。

**你需完成的平台配置（AI 无法代操作微信后台）**：
1. 确认服务号已**微信认证**（未认证不能发模板消息/网页授权）。
2. 若走网页授权路线：公众平台 → **设置与开发 → 公众号设置 → 功能设置 → 网页授权域名**，填 `cloud1-d8g9mhgxm32d2eac6-1468614423.tcloudbaseapp.com`（不带 `https://`），并上传验证文件到该静态网站根（用 CloudBase 静态网站托管上传）。同时小程序后台 → **开发管理 → 开发设置 → 业务域名** 加同域名。
3. 若服务号 openid 走环境变量（网页授权换 openid 需要 `mpAuth` 的 `MP_APP_SECRET`）：提供值后由 AI 写进 `mpAuth` 环境变量。

> 注：发模板消息本身**不需要**公众平台「服务器配置」/ Token。此前的"消息推送/服务器配置"路径描述已过时，以本段为准。

### 7.3 短信（独立产品）
1. 腾讯云短信控制台完成签名（如「二曜路8号咖啡」）+ 通知模板审批。
2. 拿到 SmsSdkAppId / SignName / TemplateId。
3. 配置：环境变量（`SMS_SECRET_ID`/`SMS_SECRET_KEY`/`SMS_SDK_APP_ID`/`SMS_SIGN_NAME`/`SMS_TEMPLATE_ID`/`SMS_REGION`）或 `config_sms` 集合（`_id:sms`）。
4. 管理端「项目配置 → 全局设定 → 短信推送」逐项目开启并填注意事项（≤30 字）。

---

## 8. 验证清单（冒烟测试）

- [ ] 真实 AppID 打开，云能力初始化无报错。
- [ ] 店主微信首次进管理端，`admins` 出现一条 `owner`。
- [ ] `seedData` 后首页出现 3 个项目。
- [ ] 顾客端：选日期→选场次→填手机号→提交，收到「预约成功」；`reservations` 新增一条。
- [ ] 订阅消息：下单后收到微信订阅通知（需用户授权）。
- [ ] 服务号消息：修复 openid 采集后，关注服务号的用户下单收到服务号通知（待修复项）。
- [ ] 短信：开启项目短信并配置 `config_sms` 后，成功预约的手机号收到短信。
- [ ] 审核流（需审项目）：owner 审核通过 → 顾客「我的预约」变成功并收到通知。

---

## 9. 回退与常见问题

- **云函数部署失败**：确认运行时 Node 18、依赖安装成功；新建函数须 `package.json` 声明 `wx-server-sdk`。
- **短信发不出**：签名/模板是否审批、TemplateId 与变量顺序、`config_sms`/环境变量是否生效、手机号格式。
- **服务号 -604101**：`config.json` 未声明 openapi 权限，或权限缓存未生效（等 ~10 分钟）。
- **服务号收不到**：`users.mpOpenid` 为空（采集链路缺陷，见 7.2 待修复）；或用户未关注服务号。
- **环境 ID 不匹配**：`app.js` 的 `ENV_ID` 与开发者工具关联云环境须一致。
