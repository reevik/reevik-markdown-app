use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
/// Used for the HTTP API when the user hasn't chosen a model.
const DEFAULT_MODEL: &str = "claude-sonnet-4-5-20250929";

/// The model picked in Settings. Empty/None means "let the backend decide": the
/// CLI keeps its own configured default and the API falls back to [`DEFAULT_MODEL`].
static MODEL_OVERRIDE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn set_model_override(model: Option<String>) {
    *MODEL_OVERRIDE.lock().unwrap() = model.filter(|m| !m.trim().is_empty());
}

/// The `--model` value to pass to the CLI, if the user chose one.
fn model_arg() -> Option<String> {
    MODEL_OVERRIDE.lock().unwrap().clone()
}

fn api_model() -> String {
    model_arg().unwrap_or_else(|| DEFAULT_MODEL.to_string())
}
/// How much of the note to send. Enough for long documents while staying well
/// within the model's context window.
const MAX_TEXT_CHARS: usize = 40_000;

const KEYRING_SERVICE: &str = "com.reevik.markdown-editor";
const KEYRING_USER: &str = "anthropic-api-key";

const SYSTEM_PROMPT: &str = "You are a meticulous writing editor helping improve a Markdown document. Read the document and propose concrete improvements to its clarity, structure, grammar, tone, and Markdown formatting — while preserving the author's voice and meaning. Do not invent facts.\n\nRespond with ONLY a single JSON object — no prose, no markdown fences. The JSON must have exactly these top-level keys:\n- \"quality\": an object rating the document AS IT IS NOW. Score honestly on an absolute scale where 90+ is publication-ready and 50 is a rough draft; do not flatter. Keys:\n    - \"score\": overall quality, an integer 0-100.\n    - \"verdict\": at most four words summarising that score, e.g. \"Solid, needs tightening\".\n    - \"clarity\", \"structure\", \"grammar\", \"tone\": integers 0-100 for each dimension.\n- \"summary\": a one-sentence overall assessment of the document.\n- \"suggestions\": an array of specific, INDIVIDUALLY-APPLICABLE edits. Each item is an object with these keys:\n    - \"title\": a short label for the change.\n    - \"detail\": one sentence explaining the change and why.\n    - \"original\": the exact text span, copied VERBATIM from the document, that should be replaced. It MUST appear character-for-character in the document so it can be located automatically. Keep it as short as possible while remaining unique.\n    - \"replacement\": the improved text to substitute for \"original\".\n  Each suggestion must stand on its own as a single original→replacement edit. Return between 1 and 8 items; use an empty array only if the text is already excellent.\n\nIMPORTANT: propose only LOCAL edits. Never rewrite or restate the document as a whole, and never return the full text — each \"original\" must be a short span (at most a sentence or two) that the author can accept or reject on its own.";

pub fn get_api_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .ok()?
        .get_password()
        .ok()
}

pub fn set_api_key(key: &str) -> Result<()> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?
        .set_password(key)
        .context("saving API key to OS keychain")
}

/// Locates the local `claude` CLI. Checks well-known install paths first (so it
/// still resolves when the app is launched from Finder with a minimal PATH),
/// then falls back to `which`.
pub fn find_claude_cli() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".claude/local/claude"));
        candidates.push(PathBuf::from(&home).join(".local/bin/claude"));
    }
    for c in &candidates {
        if c.exists() {
            return Some(c.clone());
        }
    }

    let out = std::process::Command::new("which").arg("claude").output().ok()?;
    if out.status.success() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    None
}

/// True when any AI backend is available (local CLI or a stored API key).
pub fn is_available() -> bool {
    find_claude_cli().is_some() || get_api_key().is_some()
}

/// A single editorial suggestion returned to the frontend.
#[derive(serde::Serialize)]
pub struct Suggestion {
    pub title: String,
    pub detail: String,
    /// Exact text span in the document to replace (for one-click apply).
    pub original: String,
    pub replacement: String,
}

