# 订阅通知模板调整 + 管理台配置原型

## 已完成的工作
1. **顾客侧 3 处「店铺名」→「项目名」更正**（源码为准）
   - `reserveSuccess.thing10`（createReservation 免审 + reviewReservation 审核通过）→ `p.name`
   - `reserveCancel.thing1`（cancelReservation）→ `pName`
   - `rem - reminder.thing10`（remindReservation）→ `pName`
2. **reminder 文案**改为「预约时间很近了，记得还有一个预约，路上注意安全哦。」
3. **新增结束提醒模板 `reminderEnd`**（模板 ID `ShNSAxZvFsDgyZhFfi3OTUoYqm5khLVJkhCnqI1IEeo`），并已加入前端 `BOOKER_TPLS` 授权集合。
4. **重写 `remindReservation`**：在「开场前 ≤60 分钟」基础上新增「场次结束时刻」触发（标记 `ended` 防重复），复用既有每 15 分钟定时触发器；开场提醒文案同步更新。
5. `_lib/index.js` 的 `TPL` 增加 `reminderEnd`，并已 `cp` 同步到全部 49 个 `lib.js`。

## 前端
- 已上传体验版 **6.4.45**（含 subscribe.js 的 reminderEnd 与 BOOKER_TPLS 调整）。

## 文档与可视化
- `docs/订阅模板对照表.md`：已修订——3 处项目名更正、reminder 文案更新、新增 reminderEnd、新增触发时间点与拼接示例。
- `docs/subscribe-config-prototype.html`：管理台「订阅通知配置」原型（全局开关 + 7 个模板卡片 + 固定语前端可配置），用于讨论，后端未实现。

## ⚠️ 待解决：云函数尚未部署
当前会话**未挂载 CloudBase 部署工具**（`.workbuddy/.mcp.json` 仅含 agent-mail 代理），无法直接部署云函数。**代码已改好并通过语法校验，但需用户在连接器管理页重连 CloudBase（断开→重连并点「信任/授权」），或重启 chat 会话**，之后由我执行 `updateFunctionCode` 部署这 4 个函数：`createReservation`、`reviewReservation`、`cancelReservation`、`remindReservation`。

未部署期间：后端「项目名」与「结束提醒」逻辑不会生效，前端授权集合已含新模板。

## 下一步
- 用户重连 CloudBase 后，我立即部署 4 个云函数（存量函数，`updateFunctionCode` 可靠覆盖）。
- 管理台订阅配置原型经你审阅讨论后，再决定是否落地后端（`config.subscribe` 配置文档 + 后端读取替代硬编码 + 管理台页面入口）。
