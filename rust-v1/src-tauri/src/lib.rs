use base64::{engine::general_purpose::STANDARD, Engine as _};
use lopdf::{dictionary, Document, Object, ObjectId, StringFormat};
use rfd::FileDialog;
use reqwest::blocking::{multipart, Client, Response};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, fs::File, io::{Cursor, Read, Write}, path::{Path, PathBuf}, process::Command, time::Duration};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedDocument {
    path: String,
    name: String,
    extension: String,
    base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudOcrPayload {
    provider: String,
    image_data_url: String,
    image_width: f32,
    image_height: f32,
    api_key: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    interface_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudOcrWord {
    text: String,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
    confidence: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudOcrResult {
    words: Vec<CloudOcrWord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationPayload {
    #[serde(rename = "type")]
    annotation_type: String,
    severity: String,
    status: String,
    author: String,
    body: String,
    location: String,
    selected_text: Option<String>,
    selection_anchor: Option<SelectionAnchorPayload>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RatingPayload {
    technical_understanding: String,
    communication: String,
    patent_quality: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LlmReviewFindingPayload {
    module: String,
    severity: String,
    evidence_level: String,
    title: String,
    location: String,
    quote: String,
    analysis: String,
    recommendation: String,
    sources: String,
    accepted: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LlmReviewReportPayload {
    technical_field: String,
    rulebook_version: String,
    rulebook_verified_at: String,
    provider: String,
    model: String,
    generated_at: String,
    findings: Vec<LlmReviewFindingPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmCompletionPayload {
    provider: String,
    endpoint: String,
    api_key: String,
    model: String,
    system: String,
    user: String,
    purpose: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmCompletionResult {
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmModelListPayload {
    provider: String,
    endpoint: String,
    api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmModelListResult {
    models: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmAgentTurnPayload {
    provider: String,
    endpoint: String,
    api_key: String,
    model: String,
    purpose: String,
    messages: Vec<Value>,
    tools: Vec<McpToolPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmAgentToolCallResult {
    id: String,
    name: String,
    arguments: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmAgentTurnResult {
    content: String,
    assistant_message: Value,
    tool_calls: Vec<LlmAgentToolCallResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpListToolsPayload {
    endpoint: String,
    api_key: String,
    #[serde(default)]
    headers_json: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct McpToolPayload {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpListToolsResult {
    tools: Vec<McpToolPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalListToolsPayload {
    provider: String,
    endpoint: String,
    api_key: String,
    #[serde(rename = "clientSecret")]
    _client_secret: String,
    #[serde(default)]
    headers_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalToolCallPayload {
    provider: String,
    endpoint: String,
    api_key: String,
    client_secret: String,
    #[serde(default)]
    headers_json: String,
    search_engine: String,
    count: usize,
    tool_name: String,
    arguments: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalToolCallResult {
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalExecutePayload {
    provider: String,
    endpoint: String,
    api_key: String,
    client_secret: String,
    search_engine: String,
    count: usize,
    tool_name: String,
    argument_template: String,
    #[serde(default)]
    headers_json: String,
    queries: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalExecuteResult {
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveRevisionResult {
    revision_path: String,
    rating_path: Option<String>,
    review_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionAnchorPayload {
    #[serde(default)]
    start_paragraph_text: String,
    #[serde(default)]
    start_offset: usize,
    #[serde(default)]
    end_paragraph_text: String,
    #[serde(default)]
    end_offset: usize,
    #[serde(default)]
    pdf_rects: Vec<PdfRectPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfRectPayload {
    page_number: u32,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

const COMMENTS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const COMMENTS_RELATIONSHIP_TYPE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const WORD_NAMESPACE: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn vector_image_extension(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with("word/media/") && (lower.ends_with(".emf") || lower.ends_with(".wmf"))
}

fn png_media_path(path: &str) -> String {
    let extension_start = path.rfind('.').unwrap_or(path.len());
    format!("{}.png", &path[..extension_start])
}

fn powershell_encoded_command(script: &str) -> String {
    let utf16 = script.encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    STANDARD.encode(utf16)
}

fn convert_vector_images(
    images: &BTreeMap<String, Vec<u8>>,
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let directory = tempfile::tempdir()
        .map_err(|error| format!("无法创建附图转换临时目录：{error}"))?;
    let source_directory = directory.path().join("source");
    let output_directory = directory.path().join("png");
    fs::create_dir_all(&source_directory)
        .and_then(|_| fs::create_dir_all(&output_directory))
        .map_err(|error| format!("无法准备附图转换目录：{error}"))?;

    let mut source_names = BTreeMap::new();
    for (index, (media_path, bytes)) in images.iter().enumerate() {
        let extension = Path::new(media_path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("emf");
        let temporary_name = format!("figure-{index}.{extension}");
        fs::write(source_directory.join(&temporary_name), bytes)
            .map_err(|error| format!("无法读取矢量附图 {media_path}：{error}"))?;
        source_names.insert(media_path.clone(), temporary_name);
    }

    let source_literal = source_directory.to_string_lossy().replace('\'', "''");
    let output_literal = output_directory.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sourceDirectory = '{source_literal}'
$outputDirectory = '{output_literal}'
Get-ChildItem -LiteralPath $sourceDirectory -File | ForEach-Object {{
  $image = [System.Drawing.Image]::FromFile($_.FullName)
  try {{
    $destination = Join-Path $outputDirectory ([System.IO.Path]::GetFileNameWithoutExtension($_.Name) + '.png')
    $bitmap = New-Object System.Drawing.Bitmap($image.Width, $image.Height)
    try {{
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {{
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.DrawImage($image, 0, 0, $bitmap.Width, $bitmap.Height)
      }} finally {{
        $graphics.Dispose()
      }}
      $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
    }} finally {{
      $bitmap.Dispose()
    }}
  }} finally {{
    $image.Dispose()
  }}
}}"#,
    );
    let encoded = powershell_encoded_command(&script);
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded,
    ]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output()
        .map_err(|error| format!("无法启动 Windows 矢量附图转换：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Windows 矢量附图转换失败：{}", detail.trim()));
    }

    let mut converted = BTreeMap::new();
    for (media_path, temporary_name) in source_names {
        let png_name = format!(
            "{}.png",
            Path::new(&temporary_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("figure")
        );
        let png = fs::read(output_directory.join(png_name))
            .map_err(|error| format!("无法读取转换后的附图 {media_path}：{error}"))?;
        if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(format!("附图 {media_path} 未能转换为有效 PNG"));
        }
        converted.insert(png_media_path(&media_path), png);
    }
    Ok(converted)
}

fn prepare_docx_for_preview(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|error| format!("无法解析 DOCX：{error}"))?;
    let mut entries = Vec::with_capacity(archive.len());
    let mut vector_images = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)
            .map_err(|error| format!("无法读取 DOCX 内容：{error}"))?;
        let name = entry.name().to_string();
        let is_directory = entry.is_dir();
        let mut contents = Vec::new();
        if !is_directory {
            entry.read_to_end(&mut contents)
                .map_err(|error| format!("无法读取 DOCX 内容 {name}：{error}"))?;
        }
        if vector_image_extension(&name) {
            vector_images.insert(name.clone(), contents.clone());
        }
        entries.push((name, is_directory, contents));
    }
    if vector_images.is_empty() {
        return Ok(bytes.to_vec());
    }

    let converted = convert_vector_images(&vector_images)?;
    let replacements = vector_images.keys()
        .map(|old_path| {
            let old_name = Path::new(old_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(old_path)
                .to_string();
            let new_path = png_media_path(old_path);
            let new_name = Path::new(&new_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&new_path)
                .to_string();
            (old_name, new_name)
        })
        .collect::<Vec<_>>();

    let output = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(output);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated);
    for (name, is_directory, contents) in entries {
        if is_directory {
            writer.add_directory(name, options)
                .map_err(|error| format!("无法生成 DOCX 预览：{error}"))?;
            continue;
        }
        if vector_image_extension(&name) {
            let png_name = png_media_path(&name);
            let png = converted.get(&png_name)
                .ok_or_else(|| format!("缺少转换后的附图 {png_name}"))?;
            writer.start_file(png_name, options)
                .and_then(|_| writer.write_all(png).map_err(Into::into))
                .map_err(|error: zip::result::ZipError| format!("无法写入 DOCX 附图预览：{error}"))?;
            continue;
        }

        let mut output_contents = contents;
        if name.ends_with(".xml") || name.ends_with(".rels") {
            let mut xml = String::from_utf8(output_contents)
                .map_err(|error| format!("DOCX XML 编码无效（{name}）：{error}"))?;
            for (old_name, new_name) in &replacements {
                xml = xml.replace(old_name, new_name);
            }
            if name == "[Content_Types].xml"
                && !xml.to_ascii_lowercase().contains("extension=\"png\"")
            {
                xml = xml.replace(
                    "</Types>",
                    "<Default Extension=\"png\" ContentType=\"image/png\"/></Types>",
                );
            }
            output_contents = xml.into_bytes();
        }
        writer.start_file(name, options)
            .and_then(|_| writer.write_all(&output_contents).map_err(Into::into))
            .map_err(|error: zip::result::ZipError| format!("无法生成 DOCX 预览：{error}"))?;
    }
    let output = writer.finish()
        .map_err(|error| format!("无法完成 DOCX 预览：{error}"))?;
    Ok(output.into_inner())
}

fn xml_escape(value: &str) -> String {
    value.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml_unescape(value: &str) -> String {
    value.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn compact_text(value: &str) -> String {
    value.chars().filter(|character| !character.is_whitespace()).collect()
}

fn paragraph_text(paragraph: &str) -> String {
    let mut remaining = paragraph;
    let mut text = String::new();
    while let Some(start) = remaining.find("<w:t") {
        let after_tag = &remaining[start..];
        let Some(content_start_relative) = after_tag.find('>') else { break };
        let content_start = start + content_start_relative + 1;
        let Some(content_end_relative) = remaining[content_start..].find("</w:t>") else { break };
        let content_end = content_start + content_end_relative;
        text.push_str(&xml_unescape(&remaining[content_start..content_end]));
        remaining = &remaining[content_end + "</w:t>".len()..];
    }
    text
}

fn matching_paragraph_bounds(document_xml: &str, selected_text: Option<&str>) -> Option<(usize, usize)> {
    let needle = selected_text
        .map(compact_text)
        .filter(|value| value.len() >= 4);
    let prefix = needle.as_ref().map(|value| value.chars().take(18).collect::<String>());
    let mut search_from = 0;
    let mut last_bounds = None;

    while let Some(relative_start) = document_xml[search_from..].find("<w:p") {
        let start = search_from + relative_start;
        let after_start = &document_xml[start..];
        let Some(relative_end_tag) = after_start.find("</w:p>") else { break };
        let end = start + relative_end_tag + "</w:p>".len();
        let paragraph = &document_xml[start..end];
        last_bounds = Some((start, end));
        if let Some(needle) = &needle {
            let paragraph_value = compact_text(&paragraph_text(paragraph));
            if paragraph_value.contains(needle) || prefix.as_ref().is_some_and(|value| paragraph_value.contains(value)) {
                return Some((start, end));
            }
        }
        search_from = end;
    }
    if needle.is_some() { None } else { last_bounds }
}

fn run_start_before(document_xml: &str, before: usize) -> Option<usize> {
    let mut search_end = before;
    while let Some(start) = document_xml[..search_end].rfind("<w:r") {
        let next = document_xml.as_bytes().get(start + 4).copied();
        if matches!(next, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')) {
            return Some(start);
        }
        search_end = start;
    }
    None
}

fn replace_run_slice_with_anchors(
    document_xml: &mut String,
    text_start: usize,
    selected_end: usize,
    start_anchor: Option<&str>,
    end_anchor: Option<&str>,
) -> bool {
    let Some(text_tag_start) = document_xml[..text_start].rfind("<w:t") else { return false };
    let Some(text_open_end_relative) = document_xml[text_tag_start..].find('>') else { return false };
    let text_content_start = text_tag_start + text_open_end_relative + 1;
    if text_content_start > text_start { return false; }
    let Some(text_close_relative) = document_xml[text_content_start..].find("</w:t>") else { return false };
    let text_content_end = text_content_start + text_close_relative;
    if selected_end > text_content_end { return false; }
    let Some(run_start) = run_start_before(document_xml, text_tag_start) else { return false };
    let Some(run_end_relative) = document_xml[text_content_end..].find("</w:r>") else { return false };
    let run_end = text_content_end + run_end_relative + "</w:r>".len();

    let run_prefix = &document_xml[run_start..text_content_start];
    let run_suffix = &document_xml[text_content_end..run_end];
    let before = &document_xml[text_content_start..text_start];
    let after = &document_xml[selected_end..text_content_end];
    let mut replacement = String::new();
    if !before.is_empty() {
        replacement.push_str(run_prefix);
        replacement.push_str(before);
        replacement.push_str(run_suffix);
    }
    if let Some(anchor) = start_anchor { replacement.push_str(anchor); }
    replacement.push_str(run_prefix);
    replacement.push_str(&document_xml[text_start..selected_end]);
    replacement.push_str(run_suffix);
    if let Some(anchor) = end_anchor { replacement.push_str(anchor); }
    if !after.is_empty() {
        replacement.push_str(run_prefix);
        replacement.push_str(after);
        replacement.push_str(run_suffix);
    }
    document_xml.replace_range(run_start..run_end, &replacement);
    true
}

fn inject_exact_text_anchor(document_xml: &mut String, comment_id: usize, selected_text: &str) -> bool {
    let selected_xml = xml_escape(selected_text);
    if selected_xml.is_empty() { return false; }
    let Some(text_start) = document_xml.find(&selected_xml) else { return false };
    let selected_end = text_start + selected_xml.len();
    let start_anchor = format!("<w:commentRangeStart w:id=\"{comment_id}\"/>");
    let end_anchor = format!("<w:commentRangeEnd w:id=\"{comment_id}\"/><w:r><w:commentReference w:id=\"{comment_id}\"/></w:r>");
    replace_run_slice_with_anchors(document_xml, text_start, selected_end, Some(&start_anchor), Some(&end_anchor))
}

fn paragraph_bounds_with_text(document_xml: &str, text: &str, search_from: usize) -> Option<(usize, usize)> {
    let text_xml = xml_escape(text);
    if text_xml.is_empty() { return None; }
    let mut cursor = search_from;
    while let Some(relative_start) = document_xml[cursor..].find("<w:p") {
        let start = cursor + relative_start;
        let after_start = &document_xml[start..];
        let Some(relative_end_tag) = after_start.find("</w:p>") else { break };
        let end = start + relative_end_tag + "</w:p>".len();
        if document_xml[start..end].contains(&text_xml) {
            return Some((start, end));
        }
        cursor = end;
    }
    None
}

fn paragraph_bounds_matching_text(document_xml: &str, text: &str, search_from: usize) -> Option<(usize, usize)> {
    let target = compact_text(text);
    if target.is_empty() { return None; }
    let mut cursor = search_from;
    while let Some(relative_start) = document_xml[cursor..].find("<w:p") {
        let start = cursor + relative_start;
        let after_start = &document_xml[start..];
        let Some(relative_end_tag) = after_start.find("</w:p>") else { break };
        let end = start + relative_end_tag + "</w:p>".len();
        if compact_text(&paragraph_text(&document_xml[start..end])) == target {
            return Some((start, end));
        }
        cursor = end;
    }
    None
}

fn xml_index_at_text_offset(value: &str, offset: usize) -> Option<usize> {
    let mut decoded_offset = 0;
    let mut index = 0;
    while index < value.len() {
        if decoded_offset == offset { return Some(index); }
        let remainder = &value[index..];
        if remainder.starts_with('&') {
            let end = remainder.find(';')?;
            index += end + 1;
        } else {
            let character = remainder.chars().next()?;
            index += character.len_utf8();
        }
        decoded_offset += 1;
    }
    if decoded_offset == offset { Some(index) } else { None }
}

fn paragraph_xml_position_at_text_offset(document_xml: &str, bounds: (usize, usize), offset: usize) -> Option<usize> {
    let mut cursor = bounds.0;
    let mut remaining = offset;
    while let Some(relative_tag_start) = document_xml[cursor..bounds.1].find("<w:t") {
        let tag_start = cursor + relative_tag_start;
        let tag_end = tag_start + document_xml[tag_start..].find('>')? + 1;
        let content_end = tag_end + document_xml[tag_end..bounds.1].find("</w:t>")?;
        let content = &document_xml[tag_end..content_end];
        let length = xml_unescape(content).chars().count();
        if remaining <= length {
            return Some(tag_end + xml_index_at_text_offset(content, remaining)?);
        }
        remaining -= length;
        cursor = content_end + "</w:t>".len();
    }
    None
}

fn text_node_content_bounds(document_xml: &str, position: usize) -> Option<(usize, usize)> {
    let text_tag_start = document_xml[..position].rfind("<w:t")?;
    let content_start = text_tag_start + document_xml[text_tag_start..].find('>')? + 1;
    let content_end = content_start + document_xml[content_start..].find("</w:t>")?;
    if position < content_start || position > content_end { None } else { Some((content_start, content_end)) }
}

fn inject_selection_anchor(document_xml: &mut String, comment_id: usize, anchor: &SelectionAnchorPayload) -> bool {
    let Some(start_bounds) = paragraph_bounds_matching_text(document_xml, &anchor.start_paragraph_text, 0) else { return false };
    let end_search_from = if compact_text(&anchor.start_paragraph_text) == compact_text(&anchor.end_paragraph_text) { 0 } else { start_bounds.1 };
    let Some(end_bounds) = paragraph_bounds_matching_text(document_xml, &anchor.end_paragraph_text, end_search_from) else { return false };
    let Some(start_position) = paragraph_xml_position_at_text_offset(document_xml, start_bounds, anchor.start_offset) else { return false };
    let Some(end_position) = paragraph_xml_position_at_text_offset(document_xml, end_bounds, anchor.end_offset) else { return false };
    let Some(start_text_bounds) = text_node_content_bounds(document_xml, start_position) else { return false };
    let Some(end_text_bounds) = text_node_content_bounds(document_xml, end_position) else { return false };
    let start_anchor = format!("<w:commentRangeStart w:id=\"{comment_id}\"/>");
    let end_anchor = format!("<w:commentRangeEnd w:id=\"{comment_id}\"/><w:r><w:commentReference w:id=\"{comment_id}\"/></w:r>");

    if start_text_bounds == end_text_bounds {
        return replace_run_slice_with_anchors(document_xml, start_position, end_position, Some(&start_anchor), Some(&end_anchor));
    }
    if !replace_run_slice_with_anchors(document_xml, end_text_bounds.0, end_position, None, Some(&end_anchor)) {
        return false;
    }
    let Some(updated_start_bounds) = text_node_content_bounds(document_xml, start_position) else { return false };
    replace_run_slice_with_anchors(document_xml, start_position, updated_start_bounds.1, Some(&start_anchor), None)
}

fn inject_cross_paragraph_anchor(document_xml: &mut String, comment_id: usize, selected_text: &str) -> bool {
    let fragments: Vec<&str> = selected_text.lines().map(str::trim).filter(|fragment| !fragment.is_empty()).collect();
    if fragments.len() < 2 { return false; }
    let Some(first_bounds) = paragraph_bounds_with_text(document_xml, fragments[0], 0) else { return false };
    let Some(last_bounds) = paragraph_bounds_with_text(document_xml, fragments[fragments.len() - 1], first_bounds.1) else { return false };
    let first_xml = xml_escape(fragments[0]);
    let last_xml = xml_escape(fragments[fragments.len() - 1]);
    let Some(last_relative_start) = document_xml[last_bounds.0..last_bounds.1].find(&last_xml) else { return false };
    let last_start = last_bounds.0 + last_relative_start;
    let last_end = last_start + last_xml.len();
    let Some(last_text_tag_start) = document_xml[..last_start].rfind("<w:t") else { return false };
    let Some(last_text_open_end_relative) = document_xml[last_text_tag_start..].find('>') else { return false };
    let last_text_content_start = last_text_tag_start + last_text_open_end_relative + 1;
    let end_anchor = format!("<w:commentRangeEnd w:id=\"{comment_id}\"/><w:r><w:commentReference w:id=\"{comment_id}\"/></w:r>");
    if !replace_run_slice_with_anchors(document_xml, last_text_content_start, last_end, None, Some(&end_anchor)) {
        return false;
    }

    let Some(first_relative_start) = document_xml[first_bounds.0..first_bounds.1].find(&first_xml) else { return false };
    let first_start = first_bounds.0 + first_relative_start;
    let first_text_content_end = document_xml[first_start..].find("</w:t>").map(|index| first_start + index).unwrap_or(first_start);
    let start_anchor = format!("<w:commentRangeStart w:id=\"{comment_id}\"/>");
    replace_run_slice_with_anchors(document_xml, first_start, first_text_content_end, Some(&start_anchor), None)
}

fn inject_comment_anchor(
    document_xml: &mut String,
    comment_id: usize,
    selection_anchor: Option<&SelectionAnchorPayload>,
    selected_text: Option<&str>,
) -> Result<(), String> {
    if let Some(selection_anchor) = selection_anchor {
        if inject_selection_anchor(document_xml, comment_id, selection_anchor) {
            return Ok(());
        }
    }
    if let Some(selected_text) = selected_text {
        if inject_exact_text_anchor(document_xml, comment_id, selected_text) {
            return Ok(());
        }
        if inject_cross_paragraph_anchor(document_xml, comment_id, selected_text) {
            return Ok(());
        }
    }
    let (paragraph_start, paragraph_end) = matching_paragraph_bounds(document_xml, selected_text)
        .or_else(|| matching_paragraph_bounds(document_xml, None))
        .ok_or_else(|| "未能在 DOCX 中找到可写入批注的位置。".to_string())?;
    let paragraph = &document_xml[paragraph_start..paragraph_end];
    let opening_end = paragraph.find('>').ok_or_else(|| "DOCX 段落格式异常。".to_string())? + paragraph_start + 1;
    let paragraph_close = paragraph_end - "</w:p>".len();
    let properties_end = document_xml[opening_end..paragraph_close]
        .find("</w:pPr>")
        .map(|index| opening_end + index + "</w:pPr>".len())
        .unwrap_or(opening_end);
    let end_anchor = format!("<w:commentRangeEnd w:id=\"{comment_id}\"/><w:r><w:commentReference w:id=\"{comment_id}\"/></w:r>");
    document_xml.insert_str(paragraph_close, &end_anchor);
    let start_anchor = format!("<w:commentRangeStart w:id=\"{comment_id}\"/>");
    document_xml.insert_str(properties_end, &start_anchor);
    Ok(())
}

fn next_comment_id(comments_xml: &str) -> usize {
    let mut next_id = 0;
    let mut remaining = comments_xml;
    while let Some(index) = remaining.find("w:id=\"") {
        let after = &remaining[index + "w:id=\"".len()..];
        let Some(end) = after.find('"') else { break };
        if let Ok(id) = after[..end].parse::<usize>() {
            next_id = next_id.max(id + 1);
        }
        remaining = &after[end + 1..];
    }
    next_id
}

fn comment_xml_entry(id: usize, annotation: &AnnotationPayload) -> String {
    let summary = format!(
        "【{} · {} · {}】{}\n定位：{}",
        annotation.annotation_type,
        annotation.severity,
        annotation.status,
        annotation.body,
        annotation.location,
    );
    let author = annotation.author.trim();
    let author = if author.is_empty() { "专利阅研" } else { author };
    let initials = author.chars().next().map(|value| value.to_string()).unwrap_or_else(|| "阅".to_string());
    format!(
        "<w:comment w:id=\"{id}\" w:author=\"{}\" w:initials=\"{}\"><w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p></w:comment>",
        xml_escape(author),
        xml_escape(&initials),
        xml_escape(&summary),
    )
}

fn append_comments_xml(existing: Option<&str>, entries: &[String]) -> String {
    let insertion = entries.join("");
    match existing {
        Some(xml) if xml.contains("</w:comments>") => xml.replacen("</w:comments>", &format!("{insertion}</w:comments>"), 1),
        _ => format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:comments xmlns:w=\"{WORD_NAMESPACE}\">{insertion}</w:comments>",
        ),
    }
}

fn ensure_comments_content_type(content_types: &str) -> String {
    if content_types.contains(COMMENTS_CONTENT_TYPE) {
        content_types.to_owned()
    } else {
        content_types.replacen(
            "</Types>",
            &format!("<Override PartName=\"/word/comments.xml\" ContentType=\"{COMMENTS_CONTENT_TYPE}\"/></Types>"),
            1,
        )
    }
}

fn ensure_comments_relationship(relationships: &str) -> String {
    if relationships.contains(COMMENTS_RELATIONSHIP_TYPE) {
        return relationships.to_owned();
    }
    let mut relation_number = 1;
    while relationships.contains(&format!("Id=\"rId{relation_number}\"")) {
        relation_number += 1;
    }
    relationships.replacen(
        "</Relationships>",
        &format!("<Relationship Id=\"rId{relation_number}\" Type=\"{COMMENTS_RELATIONSHIP_TYPE}\" Target=\"comments.xml\"/></Relationships>"),
        1,
    )
}

fn write_docx_revision(original: &Path, destination: &Path, annotations: &[AnnotationPayload]) -> Result<(), String> {
    let input = File::open(original).map_err(|error| format!("无法读取原 DOCX：{error}"))?;
    let mut source = ZipArchive::new(input).map_err(|error| format!("DOCX 格式无效：{error}"))?;
    let mut files = std::collections::BTreeMap::new();
    for index in 0..source.len() {
        let mut entry = source.by_index(index).map_err(|error| format!("无法读取 DOCX 内容：{error}"))?;
        if entry.is_dir() { continue; }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|error| format!("无法读取 DOCX 文件项：{error}"))?;
        files.insert(entry.name().to_owned(), bytes);
    }

    let document_bytes = files.get("word/document.xml").ok_or_else(|| "DOCX 缺少正文内容。".to_string())?;
    let mut document_xml = String::from_utf8(document_bytes.clone()).map_err(|_| "DOCX 正文编码无法识别。".to_string())?;
    let existing_comments = files.get("word/comments.xml")
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(str::to_owned);
    let mut comment_id = existing_comments.as_deref().map(next_comment_id).unwrap_or(0);
    let mut entries = Vec::new();
    for annotation in annotations {
        inject_comment_anchor(
            &mut document_xml,
            comment_id,
            annotation.selection_anchor.as_ref(),
            annotation.selected_text.as_deref(),
        )?;
        entries.push(comment_xml_entry(comment_id, annotation));
        comment_id += 1;
    }
    files.insert("word/document.xml".to_string(), document_xml.into_bytes());
    files.insert(
        "word/comments.xml".to_string(),
        append_comments_xml(existing_comments.as_deref(), &entries).into_bytes(),
    );

    let content_types = files.get("[Content_Types].xml").ok_or_else(|| "DOCX 缺少内容类型定义。".to_string())?;
    let content_types = String::from_utf8(content_types.clone()).map_err(|_| "DOCX 内容类型编码无法识别。".to_string())?;
    files.insert("[Content_Types].xml".to_string(), ensure_comments_content_type(&content_types).into_bytes());

    let relationships_path = "word/_rels/document.xml.rels";
    let relationships = files.get(relationships_path).ok_or_else(|| "DOCX 缺少正文关系定义。".to_string())?;
    let relationships = String::from_utf8(relationships.clone()).map_err(|_| "DOCX 关系文件编码无法识别。".to_string())?;
    files.insert(relationships_path.to_string(), ensure_comments_relationship(&relationships).into_bytes());

    let output = File::create(destination).map_err(|error| format!("无法创建修订版：{error}"))?;
    let mut writer = ZipWriter::new(output);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, bytes) in files {
        writer.start_file(name, options).map_err(|error| format!("无法写入 DOCX：{error}"))?;
        writer.write_all(&bytes).map_err(|error| format!("无法写入 DOCX：{error}"))?;
    }
    writer.finish().map_err(|error| format!("无法完成 DOCX 修订版：{error}"))?;
    Ok(())
}

#[derive(Clone, Copy)]
struct PdfPageBox {
    left: f32,
    bottom: f32,
    width: f32,
    height: f32,
}

fn pdf_unicode_string(value: &str) -> Object {
    let mut bytes = vec![0xfe, 0xff];
    for unit in value.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

fn pdf_annotation_summary(annotation: &AnnotationPayload) -> String {
    format!(
        "【{} · {} · {}】{}\n定位：{}",
        annotation.annotation_type,
        annotation.severity,
        annotation.status,
        annotation.body,
        annotation.location,
    )
}

fn inherited_page_object(document: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current_id = page_id;
    loop {
        let dictionary = document.get_object(current_id).ok()?.as_dict().ok()?;
        if let Ok(value) = dictionary.get(key) {
            return Some(value.clone());
        }
        current_id = dictionary.get(b"Parent").ok()?.as_reference().ok()?;
    }
}

fn pdf_page_box(document: &Document, page_id: ObjectId) -> Result<PdfPageBox, String> {
    let value = inherited_page_object(document, page_id, b"CropBox")
        .or_else(|| inherited_page_object(document, page_id, b"MediaBox"))
        .ok_or_else(|| "PDF 页面缺少尺寸定义。".to_string())?;
    let array = value.as_array().map_err(|_| "PDF 页面尺寸格式无效。".to_string())?;
    if array.len() < 4 {
        return Err("PDF 页面尺寸数据不完整。".to_string());
    }
    let left = array[0].as_float().map_err(|_| "PDF 页面横坐标无效。".to_string())?;
    let bottom = array[1].as_float().map_err(|_| "PDF 页面纵坐标无效。".to_string())?;
    let right = array[2].as_float().map_err(|_| "PDF 页面宽度无效。".to_string())?;
    let top = array[3].as_float().map_err(|_| "PDF 页面高度无效。".to_string())?;
    Ok(PdfPageBox {
        left,
        bottom,
        width: right - left,
        height: top - bottom,
    })
}

fn attach_pdf_annotation(document: &mut Document, page_id: ObjectId, annotation_id: ObjectId) -> Result<(), String> {
    let existing = document
        .get_object(page_id)
        .map_err(|error| format!("无法读取 PDF 页面：{error}"))?
        .as_dict()
        .map_err(|_| "PDF 页面结构无效。".to_string())?
        .get(b"Annots")
        .ok()
        .cloned();

    match existing {
        Some(Object::Reference(array_id)) => {
            document
                .get_object_mut(array_id)
                .map_err(|error| format!("无法读取 PDF 批注列表：{error}"))?
                .as_array_mut()
                .map_err(|_| "PDF 批注列表格式无效。".to_string())?
                .push(Object::Reference(annotation_id));
        }
        Some(Object::Array(_)) => {
            let page = document
                .get_object_mut(page_id)
                .map_err(|error| format!("无法写入 PDF 页面：{error}"))?
                .as_dict_mut()
                .map_err(|_| "PDF 页面结构无效。".to_string())?;
            page.get_mut(b"Annots")
                .map_err(|_| "PDF 批注列表无法写入。".to_string())?
                .as_array_mut()
                .map_err(|_| "PDF 批注列表格式无效。".to_string())?
                .push(Object::Reference(annotation_id));
        }
        _ => {
            let page = document
                .get_object_mut(page_id)
                .map_err(|error| format!("无法写入 PDF 页面：{error}"))?
                .as_dict_mut()
                .map_err(|_| "PDF 页面结构无效。".to_string())?;
            page.set("Annots", vec![Object::Reference(annotation_id)]);
        }
    }
    Ok(())
}

fn write_pdf_highlight(
    document: &mut Document,
    page_id: ObjectId,
    page_box: PdfPageBox,
    rects: &[&PdfRectPayload],
    annotation: &AnnotationPayload,
    annotation_index: usize,
) -> Result<(), String> {
    let mut quad_points = Vec::new();
    let mut union_left = f32::MAX;
    let mut union_bottom = f32::MAX;
    let mut union_right = f32::MIN;
    let mut union_top = f32::MIN;

    for rect in rects {
        let left = page_box.left + rect.left.clamp(0.0, 1.0) * page_box.width;
        let right = page_box.left + (rect.left + rect.width).clamp(0.0, 1.0) * page_box.width;
        let top = page_box.bottom + (1.0 - rect.top.clamp(0.0, 1.0)) * page_box.height;
        let bottom = page_box.bottom + (1.0 - (rect.top + rect.height).clamp(0.0, 1.0)) * page_box.height;
        if right <= left || top <= bottom {
            continue;
        }
        quad_points.extend([
            Object::Real(left), Object::Real(top),
            Object::Real(right), Object::Real(top),
            Object::Real(left), Object::Real(bottom),
            Object::Real(right), Object::Real(bottom),
        ]);
        union_left = union_left.min(left);
        union_bottom = union_bottom.min(bottom);
        union_right = union_right.max(right);
        union_top = union_top.max(top);
    }
    if quad_points.is_empty() {
        return Ok(());
    }

    let author = if annotation.author.trim().is_empty() { "专利阅研" } else { annotation.author.trim() };
    let mut dictionary = dictionary! {
        "Type" => Object::Name(b"Annot".to_vec()),
        "Subtype" => Object::Name(b"Highlight".to_vec()),
        "Rect" => vec![
            Object::Real(union_left),
            Object::Real(union_bottom),
            Object::Real(union_right),
            Object::Real(union_top),
        ],
        "QuadPoints" => quad_points,
        "Contents" => pdf_unicode_string(&pdf_annotation_summary(annotation)),
        "T" => pdf_unicode_string(author),
        "NM" => Object::string_literal(format!("patent-reader-{annotation_index}")),
        "F" => Object::Integer(4),
        "C" => vec![Object::Real(1.0), Object::Real(0.78), Object::Real(0.18)],
        "CA" => Object::Real(0.35),
    };
    dictionary.set("P", Object::Reference(page_id));
    let annotation_id = document.add_object(dictionary);
    attach_pdf_annotation(document, page_id, annotation_id)
}

fn write_pdf_note(
    document: &mut Document,
    page_id: ObjectId,
    page_box: PdfPageBox,
    annotation: &AnnotationPayload,
    annotation_index: usize,
) -> Result<(), String> {
    let author = if annotation.author.trim().is_empty() { "专利阅研" } else { annotation.author.trim() };
    let right = page_box.left + page_box.width - 18.0;
    let top = page_box.bottom + page_box.height - 18.0;
    let mut dictionary = dictionary! {
        "Type" => Object::Name(b"Annot".to_vec()),
        "Subtype" => Object::Name(b"Text".to_vec()),
        "Rect" => vec![
            Object::Real(right - 18.0),
            Object::Real(top - 18.0),
            Object::Real(right),
            Object::Real(top),
        ],
        "Contents" => pdf_unicode_string(&pdf_annotation_summary(annotation)),
        "T" => pdf_unicode_string(author),
        "NM" => Object::string_literal(format!("patent-reader-note-{annotation_index}")),
        "Name" => Object::Name(b"Comment".to_vec()),
        "F" => Object::Integer(4),
        "C" => vec![Object::Real(1.0), Object::Real(0.78), Object::Real(0.18)],
    };
    dictionary.set("P", Object::Reference(page_id));
    let annotation_id = document.add_object(dictionary);
    attach_pdf_annotation(document, page_id, annotation_id)
}

fn write_pdf_revision(original: &Path, destination: &Path, annotations: &[AnnotationPayload]) -> Result<(), String> {
    let mut document = Document::load(original).map_err(|error| format!("无法读取原 PDF：{error}"))?;
    let pages = document.get_pages();
    let first_page = pages.values().next().copied().ok_or_else(|| "PDF 中没有可批注页面。".to_string())?;

    for (annotation_index, annotation) in annotations.iter().enumerate() {
        let mut by_page: BTreeMap<u32, Vec<&PdfRectPayload>> = BTreeMap::new();
        if let Some(anchor) = annotation.selection_anchor.as_ref() {
            for rect in &anchor.pdf_rects {
                by_page.entry(rect.page_number).or_default().push(rect);
            }
        }
        if by_page.is_empty() {
            let page_box = pdf_page_box(&document, first_page)?;
            write_pdf_note(&mut document, first_page, page_box, annotation, annotation_index)?;
            continue;
        }
        for (page_number, rects) in by_page {
            let page_id = pages.get(&page_number)
                .copied()
                .ok_or_else(|| format!("PDF 中不存在第 {page_number} 页，无法写入批注。"))?;
            let page_box = pdf_page_box(&document, page_id)?;
            write_pdf_highlight(&mut document, page_id, page_box, &rects, annotation, annotation_index)?;
        }
    }

    document.compress();
    document.save(destination).map_err(|error| format!("无法完成 PDF 修订版：{error}"))?;
    Ok(())
}

fn next_revision_path(original: &Path) -> PathBuf {
    let directory = original.parent().unwrap_or_else(|| Path::new("."));
    let stem = original.file_stem().and_then(|value| value.to_str()).unwrap_or("专利文件");
    let extension = original.extension().and_then(|value| value.to_str()).unwrap_or("");
    let extension_suffix = if extension.is_empty() { String::new() } else { format!(".{extension}") };
    let first = directory.join(format!("{stem}-修订版{extension_suffix}"));
    if !first.exists() {
        return first;
    }
    let mut index = 2;
    loop {
        let candidate = directory.join(format!("{stem}-修订版（{index}）{extension_suffix}"));
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn rating_workbook_path(revision: &Path) -> PathBuf {
    let stem = revision.file_stem().and_then(|value| value.to_str()).unwrap_or("专利文件-修订版");
    revision.with_file_name(format!("{stem}-评分表.xlsx"))
}

fn available_xlsx_sibling_path(original: &Path, suffix: &str) -> PathBuf {
    let directory = original.parent().unwrap_or_else(|| Path::new("."));
    let stem = original.file_stem().and_then(|value| value.to_str()).unwrap_or("专利文件");
    let first = directory.join(format!("{stem}{suffix}.xlsx"));
    if !first.exists() {
        return first;
    }
    let mut index = 2;
    loop {
        let candidate = directory.join(format!("{stem}{suffix}（{index}）.xlsx"));
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn review_workbook_path(original: &Path) -> PathBuf {
    available_xlsx_sibling_path(original, "-LLM审查报告")
}

fn write_rating_workbook(
    destination: &Path,
    case_name: &str,
    ratings: &RatingPayload,
) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let default_format = Format::new().set_font_name("宋体").set_font_size(11);
    workbook.set_default_format(&default_format, 15, 72)
        .map_err(|error| format!("无法设置评分表格式：{error}"))?;
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("Sheet1").map_err(|error| format!("无法创建评分表工作表：{error}"))?;
    worksheet.set_column_width(0, 32).map_err(|error| format!("无法设置评分表列宽：{error}"))?;
    worksheet.write_with_format(0, 0, "案件", &default_format).map_err(|error| format!("无法写入评分表：{error}"))?;
    worksheet.write_with_format(0, 1, "技术理解评级", &default_format).map_err(|error| format!("无法写入评分表：{error}"))?;
    worksheet.write_with_format(0, 2, "沟通评级", &default_format).map_err(|error| format!("无法写入评分表：{error}"))?;
    worksheet.write_with_format(0, 3, "专利质量评级", &default_format).map_err(|error| format!("无法写入评分表：{error}"))?;
    worksheet.write_with_format(1, 0, case_name, &default_format).map_err(|error| format!("无法写入评分表：{error}"))?;
    worksheet.write_with_format(1, 1, &ratings.technical_understanding, &default_format).map_err(|error| format!("无法写入评分表：{error}"))?;
    worksheet.write_with_format(1, 2, &ratings.communication, &default_format).map_err(|error| format!("无法写入评分表：{error}"))?;
    worksheet.write_with_format(1, 3, &ratings.patent_quality, &default_format).map_err(|error| format!("无法写入评分表：{error}"))?;
    workbook.save(destination).map_err(|error| format!("无法保存评分表：{error}"))
}

fn write_review_workbook(
    destination: &Path,
    case_name: &str,
    ratings: Option<&RatingPayload>,
    report: &LlmReviewReportPayload,
) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let default_format = Format::new().set_font_name("微软雅黑").set_font_size(10);
    let header_format = Format::new()
        .set_font_name("微软雅黑")
        .set_font_size(10)
        .set_bold()
        .set_background_color("#DDEFEA");
    let wrap_format = Format::new()
        .set_font_name("微软雅黑")
        .set_font_size(10)
        .set_text_wrap();
    workbook.set_default_format(&default_format, 15, 72)
        .map_err(|error| format!("无法设置审查报告格式：{error}"))?;

    let findings = workbook.add_worksheet();
    findings.set_name("审查结论").map_err(|error| format!("无法创建审查报告工作表：{error}"))?;
    let headers = [
        "序号", "模块", "严重程度", "证据等级", "标题", "原文位置", "原文摘录",
        "问题分析", "修改/核验建议", "来源", "用户采纳",
    ];
    let widths = [7.0, 20.0, 10.0, 16.0, 26.0, 22.0, 42.0, 52.0, 48.0, 42.0, 10.0];
    for (column, (header, width)) in headers.iter().zip(widths).enumerate() {
        findings.set_column_width(column as u16, width)
            .map_err(|error| format!("无法设置审查报告列宽：{error}"))?;
        findings.write_with_format(0, column as u16, *header, &header_format)
            .map_err(|error| format!("无法写入审查报告表头：{error}"))?;
    }
    for (index, finding) in report.findings.iter().enumerate() {
        let row = (index + 1) as u32;
        let values = [
            (index + 1).to_string(),
            finding.module.clone(),
            finding.severity.clone(),
            finding.evidence_level.clone(),
            finding.title.clone(),
            finding.location.clone(),
            finding.quote.clone(),
            finding.analysis.clone(),
            finding.recommendation.clone(),
            finding.sources.clone(),
            if finding.accepted { "已采纳".to_string() } else { "未采纳".to_string() },
        ];
        for (column, value) in values.iter().enumerate() {
            findings.write_with_format(row, column as u16, value, &wrap_format)
                .map_err(|error| format!("无法写入审查报告：{error}"))?;
        }
    }
    findings.set_freeze_panes(1, 0)
        .map_err(|error| format!("无法设置审查报告冻结窗格：{error}"))?;

    let summary = workbook.add_worksheet();
    summary.set_name("审查信息").map_err(|error| format!("无法创建审查信息工作表：{error}"))?;
    summary.set_column_width(0, 22).map_err(|error| format!("无法设置审查信息列宽：{error}"))?;
    summary.set_column_width(1, 70).map_err(|error| format!("无法设置审查信息列宽：{error}"))?;
    let rating_values = ratings.cloned().unwrap_or(RatingPayload {
        technical_understanding: String::new(),
        communication: String::new(),
        patent_quality: String::new(),
    });
    let metadata = [
        ("案件", case_name.to_string()),
        ("技术领域", report.technical_field.clone()),
        ("LLM服务商", report.provider.clone()),
        ("模型", report.model.clone()),
        ("规则库版本", report.rulebook_version.clone()),
        ("规则库核验日期", report.rulebook_verified_at.clone()),
        ("生成时间", report.generated_at.clone()),
        ("技术理解评级", rating_values.technical_understanding),
        ("沟通评级", rating_values.communication),
        ("专利质量评级", rating_values.patent_quality),
        ("免责声明", "本报告仅用于辅助审核，不构成法律意见；结论应由具备资质的专利代理师或律师结合案情复核。".to_string()),
    ];
    for (row, (label, value)) in metadata.iter().enumerate() {
        summary.write_with_format(row as u32, 0, *label, &header_format)
            .map_err(|error| format!("无法写入审查信息：{error}"))?;
        summary.write_with_format(row as u32, 1, value, &wrap_format)
            .map_err(|error| format!("无法写入审查信息：{error}"))?;
    }

    workbook.save(destination).map_err(|error| format!("无法保存LLM审查报告：{error}"))
}

fn cloud_ocr_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("无法初始化云 OCR 网络请求：{error}"))
}

fn cloud_response_json(response: Response, provider: &str) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().map_err(|error| format!("{provider} 返回内容无法读取：{error}"))?;
    if !status.is_success() {
        let summary = body.chars().take(240).collect::<String>();
        return Err(format!("{provider} 请求失败（HTTP {status}）：{summary}"));
    }
    serde_json::from_str(&body).map_err(|error| format!("{provider} 返回的不是有效 JSON：{error}"))
}

fn image_base64(data_url: &str) -> Result<&str, String> {
    if !data_url.starts_with("data:image/") {
        return Err("云 OCR 只允许上传附图（PNG/JPEG 等图像），不会接收正文或原文件。".to_string());
    }
    let (_, encoded) = data_url.split_once(',').ok_or_else(|| "附图数据格式无效。".to_string())?;
    if encoded.len() > 28_000_000 {
        return Err("单张附图超过云 OCR 上传上限，请先缩小图片。".to_string());
    }
    Ok(encoded)
}

fn percent_word(
    text: String,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
    image_width: f32,
    image_height: f32,
    confidence: f32,
) -> CloudOcrWord {
    let safe_width = image_width.max(1.0);
    let safe_height = image_height.max(1.0);
    CloudOcrWord {
        text,
        left: (left / safe_width * 100.0).clamp(0.0, 100.0),
        top: (top / safe_height * 100.0).clamp(0.0, 100.0),
        width: (width / safe_width * 100.0).clamp(0.0, 100.0),
        height: (height / safe_height * 100.0).clamp(0.0, 100.0),
        confidence: confidence.clamp(0.0, 100.0),
    }
}

fn ocr_space(payload: &CloudOcrPayload, client: &Client) -> Result<CloudOcrResult, String> {
    let form = multipart::Form::new()
        .text("base64Image", payload.image_data_url.clone())
        .text("language", "eng")
        .text("isOverlayRequired", "true")
        .text("scale", "true")
        .text("OCREngine", "2");
    let value = cloud_response_json(
        client.post("https://api.ocr.space/parse/image")
            .header("apikey", payload.api_key.trim())
            .multipart(form)
            .send()
            .map_err(|error| format!("OCR.Space 连接失败：{error}"))?,
        "OCR.Space",
    )?;
    if value.get("IsErroredOnProcessing").and_then(Value::as_bool).unwrap_or(false) {
        return Err(format!("OCR.Space 识别失败：{}", value.get("ErrorMessage").unwrap_or(&Value::Null)));
    }
    let mut words = Vec::new();
    if let Some(results) = value.get("ParsedResults").and_then(Value::as_array) {
        for result in results {
            let Some(lines) = result.pointer("/TextOverlay/Lines").and_then(Value::as_array) else { continue };
            for line in lines {
                let Some(items) = line.get("Words").and_then(Value::as_array) else { continue };
                for item in items {
                    let text = item.get("WordText").and_then(Value::as_str).unwrap_or_default().trim();
                    if text.is_empty() { continue; }
                    words.push(percent_word(
                        text.to_string(),
                        item.get("Left").and_then(Value::as_f64).unwrap_or_default() as f32,
                        item.get("Top").and_then(Value::as_f64).unwrap_or_default() as f32,
                        item.get("Width").and_then(Value::as_f64).unwrap_or_default() as f32,
                        item.get("Height").and_then(Value::as_f64).unwrap_or_default() as f32,
                        payload.image_width,
                        payload.image_height,
                        80.0,
                    ));
                }
            }
        }
    }
    Ok(CloudOcrResult { words })
}

fn google_vision(payload: &CloudOcrPayload, client: &Client) -> Result<CloudOcrResult, String> {
    let encoded = image_base64(&payload.image_data_url)?;
    let endpoint = if payload.endpoint.trim().is_empty() {
        "https://vision.googleapis.com/v1/images:annotate"
    } else {
        payload.endpoint.trim()
    };
    let value = cloud_response_json(
        client.post(endpoint)
            .header("x-goog-api-key", payload.api_key.trim())
            .json(&json!({
                "requests": [{
                    "image": { "content": encoded },
                    "features": [{ "type": "TEXT_DETECTION", "maxResults": 500 }]
                }]
            }))
            .send()
            .map_err(|error| format!("Google Cloud Vision 连接失败：{error}"))?,
        "Google Cloud Vision",
    )?;
    if let Some(message) = value.pointer("/responses/0/error/message").and_then(Value::as_str) {
        return Err(format!("Google Cloud Vision 识别失败：{message}"));
    }
    let mut words = Vec::new();
    let annotations = value.pointer("/responses/0/textAnnotations").and_then(Value::as_array).cloned().unwrap_or_default();
    for annotation in annotations.into_iter().skip(1) {
        let text = annotation.get("description").and_then(Value::as_str).unwrap_or_default().trim();
        if text.is_empty() { continue; }
        let vertices = annotation.pointer("/boundingPoly/vertices").and_then(Value::as_array).cloned().unwrap_or_default();
        let xs = vertices.iter().map(|vertex| vertex.get("x").and_then(Value::as_f64).unwrap_or_default() as f32).collect::<Vec<_>>();
        let ys = vertices.iter().map(|vertex| vertex.get("y").and_then(Value::as_f64).unwrap_or_default() as f32).collect::<Vec<_>>();
        if xs.is_empty() || ys.is_empty() { continue; }
        let left = xs.iter().copied().fold(f32::MAX, f32::min);
        let right = xs.iter().copied().fold(f32::MIN, f32::max);
        let top = ys.iter().copied().fold(f32::MAX, f32::min);
        let bottom = ys.iter().copied().fold(f32::MIN, f32::max);
        words.push(percent_word(text.to_string(), left, top, right - left, bottom - top, payload.image_width, payload.image_height, 90.0));
    }
    Ok(CloudOcrResult { words })
}

fn paddle_words_from_result(value: &Value, payload: &CloudOcrPayload) -> Vec<CloudOcrWord> {
    let mut words = Vec::new();
    let Some(texts) = value.get("rec_texts").and_then(Value::as_array) else { return words };
    let boxes = value.get("rec_boxes").and_then(Value::as_array);
    let polygons = value.get("rec_polys").and_then(Value::as_array);
    let scores = value.get("rec_scores").and_then(Value::as_array);
    for (index, text_value) in texts.iter().enumerate() {
        let text = text_value.as_str().unwrap_or_default().trim();
        if text.is_empty() { continue; }
        let coordinates = boxes.and_then(|items| items.get(index)).and_then(Value::as_array);
        let (left, top, right, bottom) = if let Some(coordinates) = coordinates {
            (
                coordinates.first().and_then(Value::as_f64).unwrap_or_default() as f32,
                coordinates.get(1).and_then(Value::as_f64).unwrap_or_default() as f32,
                coordinates.get(2).and_then(Value::as_f64).unwrap_or_default() as f32,
                coordinates.get(3).and_then(Value::as_f64).unwrap_or_default() as f32,
            )
        } else if let Some(points) = polygons.and_then(|items| items.get(index)).and_then(Value::as_array) {
            let xs = points.iter().filter_map(|point| point.as_array()?.first()?.as_f64()).map(|value| value as f32).collect::<Vec<_>>();
            let ys = points.iter().filter_map(|point| point.as_array()?.get(1)?.as_f64()).map(|value| value as f32).collect::<Vec<_>>();
            if xs.is_empty() || ys.is_empty() { continue; }
            (
                xs.iter().copied().fold(f32::MAX, f32::min),
                ys.iter().copied().fold(f32::MAX, f32::min),
                xs.iter().copied().fold(f32::MIN, f32::max),
                ys.iter().copied().fold(f32::MIN, f32::max),
            )
        } else {
            continue;
        };
        let confidence = scores
            .and_then(|items| items.get(index))
            .and_then(Value::as_f64)
            .unwrap_or(0.8) as f32 * 100.0;
        words.push(percent_word(
            text.to_string(),
            left,
            top,
            right - left,
            bottom - top,
            payload.image_width,
            payload.image_height,
            confidence,
        ));
    }
    words
}

fn paddle_ocr(payload: &CloudOcrPayload, client: &Client) -> Result<CloudOcrResult, String> {
    let encoded = image_base64(&payload.image_data_url)?;
    let image = STANDARD.decode(encoded).map_err(|error| format!("附图 Base64 数据无效：{error}"))?;
    let base_url = if payload.endpoint.trim().is_empty() {
        "https://paddleocr.aistudio-app.com"
    } else {
        payload.endpoint.trim().trim_end_matches('/')
    };
    let jobs_url = format!("{base_url}/api/v2/ocr/jobs");
    let model = if payload.model.trim().is_empty() { "PP-OCRv6" } else { payload.model.trim() };
    let part = multipart::Part::bytes(image)
        .file_name("patent-figure.png")
        .mime_str("image/png")
        .map_err(|error| format!("无法准备 PaddleOCR 附图：{error}"))?;
    let form = multipart::Form::new()
        .text("model", model.to_string())
        .text("optionalPayload", r#"{"useDocOrientationClassify":false,"useDocUnwarping":false,"useTextlineOrientation":false,"textRecScoreThresh":0.0,"visualize":false}"#)
        .part("file", part);
    let value = cloud_response_json(
        client.post(&jobs_url)
            .bearer_auth(payload.api_key.trim())
            .multipart(form)
            .send()
            .map_err(|error| format!("PaddleOCR 提交失败：{error}"))?,
        "PaddleOCR",
    )?;
    let job_id = value.pointer("/data/jobId").and_then(Value::as_str)
        .ok_or_else(|| "PaddleOCR 未返回任务编号。".to_string())?;
    let mut result_url = None;
    for _ in 0..45 {
        let status = cloud_response_json(
            client.get(format!("{jobs_url}/{job_id}"))
                .bearer_auth(payload.api_key.trim())
                .send()
                .map_err(|error| format!("PaddleOCR 查询任务失败：{error}"))?,
            "PaddleOCR",
        )?;
        match status.pointer("/data/state").and_then(Value::as_str) {
            Some("done") => {
                result_url = status.pointer("/data/resultUrl/jsonUrl").and_then(Value::as_str).map(str::to_string);
                break;
            }
            Some("failed") => {
                let message = status.pointer("/data/errorMsg").and_then(Value::as_str).unwrap_or("未知错误");
                return Err(format!("PaddleOCR 识别失败：{message}"));
            }
            _ => std::thread::sleep(Duration::from_secs(2)),
        }
    }
    let result_url = result_url.ok_or_else(|| "PaddleOCR 识别超时，请稍后重试。".to_string())?;
    let response = client.get(result_url).send().map_err(|error| format!("PaddleOCR 获取结果失败：{error}"))?;
    let status = response.status();
    let body = response.text().map_err(|error| format!("PaddleOCR 结果读取失败：{error}"))?;
    if !status.is_success() {
        return Err(format!("PaddleOCR 获取结果失败（HTTP {}）。", status.as_u16()));
    }
    let mut words = Vec::new();
    for line in body.lines().filter(|line| !line.trim().is_empty()) {
        let line_value: Value = serde_json::from_str(line)
            .map_err(|error| format!("PaddleOCR 结果格式无效：{error}"))?;
        for item in line_value.pointer("/result/ocrResults").and_then(Value::as_array).cloned().unwrap_or_default() {
            words.extend(paddle_words_from_result(item.get("prunedResult").unwrap_or(&Value::Null), payload));
        }
    }
    Ok(CloudOcrResult { words })
}

fn parse_custom_words(value: &Value) -> Vec<CloudOcrWord> {
    let items = value.get("words").or_else(|| value.pointer("/data/words")).and_then(Value::as_array).cloned().unwrap_or_default();
    items.into_iter().filter_map(|item| {
        let text = item.get("text").and_then(Value::as_str)?.trim();
        if text.is_empty() { return None; }
        Some(CloudOcrWord {
            text: text.to_string(),
            left: item.get("left").and_then(Value::as_f64).unwrap_or(50.0) as f32,
            top: item.get("top").and_then(Value::as_f64).unwrap_or(50.0) as f32,
            width: item.get("width").and_then(Value::as_f64).unwrap_or(4.0) as f32,
            height: item.get("height").and_then(Value::as_f64).unwrap_or(3.0) as f32,
            confidence: item.get("confidence").and_then(Value::as_f64).unwrap_or(75.0) as f32,
        })
    }).collect()
}

fn custom_ocr(payload: &CloudOcrPayload, client: &Client) -> Result<CloudOcrResult, String> {
    image_base64(&payload.image_data_url)?;
    let endpoint = payload.endpoint.trim();
    if !(endpoint.starts_with("https://") || endpoint.starts_with("http://127.0.0.1") || endpoint.starts_with("http://localhost")) {
        return Err("自定义 OCR 服务器地址必须使用 HTTPS；本机服务可使用 localhost 或 127.0.0.1。".to_string());
    }
    let interface_name = if payload.interface_name.trim().is_empty() { "自定义 OCR" } else { payload.interface_name.trim() };
    let value = cloud_response_json(
        client.post(endpoint)
            .bearer_auth(payload.api_key.trim())
            .json(&json!({
                "model": payload.model.trim(),
                "temperature": 0,
                "messages": [{
                    "role": "user",
                    "content": [{
                        "type": "text",
                        "text": "识别专利附图中实际可见的部件标号。不要把尺寸、图号或方向字母当成标号。仅返回 JSON：{\"words\":[{\"text\":\"标号\",\"left\":左上角百分比,\"top\":左上角百分比,\"width\":宽度百分比,\"height\":高度百分比,\"confidence\":0到100}]}"
                    }, {
                        "type": "image_url",
                        "image_url": { "url": payload.image_data_url }
                    }]
                }]
            }))
            .send()
            .map_err(|error| format!("{interface_name} 连接失败：{error}"))?,
        interface_name,
    )?;
    let direct = parse_custom_words(&value);
    if !direct.is_empty() { return Ok(CloudOcrResult { words: direct }); }
    let content = value.pointer("/choices/0/message/content").and_then(Value::as_str)
        .or_else(|| value.pointer("/output/0/content/0/text").and_then(Value::as_str))
        .ok_or_else(|| format!("{interface_name} 未返回可解析的 words 数据。"))?;
    let cleaned = content.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let structured: Value = serde_json::from_str(cleaned)
        .map_err(|error| format!("{interface_name} 返回的 JSON 格式无效：{error}"))?;
    Ok(CloudOcrResult { words: parse_custom_words(&structured) })
}

fn cloud_ocr_blocking(payload: CloudOcrPayload) -> Result<CloudOcrResult, String> {
    if payload.provider != "local" && payload.api_key.trim().is_empty() {
        return Err("请先填写所选云 OCR 的 API Key。".to_string());
    }
    image_base64(&payload.image_data_url)?;
    let client = cloud_ocr_client()?;
    match payload.provider.as_str() {
        "ocr-space" => ocr_space(&payload, &client),
        "google-vision" => google_vision(&payload, &client),
        "paddle-ocr" => paddle_ocr(&payload, &client),
        "custom" => custom_ocr(&payload, &client),
        _ => Err("不支持的云 OCR 服务商。".to_string()),
    }
}

#[tauri::command]
async fn cloud_ocr(payload: CloudOcrPayload) -> Result<CloudOcrResult, String> {
    tauri::async_runtime::spawn_blocking(move || cloud_ocr_blocking(payload))
        .await
        .map_err(|error| format!("云 OCR 后台任务异常结束：{error}"))?
}

fn validated_external_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") || trimmed.chars().any(char::is_whitespace) {
        return Err("仅允许打开安全的 HTTPS 地址。".to_string());
    }
    Ok(trimmed)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let target = validated_external_url(&url)?;
    let mut command = Command::new("rundll32.exe");
    command.args(["url.dll,FileProtocolHandler", target]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn()
        .map_err(|error| format!("无法调用 Windows 默认浏览器：{error}"))?;
    Ok(())
}

#[tauri::command]
fn open_document() -> Result<Option<OpenedDocument>, String> {
    let selected = FileDialog::new()
        .set_title("打开专利文件")
        .add_filter("专利文件", &["docx", "pdf"])
        .pick_file();
    let Some(path) = selected else { return Ok(None) };

    let bytes = fs::read(&path).map_err(|error| format!("无法读取文件：{error}"))?;
    let name = path.file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法读取文件名".to_string())?
        .to_owned();
    let extension = path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let preview_bytes = if extension == "docx" {
        prepare_docx_for_preview(&bytes)?
    } else {
        bytes
    };
    let base64 = STANDARD.encode(preview_bytes);
    Ok(Some(OpenedDocument {
        path: path.to_string_lossy().into_owned(),
        name,
        extension,
        base64,
    }))
}

fn opened_document(path: &Path) -> Result<OpenedDocument, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取对比文件：{error}"))?;
    let name = path.file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法读取对比文件名".to_string())?
        .to_owned();
    let extension = path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    Ok(OpenedDocument {
        path: path.to_string_lossy().into_owned(),
        name,
        extension,
        base64: STANDARD.encode(bytes),
    })
}

#[tauri::command]
fn open_comparison_documents() -> Result<Vec<OpenedDocument>, String> {
    let selected = FileDialog::new()
        .set_title("选择对比文件")
        .add_filter("对比文件", &["docx", "pdf"])
        .pick_files()
        .unwrap_or_default();
    selected.iter().map(|path| opened_document(path)).collect()
}

fn llm_completion_blocking(payload: LlmCompletionPayload) -> Result<LlmCompletionResult, String> {
    let endpoint = validated_external_url(&payload.endpoint)?;
    if payload.api_key.trim().is_empty() {
        return Err("请先填写LLM或检索服务的API Key。".to_string());
    }
    if payload.model.trim().is_empty() {
        return Err("请先填写模型或工具名称。".to_string());
    }
    if payload.system.len() > 120_000 || payload.user.len() > 600_000 {
        return Err("本次审查内容超过安全传输上限，请缩小审查范围。".to_string());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(240))
        .build()
        .map_err(|error| format!("无法初始化LLM请求：{error}"))?;
    let response = client
        .post(endpoint)
        .bearer_auth(payload.api_key.trim())
        .json(&json!({
            "model": payload.model.trim(),
            "messages": [
                { "role": "system", "content": payload.system },
                { "role": "user", "content": payload.user }
            ],
            "stream": false
        }))
        .send()
        .map_err(|error| format!("{}请求失败：{error}", payload.purpose))?;
    let provider_name = if payload.provider.trim().is_empty() { "LLM" } else { payload.provider.trim() };
    let body = cloud_response_json(response, provider_name)?;
    let content = body.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .or_else(|| body.pointer("/output_text").and_then(Value::as_str))
        .ok_or_else(|| format!("{provider_name}返回内容中没有可读取的文本。"))?
        .trim()
        .to_string();
    if content.is_empty() {
        return Err(format!("{provider_name}返回了空结果。"));
    }
    Ok(LlmCompletionResult { content })
}

#[tauri::command]
async fn llm_completion(payload: LlmCompletionPayload) -> Result<LlmCompletionResult, String> {
    tauri::async_runtime::spawn_blocking(move || llm_completion_blocking(payload))
        .await
        .map_err(|error| format!("LLM后台任务异常结束：{error}"))?
}

fn parse_agent_tool_calls(message: &Value) -> Result<Vec<LlmAgentToolCallResult>, String> {
    message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|call| {
            let id = call.get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let function = call.get("function")
                .ok_or_else(|| "LLM工具调用缺少function字段。".to_string())?;
            let name = function.get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if id.is_empty() || name.is_empty() {
                return Err("LLM工具调用缺少id或工具名称。".to_string());
            }
            let arguments = match function.get("arguments") {
                Some(Value::String(text)) => serde_json::from_str::<Value>(text)
                    .map_err(|error| format!("LLM为工具{name}生成的参数不是合法JSON：{error}"))?,
                Some(value) => value.clone(),
                None => json!({}),
            };
            if !arguments.is_object() {
                return Err(format!("LLM为工具{name}生成的参数必须是JSON对象。"));
            }
            Ok(LlmAgentToolCallResult { id, name, arguments })
        })
        .collect()
}

fn llm_agent_turn_blocking(payload: LlmAgentTurnPayload) -> Result<LlmAgentTurnResult, String> {
    let endpoint = validated_external_url(&payload.endpoint)?;
    if payload.api_key.trim().is_empty() {
        return Err("请先填写LLM的API Key。".to_string());
    }
    if payload.model.trim().is_empty() {
        return Err("请先选择支持工具调用的模型。".to_string());
    }
    let message_bytes = serde_json::to_vec(&payload.messages)
        .map_err(|error| format!("无法整理LLM检索会话：{error}"))?;
    if message_bytes.len() > 1_200_000 {
        return Err("LLM检索会话超过安全传输上限，请减少工具调用轮次。".to_string());
    }
    let tools = payload.tools.iter().map(|tool| {
        json!({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema,
            }
        })
    }).collect::<Vec<_>>();
    let mut request_body = json!({
        "model": payload.model.trim(),
        "messages": payload.messages,
        "stream": false,
    });
    if !tools.is_empty() {
        request_body["tools"] = Value::Array(tools);
        request_body["tool_choice"] = Value::String("auto".to_string());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(240))
        .build()
        .map_err(|error| format!("无法初始化LLM工具调用请求：{error}"))?;
    let response = client
        .post(endpoint)
        .bearer_auth(payload.api_key.trim())
        .json(&request_body)
        .send()
        .map_err(|error| format!("{}请求失败：{error}", payload.purpose))?;
    let provider_name = if payload.provider.trim().is_empty() { "LLM" } else { payload.provider.trim() };
    let body = cloud_response_json(response, provider_name)?;
    let assistant_message = body.pointer("/choices/0/message")
        .cloned()
        .ok_or_else(|| format!("{provider_name}没有返回可读取的assistant消息；请确认所选模型支持工具调用。"))?;
    let content = assistant_message.get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let tool_calls = parse_agent_tool_calls(&assistant_message)?;
    if content.is_empty() && tool_calls.is_empty() {
        return Err(format!("{provider_name}既没有返回文本，也没有调用检索工具；请更换支持工具调用的模型。"));
    }
    Ok(LlmAgentTurnResult { content, assistant_message, tool_calls })
}

#[tauri::command]
async fn llm_agent_turn(payload: LlmAgentTurnPayload) -> Result<LlmAgentTurnResult, String> {
    tauri::async_runtime::spawn_blocking(move || llm_agent_turn_blocking(payload))
        .await
        .map_err(|error| format!("LLM工具调用后台任务异常结束：{error}"))?
}

fn parse_llm_model_ids(body: &Value) -> Vec<String> {
    let entries = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models = entries
        .iter()
        .filter_map(|entry| {
            entry
                .get("id")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .collect::<Vec<_>>();
    models.sort_by_key(|value| value.to_ascii_lowercase());
    models.dedup();
    models
}

fn llm_list_models_blocking(payload: LlmModelListPayload) -> Result<LlmModelListResult, String> {
    let endpoint = validated_external_url(&payload.endpoint)?;
    if payload.api_key.trim().is_empty() {
        return Err("请先填写所选服务商的API Key。".to_string());
    }
    let provider_name = if payload.provider.trim().is_empty() { "LLM" } else { payload.provider.trim() };
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("无法初始化模型列表请求：{error}"))?;
    let response = client
        .get(endpoint)
        .bearer_auth(payload.api_key.trim())
        .send()
        .map_err(|error| format!("{provider_name}模型列表请求失败：{error}"))?;
    let body = cloud_response_json(response, provider_name)?;
    let models = parse_llm_model_ids(&body);
    if models.is_empty() {
        return Err(format!("{provider_name}未返回可用的模型名称；仍可手工填写模型ID。"));
    }
    Ok(LlmModelListResult { models })
}

#[tauri::command]
async fn llm_list_models(payload: LlmModelListPayload) -> Result<LlmModelListResult, String> {
    tauri::async_runtime::spawn_blocking(move || llm_list_models_blocking(payload))
        .await
        .map_err(|error| format!("模型列表后台任务异常结束：{error}"))?
}

fn parse_mcp_wire_json(text: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return Ok(value);
    }
    for line in text.lines().rev() {
        if let Some(data) = line.trim().strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                return Ok(value);
            }
        }
    }
    Err("MCP服务器未返回可解析的JSON或SSE数据。".to_string())
}

fn parse_mcp_headers(headers_json: &str) -> Result<HeaderMap, String> {
    if headers_json.trim().is_empty() {
        return Ok(HeaderMap::new());
    }
    let values = serde_json::from_str::<serde_json::Map<String, Value>>(headers_json)
        .map_err(|error| format!("自定义请求头不是合法JSON对象：{error}"))?;
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let lower = name.to_ascii_lowercase();
        if matches!(lower.as_str(), "host" | "content-length" | "connection" | "transfer-encoding") {
            return Err(format!("自定义请求头不允许设置{name}。"));
        }
        let text = value
            .as_str()
            .ok_or_else(|| format!("自定义请求头{name}的值必须是字符串。"))?;
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("自定义请求头名称{name}无效。"))?;
        let header_value = HeaderValue::from_str(text)
            .map_err(|_| format!("自定义请求头{name}的值无效。"))?;
        headers.insert(header_name, header_value);
    }
    Ok(headers)
}

fn mcp_request(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HeaderMap,
    session_id: Option<&str>,
    body: &Value,
) -> reqwest::blocking::RequestBuilder {
    let mut request = client
        .post(endpoint)
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .header("MCP-Protocol-Version", "2025-03-26")
        .json(body);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    if !custom_headers.is_empty() {
        request = request.headers(custom_headers.clone());
    }
    if let Some(session_id) = session_id.filter(|value| !value.is_empty()) {
        request = request.header("Mcp-Session-Id", session_id);
    }
    request
}

fn mcp_post(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HeaderMap,
    session_id: Option<&str>,
    body: &Value,
) -> Result<(Value, Option<String>), String> {
    let response = mcp_request(client, endpoint, api_key, custom_headers, session_id, body)
        .send()
        .map_err(|error| format!("MCP请求失败：{error}"))?;
    let status = response.status();
    let next_session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
        .or_else(|| session_id.map(ToOwned::to_owned));
    let text = response
        .text()
        .map_err(|error| format!("无法读取MCP响应：{error}"))?;
    if !status.is_success() {
        return Err(format!("MCP服务器返回HTTP {}：{}", status.as_u16(), text.chars().take(600).collect::<String>()));
    }
    let value = parse_mcp_wire_json(&text)?;
    if let Some(error) = value.get("error") {
        return Err(format!("MCP服务器返回错误：{}", error));
    }
    Ok((value, next_session_id))
}

fn mcp_post_notification(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HeaderMap,
    session_id: Option<&str>,
    body: &Value,
) -> Result<(), String> {
    let response = mcp_request(client, endpoint, api_key, custom_headers, session_id, body)
        .send()
        .map_err(|error| format!("MCP初始化确认失败：{error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("MCP初始化确认返回HTTP {}。", response.status().as_u16()))
    }
}

fn parse_mcp_tools(value: &Value) -> Vec<McpToolPayload> {
    value
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            let name = tool.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            Some(McpToolPayload {
                name: name.to_string(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                input_schema: tool
                    .get("inputSchema")
                    .or_else(|| tool.get("input_schema"))
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            })
        })
        .collect()
}

fn connect_mcp(
    endpoint: &str,
    api_key: &str,
    headers_json: &str,
) -> Result<(Client, Option<String>, Vec<McpToolPayload>), String> {
    let endpoint = validated_external_url(endpoint)?;
    let custom_headers = parse_mcp_headers(headers_json)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("无法初始化MCP连接：{error}"))?;
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "patent-reader", "version": "1.1.0" }
        }
    });
    let (_, session_id) = mcp_post(&client, &endpoint, api_key, &custom_headers, None, &initialize)?;
    mcp_post_notification(
        &client,
        &endpoint,
        api_key,
        &custom_headers,
        session_id.as_deref(),
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )?;
    let (tools_value, session_id) = mcp_post(
        &client,
        &endpoint,
        api_key,
        &custom_headers,
        session_id.as_deref(),
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
    )?;
    let tools = parse_mcp_tools(&tools_value);
    if tools.is_empty() {
        return Err("MCP服务器连接成功，但没有返回可调用工具。".to_string());
    }
    Ok((client, session_id, tools))
}

fn mcp_list_tools_blocking(payload: McpListToolsPayload) -> Result<McpListToolsResult, String> {
    let (_, _, tools) = connect_mcp(&payload.endpoint, &payload.api_key, &payload.headers_json)?;
    Ok(McpListToolsResult { tools })
}

#[tauri::command]
async fn mcp_list_tools(payload: McpListToolsPayload) -> Result<McpListToolsResult, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_list_tools_blocking(payload))
        .await
        .map_err(|error| format!("MCP工具发现任务异常结束：{error}"))?
}

fn research_tool(name: &str, description: &str, input_schema: Value) -> McpToolPayload {
    McpToolPayload {
        name: name.to_string(),
        description: description.to_string(),
        input_schema,
    }
}

fn zhipu_research_tools() -> Vec<McpToolPayload> {
    vec![research_tool(
        "web_search",
        "使用智谱Web Search检索网页、论文、标准、专利线索和权威技术资料。可根据前次结果改写query继续检索。",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "检索词，不超过70个字符" },
                "count": { "type": "integer", "minimum": 1, "maximum": 50 }
            },
            "required": ["query"]
        }),
    )]
}

fn epo_research_tools() -> Vec<McpToolPayload> {
    let reference_properties = json!({
        "type": { "type": "string", "enum": ["publication", "application", "priority"], "default": "publication" },
        "format": { "type": "string", "enum": ["epodoc", "docdb"], "default": "epodoc" },
        "number": { "type": "string", "description": "专利文献号，例如EP1000000或US20240001234A1" }
    });
    vec![
        research_tool(
            "ops_search",
            "使用EPO OPS CQL检索全球专利。字段包括ti、ab、pa、in、pd、num、cl和cpc；支持AND、OR、NOT。",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "CQL检索式" },
                    "range": { "type": "string", "default": "1-25", "description": "结果范围，例如1-25" }
                },
                "required": ["query"]
            }),
        ),
        research_tool(
            "ops_get_biblio",
            "按文献号获取完整书目数据，包括标题、申请人、发明人、分类号、优先权和引用文献。",
            json!({ "type": "object", "properties": reference_properties.clone(), "required": ["number"] }),
        ),
        research_tool(
            "ops_get_abstract",
            "按文献号获取专利摘要。用于核查候选文献是否值得继续读取全文。",
            json!({ "type": "object", "properties": reference_properties.clone(), "required": ["number"] }),
        ),
        research_tool(
            "ops_get_fulltext",
            "按文献号获取专利说明书或权利要求全文。part应为description或claims。",
            json!({
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["publication", "application", "priority"], "default": "publication" },
                    "format": { "type": "string", "enum": ["epodoc", "docdb"], "default": "epodoc" },
                    "number": { "type": "string" },
                    "part": { "type": "string", "enum": ["description", "claims"], "default": "claims" }
                },
                "required": ["number", "part"]
            }),
        ),
        research_tool(
            "ops_get_family",
            "获取INPADOC扩展专利同族，可附带biblio或legal数据。",
            json!({
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["publication", "application", "priority"], "default": "publication" },
                    "format": { "type": "string", "enum": ["epodoc", "docdb"], "default": "epodoc" },
                    "number": { "type": "string" },
                    "constituents": { "type": "string", "enum": ["", "biblio", "legal"], "default": "" }
                },
                "required": ["number"]
            }),
        ),
        research_tool(
            "ops_get_equivalents",
            "获取DOCDB简单同族，用于寻找同一发明的直接等效公开文本。",
            json!({ "type": "object", "properties": reference_properties, "required": ["number"] }),
        ),
        research_tool(
            "ops_cpc_search",
            "按关键词搜索CPC分类定义，用于确定下一轮专利检索的分类号。",
            json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }),
        ),
        research_tool(
            "ops_convert_number",
            "在original、docdb和epodoc之间转换专利号格式。",
            json!({
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["publication", "application", "priority"], "default": "publication" },
                    "input_format": { "type": "string", "enum": ["original", "docdb", "epodoc"], "default": "original" },
                    "number": { "type": "string" },
                    "output_format": { "type": "string", "enum": ["original", "docdb", "epodoc"], "default": "epodoc" }
                },
                "required": ["number"]
            }),
        ),
    ]
}

