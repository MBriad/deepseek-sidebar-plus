/* 录一段真实界面操作，转成 GIF 放进 docs/media/。
 *
 * 为什么不用手工录屏：界面一改，手工 GIF 就过期了。这里用 Playwright 驱动真实扩展，
 * 重跑一次就出新图。
 *
 * 用法：
 *   npm run demo            # 录 PDF 阅读器（默认场景）
 *   npm run demo -- reader
 *
 * 需要 ffmpeg 才能转 GIF；没有的话只留 webm，脚本会打印转换命令。
 */
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mediaDir = path.join(root, 'docs', 'media')
const viewport = { width: 960, height: 660 }

const scenes = {
  // PDF 增强阅读器：打开、展开目录、跳到某一章。全部本地，不需要网络。
  async reader({ page, extensionId }) {
    const pdf = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'text.pdf'))
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/pdf/')) {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length })
        res.end(pdf)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/pdf/demo`

    try {
      await page.goto(`chrome-extension://${extensionId}/src/pdf-reader.html?file=${encodeURIComponent(url)}&name=Demo`)
      await page.waitForTimeout(2200)
      await page.frameLocator('#pdfjs-frame').locator('#pdfjs-outline-toggle').click()
      await page.waitForTimeout(900)
      await page.frameLocator('#pdfjs-frame').locator('.outline-item').first().click()
      await page.waitForTimeout(900)
      // 选中一行文字，展示划词高亮
      await page.frameLocator('#pdfjs-frame').locator('.textLayer span').first().dblclick()
      await page.waitForTimeout(1200)
    } finally {
      server.close()
    }
  },
}

const sceneName = process.argv[2] || 'reader'
const scene = scenes[sceneName]
if (!scene) {
  console.error(`未知场景：${sceneName}（可选：${Object.keys(scenes).join(', ')}）`)
  process.exit(1)
}

fs.mkdirSync(mediaDir, { recursive: true })
const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-demo-'))
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-demo-profile-'))

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport,
  recordVideo: { dir: videoDir, size: viewport },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-sandbox',
  ],
})

try {
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker', { timeout: 20000 })
  const workerUrl = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'))
  const extensionId = new URL(workerUrl.url()).host

  const page = await context.newPage()
  await scene({ page, extensionId })
  await page.waitForTimeout(600)
  // 存一张定帧：既能当 README 的静态图，也能确认录制内容没跑偏。
  await page.screenshot({ path: path.join(mediaDir, `${sceneName}-poster.png`) })
  console.log(`poster: ${path.join(mediaDir, `${sceneName}-poster.png`)}`)
} finally {
  const video = await context.pages()[0]?.video()?.path?.()
  await context.close()

  const webm = path.join(mediaDir, `${sceneName}.webm`)
  const source = video || fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm')).map((f) => path.join(videoDir, f))[0]
  if (source && fs.existsSync(source)) {
    fs.copyFileSync(source, webm)
    console.log(`webm: ${webm}`)
  } else {
    console.error('没有拿到录制文件')
  }

  const gif = path.join(mediaDir, `${sceneName}.gif`)
  try {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', webm,
      '-vf', 'fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
      gif,
    ], { stdio: 'inherit' })
    const size = (fs.statSync(gif).size / 1024).toFixed(0)
    console.log(`gif:  ${gif} (${size} KB)`)
  } catch {
    console.log('没有 ffmpeg，跳过 GIF。装好后执行：')
    console.log(`  ffmpeg -y -i ${webm} -vf "fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" ${gif}`)
  }
}
