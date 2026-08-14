# 部署指南 · 二曜路8号咖啡和清酒 · 预约小程序（CloudBase）

微信原生小程序 + 腾讯云开发 CloudBase 的可运行脚手架。本文覆盖三类部署前置：

1. **云平台（CloudBase）环境与微信小程序 AppID**
2. **CloudBase MCP 配置**（让 WorkBuddy / IDE 帮你部署、建集合、发短信）
3. **数据库初始化**（集合创建、权限、种子数据、短信配置）

> 设计基线：`design/design-system.html`（v6.3 原型）、`design/DESIGN_SYSTEM.md` §13（短信）。
> 架构契约：`C:\Users\Administrator\.workbuddy\plans\toasty-nebula-babbage.md`。
> 代码：`miniprogram/`（前端）、`cloudfunctions/`（27 个云函数）。

---

## 0. 前置清单（Checklist）

| 项 | 说明 | 获取位置 |
|---|---|---|
| 微信小程序 AppID | 真实 AppID（非 `touristappid`） | 微信公众平台 → 开发管理 → 开发设置 |
| 微信开发者工具 | 导入项目并预览/上传 | https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html |
| 腾讯云账号 + 实名 | 开通云开发 | https://console.cloud.tencent.com/ |
| CloudBase 环境 ID | 形如 `reservecoffee-xxx` | 云开发控制台 → 环境 → 概览 |
| （可选）CloudBase MCP | 让 AI 直接部署/建库 | 见 §2 |
| （可选）短信签名 + 模板 | 短信到达能力 | 见 §7 |

---

## 1. 云平台（CloudBase）准备

1. **开通云开发**：登录云开发控制台（与小程序 AppID 同主体）。新建环境，记录**环境 ID**。
2. **环境套餐**：个人版（¥19.9/月）即可支撑本预约系统；上线后按资源点计量。
3. **关联小程序**：在云开发控制台「设置 → 环境」中确认该环境已绑定你的小程序 AppID（微信云开发默认同主体自动关联）。
4. **首次进入即店主**：用店主微信打开小程序管理端，首个进入者自动成为 `owner`（`_lib/ensureOwner`）。

---

## 2. 配置 CloudBase MCP

> MCP 让 WorkBuddy / 主流 IDE 直接调用 CloudBase（建集合、部署云函数、发短信），免去手动控制台点击。

### 方式 A（推荐，在 WorkBuddy 内）
- 当前连接器 `cloudbase` 为 **disconnected**。在工作区右侧「连接器」面板找到 **CloudBase（腾讯云 CloudBase）**，点击连接并授权登录腾讯云。
- 连接成功后告诉我「已连接」，我即可用 MCP 工具：创建 7 个集合、逐个部署 27 个云函数、写入 `config_sms` 等。

### 方式 B（手动 MCP 配置，适用于 Cursor / VS Code 等 IDE）
在 IDE 的 MCP 配置（如 `mcp.json`）中加入：

```json
{
  "mcpServers": {
    "cloudbase": {
      "command": "npx",
      "args": ["@cloudbase/cloudbase-mcp@latest"],
      "env": {
        "CLOUDBASE_API_KEY": "<你的环境级 API Key>",
        "CLOUDBASE_ENV_ID": "<你的环境 ID>"
      }
    }
  }
}
```

- `CLOUDBASE_API_KEY`：CloudBase 控制台 → 环境设置 → API 密钥 创建（环境级，长期有效，建议用环境变量注入，勿硬编码）。
- 不设密钥时，首次调用会走设备码 OAuth 登录引导你选环境。
- 本地模式要求已装 Node.js 与 `npx`（本机 managed Node 22 可用）。

---

## 3. 本地工程配置（两处占位需替换）

**① `miniprogram/app.js`** — 把 `ENV_ID` 换成你的环境 ID：

```js
const ENV_ID = 'your-env-id'   // ← 替换为 CloudBase 环境 ID
```

**② `project.config.json`** — 把 `appid` 换成真实 AppID（当前为 `touristappid`，只能预览、无法用云能力）：

```json
"appid": "wxYourRealAppId"
```

微信开发者工具「导入项目」：目录选仓库根，`miniprogramRoot` 已指向 `miniprogram/`，`cloudfunctionRoot` 已指向 `cloudfunctions/`。

---

## 4. 数据库初始化（云开发 NoSQL 集合）

在云开发控制台「数据库」或经 MCP 创建以下集合（权限规则统一：**读 = 所有用户；写 = 仅云函数/后台**）：

| 集合 | 说明 |
|---|---|
| `config_homepage` | 首页配置，单文档 `_id: homepage`（logo/头图/简介） |
| `projects` | 预约项目（含 `openDays`/`advanceDays`/`useSlotTemplate`/`smsEnabled`/`smsNotice` 等） |
| `schedules` | 按项目+天的场次（人数上限/已约/暂停） |
| `reservations` | 预约记录（双轴 `status` + `review`） |
| `admins` | 微信授权管理员（owner / manager） |
| `stats_daily` | 访问统计（按日） |
| `config_sms` | 短信全局配置（单文档 `_id:'sms'`，见 §7） |