fn looks_mutating_mcp_tool(tool: &McpToolPayload) -> bool {
    let value = format!("{} {}", tool.name, tool.description).to_ascii_lowercase();
    [
        "delete", "remove", "create", "update", "write", "upload", "publish",
        "submit", "modify", "edit", "删除", "新建", "创建", "更新", "写入", "上传", "提交",
    ].iter().any(|keyword| value.contains(keyword))
}

fn retrieval_list_tools_blocking(payload: RetrievalListToolsPayload) -> Result<McpListToolsResult, String> {
    let tools = match payload.provider.as_str() {
        "zhipu" => zhipu_research_tools(),
        "epo-ops" => epo_research_tools(),
        "patsnap-mcp" | "custom-mcp" => {
            let (_, _, tools) = connect_mcp(&payload.endpoint, &payload.api_key, &payload.headers_json)?;
            tools.into_iter().filter(|tool| !looks_mutating_mcp_tool(tool)).collect()
        }
        _ => return Err("不支持的检索工具提供方。".to_string()),
    };
    if tools.is_empty() {
        return Err("当前检索连接没有返回可供LLM调用的只读工具。".to_string());
    }
    Ok(McpListToolsResult { tools })
}

#[tauri::command]
async fn retrieval_list_tools(payload: RetrievalListToolsPayload) -> Result<McpListToolsResult, String> {
    tauri::async_runtime::spawn_blocking(move || retrieval_list_tools_blocking(payload))
        .await
        .map_err(|error| format!("检索工具发现任务异常结束：{error}"))?
}

