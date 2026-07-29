const fs = require('node:fs')
const path = require('node:path')
const { test, expect } = require('@playwright/test')

test.use({ channel: 'chrome' })
test.setTimeout(60_000)

const fixturePath = path.resolve(
  __dirname,
  '../../example/【专利初稿】2026-0603903CN-超低温自调节针阀节流装置.docx',
)
const documentPayload = {
  path: fixturePath,
  name: path.basename(fixturePath),
  extension: 'docx',
  base64: fs.readFileSync(fixturePath).toString('base64'),
}

test('OCR 设置隔离、链接桥接、Paddle 与自定义配置', async ({ page }) => {
  await page.addInitScript((payload) => {
    window.__openedExternalUrls = []
    window.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          if (command === 'open_document') return payload
          if (command === 'open_external_url') {
            window.__openedExternalUrls.push(args.url)
            return null
          }
          if (command === 'save_revision') {
            return { revisionPath: 'D:/mock-修订版.docx', ratingPath: null }
          }
          if (command === 'cloud_ocr') return { words: [] }
          throw new Error(`未处理的测试命令：${command}`)
        },
      },
    }
  }, documentPayload)

  await page.goto('http://127.0.0.1:5187')
  await page.getByRole('button', { name: '打开 DOCX 或 PDF' }).click()
  await page.getByRole('button', { name: /确认并开始阅读/ }).click()
  await expect(page.getByRole('button', { name: /OCR 设置，当前为本机 OCR/ })).toBeVisible()

  await page.getByRole('button', { name: /OCR 设置，当前为本机 OCR/ }).click()
  const dialog = page.getByRole('dialog', { name: 'OCR 识别方式' })
  const provider = dialog.getByLabel('服务商')
  await provider.selectOption('ocr-space')
  await dialog.locator('input[type="password"]').fill('ocr-space-only')
  await dialog.getByRole('button', { name: /API 获取/ }).click()
  await expect.poll(() => page.evaluate(() => window.__openedExternalUrls.at(-1))).toBe(
    'https://ocr.space/ocrapi/freekey',
  )

  await provider.selectOption('google-vision')
  await expect(dialog.locator('input[type="password"]')).toHaveValue('')

  await provider.selectOption('paddle-ocr')
  await expect(dialog.getByLabel('模型名称')).toHaveValue('PP-OCRv6')
  await dialog.getByRole('button', { name: /API 获取/ }).click()
  await expect.poll(() => page.evaluate(() => window.__openedExternalUrls.at(-1))).toBe(
    'https://aistudio.baidu.com/account/accessToken',
  )

  await provider.selectOption('custom')
  await dialog.getByLabel('接口名称').fill('企业视觉 OCR')
  await dialog.getByLabel('服务器地址').fill('https://ocr.example.com/v1/chat/completions')
  await dialog.locator('input[type="password"]').fill('custom-only')
  await dialog.getByLabel('模型名称').fill('vision-ocr-pro')
  await dialog.getByRole('button', { name: '应用识别方式' }).click()

  await expect(page.getByRole('button', { name: /OCR 设置，当前为企业视觉 OCR/ })).toBeVisible()
  await page.getByRole('button', { name: /OCR 设置，当前为企业视觉 OCR/ }).click()
  await expect(dialog.getByLabel('接口名称')).toHaveValue('企业视觉 OCR')
  await expect(dialog.locator('input[type="password"]')).toHaveValue('custom-only')
})
