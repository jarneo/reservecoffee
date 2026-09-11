# 订阅通知增强：微信优先降级 + 取消短信 + 前一天 17:30 提醒（2026-09-11）

## 做了什么

按你拍板的三项需求，完成代码实现、离线测试、云端部署与**真机端到端验证**：

1. **微信优先降级开关**（`config.smsnotify.skipSmsIfWxOk`，默认关）
   同一事件的微信订阅消息已送达（`errcode 0`）→ 不再补发对应短信；`43101` 未授权 / `47003` 字段非法 / `-501001` 凭证异常 → 短信照发兜底。
   判定函数 `_lib.shouldSkipSms`；延迟成功短信的降级靠落库 `reservations.wxSuccessOk`；发送顺序统一改为**先订阅后短信**。
   关（默认）＝不做判断、双通道都发，与既有行为一致。

2. **取消短信**（模板 `2729679`）
   顾客取消或**管理员代顾客取消**都发顾客，不推管理员。
   `cancelReservation` 只落**延迟计划**（`smsCancelAt = now + cancelDelay`，默认 3 分钟），由 `remindReservation` 补发并**复校仍为 cancelled**（已被恢复则跳过）。
   拆两步的收益：`cancelReservation` 不需要新增短信 SDK 依赖，避免删函数重装的运维风险。

3. **前一天 17:30 提醒**（微信「入场时间通知」编号 22555 / ID `rQEgm5zUep1S9oGeYKYUEawhPK3rs48EQwNncx0HP04` + 短信 `2729722`）
   目标＝次日 `confirmed` 的预约；时刻可在管理台配（时/分选择器，默认 17:30）。
   **同一顾客次日多笔只发最早一场**（其余标 `dayBeforeSkipped='dup-openid'`）；幂等标记 `dayBeforeNotified`。
   **字段键已与 MP 后台逐字核对并钉死**：地点 `thing2` / 入场时间 `time1` / 入场时长 `thing3` / 温馨提醒 `thing4`（此前设想的 4 组候选试错已删除——键名一确定就没必要猜）。

附带交付：
- `deploy/sync-lib.sh`（部署前同步共享库到各函数 `lib.js`/`sms.js`）
- `deploy/tests/{harness,remind.test,cancel.test,saveNotifyConfig.test}.js`（离线沙箱测试，**94 项断言全绿**：remind 41 + cancel 23 + saveNotifyConfig 30）
- `docs/订阅模板对照表.md` 按源码全量校正（8 订阅 + 5 短信 + 降级语义 + 运行期排查）
- `交付说明_订阅通知增强_20260911.md`（部署清单与待办）

**附带修复（同日深夜）**：管理台「全局通知配置 → 保存」报 `-504002`。CLS 实锤真凶是
`document.set:fail -501007 … 不能更新_id的值` —— `saveNotifyConfig` 的「文档不存在就新建」分支把 `_id` 塞进了 `set({data})`。
因 `config.subscribe` 文档从来不存在，**此前每一次保存都失败、开关从未落库**。已抽 `upsertConfig()` 修好并重新部署；
测试桩同时补上 `set/update` 禁带 `_id` 的真实约束（旧写法会被拦下）。详见交付说明 §六。

**附带修复（09-12 凌晨）**：「我的预约」里 09-11 的预约不显示「已过期」。三个缺陷一并修掉（详见交付说明 §七）：
1. **时区**：`listMyReservations` 用 `new Date('2026-09-11 20:00')` 按容器时区解析，而容器是 **UTC**、字段存的是北京时间 → 过期判定整体延后 8 小时（15:00 之后结束的场次全部误判）。改用 `Date.UTC(...) - 8h`。
2. **`ended` 永不落库**（更严重）：`remindReservation` pass ④ 的 where 带了 `reminded: _.neq(true)`，而正常预约都会先收到开场前提醒 → 从此不再进入循环 → **结束提醒与过期短信几乎从未发出**。改为一律用 `!r.reminded` 守卫。
3. **深夜补发**：加发送时间窗 `END_SEND_WINDOW_MIN=120`，超窗只打 `ended` + `reminderEndSkipped:'too-late'`。另修正 `expiredWhen` 缺省口径（旧代码缺省 `'before'`，会提前 5 分钟发「预约已完成」）。
- 已验证：00:15 定时轮次 `checked:31 / sentEnd:28 / sentStart:0`，29 笔历史积压（08-23→09-11）补打 `too-late`，**零消息发出**。
- 测试增至 **130 项全绿**，且 `TZ=UTC` 与 `TZ=Asia/Shanghai` 下结果一致。