fn argument_string<'a>(arguments: &'a Value, name: &str, fallback: &'a str) -> &'a str {
    arguments.get(name).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).unwrap_or(fallback)
}

fn safe_epo_segment(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')) {
        return Err(format!("EPO参数{field}包含不允许的字符。"));
    }
    Ok(trimmed.to_string())
}

fn epo_authenticated_client(payload: &RetrievalToolCallPayload) -> Result<(Client, String), String> {
    if payload.api_key.trim().is_empty() || payload.client_secret.trim().is_empty() {
        return Err("请填写EPO OPS Consumer Key和Consumer Secret。".to_string());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("无法初始化EPO OPS连接：{error}"))?;
    let response = client
        .post("https://ops.epo.org/3.2/auth/accesstoken")
        .basic_auth(payload.api_key.trim(), Some(payload.client_secret.trim()))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .map_err(|error| format!("EPO OPS认证失败：{error}"))?;
    let body = cloud_response_json(response, "EPO OPS认证")?;
    let token = body.get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "EPO OPS认证响应中没有access_token。".to_string())?
        .to_string();
    Ok((client, token))
}

fn epo_result_text(response: Response, context: &str) -> Result<String, String> {
    let body = cloud_response_json(response, context)?;
    let mut content = serde_json::to_string_pretty(&body)
        .map_err(|error| format!("无法整理{context}结果：{error}"))?;
    if content.len() > 180_000 {
        content.truncate(180_000);
        content.push_str("\n[结果过长，已截断]");
    }
    Ok(content)
}

