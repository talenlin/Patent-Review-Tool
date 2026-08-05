# PaddleOCR 本机运行时

本目录的 `paddle_ocr_worker.py` 只调用本机安装的 PaddleOCR 3.x / PP-OCRv5 Mobile；
它不包含网络请求，也不会把附图发送到服务端。

本目录会被独立打包成 `paddle-ocr-mobile-*.zip` 插件。主程序安装包不包含
Python 运行时、PaddleOCR 依赖或模型；用户只在选择“本机 PaddleOCR 3（增强插件）”
后才安装这个 ZIP。本机识别时不会上传附图，也不会再下载模型。开发环境可通过下列命令准备同等运行时：

```powershell
py -3.12 -m pip install -r requirements.txt
```

可用 `PATENT_READER_PADDLE_PYTHON` 环境变量指定该 Python 解释器路径。

发布装配时运行 `prepare-paddle-runtime.ps1`，再运行 `package-plugin.ps1`；它们会将
Python、PaddleOCR、PP‑OCRv5 Mobile 检测模型和识别模型放入独立插件 ZIP（这些生成目录不提交到 Git）。