> 集合权限务必设为「仅创建者可读写 / 所有用户可读，仅后台可写」的组合；本项目所有写操作都经云函数，前端**不直接写库**，因此推荐 `读=所有用户、写=仅管理端`（云函数使用管理员态写入）。

**写入种子数据**：部署完成后调用 `seedData` 云函数（owner 身份），自动写入首页文案 + 3 个种子项目（法兰绒深烘咖啡 / 清酒品鉴 / 法兰绒研习社）。也可在控制台手动给 `config_homepage` 写 `_id:'homepage'` 文档。

---

## 5. 云函数部署

`cloudfunctions/` 下共 **27 个函数**，每个目录含 `index.js` + `lib.js` + `sms.js`（用到短信的 3 个）+ `package.json`，运行时 **Nodejs18**（云开发侧选择 Node 18）。

**顾客端（5）**：`getHomepage` `getProject` `createReservation` `listMyReservations` `cancelReservation`
**管理端（22）**：`getRole` `updateHomepage` `listProjects` `createProject` `updateProject` `publishProject` `getSchedule` `setDaySessions` `setOpenDays` `copyDaySessions` `setSession` `listSessionReservations` `reviewReservation` `markCompleted` `listAdmins` `addAdmin` `removeAdmin` `getVisitStats` `exportData` `listReviews` `seedData` `sendSms`

部署方式（任选）：
- **控制台 / MCP**：逐个右键「上传并部署：云端安装依赖」。
- **CLI**：`tcb fn deploy --all`（需先配置 CLI 登录）。
- `wx-server-sdk` 与 `tencentcloud-sdk-nodejs-sms`（仅 3 个短信函数）会在部署时按 `package.json` 自动安装。

---

## 6. 短信服务开通（如启用短信推送）

短信是**独立产品**，需额外在腾讯云「短信」控制台完成：

1. **资质与上图**：完成短信签名（如「二曜路8号咖啡」）实名报备。
2. **申请通知模板**：模板类型选「通知短信」，正文用变量占位，例如：
   > `【签名】{1}，您预约的{2}已{3}。预约日期{4}，场次{5}。{6}`
   变量顺序须与代码一致：`{1}称呼 {2}项目 {3}状态 {4}日期 {5}场次 {6}注意事项`。模板审批通过后拿到 **TemplateId**。
3. **拿到 SmsSdkAppId / SignName / TemplateId**。
4. **配置凭证**，二选一：
   - **环境变量**（推荐，更安全）：在 3 个短信函数（`sendSms`/`createReservation`/`reviewReservation`）的「云函数配置 → 环境变量」设置 `SMS_SECRET_ID`、`SMS_SECRET_KEY`、`SMS_SDK_APP_ID`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_ID`、`SMS_REGION`。
   - **数据库**：向 `config_sms` 写入 `{ _id:'sms', smsSdkAppId, signName, templateId, secretId, secretKey, region }`。
5. **项目级开关**：管理端「项目配置 → 全局设定 → 短信推送」逐项目开启并填写注意事项（≤30 字）。未开启则不发。

> 合规提醒：正文模板固定、变量填充是监管要求；每项目的「自定义内容」只能落在变量 `{6}`（注意事项），不可改写模板正文。

---

## 7. 微信订阅消息模板（可选，非短信）

`createReservation`/`reviewReservation`/`cancelReservation` 已预留 `cloud.openapi.subscribeMessage.send` 调用点（`_lib` 常量 `TPL`）。小程序后台申请到真实模板 ID 后，替换占位 `TPL_ID_*` 即可；未申请时调用失败**不阻断**主流程。

---

## 8. 验证清单（冒烟测试）

- [ ] 微信开发者工具用真实 AppID 打开，云能力初始化无报错。
- [ ] 店主微信首次进入管理端，`admins` 出现一条 `owner` 记录。
- [ ] 调用 `seedData` 后，首页出现 3 个项目；`projects` 含 `smsEnabled/smsNotice` 字段。
- [ ] 顾客端：选日期→选场次→填手机号→提交，收到「预约成功」或「待审核」提示；`reservations` 新增一条。
- [ ] 管理端：项目配置可批量开放/关闭日期、增删场次、改名额、开关短信。
- [ ] 短信：开启项目短信并配置 `config_sms` 后，成功预约的手机号收到短信（含日期/场次/注意事项）。
- [ ] 审核流（需审项目）：owner 在「审核」通过 → 顾客「我的预约」变「预约成功」并收到短信。

---

## 9. 回退与常见问题

- **回退原型**：本仓库 git 强版本锁，需退回 v6.3 原型执行 `git reset --hard e2e068c`（基线）；当前 SMS 改动在正常里程碑提交之上。
- **云函数部署失败**：确认运行时选 Node 18、依赖安装成功；短信函数需 `tencentcloud-sdk-nodejs-sms`。
- **短信发不出**：检查签名/模板是否审批通过、`TemplateId` 与变量顺序是否一致、凭证环境变量是否生效、手机号格式是否为 11 位大陆号码。
- **环境 ID 不匹配**：`app.js` 的 `ENV_ID` 与微信开发者工具所关联云环境须一致。

---

_文档版本：v6.3 + SMS · 配套 `design-system.html` 原型与架构计划文件。_