**收口（09-12 00:20）**：修完 §七 后做了一次**全仓库扫描**，发现同一个时区 bug 在 `cancelReservation` 里还有第二份拷贝
（`new Date(\`${r.date} ${r.sessionEnd}\`)`，用于「该预约当前不可取消」守卫）——**顾客可在场次结束后 8 小时内取消一笔已结束的预约并错误释放名额**
（实测：结束于 1 分钟前的场次，旧实现判定「未结束」，偏差 **+8.0 小时**）。
治本而非再抄一份：把 `bjTs()` / `effStatus()` **上收到共享库 `_lib`** 并导出，`cancelReservation`、`listMyReservations` 删掉各自本地实现统一调用——
此后全项目只有一份过期判定。`cancel.test.js` 增 C10–C14（时区/边界/跨天），**全量 139 项全绿**（双时区）。
已部署 `cancelReservation`（00:20:35）、`listMyReservations`（00:20:44）。详见交付说明 §八。

## 关键决策

- **字段键以 MP 后台原文为准并钉死**：你提供了「详细内容」原文（thing2/time1/thing3/thing4），据此把原先的 4 组候选试错**整体删除**，改为常量 `DAY_BEFORE_KEY`。教训：该模板编号规律与既有模板不重合（`reminder` 是 thing10/time1/thing5），不能类推。
- **发送时间窗 `[dayBeforeAt, +180min]`**：防「任务长期停用后恢复深夜补发」与「部署当天已过时刻立即补发」。
- **取消短信交给定时任务发**：换掉「给 cancelReservation 加短信 SDK 依赖」的方案，零依赖变更。
- **先测后部署**：沙箱里用**真实 `_lib`**跑分支矩阵（开关×通道×状态×权限），不靠部署到线上试。

## 部署与验证结果（✅ 全部完成）

**部署**：8 个云函数经 CloudBase MCP 全部更新成功，`ModTime` 实证：
`createReservation`/`cancelReservation` 22:53:55 · `reviewReservation`/`reviewAllReservations` 22:54:02 · `getSmsConfig`/`saveSmsConfig` 22:54:09 · **`remindReservation` 23:17:01（钉死字段键版）** · `saveNotifyConfig` 23:17:13。

**云端配置**：`config_sms.templates` 增 `dayBefore=2729722`、`cancel=2729679`（`$set` 点号路径，保护文档里的 `visitors` 数据）；`config/smsnotify` 落默认值。

**真机端到端验证（23:30 定时轮次，实测）**：

| 观测项 | 实测值 | 结论 |
|---|---|---|
| CLS `request_source` | `TCB_API` | 调度健康（MCP 改代码未破坏 DevTools 注册的云侧调度） |
| `[dayBefore] target=` | `2026-09-12 rows= 3 picked= 1 at= 1410` | 次日记账正确；**3 笔去重→只发 1 笔** |
| 微信订阅 | `errCode 43101`（模板 ID 与 MP 后台一致） | 模板/键/凭证链路通，仅缺用户授权 |
| 短信兜底 | `SendStatusSet[0].Code = "Ok"`，`PhoneNumber +86180623062` | **短信真实送达** |
| 另两笔同一顾客预约 | `dayBeforeSkipped = "dup-openid"` | 未重复打扰 |
| 已取消那笔 | 无任何 dayBefore 字段写入 | 状态过滤正确 |
| `config.smsnotify.dayBeforeAt` | 已从临时 `23:25` **回退为 `17:30`** | 恢复正常生产时刻 |

**顺带查实的一件大事**：23:30 的微信发送返回的是 `43101`（微信侧「用户未授权」）而不是 `-501001`——**说明云调用凭证当前是有效的**，网关拿到了 token 并被微信受理。（今日早前的 `reservations.reminderNotify` 仍是 `-501001`，说明凭证是在今日内恢复的。）这意味着此前的订阅消息凭证阻塞已解除，建议明天用一笔真实预约再复测「临近提醒」。

