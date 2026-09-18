//! Рендер .md-файлов в HTML для показа в sandboxed iframe — тем же путём,
//! которым уже показываются .html file card'ы (см. `lib.rs::register_uri_scheme_protocol`).
//! Т.к. iframe всегда открыт с `sandbox=""` (без `allow-scripts`), встроенный в
//! markdown raw HTML безопасен ровно настолько же, насколько уже безопасны сами
//! .html file card'ы — скрипты не выполнятся в любом случае.

use std::fs;
use std::io::Read;
use std::path::Path;

/// Верхняя граница на чтение markdown-файла перед рендером: рендер происходит
/// на каждый запрос протокола (не при коммите карточки), поэтому файл целиком
/// не аллоцируется сверх этого лимита — защита от патологически больших файлов.
pub const MARKDOWN_RENDER_LIMIT: usize = 1024 * 1024; // 1 MiB

/// Читает файл ограниченным `take()` (без аллокации всего файла) и рендерит
/// его в HTML-документ со стилями Quiet Desk. Бинарный/невалидный UTF-8 контент
/// не приводит к ошибке — теряются только некорректные байты (lossy).
pub fn render_markdown_file(path: &Path, limit: usize) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take((limit as u64).saturating_add(1))
        .read_to_end(&mut buffer)
        .ok()?;
    buffer.truncate(limit.min(buffer.len()));
    let source = String::from_utf8_lossy(&buffer);
    Some(render_markdown_to_document(&source))
}

/// Конвертирует markdown в тело `<body>` через pulldown-cmark (GFM-таблицы,
/// зачёркивание, чек-листы) и оборачивает в HTML-документ с инлайн-стилями.
pub fn render_markdown_to_document(source: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);

    let parser = Parser::new_ext(source, options);
    let mut body = String::new();
    html::push_html(&mut body, parser);

    format!(
        "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">\n<style>{}</style>\n</head><body>\n{}\n</body></html>",
        MARKDOWN_PREVIEW_CSS, body
    )
}

/// Стили под Quiet Desk. Iframe — отдельный документ, CSS-переменные родителя
/// в него не пробрасываются, поэтому значения токенов продублированы буквально
/// (светлая + `prefers-color-scheme: dark` тема, см. `src/styles/tokens.css`).
const MARKDOWN_PREVIEW_CSS: &str = r#"
:root { color-scheme: light dark; }
body {
  margin: 0;
  padding: 10px 12px;
  font: 400 13px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  color: #252927;
  background: #ffffff;
}
h1, h2, h3, h4, h5, h6 {
  margin: 0.9em 0 0.4em;
  line-height: 1.25;
  font-weight: 600;
  color: #252927;
}
h1 { font-size: 1.5em; }
h2 { font-size: 1.28em; }
h3 { font-size: 1.12em; }
p, ul, ol, blockquote, table { margin: 0.5em 0; max-width: 68em; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.15em 0; }
a { color: #2563eb; }
strong { font-weight: 600; }
em { font-style: italic; }
code {
  font: 400 0.92em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: rgba(54, 63, 58, 0.08);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
pre {
  background: rgba(54, 63, 58, 0.06);
  padding: 10px 12px;
  border-radius: 6px;
  overflow: auto;
}
pre code { background: none; padding: 0; }
blockquote {
  margin-left: 0;
  padding: 0.2em 0.9em;
  border-left: 3px solid rgba(54, 63, 58, 0.2);
  color: #5f6763;
}
table { border-collapse: collapse; width: 100%; overflow-wrap: anywhere; }
th, td {
  border: 1px solid rgba(54, 63, 58, 0.2);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}
th { background: rgba(54, 63, 58, 0.06); font-weight: 600; }
hr { border: none; border-top: 1px solid rgba(54, 63, 58, 0.2); margin: 1em 0; }
img { max-width: 100%; }
@media (prefers-color-scheme: dark) {
  body { color: #eef0ee; background: #242923; }
  h1, h2, h3, h4, h5, h6 { color: #eef0ee; }
  a { color: #60a5fa; }
  code { background: rgba(255, 255, 255, 0.1); }
  pre { background: rgba(255, 255, 255, 0.08); }
  blockquote { border-left-color: rgba(255, 255, 255, 0.14); color: #c8ceca; }
  th, td { border-color: rgba(255, 255, 255, 0.14); }
  th { background: rgba(255, 255, 255, 0.08); }
  hr { border-top-color: rgba(255, 255, 255, 0.14); }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_headings_and_paragraphs() {
        let html = render_markdown_to_document("# Title\n\nSome text.");
        assert!(html.contains("<h1>Title</h1>"));
        assert!(html.contains("<p>Some text.</p>"));
    }

    #[test]
    fn renders_gfm_table() {
        let md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
        let html = render_markdown_to_document(md);
        assert!(html.contains("<table>"));
        assert!(html.contains("<th>A</th>"));
        assert!(html.contains("<td>1</td>"));
        // сырой markdown-синтаксис таблицы не должен просачиваться в текст
        assert!(!html.contains("| A | B |"));
    }

    #[test]
    fn renders_list_bold_and_code() {
        let md = "- **bold** item\n- `inline code`\n";
        let html = render_markdown_to_document(md);
        assert!(html.contains("<ul>"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<code>inline code</code>"));
    }

    #[test]
    fn renders_blockquote_and_link() {
        let md = "> quoted\n\n[text](https://example.com)";
        let html = render_markdown_to_document(md);
        assert!(html.contains("<blockquote>"));
        assert!(html.contains("<a href=\"https://example.com\">text</a>"));
    }

    #[test]
    fn bounded_read_truncates_large_file() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("myspace-md-test-{}-{}", std::process::id(), unique));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.md");
        // Маркер, которого точно нет в CSS-обвязке рендера — считаем именно
        // его вхождения, а не общую длину вывода (HTML+CSS обвязка сама по
        // себе длиннее лимита чтения исходника).
        let big = "ZZZ ".repeat(500); // 2000 байт
        std::fs::write(&path, &big).unwrap();

        let rendered = render_markdown_file(&path, 100).expect("renders");
        let marker_count = rendered.matches("ZZZ").count();
        assert!(
            marker_count <= 26, // 100 байт лимита / 4 байта на "ZZZ " (с запасом)
            "expected only a bounded prefix of the source to be read, got {marker_count} markers"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
