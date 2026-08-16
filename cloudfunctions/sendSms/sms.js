// cloudfunctions/_lib/sms.js — 腾讯云短信发送辅助
// 依赖：tencentcloud-sdk-nodejs-sms（在调用方云函数的 package.json 中声明）
// 合规说明：国内短信必须使用控制台「已审批」的签名 + 模板；本辅助使用单一模板，
// 通过变量携带动态内容（称呼/项目/状态/日期/场次/注意事项），每项目的自定义内容
// 体现在「注意事项」变量上，而非自由拼接正文，以确保通过运营商模板审核。

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
 * 发送预约类短信
 * @param {object} o { db, phone, name, project, date, time, status, notice }
 *   status: 'confirmed' | 'pending'（决定短信正文里的状态文案）
 * 返回 { skipped, reason } 或 { ok, res } / { ok:false, error }
 */
async function sendReservationSms(o) {
  const { db, phone, name, project, date, time, status, notice } = o
  if (!phone) return { skipped: true, reason: 'no phone' }

  const cfg = await loadConfig(db)
  if (!cfg) return { skipped: true, reason: 'sms not configured' }

  const statusText = status === 'confirmed' ? '预约成功' : '待审核'
  const noticeText = (notice && notice.trim()) || (cfg && cfg.noticeTemplate && cfg.noticeTemplate.trim()) || '请准时到店，如需取消请提前在「我的预约」操作'

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
  // {1}称呼 {2}项目 {3}状态 {4}日期 {5}场次 {6}注意事项
  const TemplateParamSet = [
    name || '顾客',
    project || '',
    statusText,
    date || '',
    time || '',
    noticeText
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
