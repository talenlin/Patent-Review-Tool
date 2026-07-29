# 专利阅研 Rust V1

此目录是 Tauri/Rust 桌面端。界面继续使用 `../app` 中现有的 React 实现；文件选择、文件读取和“修订版”另存为由 Rust 命令执行。

## 本机运行

在 `src-tauri` 中运行：

```powershell
& "C:\Users\talenlin\.cargo\bin\cargo.exe" build
Start-Process .\target\debug\patent-reader-v1.exe
```

## 生成安装包

首次安装 Tauri 命令行工具：

```powershell
& "C:\Users\talenlin\.cargo\bin\cargo.exe" install tauri-cli --version 2.11.0 --locked
```

随后先在 `../app` 中运行 `npm.cmd run build`，再在本目录运行：

```powershell
& "C:\Users\talenlin\.cargo\bin\cargo.exe" tauri build
```
