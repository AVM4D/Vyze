use reqwest::Client;
use std::path::Path;
use std::time::Duration;

/// Fetches a web URL and converts its readable HTML content into clean Markdown.
pub async fn fetch_url_markdown(url: &str) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
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
    
    // Limit to max 12,000 characters to protect AI token limits
    if markdown.len() > 12000 {
        Ok(format!("{}...\n\n[Content truncated at 12,000 characters]", &markdown[..12000]))
    } else {
        Ok(markdown)
    }
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
pub async fn read_file_content(path_str: &str) -> Result<String, String> {
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

    // Limit to max 15,000 characters
    if content.len() > 15000 {
        Ok(format!("```\n{}...\n[File truncated at 15,000 characters]\n```", &content[..15000]))
    } else {
        Ok(format!("```\n{}\n```", content))
    }
}