fn execute_epo_tool(payload: &RetrievalToolCallPayload) -> Result<String, String> {
    let base_url = validated_external_url(&payload.endpoint)?;
    let (client, token) = epo_authenticated_client(payload)?;
    let arguments = &payload.arguments;
    let tool_name = payload.tool_name.as_str();
    if tool_name == "ops_search" {
        let query = argument_string(arguments, "query", "");
        if query.is_empty() {
            return Err("ops_search缺少query参数。".to_string());
        }
        let range = argument_string(arguments, "range", "1-25");
        if !range.chars().all(|character| character.is_ascii_digit() || character == '-') {
            return Err("ops_search的range必须采用1-25格式。".to_string());
        }
        let response = client
            .get(format!("{}/published-data/search", base_url.trim_end_matches('/')))
            .bearer_auth(&token)
            .header("Accept", "application/json")
            .query(&[("q", query), ("Range", range)])
            .send()
            .map_err(|error| format!("EPO OPS检索失败：{error}"))?;
        return epo_result_text(response, "EPO OPS检索");
    }
    if tool_name == "ops_cpc_search" {
        let query = argument_string(arguments, "query", "");
        if query.is_empty() {
            return Err("ops_cpc_search缺少query参数。".to_string());
        }
        let response = client
            .get(format!("{}/classification/cpc/search", base_url.trim_end_matches('/')))
            .bearer_auth(&token)
            .header("Accept", "application/json")
            .query(&[("q", query)])
            .send()
            .map_err(|error| format!("EPO CPC检索失败：{error}"))?;
        return epo_result_text(response, "EPO CPC检索");
    }
    let reference_type = safe_epo_segment(argument_string(arguments, "type", "publication"), "type")?;
    let format = safe_epo_segment(argument_string(arguments, "format", "epodoc"), "format")?;
    let number = safe_epo_segment(argument_string(arguments, "number", ""), "number")?;
    let path = match tool_name {
        "ops_get_biblio" => format!("/published-data/{reference_type}/{format}/{number}/biblio"),
        "ops_get_abstract" => format!("/published-data/{reference_type}/{format}/{number}/abstract"),
        "ops_get_fulltext" => {
            let part = safe_epo_segment(argument_string(arguments, "part", "claims"), "part")?;
            if !matches!(part.as_str(), "description" | "claims") {
                return Err("ops_get_fulltext的part必须是description或claims。".to_string());
            }
            format!("/published-data/{reference_type}/{format}/{number}/{part}")
        }
        "ops_get_family" => {
            let constituents = argument_string(arguments, "constituents", "");
            let suffix = if matches!(constituents, "biblio" | "legal") { format!("/{constituents}") } else { String::new() };
            format!("/family/{reference_type}/{format}/{number}{suffix}")
        }
        "ops_get_equivalents" => format!("/published-data/{reference_type}/{format}/{number}/equivalents"),
        "ops_convert_number" => {
            let input_format = safe_epo_segment(argument_string(arguments, "input_format", "original"), "input_format")?;
            let output_format = safe_epo_segment(argument_string(arguments, "output_format", "epodoc"), "output_format")?;
            format!("/number-service/{reference_type}/{input_format}/{number}/{output_format}")
        }
        _ => return Err(format!("不支持的EPO检索工具：{tool_name}")),
    };
    let response = client
        .get(format!("{}{}", base_url.trim_end_matches('/'), path))
        .bearer_auth(&token)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| format!("EPO工具{tool_name}调用失败：{error}"))?;
    epo_result_text(response, tool_name)
}

