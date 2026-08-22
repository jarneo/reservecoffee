# 服务通知（服务号模板消息）实现 · 概览

**日期**：2026-08-22
**状态**：代码已全部完成（本地），已同步 `lib.js` 并 `node --check` 全通过；**待部署**（本会话 CloudBase 工具未加载）。

## 做了什么
- **后端**
  - `_lib/index.js`：新增 `MP_TPL`（4 个服务号模板 ID）+ `sendMp` / `getMpOpenid` / `notifyAdminsMp` / `readMpSwitch` / `mpOn`。
  - 新云函数 `mpCallback`（关注/取消关注事件 → 写 `users.mpOpenid`，按 unionid 关联，免 AppSecret/出网）。
  - 新云函数 `getNotifyConfig` / `saveNotifyConfig`（读写 `config.subscribe` / `config.mp`）。
  - `create` / `cancel` / `review` 接入服务号发送（双层开关：`projects.mpNotify` && `config.mp[key]`）；顺带修复 `cancel` 的 `pName` 提前使用、`review` 的 `p` 跨 if 作用域两处 ReferenceError（订阅消息也受影响）。
  - `saveProfile` 存 `unionid`（关联服务号关键）。
- **前端（管理台）**
  - 新页面 `pages/admin/notifyConfig`：订阅 7 开关 / 服务号 4 开关 + AppID + Token / 短信跳转。
  - `projectConfig` 新增「开启服务号通知」总开关（`mpNotify`）；`hub` 加入口；`app.json` 注册。
- **文档**：`docs/服务通知实现与配置.md`（字段映射、双层开关、公众平台配置步骤、time 字段提醒、AppSecret 澄清）。

## 关键结论
- **不需要服务号 AppSecret**：服务号模板消息走 `cloud.openapi.templateMessage.send`，凭据由「云环境绑定服务号」托管（与订阅消息同理）。
- **服务号送达前提**：① 用户关注服务号 ② 公众平台「消息推送」指向 `mpCallback` ③ 云环境已绑服务号。未关注自动跳过，不报错。

## 待办（阻塞/下一步）
1. **重连 / 重开 chat 会话**加载 CloudBase 工具后，由 AI 部署 7 个云函数（`createReservation` `cancelReservation` `reviewReservation` `saveProfile` `mpCallback` `getNotifyConfig` `saveNotifyConfig`）。
2. 前端上传体验版（`deploy/sync.js`）使 `notifyConfig` 页与 `mpNotify` 开关生效。
3. 公众平台配置消息推送 Token 并回填到「全局通知配置 → 服务号 → Token」。
