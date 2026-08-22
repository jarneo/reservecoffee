// cloudfunctions/_lib/sms.js — 腾讯云短信发送辅助（单条留座模板）
// 依赖：tencentcloud-sdk-nodejs-sms（在调用方云函数的 package.json 中声明）
// 合规说明：国内短信必须使用控制台「已审批」的签名 + 模板。本辅助使用单一模板，
// 变量：{1}称呼 {2}日期 {3}场次 {4}几人位；正文固定、变量填充，确保通过运营商模板审核。
// 店铺名由控制台签名 SignName 提供（=「二曜路8号咖啡和清酒」），模板正文不含签名前缀。

const REGION = process.env.SMS_REGION || 'ap-guangzhou'

// 读取短信全局配置：优先环境变量，回退 config_sms 文档（_id:'sms'）
async function loadConfig(db) {
  const env = {
    secretId: process.env.SMS_SECRET_ID,
    secretKey: process.env.SMS_SECRET_KEY,
    smsSdkAppId: process.env.SMS_SDK_APP_ID,
    signName: process.env.SMS_SIGN_NAME,
    templateId: process.env.SMS_TEMPLATE_ID
  }
  const hasEnv = env.secretId && env.secretKey && env.smsSdkAppId && env.signName && env.templateId
  if (hasEnv) return env
  const doc = await db.collection('config_sms').doc('sms').get().catch(() => ({ data: null }))
  return doc && doc.data ? doc.data : null
}

/**
 * 发送预约留座短信（单条，≤70 字，仅发预订人）
 * @param {object} o { db, phone, name, date, time, seats }
 *   date: 友好短日期（如 8月20日，由调用方 monthDay 生成）
 *   time: 场次时段（如 14:00-15:00）
 *   seats: 几人位（如 2人位）
 * 返回 { skipped, reason } 或 { ok, res } / { ok:false, error }
 */
async function sendReservationSms(o) {
  const { db, phone, name, date, time, seats } = o
  if (!phone) return { skipped: true, reason: 'no phone' }

  const cfg = await loadConfig(db)
  if (!cfg) return { skipped: true, reason: 'sms not configured' }

  let SmsClient
  try {
    SmsClient = require('tencentcloud-sdk-nodejs-sms').sms.v20210111.Client
  } catch (e) {
    console.warn('[sms] SDK not installed, skip:', e.message)
    return { skipped: true, reason: 'sdk missing' }
  }

  const client = new SmsClient({
    credential: { secretId: cfg.secretId, secretKey: cfg.secretKey },
    region: REGION,
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } }
  })

  // 模板变量顺序需与控制台已审批模板一致：
  // {1}称呼 {2}日期 {3}场次 {4}几人位
  // 模板正文（不含签名，签名由 SignName 提供）：
  //   亲爱的{1}，已为您留座：{2} {3}，{4}。到店报手机号即可，期待相见～
  const TemplateParamSet = [
    name || '顾客',
    date || '',
    time || '',
    seats || ''
  ]

  try {
    const res = await client.SendSms({
      PhoneNumberSet: ['+86' + phone],
      SmsSdkAppId: cfg.smsSdkAppId,
      SignName: cfg.signName,
      TemplateId: cfg.templateId,
      TemplateParamSet
    })
    console.log('[sms] sent ok', res && res.SendStatusSet)
    return { ok: true, res }
  } catch (e) {
    console.warn('[sms] send failed (ignored):', e.message)
    return { ok: false, error: e.message }
  }
}

module.exports = { sendReservationSms, loadConfig }