fn execute_zhipu_tool(payload: &RetrievalToolCallPayload) -> Result<String, String> {
    if payload.tool_name != "web_search" {
        return Err("智谱检索只提供web_search工具。".to_string());
    }
    let query = argument_string(&payload.arguments, "query", "");
    if query.is_empty() {
        return Err("web_search缺少query参数。".to_string());
    }
    let count = payload.arguments.get("count")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(payload.count)
        .clamp(1, 50);
    let endpoint = validated_external_url(&payload.endpoint)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("无法初始化智谱搜索：{error}"))?;
    let short_query = query.chars().take(70).collect::<String>();
    let engine = if payload.search_engine.trim().is_empty() { "search_pro" } else { payload.search_engine.trim() };
    let response = client
        .post(endpoint)
        .bearer_auth(payload.api_key.trim())
        .json(&json!({
            "search_query": short_query,
            "search_engine": engine,
            "search_intent": false,
            "count": count,
            "search_recency_filter": "noLimit",
            "content_size": "high"
        }))
        .send()
        .map_err(|error| format!("智谱搜索请求失败：{error}"))?;
    epo_result_text(response, "智谱Web Search")
}

fn execute_mcp_tool(payload: &RetrievalToolCallPayload) -> Result<String, String> {
    let custom_headers = parse_mcp_headers(&payload.headers_json)?;
    let (client, session_id, tools) = connect_mcp(&payload.endpoint, &payload.api_key, &payload.headers_json)?;
    let selected = tools.iter()
        .find(|tool| tool.name == payload.tool_name)
        .ok_or_else(|| format!("MCP服务器未提供工具{}。", payload.tool_name))?;
    if looks_mutating_mcp_tool(selected) {
        return Err("专利检索代理不允许调用可能修改外部数据的MCP工具。".to_string());
    }
    if !payload.arguments.is_object() {
        return Err("MCP工具参数必须是JSON对象。".to_string());
    }
    let (value, _) = mcp_post(
        &client,
        &payload.endpoint,
        &payload.api_key,
        &custom_headers,
        session_id.as_deref(),
        &json!({
            "jsonrpc": "2.0",
            "id": 100,
            "method": "tools/call",
            "params": { "name": selected.name, "arguments": payload.arguments }
        }),
    )?;
    Ok(mcp_result_text(&value))
}

