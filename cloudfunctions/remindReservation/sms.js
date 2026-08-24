// cloudfunctions/_lib/sms.js — 腾讯云短信发送辅助（多模板）
// 依赖：tencentcloud-sdk-nodejs-sms（在调用方云函数的 package.json 中声明）
// 合规说明：国内短信必须使用控制台「已审批」的签名 + 模板。本辅助支持多模板，
// 变量顺序须与控制台已审批模板一致（见各模板的 {1}{2}{3}… 占位）。
// 店铺名由控制台签名 SignName 提供（=「二曜路8号咖啡和清酒」），模板正文不含签名前缀。

const REGION = process.env.SMS_REGION || 'ap-guangzhou'

// 读取短信全局配置：优先环境变量，回退 config_sms 文档（_id:'sms'）
// 返回：{ secretId, secretKey, smsSdkAppId, signName, region, templates:{success,approaching,expired} }
async function loadConfig(db) {
  const env = {
    secretId: process.env.SMS_SECRET_ID,
    secretKey: process.env.SMS_SECRET_KEY,
    smsSdkAppId: process.env.SMS_SDK_APP_ID,
    signName: process.env.SMS_SIGN_NAME,
    region: process.env.SMS_REGION
  }
  const hasEnv = env.secretId && env.secretKey && env.smsSdkAppId && env.signName
  if (hasEnv) {
    // 环境变量仅支持单模板(SMS_TEMPLATE_ID) 的兼容回退：三个场景复用同一模板
    return {
      ...env,
      region: env.region || REGION,
      templates: { success: process.env.SMS_TEMPLATE_ID, approaching: process.env.SMS_TEMPLATE_ID, expired: process.env.SMS_TEMPLATE_ID }
    }
  }
  const doc = await db.collection('config_sms').doc('sms').get().catch(() => ({ data: null }))
  const c = doc && doc.data ? doc.data : null
  if (!c) return null
  return {
    secretId: c.secretId,
    secretKey: c.secretKey,
    smsSdkAppId: c.smsSdkAppId,
    signName: c.signName,
    region: c.region || REGION,
    templates: c.templates || {}
  }
}

// 构造模板变量数组。
// 注意：三个模板的 {N} 变量顺序/数量可能与下方默认不同，须以腾讯云控制台模板内容为准。
// 当前默认采用现有留座模板顺序：{1}称呼 {2}日期 {3}场次 {4}几人位。
// 待用户提供三个模板的真实占位顺序后，在此按 type 分模板锁定（见 buildSmsParams 的 TODO）。
function buildSmsParams(type, ctx) {
  // TODO(待确认): 用户从腾讯云控制台粘贴三个模板的 {1}{2}{3}… 内容后，
  // 按各模板真实变量顺序返回数组。目前统一用 称呼/日期/场次/几人位 占位。
  const name = (ctx && ctx.name) || '顾客'
  const date = (ctx && ctx.date) || ''
  const time = (ctx && ctx.time) || ''
  const seats = (ctx && ctx.seats) || ''
  return [name, date, time, seats]
}

/**
 * 发送指定模板的短信（通用）
 * @param {object} o { db, phone, templateId, params }
 *   params: 字符串数组，顺序与模板 {1}{2}{3}… 一致
 */
async function sendTemplateSms(o) {
  const { db, phone, templateId, params } = o
  if (!phone) return { skipped: true, reason: 'no phone' }
  if (!templateId) return { skipped: true, reason: 'no templateId' }

  const cfg = await loadConfig(db)
  if (!cfg || !cfg.secretId) return { skipped: true, reason: 'sms not configured' }

  let SmsClient
  try {
    SmsClient = require('tencentcloud-sdk-nodejs-sms').sms.v20210111.Client
  } catch (e) {
    console.warn('[sms] SDK not installed, skip:', e.message)
    return { skipped: true, reason: 'sdk missing' }
  }

  const client = new SmsClient({
    credential: { secretId: cfg.secretId, secretKey: cfg.secretKey },
    region: cfg.region || REGION,
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } }
  })

  try {
    const res = await client.SendSms({
      PhoneNumberSet: ['+86' + phone],
      SmsSdkAppId: cfg.smsSdkAppId,
      SignName: cfg.signName,
      TemplateId: String(templateId),
      TemplateParamSet: params || []
    })
    console.log('[sms] sent ok', templateId, res && res.SendStatusSet)
    return { ok: true, res }
  } catch (e) {
    console.warn('[sms] send failed (ignored):', e.message)
    return { ok: false, error: e.message }
  }
}

/**
 * 发送预约留座短信（兼容旧调用）：使用 success 模板 + 4 变量占位
 * @param {object} o { db, phone, name, date, time, seats }
 */
async function sendReservationSms(o) {
  const { db, phone, name, date, time, seats } = o
  const cfg = await loadConfig(db)
  if (!cfg) return { skipped: true, reason: 'sms not configured' }
  const tid = cfg.templates && cfg.templates.success
  if (!tid) return { skipped: true, reason: 'no success template' }
  return sendTemplateSms({
    db, phone, templateId: tid,
    params: buildSmsParams('success', { name, date, time, seats })
  })
}

module.exports = { sendReservationSms, sendTemplateSms, loadConfig, buildSmsParams }
