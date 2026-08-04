use reqwest::Client;
use std::path::Path;
use std::time::Duration;

/// Fetches a web URL and converts its readable HTML content into clean Markdown.
/// If `max_limit` is `Some(limit)` and `limit > 0`, content is capped at `limit` characters.
/// If `max_limit` is `None` or `Some(0)`, the full document is returned untruncated.
pub async fn fetch_url_markdown(url: &str, max_limit: Option<usize>) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL '{}': {}", url, e))?;

    if !res.status().is_success() {
        return Err(format!("Web request returned HTTP status {}", res.status()));
    }

    let html = res
        .text()
        .await
        .map_err(|e| format!("Failed to read HTML body: {}", e))?;

    let markdown = html_to_markdown(&html);
    
    if let Some(limit) = max_limit {
        if limit > 0 && markdown.len() > limit {
            return Ok(format!(
                "{}...\n\n[Content truncated at {} characters. You can change or disable this limit in Settings]",
                &markdown[..limit],
                limit
            ));
        }
    }

    Ok(markdown)
}

/// Simple regex-free HTML-to-Markdown noise stripper.
fn html_to_markdown(html: &str) -> String {
    let mut text = html.to_string();

    // 1. Remove script and style blocks
    while let Some(start) = text.find("<script") {
        if let Some(end) = text[start..].find("</script>") {
            text.replace_range(start..start + end + 9, "");
        } else {
            break;
        }
    }

    while let Some(start) = text.find("<style") {
        if let Some(end) = text[start..].find("</style>") {
            text.replace_range(start..start + end + 8, "");
        } else {
            break;
        }
    }

    // 2. Convert common HTML tags to Markdown equivalents
    text = text.replace("<h1>", "\n# ")
               .replace("</h1>", "\n")
               .replace("<h2>", "\n## ")
               .replace("</h2>", "\n")
               .replace("<h3>", "\n### ")
               .replace("</h3>", "\n")
               .replace("<p>", "\n")
               .replace("</p>", "\n")
               .replace("<br>", "\n")
               .replace("<br/>", "\n")
               .replace("<br />", "\n")
               .replace("<code>", "`")
               .replace("</code>", "`")
               .replace("<pre>", "\n```\n")
               .replace("</pre>", "\n```\n")
               .replace("<li>", "\n- ")
               .replace("</li>", "");

    // 3. Strip all remaining HTML tags
    let mut in_tag = false;
    let mut clean_buf = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            clean_buf.push(ch);
        }
    }

    // 4. Normalize multiple blank lines
    let lines: Vec<&str> = clean_buf
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    lines.join("\n")
}

/// Reads a local text file from disk safely.
/// If `max_limit` is `Some(limit)` and `limit > 0`, content is capped at `limit` characters.
/// If `max_limit` is `None` or `Some(0)`, the full file is returned untruncated.
pub async fn read_file_content(path_str: &str, max_limit: Option<usize>) -> Result<String, String> {
    let clean_path = path_str.trim().trim_matches('"').trim_matches('\'');
    let path = Path::new(clean_path);

    if !path.exists() {
        return Err(format!("File does not exist: {}", clean_path));
    }

    if !path.is_file() {
        return Err(format!("Path is a directory, not a file: {}", clean_path));
    }

    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", clean_path, e))?;

    if let Some(limit) = max_limit {
        if limit > 0 && content.len() > limit {
            return Ok(format!(
                "```\n{}...\n[File truncated at {} characters. You can change or disable this limit in Settings]\n```",
                &content[..limit],
                limit
            ));
        }
    }

    Ok(format!("```\n{}\n```", content))
}