fn retrieval_call_tool_blocking(payload: RetrievalToolCallPayload) -> Result<RetrievalToolCallResult, String> {
    let content = match payload.provider.as_str() {
        "zhipu" => execute_zhipu_tool(&payload)?,
        "epo-ops" => execute_epo_tool(&payload)?,
        "patsnap-mcp" | "custom-mcp" => execute_mcp_tool(&payload)?,
        _ => return Err("不支持的检索工具提供方。".to_string()),
    };
    Ok(RetrievalToolCallResult { content })
}

#[tauri::command]
async fn retrieval_call_tool(payload: RetrievalToolCallPayload) -> Result<RetrievalToolCallResult, String> {
    tauri::async_runtime::spawn_blocking(move || retrieval_call_tool_blocking(payload))
        .await
        .map_err(|error| format!("检索工具后台任务异常结束：{error}"))?
}

fn replace_query_placeholder(value: &mut Value, query: &str) {
    match value {
        Value::String(text) => *text = text.replace("{{query}}", query),
        Value::Array(items) => items.iter_mut().for_each(|item| replace_query_placeholder(item, query)),
        Value::Object(map) => map.values_mut().for_each(|item| replace_query_placeholder(item, query)),
        _ => {}
    }
}

fn automatic_mcp_arguments(schema: &Value, query: &str) -> Value {
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let preferred = ["query", "search_query", "q", "keywords", "keyword", "text", "prompt"];
    let selected = preferred
        .iter()
        .find_map(|name| properties.get(*name).map(|_| (*name).to_string()))
        .or_else(|| {
            properties.iter().find_map(|(name, property)| {
                let lower = name.to_ascii_lowercase();
                let looks_like_query = lower.contains("query") || lower.contains("search") || lower.contains("keyword");
                (looks_like_query && property.get("type").and_then(Value::as_str).unwrap_or("string") == "string")
                    .then(|| name.clone())
            })
        })
        .or_else(|| {
            schema.get("required").and_then(Value::as_array).and_then(|required| {
                required.iter().filter_map(Value::as_str).find_map(|name| {
                    let property = properties.get(name)?;
                    (property.get("type").and_then(Value::as_str).unwrap_or("string") == "string")
                        .then(|| name.to_string())
                })
            })
        });
    selected
        .map(|name| {
            let mut arguments = serde_json::Map::new();
            arguments.insert(name, Value::String(query.to_string()));
            Value::Object(arguments)
        })
        .unwrap_or_else(|| json!({ "query": query }))
}