/// How good the document is right now, 0-100 overall plus per-dimension scores.
#[derive(serde::Serialize)]
pub struct Quality {
    pub score: u8,
    pub verdict: String,
    pub clarity: u8,
    pub structure: u8,
    pub grammar: u8,
    pub tone: u8,
}

/// The parsed result of an AI review of a note.
#[derive(serde::Serialize)]
pub struct Review {
    /// `None` when the model omitted or malformed the rating.
    pub quality: Option<Quality>,
    pub summary: String,
    pub suggestions: Vec<Suggestion>,
}

/// Reads a 0-100 rating, clamping whatever the model produced into range.
fn score_field(v: &Value, key: &str) -> u8 {
    v.get(key)
        .and_then(|n| n.as_f64().or_else(|| n.as_str().and_then(|s| s.parse().ok())))
        .map(|n| n.round().clamp(0.0, 100.0) as u8)
        .unwrap_or(0)
}

fn build_quality(raw: &Value) -> Option<Quality> {
    let q = raw.get("quality")?;
    let score = score_field(q, "score");
    // A missing/zero overall score means the model didn't really rate it.
    if score == 0 {
        return None;
    }
    Some(Quality {
        score,
        verdict: q
            .get("verdict")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        clarity: score_field(q, "clarity"),
        structure: score_field(q, "structure"),
        grammar: score_field(q, "grammar"),
        tone: score_field(q, "tone"),
    })
}

fn build_review(raw: Value) -> Review {
    let quality = build_quality(&raw);
    let summary = raw
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let suggestions = raw
        .get("suggestions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|s| {
                    let title = s.get("title").and_then(Value::as_str)?.to_string();
                    let detail = s
                        .get("detail")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let original = s
                        .get("original")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let replacement = s
                        .get("replacement")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    Some(Suggestion {
                        title,
                        detail,
                        original,
                        replacement,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Review {
        quality,
        summary,
        suggestions,
    }
}

/// Reviews a note via the local `claude` CLI, emitting the reply to `on_progress` as it
/// is generated, so the UI can render the score and early suggestions immediately.
///
/// Both plain `-p` and `--output-format json` buffer: they write nothing until the
/// turn is complete. Only `stream-json` with `--include-partial-messages` yields
/// token-level deltas, as NDJSON events shaped like:
///   {"type":"stream_event","event":{"type":"content_block_delta",
///    "delta":{"type":"text_delta","text":"…"}}}
pub async fn suggest_via_cli_streamed<F>(cli: &Path, text: &str, mut on_progress: F) -> Result<Review>
where
    F: FnMut(&str),
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    let snippet: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let prompt = format!(
        "{SYSTEM_PROMPT}\n\n---\n\nReview the following Markdown document and return ONLY the JSON object described above.\n\nDocument:\n{snippet}"
    );

    let mut cmd = tokio::process::Command::new(cli);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        // stream-json in print mode requires --verbose; partial messages turn the
        // per-message events into per-token deltas.
        .arg("--verbose")
        .arg("--include-partial-messages");
    if let Some(m) = model_arg() {
        cmd.arg("--model").arg(m);
    }
    let mut child = cmd
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawning claude CLI")?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .context("writing prompt to claude CLI")?;
        stdin.shutdown().await.ok();
    }

    let stdout = child.stdout.take().context("claude CLI stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut acc = String::new();
    // The terminating `result` event carries the whole reply; prefer it over the
    // accumulated deltas in case any were dropped.
    let mut final_reply: Option<String> = None;

    let read_loop = async {
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue; // not an event we understand — skip it
            };
            match v.get("type").and_then(Value::as_str) {
                Some("stream_event") => {
                    let ev = v.get("event");
                    let is_delta = ev
                        .and_then(|e| e.get("type"))
                        .and_then(Value::as_str)
                        == Some("content_block_delta");
                    if is_delta {
                        if let Some(t) = ev
                            .and_then(|e| e.get("delta"))
                            .and_then(|d| d.get("text"))
                            .and_then(Value::as_str)
                        {
                            acc.push_str(t);
                            on_progress(&acc);
                        }
                    }
                }
                Some("result") => {
                    if let Some(r) = v.get("result").and_then(Value::as_str) {
                        final_reply = Some(r.to_string());
                    }
                }
                _ => {}
            }
        }
        Ok::<(), std::io::Error>(())
    };

    tokio::time::timeout(std::time::Duration::from_secs(240), read_loop)
        .await
        .context("claude CLI timed out")?
        .context("reading claude CLI output")?;

    let status = child.wait().await.context("waiting for claude CLI")?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            e.read_to_string(&mut err).await.ok();
        }
        anyhow::bail!("claude CLI exited unsuccessfully: {err}");
    }

    let reply = final_reply.unwrap_or(acc);
    let json_str = extract_json_object(&reply).context("no JSON object in claude CLI reply")?;
    let raw: Value = serde_json::from_str(json_str).context("parsing review JSON from CLI")?;
    Ok(build_review(raw))
}

