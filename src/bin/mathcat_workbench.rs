//! Local MathCAT Workbench. All MathCAT calls stay on the server thread.
use clap::Parser;
use libmathcat::interface::*;
use log::{LevelFilter, Log, Metadata, Record};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;

const HTML: &str = include_str!("mathcat_workbench/index.html");
const JS: &str = include_str!("mathcat_workbench/app.js");
const CSS: &str = include_str!("mathcat_workbench/style.css");
const MAX_BODY: usize = 1024 * 1024 + 64 * 1024;

#[derive(Parser)]
#[command(about = "Local MathCAT Workbench", version)]
struct Options {
    /// MathCAT Rules directory. Defaults to the checkout's Rules directory.
    #[arg(long)]
    rules_dir: Option<PathBuf>,
    /// Local port. Zero chooses an available port.
    #[arg(long, default_value_t = 0)]
    port: u16,
}

struct AppLogger(Mutex<Vec<String>>);
static APP_LOGGER: AppLogger = AppLogger(Mutex::new(Vec::new()));
impl Log for AppLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool { metadata.level() <= log::Level::Debug }
    fn log(&self, record: &Record<'_>) {
        if self.enabled(record.metadata()) {
            if let Ok(mut messages) = self.0.lock() {
                messages.push(format!("{} {}: {}", record.level(), record.target(), record.args()));
            }
        }
    }
    fn flush(&self) {}
}
fn take_logs() -> Vec<String> {
    std::mem::take(&mut *APP_LOGGER.0.lock().expect("logger lock"))
}
fn finish_event(mut event: Value) -> Value {
    event["logs"] = json!(take_logs());
    event
}

