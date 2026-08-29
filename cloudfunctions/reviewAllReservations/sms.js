// cloudfunctions/_lib/sms.js — 腾讯云短信发送辅助（多模板，无参数模板）
// 依赖：tencentcloud-sdk-nodejs-sms（在调用方云函数的 package.json 中声明）
// 合规说明：国内短信必须使用控制台「已审批」的签名 + 模板。
// 注意：本项目的三个业务模板（预定成功 2715328 / 预约临近 2716156 / 预约过期 2716682）
// 均为「无参数模板」（除验证码模板外均不支持参数配置），故发送时不传 TemplateParamSet。
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

/**
 * 发送指定模板的短信（无参数模板）
 * @param {object} o { db, phone, templateId }
 *   templateId：腾讯云控制台已审批的模板 ID（字符串/数字均可）
 * 说明：三个业务模板均为无参数模板，故 TemplateParamSet 恒为空数组。
 */
async function sendTemplateSms(o) {
  const { db, phone, templateId } = o
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
      TemplateParamSet: []
    })
    console.log('[sms] sent ok', templateId, res && res.SendStatusSet)
    return { ok: true, res }
  } catch (e) {
    console.warn('[sms] send failed (ignored):', e.message)
    return { ok: false, error: e.message }
  }
}

/**
 * 发送「预定成功」短信（兼容旧调用）：使用 success 模板（无参数）
 * @param {object} o { db, phone }
 */
async function sendReservationSms(o) {
  const { db, phone } = o
  const cfg = await loadConfig(db)
  if (!cfg) return { skipped: true, reason: 'sms not configured' }
  const tid = cfg.templates && cfg.templates.success
  if (!tid) return { skipped: true, reason: 'no success template' }
  return sendTemplateSms({ db, phone, templateId: tid })
}

module.exports = { sendReservationSms, sendTemplateSms, loadConfig }