/// Reviews a note via the Anthropic HTTP API using a stored API key.
pub async fn suggest_via_api(api_key: &str, text: &str) -> Result<Review> {
    let snippet: String = text.chars().take(MAX_TEXT_CHARS).collect();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .context("building HTTP client")?;

    let response = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({
            "model": api_model(),
            "max_tokens": 8192,
            "system": SYSTEM_PROMPT,
            "messages": [{
                "role": "user",
                "content": format!("Review this Markdown document:\n\n{snippet}"),
            }],
        }))
        .send()
        .await
        .context("calling Anthropic API")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Anthropic API error {status}: {body}");
    }

    let body: Value = response.json().await.context("parsing Anthropic response")?;
    let reply = body["content"][0]["text"]
        .as_str()
        .context("missing text in Anthropic response")?;

    let json_str = extract_json_object(reply).context("no JSON object in AI reply")?;
    let raw: Value = serde_json::from_str(json_str).context("parsing review JSON")?;
    Ok(build_review(raw))
}

const REPHRASE_PROMPT: &str = "You are a writing editor. Rephrase the text the user provides to improve clarity, flow, and concision while preserving its meaning, tone, and any Markdown formatting. Return ONLY the rephrased text — no preamble, quotes, or explanation.";

/// Rephrases a selection via the local `claude` CLI in plain print mode.
pub async fn rephrase_via_cli(cli: &Path, text: &str) -> Result<String> {
    let snippet: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let prompt = format!("{REPHRASE_PROMPT}\n\n---\n\nText to rephrase:\n{snippet}");

    let mut cmd = tokio::process::Command::new(cli);
    cmd.arg("-p");
    if let Some(m) = model_arg() {
        cmd.arg("--model").arg(m);
    }
    let mut child = cmd
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawning claude CLI")?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.context("writing prompt to claude CLI")?;
        stdin.shutdown().await.ok();
    }

    let output = tokio::time::timeout(std::time::Duration::from_secs(120), child.wait_with_output())
        .await
        .context("claude CLI timed out")?
        .context("waiting for claude CLI")?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("claude CLI exited unsuccessfully: {err}");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Rephrases a selection via the Anthropic HTTP API using a stored key.
pub async fn rephrase_via_api(api_key: &str, text: &str) -> Result<String> {
    let snippet: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .context("building HTTP client")?;

    let response = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({
            "model": api_model(),
            "max_tokens": 4096,
            "system": REPHRASE_PROMPT,
            "messages": [{ "role": "user", "content": format!("Text to rephrase:\n\n{snippet}") }],
        }))
        .send()
        .await
        .context("calling Anthropic API")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Anthropic API error {status}: {body}");
    }

    let body: Value = response.json().await.context("parsing Anthropic response")?;
    let reply = body["content"][0]["text"]
        .as_str()
        .context("missing text in Anthropic response")?;
    Ok(reply.trim().to_string())
}

// --- Find references -------------------------------------------------------

