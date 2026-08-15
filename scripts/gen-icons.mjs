// JUNDSH 桌面端 · 图标生成器
// 读取官方鲸鱼标志 (assets/whale.svg)，生成：
//   - assets/whale-white.svg   白色鲸鱼（启动页 / 深色场景）
//   - build/icon.png           512 应用图标（白底黑鲸）
//   - build/icon.ico           多尺寸 Windows 图标（16~256）
//   - build/icon-{size}.png    各尺寸 PNG（打包/调试用）
//   - build/tray.png           32px 托盘图标（白底黑鲸）
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const write = (p, data) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
  fs.writeFileSync(path.join(root, p), data)
}

// ---------- 解析鲸鱼路径 ----------
const whaleSvg = read('assets/whale.svg')
const d = whaleSvg.match(/<path[^>]*\sd="([^"]+)"/)?.[1]
if (!d) throw new Error('无法从 whale.svg 提取路径 d')

// favicon 路径全部使用绝对坐标 (M/C/Z)，直接按数字对求包围盒
function pathBBox(d) {
  const nums = d.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi).map(Number)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (nums[i] < minX) minX = nums[i]
    if (nums[i] > maxX) maxX = nums[i]
    if (nums[i + 1] < minY) minY = nums[i + 1]
    if (nums[i + 1] > maxY) maxY = nums[i + 1]
  }
  return { minX, minY, maxX, maxY }
}
const bbox = pathBBox(d)
const W = bbox.maxX - bbox.minX
const H = bbox.maxY - bbox.minY

// 在 size×size 画布中按比例缩放并居中
function fit(size, pad) {
  const scale = Math.min((size - pad * 2) / W, (size - pad * 2) / H)
  const cx = size / 2 - (bbox.minX + W / 2) * scale
  const cy = size / 2 - (bbox.minY + H / 2) * scale
  return { scale, cx, cy }
}

// ---------- 白色鲸鱼（透明底，用于深色场景：启动页/离线页） ----------
write('assets/whale-white.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <g transform="translate(128 128) scale(${216 / W}) translate(${-bbox.minX - W / 2} ${-bbox.minY - H / 2})">
    <path d="${d}" fill="#FFFFFF"/>
  </g>
</svg>
`)

// ---------- 应用图标：白底 + 官方黑色鲸鱼 ----------
function appIconSvg(size) {
  const { scale, cx, cy } = fit(size, size * 0.125)
  const r = size * 0.226
  const bx = cx + bbox.minX * scale
  const by = cy + bbox.minY * scale
  const bubble = (x, y, rad, op) => `<circle cx="${x}" cy="${y}" r="${rad}" fill="#0B1220" opacity="${op}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bgw" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#EDF1F8"/>
    </linearGradient>
    <radialGradient id="gloww" cx="0.32" cy="0.22" r="0.9">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" fill="url(#bgw)"/>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" fill="url(#gloww)"/>
  <rect x="${size * 0.002}" y="${size * 0.002}" width="${size * 0.996}" height="${size * 0.996}" rx="${r * 0.99}" fill="none" stroke="#0B1220" stroke-opacity="0.12" stroke-width="${Math.max(1.2, size * 0.004)}"/>
  <g transform="translate(${cx} ${cy}) scale(${scale})">
    <path d="${d}" fill="#0B1220"/>
  </g>
  <g>
    ${bubble(bx - size * 0.085, by - size * 0.062, size * 0.016, 0.16)}
    ${bubble(bx - size * 0.115, by - size * 0.095, size * 0.010, 0.11)}
    ${bubble(bx - size * 0.055, by - size * 0.112, size * 0.008, 0.08)}
    ${bubble(bx + W * scale * 0.86, by + H * scale * 0.92, size * 0.009, 0.10)}
  </g>
</svg>
`
}

// ---------- 渲染 ----------
const sizes = [16, 24, 32, 48, 64, 128, 256, 512]
const pngs = []
for (const s of sizes) {
  const svg = appIconSvg(s)
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  write(`build/icon-${s}.png`, png)
  if (s !== 512) pngs.push({ size: s, data: png })
  if (s === 512) write('build/icon.png', png)
}

// ICO：头 + 目录项 + PNG 数据块（Vista+ 支持 PNG 压缩条目）
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  const blobs = []
  let offset = 6 + 16 * entries.length
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    dirs.push(e)
    blobs.push(data)
    offset += data.length
  }
  return Buffer.concat([header, ...dirs, ...blobs])
}
write('build/icon.ico', buildIco(pngs))

// 托盘图标：白底圆角小方块 + 黑色鲸鱼（深浅托盘都可见）
// 生成 32px 与 64px(@2x，高分屏自动选用)
function traySvg(size) {
  const { scale, cx, cy } = fit(size, size * 0.16)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="tbw" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#E7ECF5"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${size * 0.28}" fill="url(#tbw)"/>
  <rect x="${size * 0.022}" y="${size * 0.022}" width="${size * 0.956}" height="${size * 0.956}" rx="${size * 0.25}" fill="none" stroke="#0B1220" stroke-opacity="0.14" stroke-width="${size * 0.028}"/>
  <g transform="translate(${cx} ${cy}) scale(${scale})">
    <path d="${d}" fill="#0B1220"/>
  </g>
</svg>
`
}
{
  write('build/tray.png', await sharp(Buffer.from(traySvg(32))).png().toBuffer())
  write('build/tray@2x.png', await sharp(Buffer.from(traySvg(64))).png().toBuffer())
}

console.log('图标生成完成:')
for (const f of ['build/icon.ico', 'build/icon.png', 'build/tray.png', 'build/tray@2x.png', 'assets/whale-white.svg']) {
  console.log('  ', f, fs.statSync(path.join(root, f)).size, 'bytes')
}
