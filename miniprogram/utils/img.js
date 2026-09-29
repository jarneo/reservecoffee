// miniprogram/utils/img.js
// 上传前压缩：替代原 CloudBase 数据万象 imageMogr2 实时处理（避免按次计费）。
// 用 wx.compressImage 在手机端把图缩到目标最大宽度并压质量，返回压缩后的临时文件路径。
// ⚠️ 任何异常都回退原图路径，保证上传流程绝不中断（旧基础库 / 不支持的格式也不会让用户传不了图）。
//
// 档位与历史 imageMogr2 规格对齐：
//   hero/cover 750w q72 · card 400w q72 · icon/avatar 160w q80 · full 1080w q80
// 只缩不放：源图宽度小于目标时仅按质量压，不会放大。
const SPEC = {
  hero:   { width: 750,  quality: 72 },
  cover:  { width: 750,  quality: 72 },
  card:   { width: 400,  quality: 72 },
  icon:   { width: 160,  quality: 80 },
  avatar: { width: 160,  quality: 80 },
  full:   { width: 1080, quality: 80 }
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
      fail: () => resolve(tempPath)
    })
  })
}

module.exports = { compress, SPEC }