const REFERENCES_PROMPT: &str = "You are a research assistant. Using web search, find high-quality references — peer-reviewed papers, preprints, standards, official documentation, and reputable technical blog posts — that are genuinely relevant to the topic of the user's Markdown document.\n\nRules:\n- You MUST use web search to find real, currently-reachable sources. NEVER invent a title, author, year, DOI or URL, and never guess a URL's shape.\n- Only include a reference you actually saw in a search result, and copy its URL exactly as returned.\n- Prefer primary and authoritative sources; skip SEO spam and content farms.\n- Aim for 5-8 references, most useful first, covering a range of perspectives.\n\nRespond with ONLY a single JSON object — no prose, no markdown fences:\n{\n  \"query\": \"the topic you searched for, in a few words\",\n  \"references\": [\n    {\n      \"title\": \"exact title of the work\",\n      \"url\": \"exact URL from the search result\",\n      \"source\": \"publisher, journal, or site name\",\n      \"year\": \"publication year, or an empty string if unknown\",\n      \"kind\": \"one of: paper, article, docs, book, other\",\n      \"summary\": \"one sentence on what the source says\",\n      \"relevance\": \"one sentence on why it helps this document\"\n    }\n  ]\n}\nReturn an empty \"references\" array if search turns up nothing suitable — an empty list is far better than a fabricated one.";

/// One source suggested by the research agent.
#[derive(serde::Serialize)]
pub struct Reference {
    pub title: String,
    pub url: String,
    pub source: String,
    pub year: String,
    pub kind: String,
    pub summary: String,
    pub relevance: String,
}

#[derive(serde::Serialize)]
pub struct ReferenceResult {
    pub query: String,
    pub references: Vec<Reference>,
}

fn build_references(raw: Value) -> ReferenceResult {
    let field = |v: &Value, k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let references = raw
        .get("references")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|r| {
                    let title = field(r, "title");
                    let url = field(r, "url");
                    // Drop anything without a real http(s) link — that's the signal
                    // it came from an actual search result rather than memory.
                    if title.is_empty() || !url.starts_with("http") {
                        return None;
                    }
                    Some(Reference {
                        title,
                        url,
                        source: field(r, "source"),
                        year: field(r, "year"),
                        kind: field(r, "kind"),
                        summary: field(r, "summary"),
                        relevance: field(r, "relevance"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    ReferenceResult {
        query: field(&raw, "query"),
        references,
    }
}

/// Finds references with the local `claude` CLI, allowing only its WebSearch tool,
/// streaming both the reply text and a human-readable note of what it is searching
/// for — otherwise the panel sits silent for the length of several web round-trips.
///
/// `on_progress` receives `(reply_so_far, activity)`.
pub async fn find_references_via_cli_streamed<F>(
    cli: &Path,
    text: &str,
    mut on_progress: F,
) -> Result<ReferenceResult>
where
    F: FnMut(&str, &str),
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    let snippet: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let prompt = format!(
        "{REFERENCES_PROMPT}\n\n---\n\nFind references for the topic of this Markdown document and return ONLY the JSON object described above.\n\nDocument:\n{snippet}"
    );

    let mut cmd = tokio::process::Command::new(cli);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        // Unlike the other calls this one needs a tool: web search, and nothing else.
        .arg("--allowedTools")
        .arg("WebSearch");
    if let Some(m) = model_arg() {
        cmd.arg("--model").arg(m);
    }
    let mut child = cmd
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawning claude CLI")?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .context("writing prompt to claude CLI")?;
        stdin.shutdown().await.ok();
    }

    let stdout = child.stdout.take().context("claude CLI stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut acc = String::new();
    let mut final_reply: Option<String> = None;
    // Tool-call arguments arrive as a stream of JSON fragments; buffer them so the
    // search query can be shown once enough has arrived.
    let mut tool_args = String::new();
    let mut in_tool = false;
    let mut searches = 0usize;

    let read_loop = async {
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match v.get("type").and_then(Value::as_str) {
                Some("stream_event") => {
                    let Some(ev) = v.get("event") else { continue };
                    match ev.get("type").and_then(Value::as_str) {
                        Some("content_block_start") => {
                            let block = ev.get("content_block");
                            let kind = block.and_then(|b| b.get("type")).and_then(Value::as_str);
                            in_tool = kind == Some("tool_use") || kind == Some("server_tool_use");
                            if in_tool {
                                tool_args.clear();
                                searches += 1;
                                on_progress(&acc, &format!("Searching the web ({searches})…"));
                            }
                        }
                        Some("content_block_delta") => {
                            let delta = ev.get("delta");
                            if let Some(t) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                                acc.push_str(t);
                                on_progress(&acc, "Writing up the results…");
                            } else if let Some(j) =
                                delta.and_then(|d| d.get("partial_json")).and_then(Value::as_str)
                            {
                                tool_args.push_str(j);
                                if let Some(q) = extract_query(&tool_args) {
                                    on_progress(&acc, &format!("Searching: {q}"));
                                }
                            }
                        }
                        Some("content_block_stop") => in_tool = false,
                        _ => {}
                    }
                }
                Some("result") => {
                    if let Some(r) = v.get("result").and_then(Value::as_str) {
                        final_reply = Some(r.to_string());
                    }
                }
                _ => {}
            }
        }
        Ok::<(), std::io::Error>(())
    };

    tokio::time::timeout(std::time::Duration::from_secs(300), read_loop)
        .await
        .context("claude CLI timed out while searching")?
        .context("reading claude CLI output")?;

    let status = child.wait().await.context("waiting for claude CLI")?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            e.read_to_string(&mut err).await.ok();
        }
        anyhow::bail!("claude CLI exited unsuccessfully: {err}");
    }

    let reply = final_reply.unwrap_or(acc);
    let json_str = extract_json_object(&reply).context("no JSON object in claude CLI reply")?;
    let raw: Value = serde_json::from_str(json_str).context("parsing references JSON from CLI")?;
    Ok(build_references(raw))
}

