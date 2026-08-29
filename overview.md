# 审核通知收不到 —— 根因与修复（2026-08-25）

## 真实根因（已用诊断函数实证）
不是授权问题、不是字段关键字问题、不是代码逻辑问题。

用临时诊断函数 `diagNotify` 对全部 4 个管理员各发一次 `adminReview`，全部返回：
```
errCode: -501001
errMsg: subscribeMessage.send:fail invalid wx openapi access_token
```
**根因 = 云环境 `cloud1-d8g9mhgxm32d2eac6` 没有配置小程序的 AppSecret（微信开发者凭证）。**

所有 `cloud.openapi.*` 调用（订阅消息、手机号、内容安全）都依赖环境凭证去换取 access_token。
凭证缺失 → 拿不到 token → 所有订阅消息统一静默失败。所以**不只是审核通知，预约成功 / 新预约 / 开场提醒 / 审核结果……其实全部发不出去**，只是你先测到了审核这一条。

前两轮"空手机号 47003""字段关键字不匹配"的假设均被排除（diag 直接调用发信函数也是 -501001，根本走不到字段校验）。

## 必须由你完成的修复（控制台手动步骤，沙箱无法代操作）
1. 打开 **CloudBase 控制台** → 进入环境 **`cloud1-d8g9mhgxm32d2eac6`**。
2. **环境设置 → 微信开发者凭证**（或"微信小程序"凭证配置项）。
3. 填入小程序 **AppID `wxb97578ed89c6e2c7`** 对应的 **AppSecret**（在小程序后台「开发管理 → 开发设置 → AppSecret」获取/重置），保存。
4. 保存后，**管理台 hub 页再点一次「开启管理推送」** 续期授权（订阅为一次性，授权额度用一次少一次）。
5. 提交一个「法兰绒研习社预约」（needReview=true）的待审预约（填手机号）。

完成后告诉我，我用 `diagNotify` 复测：若不再报 -501001，说明凭证生效、通知链路已通。

## 已落地的改动（不依赖你的控制台操作）
- `_lib` 的 `sendSubscribe`/`notifyAdmins` 改为**返回结构化结果**（ok / skipped / errCode / errMsg），不再静默吞错误。
- `createReservation` / `reviewReservation` 把管理侧发送结果落库到预约记录的 `adminNotify` / `adminNotifyReview`，便于后续复查。
- `util.requestSubscribe` 把授权 accept/reject 结果打到控制台。
- 前端已上传体验版 **6.5.10**；`createReservation` / `reviewReservation` 已重新部署（保留健康依赖）。
- 临时诊断函数 `diagNotify` 暂留（验证通过后删除）。

## 待你本机执行（沙箱 git 受限）
```bash
git add -A && git commit -m "fix: 订阅发送结果落库诊断；_lib 返回结构化错误" && git push && git push --tags
```
