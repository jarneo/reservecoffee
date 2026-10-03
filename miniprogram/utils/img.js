// miniprogram/utils/img.js
// 上传前压缩：替代原 CloudBase 数据万象 imageMogr2 实时处理（避免按次计费）。
// 用 wx.compressImage 在手机端把图缩到目标最大宽度并压质量，返回压缩后的临时文件路径。
// ⚠️ 任何异常都回退原图路径，保证上传流程绝不中断（旧基础库 / 不支持的格式也不会让用户传不了图）。
//
// 档位按「实际显示物理像素」定，而不是按 imageMogr2 时代的逻辑像素。
// 菜品栏 343rpx 在 3x 屏上 ≈ 535 物理像素 —— 旧档 400w 在 3x 屏本身就偏紧，
// 叠加「chooseMedia 先压一次 + 本函数再压一次」的两次有损损失，菜品图会明显发糊。
// ⚠️ 调用方必须用 wx.chooseMedia({ sizeType: ['original'] })，
//    否则微信会先压一次（质量不可控），与这里的压缩叠加 → 双重有损。
// 体积参考（原图 3000×4000，JPEG q80）：card 13KB→38KB，hero 47KB→109KB。
const SPEC = {
  hero:   { width: 1080, quality: 80 },   // 首页全宽头图 750rpx，3x 需 1080；仅此一张，宁大勿糊
  cover:  { width: 1080, quality: 80 },
  card:   { width: 640,  quality: 80 },   // 菜品列表 3x 需 535 → 取 640 留 20% 余量（旧值 400 偏小）
  icon:   { width: 240,  quality: 82 },   // 项目图标 3x 需 273，图标小且近方形，略欠可接受
  avatar: { width: 240,  quality: 82 },
  full:   { width: 1280, quality: 82 }    // 预留：详情页大图。启用需先给 products 加 imageLarge 字段
}

// 压缩单张图片。kind 取 SPEC 档位名；可用 opts {width,quality} 覆盖。
// 返回 Promise<string>：压缩后的临时文件路径（失败则原样返回入参）。
function compress(tempPath, kind, opts) {
  const o = opts || {}
  const spec = SPEC[kind] || {}
  const width = o.width || spec.width || 1080
  const quality = o.quality || spec.quality || 80
  return new Promise((resolve) => {
    if (!tempPath || typeof wx.compressImage !== 'function') return resolve(tempPath)
    wx.compressImage({
      src: tempPath,
      quality,
      compressedWidth: width,
      success: (r) => resolve((r && r.tempFilePath) || tempPath),
      // ⚠️ compressedWidth 只约束宽度、不约束高度：极端长图（如 1080×20000）输出超 iOS 单边上限会 fail，
      //    此时回退原图 → 3~5MB 直传且此前完全无提示。这里加 warn 让问题可被发现。
      //    不加体积硬限制：会阻断用户上传，违背本文件「异常必须回退原图」的设计原则。
      fail: (err) => {
        console.warn('[img] compress failed, fallback to original (' + kind + '):', err && (err.errMsg || err.message || err))
        resolve(tempPath)
      }
    })
  })
}

module.exports = { compress, SPEC }