fn mcp_arguments(template: &str, schema: &Value, query: &str) -> Result<Value, String> {
    if template.trim().is_empty() {
        return Ok(automatic_mcp_arguments(schema, query));
    }
    let mut value = serde_json::from_str::<Value>(template)
        .map_err(|error| format!("MCP参数模板不是合法JSON：{error}"))?;
    if !value.is_object() {
        return Err("MCP参数模板必须是JSON对象。".to_string());
    }
    replace_query_placeholder(&mut value, query);
    Ok(value)
}

fn mcp_result_text(value: &Value) -> String {
    let content = value.pointer("/result/content").and_then(Value::as_array);
    if let Some(content) = content {
        let text = content
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            return text;
        }
    }
    value.get("result").cloned().unwrap_or_else(|| value.clone()).to_string()
}

fn execute_mcp_retrieval(payload: &RetrievalExecutePayload) -> Result<String, String> {
    let custom_headers = parse_mcp_headers(&payload.headers_json)?;
    let (client, session_id, tools) = connect_mcp(&payload.endpoint, &payload.api_key, &payload.headers_json)?;
    let selected = tools
        .iter()
        .find(|tool| tool.name == payload.tool_name)
        .or_else(|| tools.first())
        .ok_or_else(|| "MCP服务器没有可用工具。".to_string())?;
    let mut output = Vec::new();
    for (index, query) in payload.queries.iter().take(8).enumerate() {
        let arguments = mcp_arguments(&payload.argument_template, &selected.input_schema, query)?;
        let (value, _) = mcp_post(
            &client,
            &payload.endpoint,
            &payload.api_key,
            &custom_headers,
            session_id.as_deref(),
            &json!({
                "jsonrpc": "2.0",
                "id": 100 + index,
                "method": "tools/call",
                "params": { "name": selected.name, "arguments": arguments }
            }),
        )?;
        output.push(format!("【MCP查询：{}】\n{}", query, mcp_result_text(&value)));
    }
    Ok(output.join("\n\n"))
}

fn execute_zhipu_retrieval(payload: &RetrievalExecutePayload) -> Result<String, String> {
    if payload.api_key.trim().is_empty() {
        return Err("请先填写智谱API Key。".to_string());
    }
    let endpoint = validated_external_url(&payload.endpoint)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("无法初始化智谱搜索：{error}"))?;
    let engine = if payload.search_engine.trim().is_empty() { "search_pro" } else { payload.search_engine.trim() };
    let count = payload.count.clamp(1, 50);
    let mut output = Vec::new();
    for query in payload.queries.iter().take(8) {
        let short_query = query.chars().take(70).collect::<String>();
        let response = client
            .post(endpoint)
            .bearer_auth(payload.api_key.trim())
            .json(&json!({
                "search_query": short_query,
                "search_engine": engine,
                "search_intent": false,
                "count": count,
                "search_recency_filter": "noLimit",
                "content_size": "high"
            }))
            .send()
            .map_err(|error| format!("智谱搜索请求失败：{error}"))?;
        let body = cloud_response_json(response, "智谱 Web Search")?;
        let results = body.get("search_result").and_then(Value::as_array).cloned().unwrap_or_default();
        let formatted = results
            .iter()
            .map(|item| {
                format!(
                    "- {} | {} | {}\n  {}\n  {}",
                    item.get("title").and_then(Value::as_str).unwrap_or("无标题"),
                    item.get("media").and_then(Value::as_str).unwrap_or("未知来源"),
                    item.get("publish_date").and_then(Value::as_str).unwrap_or("日期未知"),
                    item.get("link").and_then(Value::as_str).unwrap_or(""),
                    item.get("content").and_then(Value::as_str).unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        output.push(format!("【智谱查询：{}】\n{}", short_query, formatted));
    }
    Ok(output.join("\n\n"))
}

fn execute_epo_retrieval(payload: &RetrievalExecutePayload) -> Result<String, String> {
    if payload.api_key.trim().is_empty() || payload.client_secret.trim().is_empty() {
        return Err("请填写EPO OPS Consumer Key和Consumer Secret。".to_string());
    }
    let base_url = validated_external_url(&payload.endpoint)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("无法初始化EPO OPS连接：{error}"))?;
    let auth_response = client
        .post("https://ops.epo.org/3.2/auth/accesstoken")
        .basic_auth(payload.api_key.trim(), Some(payload.client_secret.trim()))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .map_err(|error| format!("EPO OPS认证失败：{error}"))?;
    let auth = cloud_response_json(auth_response, "EPO OPS认证")?;
    let token = auth
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "EPO OPS认证响应中没有access_token。".to_string())?;
    let count = payload.count.clamp(1, 100);
    let search_url = format!("{}/published-data/search", base_url.trim_end_matches('/'));
    let range = format!("1-{count}");
    let mut output = Vec::new();
    for query in payload.queries.iter().take(8) {
        let response = client
            .get(&search_url)
            .bearer_auth(token)
            .header("Accept", "application/json")
            .query(&[("q", query.as_str()), ("Range", range.as_str())])
            .send()
            .map_err(|error| format!("EPO OPS检索失败：{error}"))?;
        let body = cloud_response_json(response, "EPO OPS")?;
        let mut serialized = serde_json::to_string_pretty(&body)
            .map_err(|error| format!("无法整理EPO OPS结果：{error}"))?;
        if serialized.len() > 180_000 {
            serialized.truncate(180_000);
            serialized.push_str("\n[结果过长，已截断]");
        }
        output.push(format!("【EPO OPS CQL：{}】\n{}", query, serialized));
    }
    Ok(output.join("\n\n"))
}

fn retrieval_execute_blocking(payload: RetrievalExecutePayload) -> Result<RetrievalExecuteResult, String> {
    if payload.queries.is_empty() {
        return Err("没有可执行的检索词。".to_string());
    }
    let content = match payload.provider.as_str() {
        "zhipu" => execute_zhipu_retrieval(&payload)?,
        "epo-ops" => execute_epo_retrieval(&payload)?,
        "patsnap-mcp" | "custom-mcp" => execute_mcp_retrieval(&payload)?,
        _ => return Err("不支持的联网检索服务商。".to_string()),
    };
    if content.trim().is_empty() {
        return Err("检索服务未返回可供审查的内容。".to_string());
    }
    Ok(RetrievalExecuteResult { content })
}

#[tauri::command]
async fn retrieval_execute(payload: RetrievalExecutePayload) -> Result<RetrievalExecuteResult, String> {
    tauri::async_runtime::spawn_blocking(move || retrieval_execute_blocking(payload))
        .await
        .map_err(|error| format!("联网检索后台任务异常结束：{error}"))?
}

