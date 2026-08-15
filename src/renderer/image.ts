/** Read an image file/blob into a (downscaled) PNG data URL suitable for a vision model. */
const MAX_DIM = 1400

export async function fileToImageDataUrl(file: File | Blob): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null
  const dataUrl = await blobToDataUrl(file)
  try {
    return await downscale(dataUrl)
  } catch {
    return dataUrl
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

function downscale(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const longest = Math.max(img.width, img.height)
      const scale = Math.min(1, MAX_DIM / longest)
      if (scale >= 1) return resolve(dataUrl)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(dataUrl)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = dataUrl
  })
}
