import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [bridge, app, rust] = await Promise.all([
  readFile(new URL('../src/tauri-bridge.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../rust-v1/src-tauri/src/lib.rs', import.meta.url), 'utf8'),
])

assert.match(rust, /static CLOSE_REQUESTED: AtomicBool/, '桌面端必须保留关闭请求标记')
assert.match(rust, /fn take_close_request\(\) -> bool/, '桌面端必须提供读取关闭请求的命令')
assert.match(rust, /CLOSE_REQUESTED\.store\(true, Ordering::Release\)/, '关闭窗口时必须写入关闭请求标记')
assert.match(bridge, /invoke<boolean>\('take_close_request'\)/, '桥接层必须读取关闭请求标记')
assert.match(app, /onExitRequested\(\(\) =>/, '应用必须响应关闭请求')
assert.match(app, /\.exitApp\)/, '确认“直接退出”后必须调用桌面端退出命令')

console.log('退出确认链路回归检查通过')