## 待你处理

1. ~~前端上传~~ ✅ 你已在微信开发者工具「上传」（版本 `6.6.4`，`subscribe.js` 已含 `dayBefore`，`BOOKER_TPLS` 5 个模板按 3+2 分两次弹窗）。
2. **授权前一天提醒模板**：现有 3 笔 09-12 的预约已打 `dayBeforeNotified` 不再补发。要看到「入场时间通知」卡片本身，请在**新版体验版**里再提交一笔**未来日期**的预约，弹窗时把两个授权框都允许（第二个框含「入场时间通知」）。
3. **观察正式生效**：明天（09-12）17:30 起，针对 09-13 的预约自动推送（微信 + 短信；短信开关 `skipSmsIfWxOk` 当前为**关**＝双通道都发，等你确认卡片稳定后可开启省短信）。

---

## 追加轮次：管理端推送与字段展示（09-12 00:26–00:55）

**① 管理员推送「没有了」= 一次性订阅授权被用尽（不是代码 bug）**
权威判据是 `reservations.adminNotify[].errCode`：用户账号 00:22–00:23 两笔的新预约提醒 **5/5 全 `43101`**，但同一时刻「待审核提醒」模板却有 `ok:true`——**各模板独立计数**。开关、模板 ID、云调用权限均已逐一排除。
真实缺陷在**前端**：`util.requestSubscribe` 忽略授权结果、`hub.enableAdminNotify` 无条件提示「已授权」→ 管理员永远发现不了失败。
已改为返回真实结果（`{total, accepted[], rejected[], failed[], errCode}`）＋ hub 按结果反馈＋授权卡片置顶常驻。
⚠️ **关键坑**：所有分片必须在**同一个同步 tick** 内下发（微信要求 TAP 手势上下文），改 Promise 串行会让第 2 组起弹窗失败。

**② 管理端看不到「备注 / 微信 / 性别 / 年龄」**
后端 `listReviews` 只返回 `note` 漏了 `wechat/gender/age`；前端 `sessions`/`review` 两个页面压根没渲染。两端均补齐，`sessions` 详情弹层新增**微信号带「复制」按钮**（管理员常需复制微信号联系）。
新增 `listReviews.test.js`（16 项）锁死字段契约。⚠️ 踩坑：`ok()` 把数据包在 `data` 下，测试须读 `res.data.list`。

**③ 审核环节不再通知管理员（通过 / 拒绝都停推）**
原实现不论通过/拒绝都推「待审核提醒」，语义不符且打扰。**定案：审核环节对管理员零推送**，两个分支都落库
`{skipped:true, decision, reason:'admin push disabled on review'}` 留痕。**「待审核提醒」只在顾客下单时由 `createReservation` 发出**。
单条/批量**同源拷贝必须同步改**。新增 `review.test.js`（**26 项**，一个文件跑两个入口），并**反证过**（把拒绝推送打回 → 2 项变红）。

**④ 复核「我没有点拒绝」——我错了，用户是对的**
回查：`review:'rejected'` **0 条**，从未拒绝过。投诉的那条实为 00:38:48 点「通过」后由旧代码发出的第二条「待审核提醒」；修复部署于 00:41:15（晚 2.5 分钟）。
✅ 机制诊断（授权耗尽）方向正确且被 00:37:57 的 `ok:true` 正向验证；❌ 但我把 `43101` 文案当字面意思复述了——**`43101` 只表示「该模板无可用一次性授权次数」，不代表用户点过「拒绝」**。

**全量回归 181 项全绿**（remind 59 + cancel 32 + saveNotifyConfig 30 + listMyReservations 18 + listReviews 16 + review 26），`TZ=UTC` 与 `TZ=Asia/Shanghai` 一致。

**已部署并核对**：`reviewReservation`（00:54:57）、`reviewAllReservations`（00:55:03），均 `Active`，云端 CodeInfo 已逐字核对含新分支。

**待你处理**：① 在管理台点「续订管理推送」并勾选「总是保持以上选择，不再询问」（你本人 00:37:57 已续订成功，另 4 个管理员从未授权）；② DevTools 重新上传小程序（本轮改了 `util.js`/`hub.*`/`sessions.*`/`review.wxml`）；③ 下次审核时留意管理员侧应**零推送**。
