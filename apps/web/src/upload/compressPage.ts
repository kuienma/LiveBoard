/** 上传前压缩到的长边像素（docs/spec.md 第 4.1 节）。 */
export const MAX_EDGE = 2000

const JPEG_QUALITY = 0.85

export interface CompressedPage {
  /** 压缩后的 JPEG，直接用于上传。 */
  file: File
  /** 供界面显示缩略图，用完要 revokeObjectURL。 */
  previewUrl: string
  width: number
  height: number
  originalBytes: number
}

/**
 * 把一张照片压到长边 MAX_EDGE 并转成 JPEG。
 *
 * 转 JPEG 不只是为了小：iPhone 相机默认出 HEIC，后端不认，
 * 而 Safari 能把 HEIC 解码进 canvas，于是这一步顺带解决了格式问题。
 * imageOrientation: 'from-image' 让竖拍的照片不会躺倒（iOS 照片常带 EXIF 方向）。
 */
export async function compressPage(file: File): Promise<CompressedPage> {
  const bitmap = await decode(file)
  const { width, height } = fit(bitmap.width, bitmap.height)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('当前浏览器不支持 canvas，无法压缩图片')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const blob = await toJpeg(canvas)
  const name = file.name.replace(/\.[^.]+$/, '') || 'page'

  return {
    file: new File([blob], `${name}.jpg`, { type: 'image/jpeg' }),
    previewUrl: URL.createObjectURL(blob),
    width,
    height,
    originalBytes: file.size,
  }
}

/** 等比缩放到长边不超过 MAX_EDGE；本来就小的不放大。 */
export function fit(
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

type Decoded = (ImageBitmap | HTMLImageElement) & { close?: () => void }

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      return (await createImageBitmap(file, { imageOrientation: 'from-image' })) as Decoded
    } catch {
      // 某些浏览器不支持 imageOrientation 选项，退回不带选项
      try {
        return (await createImageBitmap(file)) as Decoded
      } catch {
        // 再退回 <img>
      }
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () =>
        reject(new Error(`这张图片无法解码（${file.type || '未知格式'}），换一张试试`))
      image.src = url
    })
    return image as Decoded
  } finally {
    URL.revokeObjectURL(url)
  }
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('图片压缩失败'))
          return
        }
        resolve(blob)
      },
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}