#[tauri::command]
fn save_revision(
    original_path: String,
    annotations: Vec<AnnotationPayload>,
    ratings: Option<RatingPayload>,
    llm_report: Option<LlmReviewReportPayload>,
) -> Result<SaveRevisionResult, String> {
    let original = PathBuf::from(original_path);
    if !original.is_file() {
        return Err("原文件不存在，无法生成修订版。".to_string());
    }
    let destination = next_revision_path(&original);
    let is_docx = original.extension().and_then(|value| value.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("docx"));
    let is_pdf = original.extension().and_then(|value| value.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    if is_docx && !annotations.is_empty() {
        write_docx_revision(&original, &destination, &annotations)?;
    } else if is_pdf && !annotations.is_empty() {
        write_pdf_revision(&original, &destination, &annotations)?;
    } else {
        fs::copy(&original, &destination).map_err(|error| format!("无法生成修订版：{error}"))?;
    }
    let rating_path = ratings
        .as_ref()
        .filter(|value| {
            !value.technical_understanding.trim().is_empty()
                || !value.communication.trim().is_empty()
                || !value.patent_quality.trim().is_empty()
        })
        .map(|value| {
            let path = rating_workbook_path(&destination);
            let case_name = original.file_name().and_then(|value| value.to_str()).unwrap_or("专利文件");
            write_rating_workbook(&path, case_name, &value)?;
            Ok::<String, String>(path.to_string_lossy().into_owned())
        })
        .transpose()?;
    let review_path = llm_report
        .filter(|value| !value.findings.is_empty())
        .map(|value| {
            let path = review_workbook_path(&original);
            let case_name = original.file_name().and_then(|value| value.to_str()).unwrap_or("专利文件");
            write_review_workbook(&path, case_name, ratings.as_ref(), &value)?;
            Ok::<String, String>(path.to_string_lossy().into_owned())
        })
        .transpose()?;
    Ok(SaveRevisionResult {
        revision_path: destination.to_string_lossy().into_owned(),
        rating_path,
        review_path,
    })
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_document,
            open_comparison_documents,
            save_revision,
            cloud_ocr,
            llm_completion,
            llm_list_models,
            llm_agent_turn,
            mcp_list_tools,
            retrieval_list_tools,
            retrieval_call_tool,
            retrieval_execute,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("启动专利阅研失败");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_and_sorts_openai_compatible_model_lists() {
        let models = parse_llm_model_ids(&json!({
            "data": [
                { "id": "deepseek-v4-pro" },
                { "id": "deepseek-v4-flash" },
                { "id": "deepseek-v4-pro" }
            ]
        }));
        assert_eq!(models, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);
    }

    #[test]
    fn parses_native_llm_tool_calls_for_the_research_agent() {
        let calls = parse_agent_tool_calls(&json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {
                    "name": "ops_search",
                    "arguments": "{\"query\":\"ti=bellows AND ab=valve\"}"
                }
            }]
        })).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "ops_search");
        assert_eq!(calls[0].arguments["query"], "ti=bellows AND ab=valve");
    }

    #[test]
    fn exposes_search_and_detail_tools_for_iterative_epo_research() {
        let tools = epo_research_tools();
        let names = tools.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>();
        assert!(names.contains(&"ops_search"));
        assert!(names.contains(&"ops_get_abstract"));
        assert!(names.contains(&"ops_get_fulltext"));
        assert!(names.contains(&"ops_get_family"));
        assert!(looks_mutating_mcp_tool(&research_tool(
            "delete_document",
            "Delete a document",
            json!({ "type": "object" }),
        )));
    }

    #[test]
    fn cloud_ocr_rejects_non_image_payloads_before_network_access() {
        let error = cloud_ocr_blocking(CloudOcrPayload {
            provider: "ocr-space".to_string(),
            image_data_url: "data:application/pdf;base64,AAAA".to_string(),
            image_width: 100.0,
            image_height: 100.0,
            api_key: "test-key".to_string(),
            endpoint: String::new(),
            model: String::new(),
            interface_name: String::new(),
        }).unwrap_err();
        assert!(error.contains("只允许上传附图"));
    }

    #[test]
    fn external_links_allow_https_and_reject_remote_http() {
        assert_eq!(
            validated_external_url("https://ocr.space/ocrapi/freekey").unwrap(),
            "https://ocr.space/ocrapi/freekey"
        );
        assert!(validated_external_url("http://example.com/key").is_err());
    }

    #[test]
    fn parses_paddle_and_custom_word_coordinates() {
        let payload = CloudOcrPayload {
            provider: "paddle-ocr".to_string(),
            image_data_url: "data:image/png;base64,AA==".to_string(),
            image_width: 1000.0,
            image_height: 500.0,
            api_key: "test-key".to_string(),
            endpoint: String::new(),
            model: "PP-OCRv6".to_string(),
            interface_name: String::new(),
        };
        let paddle = json!({
            "rec_texts": ["122"],
            "rec_boxes": [[100, 50, 200, 100]],
            "rec_scores": [0.92]
        });
        let words = paddle_words_from_result(&paddle, &payload);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "122");
        assert_eq!(words[0].left, 10.0);
        assert_eq!(words[0].top, 10.0);
        assert_eq!(words[0].confidence, 92.0);

        let custom = parse_custom_words(&json!({
            "words": [{
                "text": "221",
                "left": 12.5,
                "top": 25.0,
                "width": 8.0,
                "height": 4.0,
                "confidence": 88.0
            }]
        }));
        assert_eq!(custom.len(), 1);
        assert_eq!(custom[0].text, "221");
        assert_eq!(custom[0].left, 12.5);
    }

    #[test]
    fn writes_rating_workbook_in_the_requested_layout() {
        let requested_path = std::env::var_os("PATENT_READER_RATING_PROBE").map(PathBuf::from);
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = requested_path
            .as_ref()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| std::env::temp_dir().join(format!("patent-reader-rating-{unique}")));
        fs::create_dir_all(&directory).unwrap();
        let path = requested_path
            .clone()
            .unwrap_or_else(|| directory.join("示例专利-修订版-评分表.xlsx"));
        write_rating_workbook(
            &path,
            "示例专利.docx",
            &RatingPayload {
                technical_understanding: "A".to_string(),
                communication: "B".to_string(),
                patent_quality: "C".to_string(),
            },
        ).unwrap();

        let mut archive = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let mut shared_strings = String::new();
        archive.by_name("xl/sharedStrings.xml").unwrap().read_to_string(&mut shared_strings).unwrap();
        assert!(shared_strings.contains("案件"));
        assert!(shared_strings.contains("技术理解评级"));
        assert!(shared_strings.contains("沟通评级"));
        assert!(shared_strings.contains("专利质量评级"));
        assert!(shared_strings.contains("示例专利.docx"));
        assert!(shared_strings.contains(">A<"));
        assert!(shared_strings.contains(">B<"));
        assert!(shared_strings.contains(">C<"));
        if requested_path.is_none() {
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn writes_llm_review_workbook_with_findings_and_audit_metadata() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("patent-reader-llm-report-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("示例专利-LLM审查报告.xlsx");
        let report = LlmReviewReportPayload {
            technical_field: "太阳能电池".to_string(),
            rulebook_version: "1.0.1".to_string(),
            rulebook_verified_at: "2026-07-30".to_string(),
            provider: "OpenAI".to_string(),
            model: "gpt-5.6-terra".to_string(),
            generated_at: "2026-07-30T10:00:00+08:00".to_string(),
            findings: vec![LlmReviewFindingPayload {
                module: "清楚性、支持性及形式缺陷".to_string(),
                severity: "重要".to_string(),
                evidence_level: "规则库核验".to_string(),
                title: "术语前后不一致".to_string(),
                location: "权利要求1".to_string(),
                quote: "所述封装层".to_string(),
                analysis: "说明书中使用封装胶膜，名称不一致。".to_string(),
                recommendation: "统一术语并核对保护范围。".to_string(),
                sources: "专利审查指南：https://www.cnipa.gov.cn/".to_string(),
                accepted: true,
            }],
        };
        let ratings = RatingPayload {
            technical_understanding: "A".to_string(),
            communication: "B".to_string(),
            patent_quality: "C".to_string(),
        };
        write_review_workbook(&path, "示例专利.docx", Some(&ratings), &report).unwrap();

        let mut archive = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let mut shared_strings = String::new();
        archive.by_name("xl/sharedStrings.xml").unwrap().read_to_string(&mut shared_strings).unwrap();
        assert!(shared_strings.contains("序号"));
        assert!(shared_strings.contains("术语前后不一致"));
        assert!(shared_strings.contains("规则库核验"));
        assert!(shared_strings.contains("太阳能电池"));
        assert!(shared_strings.contains("1.0.1"));
        assert!(shared_strings.contains("已采纳"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn converts_vector_docx_figures_to_browser_readable_png() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../example/2025-0917719CN-【专利初稿】2025-0917719CN-一种减小EPD机台舟间钝化差异的新工装布局方案.docx");
        let original = fs::read(fixture).unwrap();
        let preview = prepare_docx_for_preview(&original).unwrap();
        let mut archive = ZipArchive::new(std::io::Cursor::new(preview)).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();

        assert!(!names.iter().any(|name| {
            name.starts_with("word/media/")
                && (name.to_ascii_lowercase().ends_with(".emf")
                    || name.to_ascii_lowercase().ends_with(".wmf"))
        }));
        let png_names = names.iter()
            .filter(|name| name.starts_with("word/media/") && name.ends_with(".png"))
            .collect::<Vec<_>>();
        assert_eq!(png_names.len(), 10);
        for name in png_names {
            let mut image = Vec::new();
            archive.by_name(name).unwrap().read_to_end(&mut image).unwrap();
            assert_eq!(&image[..8], b"\x89PNG\r\n\x1a\n");
        }
    }

    fn create_minimal_docx(path: &Path) {
        let output = File::create(path).unwrap();
        let mut writer = ZipWriter::new(output);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let files = [
            ("[Content_Types].xml", "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"),
            ("word/_rels/document.xml.rels", "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>"),
            ("word/document.xml", "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>前缀文字。选中的一句话。后缀文字。</w:t></w:r></w:p><w:sectPr/></w:body></w:document>"),
        ];
        for (name, contents) in files {
            writer.start_file(name, options).unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    fn create_minimal_pdf(path: &Path) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        document.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }));
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.save(path).unwrap();
    }

    #[test]
    fn writes_annotation_as_a_native_docx_comment() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("patent-reader-comment-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        let original = directory.join("source.docx");
        let revised = directory.join("source-修订版.docx");
        create_minimal_docx(&original);

        write_docx_revision(&original, &revised, &[AnnotationPayload {
            annotation_type: "缺乏支持".to_string(),
            severity: "一般".to_string(),
            status: "待处理".to_string(),
            author: "李明".to_string(),
            body: "请补充阀座的支持依据".to_string(),
            location: "原文：选中的一句话。".to_string(),
            selected_text: Some("选中的一句话。".to_string()),
            selection_anchor: None,
        }]).unwrap();

        let mut archive = ZipArchive::new(File::open(&revised).unwrap()).unwrap();
        let mut comments = String::new();
        archive.by_name("word/comments.xml").unwrap().read_to_string(&mut comments).unwrap();
        let mut document = String::new();
        archive.by_name("word/document.xml").unwrap().read_to_string(&mut document).unwrap();
        assert!(comments.contains("请补充阀座的支持依据"));
        assert!(comments.contains("w:author=\"李明\""));
        assert!(document.contains("w:commentRangeStart"));
        assert!(document.contains("w:commentReference"));
        assert!(document.contains("<w:t>前缀文字。</w:t></w:r><w:commentRangeStart"));
        assert!(document.contains("<w:commentRangeStart w:id=\"0\"/><w:r><w:t>选中的一句话。</w:t></w:r><w:commentRangeEnd"));
        assert!(document.contains("w:commentReference w:id=\"0\"/></w:r><w:r><w:t>后缀文字。"));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn anchors_a_cross_paragraph_selection_at_its_actual_start_and_end() {
        let mut document = "<w:document><w:body><w:p><w:r><w:t>前缀文字。需求。</w:t></w:r></w:p><w:p><w:r><w:t>可选地，为保证可靠性。后缀文字。</w:t></w:r></w:p></w:body></w:document>".to_string();
        inject_comment_anchor(&mut document, 7, None, Some("需求。\n可选地，为保证可靠性。")).unwrap();

        assert!(document.contains("<w:t>前缀文字。</w:t></w:r><w:commentRangeStart w:id=\"7\"/><w:r><w:t>需求。"));
        assert!(document.contains("<w:t>可选地，为保证可靠性。</w:t></w:r><w:commentRangeEnd w:id=\"7\"/><w:r><w:commentReference w:id=\"7\"/></w:r><w:r><w:t>后缀文字。"));
    }

    #[test]
    fn uses_browser_selection_offsets_for_an_inner_sentence() {
        let paragraph = "前缀文字。出口12围合的阴影范围内。这意味着阀头221在任何轴向位置均与出口12保持同轴配合，阀头221不会偏出出口12之外，后缀文字。";
        let selected = "12围合的阴影范围内。这意味着阀头221在任何轴向位置均与出口12保持同轴配合，阀头221不会偏出出口12之外，";
        let start_byte = paragraph.find(selected).unwrap();
        let start_offset = paragraph[..start_byte].chars().count();
        let end_offset = start_offset + selected.chars().count();
        let mut document = format!("<w:document><w:body><w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p></w:body></w:document>");
        let anchor = SelectionAnchorPayload {
            start_paragraph_text: paragraph.to_string(),
            start_offset,
            end_paragraph_text: paragraph.to_string(),
            end_offset,
            pdf_rects: Vec::new(),
        };

        inject_comment_anchor(&mut document, 8, Some(&anchor), Some(selected)).unwrap();

        assert!(document.contains("<w:t>前缀文字。出口</w:t></w:r><w:commentRangeStart w:id=\"8\"/><w:r><w:t>12围合的阴影范围内。"));
        assert!(document.contains("阀头221不会偏出出口12之外，</w:t></w:r><w:commentRangeEnd w:id=\"8\"/><w:r><w:commentReference w:id=\"8\"/></w:r><w:r><w:t>后缀文字。"));
    }

    #[test]
    fn parses_streamable_http_mcp_sse_payloads() {
        let value = parse_mcp_wire_json(
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n\n",
        ).unwrap();
        assert_eq!(value["result"]["tools"], json!([]));
    }

    #[test]
    fn reads_mcp_tool_metadata_and_builds_query_arguments() {
        let response = json!({
            "result": {
                "tools": [{
                    "name": "search_patents",
                    "description": "检索专利",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "query": { "type": "string" } },
                        "required": ["query"]
                    }
                }]
            }
        });
        let tools = parse_mcp_tools(&response);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "search_patents");
        assert_eq!(
            mcp_arguments("", &tools[0].input_schema, "solar cell").unwrap(),
            json!({ "query": "solar cell" }),
        );
        assert_eq!(
            mcp_arguments(
                r#"{"search_expression":"{{query}}","limit":20}"#,
                &tools[0].input_schema,
                "pn=CN123",
            ).unwrap(),
            json!({ "search_expression": "pn=CN123", "limit": 20 }),
        );
        let headers = parse_mcp_headers(r#"{"X-API-Key":"secret","X-Tenant":"patent"}"#).unwrap();
        assert_eq!(headers.get("x-tenant").unwrap(), "patent");
        assert!(parse_mcp_headers(r#"{"Content-Length":"12"}"#).is_err());
    }

    #[test]
    fn writes_pdf_selection_as_a_native_highlight_annotation() {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("patent-reader-pdf-test-{timestamp}"));
        fs::create_dir_all(&directory).unwrap();
        let original = directory.join("original.pdf");
        let revision = directory.join("revision.pdf");
        create_minimal_pdf(&original);
        let annotations = vec![AnnotationPayload {
            annotation_type: "图文不一致".to_string(),
            severity: "一般".to_string(),
            status: "待处理".to_string(),
            author: "测试人".to_string(),
            body: "需要核对附图标号。".to_string(),
            location: "PDF 第 1 页".to_string(),
            selected_text: Some("测试选区".to_string()),
            selection_anchor: Some(SelectionAnchorPayload {
                start_paragraph_text: String::new(),
                start_offset: 0,
                end_paragraph_text: String::new(),
                end_offset: 0,
                pdf_rects: vec![PdfRectPayload {
                    page_number: 1,
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.04,
                }],
            }),
        }];

        write_pdf_revision(&original, &revision, &annotations).unwrap();

        let document = Document::load(&revision).unwrap();
        let page_id = *document.get_pages().get(&1).unwrap();
        let annotations = document.get_page_annotations(page_id).unwrap();
        assert_eq!(annotations.len(), 1);
        assert_eq!(annotations[0].get(b"Subtype").unwrap().as_name().unwrap(), b"Highlight");
        assert!(annotations[0].get(b"QuadPoints").unwrap().as_array().unwrap().len() >= 8);
        fs::remove_dir_all(directory).unwrap();
    }
}
