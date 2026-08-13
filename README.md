# 二曜路8号咖啡和清酒 · 预约小程序

微信原生小程序 + 腾讯云开发 CloudBase 的可运行脚手架。黑白极简设计，一抹品牌色（暖咖棕 `#7A5230`）点缀。

> 设计基线见 `design/design-system.html`（v6.3 交互原型）与 `design/DESIGN_SYSTEM.md`；架构见 `C:\Users\Administrator\.workbuddy\plans\toasty-nebula-babbage.md`。

## 目录结构

```
reservecoffee/
├── miniprogram/              # 小程序前端（wx.cloud）
│   ├── app.js / app.json / app.wxss
│   ├── utils/                # cloud 调用封装、通用工具
│   ├── components/           # adminGuard(行为) / sessionCard / calendar
│   └── pages/                # 顾客端 4 页 + 管理端 8 页
├── cloudfunctions/           # 26 个云函数（wx-server-sdk）
│   ├── _lib/index.js         # 共享库（初始化/数据库/角色/响应/订阅占位）
│   └── <name>/index.js + lib.js + package.json
└── design/                   # 交互原型与规范（非运行代码）
```

## 环境准备

1. 微信开发者工具导入项目，目录选本仓库根，`miniprogramRoot` 已配置为 `miniprogram/`。
2. 填入小程序 AppID（`project.config.json` 当前为 `touristappid`，仅可预览部分能力，云能力需真实 AppID）。
3. 在 `miniprogram/app.js` 顶部把 `ENV_ID` 改为你的 CloudBase 环境 ID，并在微信开发者工具「云开发」中关联到同一环境。

## 数据库集合（云开发控制台创建）

| 集合 | 说明 |
|---|---|
| `config_homepage` | 首页配置，单文档 `_id: homepage` |
| `projects` | 预约项目（含 `openDays`/`advanceDays`/`useSlotTemplate` 等） |
| `schedules` | 按项目+天的场次 |
| `reservations` | 预约记录（双轴 `status` + `review`） |
| `admins` | 微信授权管理员（owner/manager） |
| `stats_daily` | 访问统计（按日） |

建议权限规则：读 = 所有用户；写 = 仅云函数（后台）。`_lib` 中的云函数已按角色做写校验。

## 云函数部署

`cloudfunctions/` 下共 26 个函数，每个目录含 `index.js` + `lib.js` + `package.json`，运行时 `Nodejs18.15`：

```
顾客端：getHomepage, getProject, createReservation, listMyReservations, cancelReservation
管理端：getRole, updateHomepage, listProjects, createProject, updateProject,
       publishProject, getSchedule, setDaySessions, setOpenDays, copyDaySessions,
       setSession, listSessionReservations, reviewReservation, markCompleted,
       listAdmins, addAdmin, removeAdmin, getVisitStats, exportData,
       listReviews, seedData
```

在 CloudBase 控制台 / MCP 逐个部署（或 `tcb fn deploy --all`）。`wx-server-sdk` 会在部署时自动安装。

## 初始化数据

部署后，用小程序以「店主」微信首次进入管理端会自动成为 `owner`（首个进入者）。随后调用 `seedData` 云函数即可写入首页文案 + 3 个种子项目（法兰绒深烘咖啡 / 清酒品鉴 / 法兰绒研习社）。
也可在云开发控制台直接为 `config_homepage` 写入 `_id:'homepage'` 文档。

## 订阅消息

`createReservation` / `reviewReservation` / `cancelReservation` 预留了微信订阅消息发送点（`_lib` 中 `TPL` 常量 + `sendSubscribe`）。模板 ID 当前为占位 `TPL_ID_*`，未申请时发送失败不阻断主流程；申请到真实模板后替换 `TPL.*` 即可。

## 已知限制 / 后续

- 爽约释放规则本期未实现（架构已预留）。
- 店员「申请成为管理员」暂为管理员手动填 OpenID 授权（`addAdmin`），未做扫码/名片分享申请流。
- 头图/图标上传走云存储，需另配上传权限与 CDN。
- 微信订阅消息模板需到小程序后台申请并替换占位 ID。
