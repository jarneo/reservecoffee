// addReview — 顾客端：发表评价（评分 + 文字 + 图片）
// 上线审核合规要求：
//  1) 必须携带真实微信昵称与头像（前端在授权弹窗后通过 chooseAvatar + nickname 采集），不允许匿名 / 随机名兜底。
//  2) 提交瞬间调用微信内容安全：msgSecCheck(文字) + imgSecCheck(图片)，任一不通过直接拦截、不入库。
//  3) 机器检测通过后进入人工审核队列 reviewStatus='pending'，审核通过(reviewStatus='approved')才对外展示。
const { db, COL, ok, fail, wxCtx, cloud } = require('./lib')

// 文字内容安全（评论场景 scene=2）
async function secCheckText(openid, text) {
  const raw = String(text || '').trim()
  if (!raw) return
  try {
    await cloud.openapi.security.msgSecCheck({ content: raw.slice(0, 500000), scene: 2, version: 2, openid })
  } catch (e) {
    const code = e && e.errCode
    if (code === 87014) throw Object.assign(new Error('评论内容包含违规信息，未通过审核'), { blocked: true })
    // 权限未配置 / 接口异常：安全优先，拒绝发布（避免违规内容流入）
    console.warn('[addReview] msgSecCheck error (rejected for safety):', code || (e && e.errMsg))
    throw Object.assign(new Error('评论发布失败，请稍后重试'), { blocked: true })
  }
}

// 图片内容安全：下载云存储文件 → 取 buffer → imgSecCheck
async function secCheckImage(fileID) {
  if (!fileID) return
  let buf
  try {
    const dl = await cloud.downloadFile({ fileID })
    buf = dl && dl.fileContent
  } catch (e) {
    console.warn('[addReview] image download failed (rejected for safety):', e && e.message)
    throw Object.assign(new Error('图片读取失败，请稍后重试'), { blocked: true })
  }
  if (!buf) throw Object.assign(new Error('图片读取失败，请稍后重试'), { blocked: true })
  const ext = (String(fileID).split('.').pop() || 'jpg').toLowerCase()
  const contentType = ext === 'png' ? 'image/png' : (ext === 'gif' ? 'image/gif' : 'image/jpeg')
  try {
    await cloud.openapi.security.imgSecCheck({ media: { contentType, value: buf } })
  } catch (e) {
    const code = e && e.errCode
    if (code === 87014) throw Object.assign(new Error('图片包含违规内容，未通过审核'), { blocked: true })
    console.warn('[addReview] imgSecCheck error (rejected for safety):', code || (e && e.errMsg))
    throw Object.assign(new Error('图片审核失败，请稍后重试'), { blocked: true })
  }
}

async function recompute(db, productId) {
  const r = await db.collection(COL.reviews).where({ productId, reviewStatus: 'approved' }).get()
  const list = r.data || []
  const count = list.length
  const avg = count ? Math.round(list.reduce((s, x) => s + (x.rating || 0), 0) / count * 10) / 10 : 0
  await db.collection(COL.products).doc(productId).update({ data: { rating: avg, ratingCount: count } }).catch(() => {})
}

exports.main = async (event) => {
  const { OPENID } = wxCtx()
  if (!OPENID) return fail('无法识别身份')

  const { productId, rating, text, name, avatar, images } = event
  if (!productId) return fail('缺少 productId')
  const r = Number(rating)
  if (!(r >= 1 && r <= 5)) return fail('请给出 1–5 星评分')

  // 真实昵称 / 头像：不允许匿名或随机名兜底
  const nick = String(name || '').trim()
  const av = String(avatar || '').trim()
  if (!nick) return fail('请先授权并填写微信昵称')
  if (!av) return fail('请先选择微信头像')

  // 内容安全：文字 + 图片，任一不通过直接拦截（不入库）
  try {
    await secCheckText(OPENID, text)
    const imgs = Array.isArray(images) ? images.filter(Boolean).slice(0, 9) : []
    for (const f of imgs) await secCheckImage(f)
  } catch (e) {
    return fail(e.message || '内容未通过审核')
  }

  const pRes = await db.collection(COL.products).doc(productId).get().catch(() => null)
  const p = pRes && pRes.data
  if (!p) return fail('菜品不存在')
  const proj = await db.collection(COL.projects).doc(p.projectId).get().catch(() => null)
  if (!proj || !proj.data || !proj.data.published) return fail('项目不可访问')

  const review = {
    projectId: p.projectId,
    productId,
    openid: OPENID,
    name: nick,
    avatar: av,
    anonymous: false,
    rating: r,
    text: String(text || '').slice(0, 300),
    images: Array.isArray(images) ? images.filter(Boolean).slice(0, 9) : [],
    reviewStatus: 'pending',   // 机器检测通过 → 进入人工审核队列
    status: 'normal',
    top: false,
    createdAt: Date.now()
  }
  const add = await db.collection(COL.reviews).add({ data: review })
  // 新评价待人工审核，不立即公开、不计入对外评分
  return ok({ id: add._id, pending: true, message: '已提交，审核通过后展示' })
}
