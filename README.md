# Patent Review Tool / 专利阅研

Windows local patent reading and review assistant for patent agents and IP engineers.

## What it does

- Reads local DOCX and searchable PDF patent drafts.
- Splits common Chinese patent sections: abstract, claims, specification, and drawings.
- Extracts reference-sign to feature-name mappings from the specification first, then falls back to contextual extraction.
- Shows drawings beside the text and overlays draggable, closable labels on recognized reference signs.
- Supports local OCR by default and optional cloud OCR providers configured by the user.
- Writes review comments back into revised DOCX/PDF files instead of using a sidecar data file.
- Saves revised files with `-修订版` in the filename by default.
- Exports patent rating records when saving a revised version.

## Privacy Model

The main workflow is local-first. Original files, text, claims, and comments stay on the user's machine.

When a cloud OCR provider is enabled, only drawing images are sent to the selected OCR service for reference-sign recognition.

## Development

Frontend:

```powershell
cd app
npm install
npm run dev
```

Production build:

```powershell
cd app
npm run build

cd ..\rust-v1\src-tauri
cargo tauri build
```

## Release

This repository publishes the current stable product line as `v1.0.0`.

The source version and Tauri application metadata are both set to `1.0.0`.
