# 部署记录 · CloudBase 实际部署

> 执行时间：2026-08-14｜方式：WorkBuddy 经 CloudBase MCP（连接器已连接）
> 环境：`cloud1-d8g9mhgxm32d2eac6`（别名 cloud1，上海，个人版，默认环境）

## 已完成

### 1. 数据库集合（7 个，已建 + 权限默认）
| 集合 | 状态 | 说明 |
|---|---|---|
| `config_homepage` | 1 条 | 首页文案（`_id:homepage`） |
| `projects` | 3 条 | 种子项目（法兰绒深烘咖啡 / 清酒品鉴 / 法兰绒研习社） |
| `config_sms` | 1 条 | 短信全局配置占位（`_id:sms`，凭证待填） |
| `admins` | 0 | 店主/管理员，首次进管理端自动生成 owner |
| `schedules` | 0 | 按项目+天的场次，业务写入 |
| `reservations` | 0 | 预约记录，业务写入 |
| `stats_daily` | 0 | 访问统计，业务写入 |

> 环境里另有 1 个原有 `test` 集合（非本项目），已忽略。

### 2. 云函数（27 个，已部署，Nodejs18.15 / Event / index.main）
顾客端 5：`getHomepage` `getProject` `createReservation` `listMyReservations` `cancelReservation`
管理端 22：`getRole` `updateHomepage` `listProjects` `createProject` `updateProject` `publishProject` `getSchedule` `setDaySessions` `setOpenDays` `copyDaySessions` `setSession` `listSessionReservations` `reviewReservation` `markCompleted` `listAdmins` `addAdmin` `removeAdmin` `getVisitStats` `exportData` `listReviews` `seedData` `sendSms`

### 3. 种子数据（已写，绕开 seedData 的 OPENID 校验）
- `config_homepage._id:homepage`：品牌名「二曜路8号咖啡和清酒」+ 简介
- `projects` ×3：含 `smsEnabled:false` / `smsNotice:''` / `openDays:[]` 等默认字段
- `config_sms._id:sms`：空凭证占位（`region:ap-shanghai`）

### 4. 端到端验证
- `listCollections` 确认 7 个集合存在且计数正确。
- 真实调用 `getHomepage`：返回 `code:0`，正确读出首页文案 + 3 个项目（函数跑通、库读通）。

### 5. 前端占位替换
- `miniprogram/app.js` 的 `ENV_ID` 已由 `your-env-id` 改为 `cloud1-d8g9mhgxm32d2eac6`。

## 待你（用户侧）完成

- [ ] **AppID**：`project.config.json` 的 `appid` 仍是 `touristappid`（只能预览、无法用云能力）。换成微信公众平台真实 AppID。
- [ ] **导入项目**：微信开发者工具「导入项目」，目录选仓库根（`miniprogramRoot`/`cloudfunctionRoot` 已指向对应目录）。
- [ ] **首位店主**：店主微信首次打开管理端，自动写入 `admins` 一条 `owner` 记录。
- [ ] **短信（可选）**：在腾讯云短信控制台完成签名+模板审批，拿到 SmsSdkAppId / SignName / TemplateId，填入 `config_sms` 或 3 个短信函数（`sendSms`/`createReservation`/`reviewReservation`）的环境变量（SMS_SECRET_ID / SMS_SECRET_KEY / SMS_SDK_APP_ID / SMS_SIGN_NAME / SMS_TEMPLATE_ID / SMS_REGION）。模板变量顺序：`{1}称呼{2}项目{3}状态{4}日期{5}场次{6}注意事项`。
- [ ] **订阅消息（可选）**：小程序后台申请 4 个订阅模板，替换 `cloudfunctions/_lib/index.js` 中 `TPL_ID_*` 占位；未申请时发送失败不阻断主流程。
- [ ] **首跑业务**：管理端发布项目→开放日期/设场次→顾客端预约，验证完整链路。

## 回退
后端变更均在云上，无 git 影响。前端改动仅 `app.js` 一行 ENV_ID。如需回退原型代码：`git reset --hard e2e068c`（v6.2 基线）。