struct Workbench {
    current: Option<(String, Value)>,
    current_result: Option<Value>,
    custom_baseline: BTreeMap<String, String>,
}
impl Workbench {
    fn new() -> Self {
        Self { current: None, current_result: None, custom_baseline: BTreeMap::new() }
    }
    fn bootstrap(&self) -> Value {
        let defaults = json!({
            "language": "en",
            "speechStyle": get_preference("SpeechStyle").unwrap_or_else(|_| "ClearSpeak".into()),
            "verbosity": get_preference("Verbosity").unwrap_or_else(|_| "Medium".into()),
            "brailleCode": get_preference("BrailleCode").unwrap_or_else(|_| "Nemeth".into()),
            "navMode": get_preference("NavMode").unwrap_or_else(|_| "Enhanced".into()),
            "custom": {}
        });
        let languages = get_supported_languages().unwrap_or_default();
        let braille_codes = get_supported_braille_codes().unwrap_or_default();
        let style_lang = defaults["language"].as_str().unwrap_or("en");
        json!({"version": get_version(), "defaults": defaults,
            "languages": languages, "brailleCodes": braille_codes,
            "speechStyles": get_supported_speech_styles(style_lang).unwrap_or_default(),
            "current": self.current_result})
    }
    fn apply_settings(&mut self, settings: &Value) -> Result<(), String> {
        let custom = settings.get("custom").and_then(Value::as_object).ok_or("Missing custom preferences object")?;
        for (name, value) in custom {
            let _ = value.as_str().ok_or_else(|| format!("Preference {name} must be text"))?;
            if !self.custom_baseline.contains_key(name) {
                let initial = get_preference(name).map_err(|e| errors_to_string(&e))?;
                self.custom_baseline.insert(name.clone(), initial);
            }
        }
        for (name, baseline) in &self.custom_baseline {
            if !custom.contains_key(name) {
                set_preference(name, baseline).map_err(|e| errors_to_string(&e))?;
            }
        }
        for (field, name) in [("language", "Language"), ("speechStyle", "SpeechStyle"),
            ("verbosity", "Verbosity"), ("brailleCode", "BrailleCode"), ("navMode", "NavMode")] {
            let value = settings.get(field).and_then(Value::as_str).ok_or_else(|| format!("Missing {field}"))?;
            set_preference(name, value).map_err(|e| errors_to_string(&e))?;
        }
        for (name, value) in custom {
            set_preference(name, value.as_str().unwrap()).map_err(|e| errors_to_string(&e))?;
        }
        Ok(())
    }
    fn preferences(&self) -> Value {
        let entries = get_all_preferences().unwrap_or_default();
        let values = entries.into_iter().map(|(name, value)| (name, json!(value))).collect::<Map<_, _>>();
        Value::Object(values)
    }
    fn evaluate(&mut self, input: String, settings: Value, reload: bool) -> Value {
        take_logs();
        let kind = if reload { "reload" } else { "evaluate" };
        let mut outputs = Map::new();
        let mut errors = Map::new();
        let mut timings = Map::new();
        self.current = None;
        self.current_result = None;
        if input.len() > 1024 * 1024 {
            errors.insert("input".into(), json!("MathML exceeds the 1 MB limit"));
        } else if let Err(error) = self.apply_settings(&settings) {
            errors.insert("preferences".into(), json!(error));
        } else {
            let previous_check = get_preference("CheckRuleFiles").unwrap_or_else(|_| "Prefs".into());
            if reload {
                if let Err(error) = set_preference("CheckRuleFiles", "All") {
                    errors.insert("reload".into(), json!(errors_to_string(&error)));
                }
            }
            if !errors.contains_key("reload") {
                let start = Instant::now();
                match set_mathml(&input) {
                    Ok(canonical) => {
                        timings.insert("canonicalize".into(), json!(milliseconds(start)));
                        outputs.insert("canonical".into(), json!(canonical));
                        let intent_start = Instant::now();
                        add_result("intent", get_intent_mathml(), &mut outputs, &mut errors);
                        timings.insert("intent".into(), json!(milliseconds(intent_start)));
                        let original_tts = get_preference("TTS").unwrap_or_else(|_| "none".into());
                        if let Err(error) = set_preference("TTS", "None") {
                            errors.insert("speech".into(), json!(errors_to_string(&error)));
                        } else {
                            let speech_start = Instant::now();
                            add_result("speech", get_spoken_text(), &mut outputs, &mut errors);
                            timings.insert("speech".into(), json!(milliseconds(speech_start)));
                        }
                        if let Err(error) = set_preference("TTS", "SSML") {
                            errors.insert("ssml".into(), json!(errors_to_string(&error)));
                        } else {
                            let ssml_start = Instant::now();
                            add_result("ssml", get_spoken_text(), &mut outputs, &mut errors);
                            timings.insert("ssml".into(), json!(milliseconds(ssml_start)));
                        }
                        if let Err(error) = set_preference("TTS", &original_tts) {
                            errors.insert("tts_restore".into(), json!(errors_to_string(&error)));
                        }
                        let braille_start = Instant::now();
                        add_result("braille", get_braille(""), &mut outputs, &mut errors);
                        timings.insert("braille".into(), json!(milliseconds(braille_start)));
                        self.current = Some((input.clone(), settings.clone()));
                    }
                    Err(error) => {
                        timings.insert("canonicalize".into(), json!(milliseconds(start)));
                        errors.insert("mathml".into(), json!(errors_to_string(&error)));
                    }
                }
            }
            if reload {
                if let Err(error) = set_preference("CheckRuleFiles", &previous_check) {
                    errors.insert("reload_restore".into(), json!(errors_to_string(&error)));
                }
            }
        }
        let event = finish_event(json!({"kind": kind, "input": input, "settings": settings,
            "outputs": outputs, "errors": errors, "timings_ms": timings,
            "preferences": self.preferences()}));
        if self.current.is_some() { self.current_result = Some(event.clone()); }
        event
    }
    fn navigate(&mut self, command: &str) -> Value {
        take_logs();
        let (input, settings) = match &self.current {
            Some((input, settings)) => (input.clone(), settings.clone()),
            None => return finish_event(json!({"kind":"navigate", "command":command,
                "errors":{"navigation":"Submit valid MathML first"}})),
        };
        let allowed = ["MovePrevious", "MoveNext", "ZoomIn", "ZoomOut", "ReadCurrent", "WhereAmI"];
        let mut outputs = Map::new();
        let mut errors = Map::new();
        let start = Instant::now();
        if !allowed.contains(&command) {
            errors.insert("navigation".into(), json!("Unsupported navigation command"));
        } else {
            let original_tts = get_preference("TTS").unwrap_or_else(|_| "None".into());
            match set_preference("TTS", "None") {
                Ok(()) => add_result("navigationSpeech", do_navigate_command(command), &mut outputs, &mut errors),
                Err(error) => { errors.insert("navigationSpeech".into(), json!(errors_to_string(&error))); },
            }
            if let Err(error) = set_preference("TTS", &original_tts) {
                errors.insert("tts_restore".into(), json!(errors_to_string(&error)));
            }
            self.focused_outputs(&mut outputs, &mut errors);
        }
        finish_event(json!({"kind":"navigate", "command":command, "input":input,
            "settings":settings, "outputs":outputs, "errors":errors,
            "timings_ms":{"navigation":milliseconds(start)}, "preferences":self.preferences()}))
    }
    fn node(&mut self, id: &str) -> Value {
        take_logs();
        let (input, settings) = match &self.current {
            Some((input, settings)) => (input.clone(), settings.clone()),
            None => return finish_event(json!({"kind":"node", "errors":{"node":"Submit valid MathML first"}})),
        };
        let mut outputs = Map::new();
        let mut errors = Map::new();
        let start = Instant::now();
        match set_navigation_node(id, 0) {
            Ok(()) => self.focused_outputs(&mut outputs, &mut errors),
            Err(error) => { errors.insert("node".into(), json!(errors_to_string(&error))); },
        }
        finish_event(json!({"kind":"node", "input":input, "settings":settings,
            "outputs":outputs, "errors":errors, "timings_ms":{"node":milliseconds(start)},
            "preferences":self.preferences()}))
    }
    fn focused_outputs(&self, outputs: &mut Map<String, Value>, errors: &mut Map<String, Value>) {
        match get_navigation_mathml_id() {
            Ok((id, offset)) => {
                outputs.insert("nodeId".into(), json!(id));
                outputs.insert("offset".into(), json!(offset));
                add_result("focusedMathml", get_navigation_mathml().map(|v| v.0), outputs, errors);
                add_result("highlightedBraille", get_braille(&id), outputs, errors);
                match get_braille_position() {
                    Ok((start, end)) => { outputs.insert("brailleRange".into(), json!([start, end])); },
                    Err(error) => { errors.insert("brailleRange".into(), json!(errors_to_string(&error))); },
                }
                self.read_current_formats(outputs, errors);
            }
            Err(error) => { errors.insert("node".into(), json!(errors_to_string(&error))); },
        }
    }
    fn read_current_formats(&self, outputs: &mut Map<String, Value>, errors: &mut Map<String, Value>) {
        let original_tts = get_preference("TTS").unwrap_or_else(|_| "None".into());
        for (tts, key) in [("None", "nodeSpeech"), ("SSML", "nodeSsml")] {
            match set_preference("TTS", tts) {
                Ok(()) => add_result(key, do_navigate_command("ReadCurrent"), outputs, errors),
                Err(error) => { errors.insert(key.into(), json!(errors_to_string(&error))); },
            }
        }
        if let Err(error) = set_preference("TTS", &original_tts) {
            errors.insert("tts_restore".into(), json!(errors_to_string(&error)));
        }
    }
    fn reload(&mut self) -> Value {
        match self.current.clone() {
            Some((input, settings)) => self.evaluate(input, settings, true),
            None => { take_logs(); finish_event(json!({"kind":"reload", "errors":{"reload":"Submit valid MathML first"}})) }
        }
    }
}
fn milliseconds(start: Instant) -> f64 { (start.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0 }
fn add_result(name: &str, result: libmathcat::errors::Result<String>, outputs: &mut Map<String, Value>, errors: &mut Map<String, Value>) {
    match result {
        Ok(value) => { outputs.insert(name.into(), json!(value)); },
        Err(error) => { errors.insert(name.into(), json!(errors_to_string(&error))); },
    }
}

struct HttpRequest { method: String, path: String, body: Vec<u8> }
fn read_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 { return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof)); }
    if line.len() > 4096 { return Err(std::io::Error::other("Request line too long")); }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").split('?').next().unwrap_or("").to_string();
    let mut length = 0usize;
    let mut header_bytes = 0;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 { return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof)); }
        header_bytes += line.len();
        if header_bytes > 32768 { return Err(std::io::Error::other("Headers too large")); }
        if line == "\r\n" || line == "\n" { break; }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().map_err(|_| std::io::Error::other("Bad content length"))?;
            }
            if name.eq_ignore_ascii_case("transfer-encoding") {
                return Err(std::io::Error::other("Transfer encoding is unsupported"));
            }
        }
    }
    if length > MAX_BODY { return Err(std::io::Error::other("Request body too large")); }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(HttpRequest { method, path, body })
}
fn reply(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    let headers = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self'\r\n\r\n", body.len());
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body)
}
fn handle(stream: &mut TcpStream, app: &mut Workbench) -> std::io::Result<()> {
    let request = match read_request(stream) {
        Ok(value) => value,
        Err(error) => return reply(stream, "400 Bad Request", "text/plain; charset=utf-8", error.to_string().as_bytes()),
    };
    let (status, content_type, body) = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => ("200 OK", "text/html; charset=utf-8", HTML.as_bytes().to_vec()),
        ("GET", "/app.js") => ("200 OK", "text/javascript; charset=utf-8", JS.as_bytes().to_vec()),
        ("GET", "/style.css") => ("200 OK", "text/css; charset=utf-8", CSS.as_bytes().to_vec()),
        ("GET", "/api/bootstrap") => ("200 OK", "application/json; charset=utf-8", app.bootstrap().to_string().into_bytes()),
        ("POST", path) if path.starts_with("/api/") => {
            match serde_json::from_slice::<Value>(&request.body) {
                Ok(payload) => {
                    let result = match path {
                        "/api/evaluate" => {
                            match (payload.get("input").and_then(Value::as_str), payload.get("settings")) {
                                (Some(input), Some(settings)) => app.evaluate(input.to_string(), settings.clone(), false),
                                _ => json!({"error":"Expected input and settings"}),
                            }
                        }
                        "/api/styles" => {
                            let language = payload.get("language").and_then(Value::as_str).unwrap_or("en");
                            match get_supported_languages() {
                                Ok(languages) if languages.iter().any(|item| item == language) => {
                                    match get_supported_speech_styles(language) {
                                        Ok(styles) => json!({"styles": styles}),
                                        Err(error) => json!({"error": errors_to_string(&error)}),
                                    }
                                }
                                _ => json!({"error":"Unsupported language"}),
                            }
                        }
                        "/api/navigate" => app.navigate(payload.get("command").and_then(Value::as_str).unwrap_or("")),
                        "/api/node" => app.node(payload.get("id").and_then(Value::as_str).unwrap_or("")),
                        "/api/reload" => app.reload(),
                        _ => json!({"error":"Unknown API route"}),
                    };
                    let status = if result.get("error").is_some() { "400 Bad Request" } else { "200 OK" };
                    (status, "application/json; charset=utf-8", result.to_string().into_bytes())
                }
                Err(_) => ("400 Bad Request", "application/json; charset=utf-8", json!({"error":"Invalid JSON"}).to_string().into_bytes()),
            }
        }
        _ => ("404 Not Found", "text/plain; charset=utf-8", b"Not found".to_vec()),
    };
    reply(stream, status, content_type, &body)
}
fn open_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    command.stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    log::set_logger(&APP_LOGGER)?;
    log::set_max_level(LevelFilter::Debug);
    let options = Options::parse();
    let rules_dir = options.rules_dir.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Rules"));
    set_rules_dir(rules_dir.to_string_lossy())?;
    set_preference("Language", "en")?;
    let listener = TcpListener::bind(("127.0.0.1", options.port))?;
    let url = format!("http://{}/", listener.local_addr()?);
    println!("MathCAT Workbench: {url}");
    if let Err(error) = open_browser(&url) {
        eprintln!("Could not open the browser: {error}. Open {url} manually.");
    }
    let mut app = Workbench::new();
    for connection in listener.incoming() {
        match connection {
            Ok(mut stream) => { if let Err(error) = handle(&mut stream, &mut app) { eprintln!("Request error: {error}"); } },
            Err(error) => eprintln!("Connection error: {error}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Evaluation exposes developer outputs, node selection reads in context without changing TTS,
    /// and malformed replacement input clears the active expression.
    #[test]
    fn workbench_keeps_results_and_errors_separate() {
        set_rules_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Rules").to_string_lossy()).unwrap();
        let mut app = Workbench::new();
        let bootstrap = app.bootstrap();
        assert_eq!(bootstrap["defaults"]["language"], "en");
        assert!(!bootstrap["languages"].as_array().unwrap().iter().any(|language| language == "Auto"));
        let settings = bootstrap["defaults"].clone();
        let valid = app.evaluate("<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>".into(), settings.clone(), false);
        assert!(valid["outputs"]["canonical"].as_str().unwrap().contains("mfrac"));
        assert!(valid["outputs"]["intent"].as_str().unwrap().contains("math"));
        assert!(valid["outputs"]["speech"].is_string());
        assert!(valid["outputs"]["ssml"].is_string());
        assert!(valid["outputs"]["braille"].is_string());
        assert_eq!(valid["preferences"]["SpeechStyle"], settings["speechStyle"]);
        assert!(valid["errors"].as_object().unwrap().is_empty());
        let original_tts = get_preference("TTS").unwrap();
        set_preference("TTS", "SSML").unwrap();
        let navigation = app.navigate("ZoomIn");
        assert!(navigation["outputs"]["navigationSpeech"].is_string());
        assert!(!navigation["outputs"]["navigationSpeech"].as_str().unwrap().contains("<speak"));
        assert_eq!(get_preference("TTS").unwrap(), "SSML");
        set_preference("TTS", &original_tts).unwrap();
        assert!(navigation["outputs"]["nodeId"].is_string());
        assert!(navigation["outputs"]["nodeSpeech"].is_string());
        assert!(navigation["outputs"]["nodeSsml"].is_string());
        let node_id = navigation["outputs"]["nodeId"].as_str().unwrap();
        assert_eq!(get_navigation_mathml_id().unwrap().0, node_id);
        let original_tts = get_preference("TTS").unwrap();
        let selected = app.node(node_id);
        assert_eq!(selected["outputs"]["nodeId"], node_id);
        assert_eq!(get_navigation_mathml_id().unwrap().0, node_id);
        assert!(selected["outputs"]["nodeSpeech"].is_string());
        assert!(selected["outputs"]["nodeSsml"].is_string());
        assert!(selected["outputs"]["highlightedBraille"].is_string());
        assert_eq!(selected["outputs"]["brailleRange"].as_array().unwrap().len(), 2);
        assert_eq!(get_preference("TTS").unwrap(), original_tts);
        assert!(app.node("missing-node")["errors"]["node"].is_string());
        let original_rule_check = get_preference("CheckRuleFiles").unwrap();
        let reloaded = app.reload();
        assert!(reloaded["outputs"]["canonical"].is_string());
        assert_eq!(get_preference("CheckRuleFiles").unwrap(), original_rule_check);
        let invalid = app.evaluate("<math><mi>x</math>".into(), settings, false);
        assert!(invalid["errors"]["mathml"].is_string());
        assert!(invalid["outputs"]["canonical"].is_null());
        assert!(app.current.is_none());
        assert!(app.current_result.is_none());
        assert!(app.bootstrap()["current"].is_null());
        assert!(app.bootstrap().get("history").is_none());
    }
}
