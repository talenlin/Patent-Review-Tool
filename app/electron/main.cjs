const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const isDevelopment = !app.isPackaged

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#f6f8fa',
    title: '专利阅研',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDevelopment) {
    window.loadURL('http://127.0.0.1:5187')
  } else {
    window.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('document:open', async () => {
    const result = await dialog.showOpenDialog({
      title: '打开专利文件',
      properties: ['openFile'],
      filters: [{ name: '专利文件', extensions: ['docx', 'pdf'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = result.filePaths[0]
    const content = await fs.readFile(filePath)
    return {
      path: filePath,
      name: path.basename(filePath),
      extension: path.extname(filePath).slice(1).toLowerCase(),
      base64: content.toString('base64'),
    }
  })

  ipcMain.handle('document:save-revision', async (_event, originalPath) => {
    const parsed = path.parse(originalPath)
    let revisionPath = path.join(parsed.dir, `${parsed.name}-修订版${parsed.ext}`)
    let index = 2
    while (true) {
      try {
        await fs.access(revisionPath)
        revisionPath = path.join(parsed.dir, `${parsed.name}-修订版（${index}）${parsed.ext}`)
        index += 1
      } catch {
        break
      }
    }
    await fs.copyFile(originalPath, revisionPath)
    return revisionPath
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
