import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  activeOcrSettings,
  createDefaultOcrSettingsStore,
  updateOcrProfile,
} from '../src/ocr-settings.ts'

let settings = createDefaultOcrSettingsStore()
settings = updateOcrProfile(settings, 'ocr-space', { apiKey: 'ocr-space-only' })
settings = { ...settings, provider: 'google-vision' }

assert.equal(
  activeOcrSettings(settings).apiKey,
  '',
  '切换到 Google Cloud Vision 时，不得沿用 OCR.Space 的 API Key',
)

const bridgeSource = fs.readFileSync(new URL('../src/tauri-bridge.ts', import.meta.url), 'utf8')
assert.match(
  bridgeSource,
  /openExternalUrl/,
  'API 获取链接必须通过桌面桥接交给 Windows 默认浏览器',
)

console.log('OCR 设置隔离与外部链接回归检查通过')