/// Pulls the `query` value out of a partially-streamed tool-argument JSON blob.
fn extract_query(partial: &str) -> Option<String> {
    let at = partial.find("\"query\"")?;
    let rest = &partial[at + 7..];
    let start = rest.find('"')?;
    let tail = &rest[start + 1..];
    // Stop at the closing quote if it has arrived; otherwise show what we have.
    let end = tail.find('"').unwrap_or(tail.len());
    let q = tail[..end].trim();
    (!q.is_empty()).then(|| q.to_string())
}

/// Finds references via the Anthropic API using its server-side web search tool.
pub async fn find_references_via_api(api_key: &str, text: &str) -> Result<ReferenceResult> {
    let snippet: String = text.chars().take(MAX_TEXT_CHARS).collect();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .context("building HTTP client")?;

    let response = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({
            "model": api_model(),
            "max_tokens": 8192,
            "system": REFERENCES_PROMPT,
            // Without this the model has no browsing and would answer from memory,
            // which is exactly how fabricated citations happen.
            "tools": [{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 8,
            }],
            "messages": [{
                "role": "user",
                "content": format!("Find references for the topic of this Markdown document:\n\n{snippet}"),
            }],
        }))
        .send()
        .await
        .context("calling Anthropic API")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Anthropic API error {status}: {body}");
    }

    let body: Value = response.json().await.context("parsing Anthropic response")?;
    let reply = collect_text_blocks(&body).context("missing text in Anthropic response")?;

    let json_str = extract_json_object(&reply).context("no JSON object in AI reply")?;
    let raw: Value = serde_json::from_str(json_str).context("parsing references JSON")?;
    Ok(build_references(raw))
}

/// Joins every `text` block in a response. A tool-using reply interleaves
/// `server_tool_use` / `web_search_tool_result` blocks, so `content[0]` is not
/// necessarily the answer.
fn collect_text_blocks(body: &Value) -> Option<String> {
    let blocks = body.get("content")?.as_array()?;
    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    (end > start).then(|| &s[start..=end])
}
