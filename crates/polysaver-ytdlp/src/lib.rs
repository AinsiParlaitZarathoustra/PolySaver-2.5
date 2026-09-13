// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 PolySaver contributors

//! # PolySaver yt-dlp Adapter
//!
//! Encapsulates `yt-dlp` execution and implements the `MediaProvider` and `MediaDownloader` ports.

pub mod aggregator;
pub mod error_classifier;
pub mod js_runtime;
pub mod node_installer;
pub mod process_runner;
pub mod updater;

use async_trait::async_trait;
use polysaver_binres::BinaryResolver;
use polysaver_core::domain::{
    CookiesBrowser, DownloadPreset, FormatOption, MediaUrl, OutputFormat, ProbeResult,
};
use polysaver_core::error::{CoreError, DownloadErrorCode, DownloadErrorDetails};
use polysaver_core::ports::media_downloader::{
    CookiesDiagnostic, DownloadStreamRequest, DownloadedStreams, JsRuntimeSpec, MediaDownloader,
    StreamProgress,
};
use polysaver_core::ports::MediaProvider;
use process_runner::{parse_fallback_progress_line, YtDlpProcessRunner};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// `before_dl` print template describing the streams yt-dlp will fetch.
///
/// `requested_formats.N` only exists when the selector merged ≥ 2 formats; for
/// single-file selections (audio presets, muxed `best`) the entries are `NA` and
/// the `fallback_*` tokens are used instead.
const META_PRINT_TEMPLATE: &str = "before_dl:[POLYSAVER_META] title:%(title)s\tduration:%(duration)s\tf0:%(requested_formats.0.format_id)s|%(requested_formats.0.filesize,filesize_approx)s\tf1:%(requested_formats.1.format_id)s|%(requested_formats.1.filesize,filesize_approx)s\tf2:%(requested_formats.2.format_id)s|%(requested_formats.2.filesize,filesize_approx)s\tfallback_id:%(format_id)s\tfallback_size:%(filesize,filesize_approx)s";

/// Progress template. Uses `%(info.format_id)s` (the reliable stream boundary
/// marker) and numeric fields only; the percentage is computed downstream.
const PROGRESS_TEMPLATE: &str = "download:[POLYSAVER_PROGRESS] status:%(progress.status)s downloaded:%(progress.downloaded_bytes)s total:%(progress.total_bytes)s est:%(progress.total_bytes_estimate)s speed:%(progress.speed)s stream:%(info.format_id)s";

/// Appends `--cookies-from-browser <browser>` when a browser is configured.
///
/// The value comes from a closed enum, so no arbitrary string can reach the
/// command line. Never combined with `--cookies` (yt-dlp rejects both at once).
fn push_cookies_from_browser_arg(args: &mut Vec<String>, browser: Option<CookiesBrowser>) {
    if let Some(browser) = browser {
        args.push("--cookies-from-browser".to_string());
        args.push(browser.as_str().to_string());
    }
}

/// Appends `--js-runtimes <name>:<absolute path>` when a runtime is available.
///
/// The path must be absolute: a GUI app on macOS does not inherit the shell
/// `PATH`, so a bare `node` would not resolve. `--no-js-runtimes` is never
/// passed, so a user-installed Deno keeps its default priority over Node.
/// `--remote-components` is not used either: official yt-dlp builds already
/// bundle `yt-dlp-ejs`.
fn push_js_runtime_arg(args: &mut Vec<String>, runtime: Option<&JsRuntimeSpec>) {
    if let Some(runtime) = runtime {
        args.push("--js-runtimes".to_string());
        args.push(format!("{}:{}", runtime.name, runtime.path));
    }
}

/// Inspects stderr lines for cookie import outcomes so failures are never silent.
#[must_use]
pub fn detect_cookies_diagnostic(stderr_lines: &[String]) -> Option<CookiesDiagnostic> {
    let joined = stderr_lines.join("\n").to_lowercase();
    if joined.contains("cannot decrypt v10 cookies")
        || joined.contains("find-generic-password failed")
        || joined.contains("failed to decrypt")
    {
        return Some(CookiesDiagnostic::DecryptFailed);
    }
    if joined.contains("permission denied")
        && (joined.contains("cookie") || joined.contains("safari"))
    {
        return Some(CookiesDiagnostic::PermissionDenied);
    }
    if joined.contains("extracted") && joined.contains("cookies from") {
        return Some(CookiesDiagnostic::Imported);
    }
    None
}

/// Diagnostic availability status for yt-dlp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpAvailability {
    pub is_ready: bool,
    pub version: Option<String>,
    pub binary_path: Option<String>,
    pub status_message: String,
}

/// Discovers or validates the yt-dlp executable.
pub async fn discover_ytdlp_binary(bin_dir: &Path) -> Result<PathBuf, CoreError> {
    let resolver = BinaryResolver::new(bin_dir.to_path_buf(), None);
    let resolved = resolver.resolve_ytdlp().await.map_err(|_| {
        CoreError::DownloadFailed(DownloadErrorDetails::from_code(
            DownloadErrorCode::YtdlpNotFound,
        ))
    })?;
    Ok(resolved.path)
}

/// Checks availability of yt-dlp without side effects using the shared or fresh resolver.
pub async fn probe_ytdlp_availability(
    bin_dir: &Path,
    resource_bin_dir: Option<&Path>,
) -> YtDlpAvailability {
    let resolver = BinaryResolver::new(bin_dir.to_path_buf(), resource_bin_dir.map(PathBuf::from));
    match resolver.resolve_ytdlp().await {
        Ok(resolved) => YtDlpAvailability {
            is_ready: true,
            version: Some(resolved.version.clone()),
            binary_path: Some(resolved.path.to_string_lossy().to_string()),
            status_message: format!("yt-dlp version {} prête", resolved.version),
        },
        Err(err) => YtDlpAvailability {
            is_ready: false,
            version: None,
            binary_path: None,
            status_message: format!("yt-dlp indisponible: {err}"),
        },
    }
}

/// Checks availability of yt-dlp using a shared BinaryResolver instance.
pub async fn probe_ytdlp_with_resolver(resolver: &BinaryResolver) -> YtDlpAvailability {
    match resolver.resolve_ytdlp().await {
        Ok(resolved) => YtDlpAvailability {
            is_ready: true,
            version: Some(resolved.version.clone()),
            binary_path: Some(resolved.path.to_string_lossy().to_string()),
            status_message: format!("yt-dlp version {} prête", resolved.version),
        },
        Err(err) => YtDlpAvailability {
            is_ready: false,
            version: None,
            binary_path: None,
            status_message: format!("yt-dlp indisponible: {err}"),
        },
    }
}

/// Real yt-dlp provider implementing `MediaProvider` and `MediaDownloader`.
///
/// Cookie extraction is stored on the downloader (not in the request) so the
/// same value applies to both `probe` and `download_stream`; the composition
/// root updates it whenever settings change.
pub struct YtDlpDownloader {
    resolver: Arc<BinaryResolver>,
    cookies_from_browser: Arc<RwLock<Option<CookiesBrowser>>>,
    js_runtime: Arc<RwLock<Option<JsRuntimeSpec>>>,
}

impl YtDlpDownloader {
    /// Creates a new `YtDlpDownloader` with dedicated app binary directory.
    #[must_use]
    pub fn new(bin_dir: PathBuf) -> Self {
        Self {
            resolver: Arc::new(BinaryResolver::new(bin_dir, None)),
            cookies_from_browser: Arc::new(RwLock::new(None)),
            js_runtime: Arc::new(RwLock::new(None)),
        }
    }

    /// Creates a new `YtDlpDownloader` with optional resource directory.
    #[must_use]
    pub fn with_resource_dir(bin_dir: PathBuf, resource_bin_dir: Option<PathBuf>) -> Self {
        Self {
            resolver: Arc::new(BinaryResolver::new(bin_dir, resource_bin_dir)),
            cookies_from_browser: Arc::new(RwLock::new(None)),
            js_runtime: Arc::new(RwLock::new(None)),
        }
    }

    /// Creates a new `YtDlpDownloader` with an injected shared `BinaryResolver`.
    #[must_use]
    pub fn with_resolver(resolver: Arc<BinaryResolver>) -> Self {
        Self {
            resolver,
            cookies_from_browser: Arc::new(RwLock::new(None)),
            js_runtime: Arc::new(RwLock::new(None)),
        }
    }

    /// Sets (or clears) the browser used for `--cookies-from-browser`.
    pub async fn set_cookies_from_browser(&self, browser: Option<CookiesBrowser>) {
        let mut guard = self.cookies_from_browser.write().await;
        *guard = browser;
    }

    /// Reads the currently configured cookie source, if any.
    async fn cookies_from_browser(&self) -> Option<CookiesBrowser> {
        *self.cookies_from_browser.read().await
    }

    /// Sets (or clears) the JavaScript runtime passed to yt-dlp.
    pub async fn set_js_runtime(&self, runtime: Option<JsRuntimeSpec>) {
        let mut guard = self.js_runtime.write().await;
        *guard = runtime;
    }

    /// Reads the currently configured JavaScript runtime, if any.
    async fn js_runtime(&self) -> Option<JsRuntimeSpec> {
        self.js_runtime.read().await.clone()
    }
}

#[async_trait]
impl MediaProvider for YtDlpDownloader {
    async fn probe(
        &self,
        url: &MediaUrl,
        cancellation_token: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<ProbeResult, CoreError> {
        let resolved = self.resolver.resolve_ytdlp().await.map_err(|_| {
            CoreError::DownloadFailed(DownloadErrorDetails::from_code(
                DownloadErrorCode::YtdlpNotFound,
            ))
        })?;
        let binary = resolved.path;
        let version = Some(resolved.version);
        let ffmpeg_bin = self.resolver.resolve_ffmpeg().await.ok().map(|r| r.path);

        let temp_dir = std::env::temp_dir();
        let mut args = vec![
            "--dump-single-json".to_string(),
            "--no-warnings".to_string(),
        ];
        push_cookies_from_browser_arg(&mut args, self.cookies_from_browser().await);
        push_js_runtime_arg(&mut args, self.js_runtime().await.as_ref());
        args.push(url.as_str().to_string());

        let run_result = YtDlpProcessRunner::run(
            &binary,
            ffmpeg_bin.as_deref(),
            &args,
            &temp_dir,
            cancellation_token.as_ref(),
            None,
            version,
        )
        .await?;

        let json_str = run_result.stdout_lines.join("\n");
        let parsed: serde_json::Value = serde_json::from_str(&json_str).map_err(|err| {
            CoreError::ProviderError(format!("Failed to parse metadata JSON: {err}"))
        })?;

        let title = parsed["title"].as_str().unwrap_or("Sans titre").to_string();
        let duration_seconds = parsed["duration"].as_u64();
        let uploader = parsed["uploader"]
            .as_str()
            .or_else(|| parsed["channel"].as_str())
            .map(String::from);
        let thumbnail_url = parsed["thumbnail"].as_str().map(String::from);

        let mut formats = Vec::new();
        if let Some(formats_arr) = parsed["formats"].as_array() {
            for f in formats_arr {
                let protocol = f["protocol"].as_str().unwrap_or("");
                let format_note = f["format_note"].as_str().unwrap_or("");
                let vcodec = f["vcodec"].as_str().unwrap_or("none");
                let acodec = f["acodec"].as_str().unwrap_or("none");
                let format_id = f["format_id"].as_str().unwrap_or("");

                // Filter out storyboards, thumbnails, mhtml protocol
                if protocol == "mhtml"
                    || format_note.to_lowercase().contains("storyboard")
                    || format_id.starts_with("sb")
                {
                    continue;
                }

                let has_video = vcodec != "none" && !vcodec.is_empty();
                let has_audio = acodec != "none" && !acodec.is_empty();
                let height = f["height"].as_u64().map(|h| h as u32);
                let ext = f["ext"].as_str().unwrap_or("mp4").to_string();
                let filesize_approx = f["filesize"]
                    .as_u64()
                    .or_else(|| f["filesize_approx"].as_u64());
                let tbr = f["tbr"].as_f64().filter(|t| *t > 0.0);

                formats.push(FormatOption {
                    format_id: format_id.to_string(),
                    height,
                    has_video,
                    has_audio,
                    extension: ext,
                    filesize_approx_bytes: filesize_approx,
                    tbr,
                    note: if format_note.is_empty() {
                        None
                    } else {
                        Some(format_note.to_string())
                    },
                });
            }
        }

        Ok(ProbeResult::new(
            url.clone(),
            title,
            duration_seconds,
            thumbnail_url,
            uploader,
            formats,
        ))
    }
}

#[async_trait]
impl MediaDownloader for YtDlpDownloader {
    async fn download_stream(
        &self,
        request: DownloadStreamRequest,
        progress_callback: Arc<dyn Fn(StreamProgress) + Send + Sync>,
    ) -> Result<DownloadedStreams, CoreError> {
        let resolved = self.resolver.resolve_ytdlp().await.map_err(|_| {
            CoreError::DownloadFailed(DownloadErrorDetails::from_code(
                DownloadErrorCode::YtdlpNotFound,
            ))
        })?;
        let binary = resolved.path;
        let version = Some(resolved.version);
        let ffmpeg_bin = self.resolver.resolve_ffmpeg().await.ok().map(|r| r.path);

        // 1. Determine format selector based on preset
        let format_selector = match request.preset {
            DownloadPreset::Video { format, quality } => match (format, quality.target_height()) {
                (OutputFormat::Mp4, Some(h)) => {
                    format!("bestvideo[height={h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height={h}]+bestaudio/best[height={h}]")
                }
                (OutputFormat::Mp4, None) => {
                    "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best".to_string()
                }
                (OutputFormat::Mov, Some(h)) => {
                    format!("bestvideo[height={h}]+bestaudio/best[height={h}]")
                }
                (OutputFormat::Mov, None) => "bestvideo+bestaudio/best".to_string(),
                _ => "bestvideo+bestaudio/best".to_string(),
            },
            DownloadPreset::Mp3 { .. } | DownloadPreset::Flac => "bestaudio/best".to_string(),
        };

        // 2. Direct single execution download with before_dl metadata printing and multi-stream progress template
        let out_template = request.temp_dir.join("stream.%(ext)s");
        let mut download_args = vec![
            "-f".to_string(),
            format_selector,
            "--output".to_string(),
            out_template.to_string_lossy().to_string(),
            "--newline".to_string(),
            "--progress".to_string(),
            "--print".to_string(),
            META_PRINT_TEMPLATE.to_string(),
            "--progress-template".to_string(),
            PROGRESS_TEMPLATE.to_string(),
            "--print".to_string(),
            "after_move:[POLYSAVER_OUTPUT] %(filepath)s".to_string(),
        ];

        push_cookies_from_browser_arg(&mut download_args, self.cookies_from_browser().await);
        push_js_runtime_arg(&mut download_args, self.js_runtime().await.as_ref());

        download_args.push(request.url.as_str().to_string());

        let run_result = YtDlpProcessRunner::run(
            &binary,
            ffmpeg_bin.as_deref(),
            &download_args,
            &request.temp_dir,
            request.cancellation_token.as_ref(),
            Some(progress_callback),
            version,
        )
        .await?;

        let downloaded_files = run_result.output_files;
        if downloaded_files.is_empty() {
            return Err(CoreError::ProviderError(
                "No media files produced by yt-dlp in the temporary directory".to_string(),
            ));
        }

        let title = run_result
            .early_meta
            .as_ref()
            .and_then(|m| m.title.clone())
            .unwrap_or_else(|| "PolySaver_Media".to_string());
        let duration_seconds = run_result
            .early_meta
            .as_ref()
            .and_then(|m| m.duration_seconds);

        // Map downloaded artifacts
        let (video_path, audio_path) = match request.preset {
            DownloadPreset::Video { .. } => {
                if downloaded_files.len() == 1 {
                    (Some(downloaded_files[0].clone()), None)
                } else {
                    let mut v = None;
                    let mut a = None;
                    for file in &downloaded_files {
                        let ext = file.extension().and_then(|s| s.to_str()).unwrap_or("");
                        if matches!(ext, "mp4" | "mkv" | "webm" | "mov") && v.is_none() {
                            v = Some(file.clone());
                        } else if matches!(ext, "m4a" | "webm" | "opus" | "mp3" | "aac")
                            && a.is_none()
                        {
                            a = Some(file.clone());
                        }
                    }
                    (v.or_else(|| downloaded_files.first().cloned()), a)
                }
            }
            DownloadPreset::Mp3 { .. } | DownloadPreset::Flac => {
                (None, Some(downloaded_files[0].clone()))
            }
        };

        Ok(DownloadedStreams {
            raw_artifacts: downloaded_files,
            video_path,
            audio_path,
            title,
            duration_seconds,
            engine_outdated: run_result.engine_outdated,
            cookies_diagnostic: run_result.cookies_diagnostic,
        })
    }
}

/// Helper function to parse human progress line for backward compatibility in unit tests.
pub fn parse_ytdlp_progress_line(line: &str) -> StreamProgress {
    parse_fallback_progress_line(line).unwrap_or(StreamProgress {
        percent: None,
        downloaded_bytes: None,
        total_bytes: None,
        total_bytes_estimate: None,
        speed_bytes_per_second: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_probe_ytdlp_availability_runs_without_panic() {
        let bin_dir =
            std::env::temp_dir().join(format!("polysaver_test_probe_{}", uuid::Uuid::new_v4()));
        let avail = probe_ytdlp_availability(&bin_dir, None).await;
        assert!(!avail.status_message.is_empty());
    }

    #[test]
    fn test_parse_ytdlp_progress_line() {
        let line = "[download]  45.2% of 100.00MiB at 5.50MiB/s ETA 00:10";
        let progress = parse_ytdlp_progress_line(line);
        assert_eq!(progress.percent, Some(45));
        assert_eq!(progress.total_bytes, Some(100 * 1024 * 1024));
        assert_eq!(
            progress.speed_bytes_per_second,
            Some((5.5 * 1024.0 * 1024.0) as u64)
        );
    }

    #[test]
    fn test_cookies_argument_is_injected_and_absent_by_default() {
        // No browser configured: no cookie flag at all.
        let mut args = vec!["--dump-single-json".to_string()];
        push_cookies_from_browser_arg(&mut args, None);
        assert!(!args.iter().any(|a| a == "--cookies-from-browser"));

        // Configured browser: exactly one flag followed by the canonical value.
        let mut args = vec!["--dump-single-json".to_string()];
        push_cookies_from_browser_arg(&mut args, Some(CookiesBrowser::Firefox));
        assert_eq!(
            args,
            vec![
                "--dump-single-json".to_string(),
                "--cookies-from-browser".to_string(),
                "firefox".to_string()
            ]
        );

        // Every supported browser maps to its exact yt-dlp value.
        for (browser, expected) in [
            (CookiesBrowser::Brave, "brave"),
            (CookiesBrowser::Chrome, "chrome"),
            (CookiesBrowser::Chromium, "chromium"),
            (CookiesBrowser::Edge, "edge"),
            (CookiesBrowser::Opera, "opera"),
            (CookiesBrowser::Safari, "safari"),
            (CookiesBrowser::Vivaldi, "vivaldi"),
            (CookiesBrowser::Whale, "whale"),
        ] {
            let mut args = Vec::new();
            push_cookies_from_browser_arg(&mut args, Some(browser));
            assert_eq!(
                args,
                vec!["--cookies-from-browser".to_string(), expected.to_string()]
            );
        }
    }

    #[tokio::test]
    async fn test_downloader_cookie_setting_round_trip() {
        let bin_dir =
            std::env::temp_dir().join(format!("polysaver_cookies_{}", uuid::Uuid::new_v4()));
        let downloader = YtDlpDownloader::new(bin_dir);

        assert!(downloader.cookies_from_browser().await.is_none());
        downloader
            .set_cookies_from_browser(Some(CookiesBrowser::Firefox))
            .await;
        assert_eq!(
            downloader.cookies_from_browser().await,
            Some(CookiesBrowser::Firefox)
        );
        downloader.set_cookies_from_browser(None).await;
        assert!(downloader.cookies_from_browser().await.is_none());
    }

    #[test]
    fn test_progress_templates_use_reliable_fields() {
        // The stream identifier must come from `info.format_id`: `progress.info_dict`
        // is removed by yt-dlp before template evaluation and always renders NA.
        assert!(PROGRESS_TEMPLATE.contains("%(info.format_id)s"));
        assert!(!PROGRESS_TEMPLATE.contains("info_dict"));
        // Numeric fields only: `_percent_str` is a string that reads "N/A%".
        assert!(!PROGRESS_TEMPLATE.contains("_percent_str"));
        assert!(PROGRESS_TEMPLATE.contains("%(progress.downloaded_bytes)s"));
        assert!(PROGRESS_TEMPLATE.contains("%(progress.total_bytes_estimate)s"));
        assert!(PROGRESS_TEMPLATE.contains("status:%(progress.status)s"));

        // Indexed per-stream metadata with an explicit single-file fallback.
        assert!(META_PRINT_TEMPLATE.contains("f0:%(requested_formats.0.format_id)s"));
        assert!(META_PRINT_TEMPLATE.contains("fallback_id:%(format_id)s"));
        assert!(META_PRINT_TEMPLATE.contains("fallback_size:%(filesize,filesize_approx)s"));
    }

    #[test]
    fn test_cookies_decryption_failures_are_detected() {
        let decrypt = vec!["WARNING: cannot decrypt v10 cookies: no key found".to_string()];
        assert_eq!(
            detect_cookies_diagnostic(&decrypt),
            Some(CookiesDiagnostic::DecryptFailed)
        );

        let keychain = vec!["ERROR: find-generic-password failed".to_string()];
        assert_eq!(
            detect_cookies_diagnostic(&keychain),
            Some(CookiesDiagnostic::DecryptFailed)
        );

        let safari = vec!["ERROR: Permission denied when reading Safari cookies".to_string()];
        assert_eq!(
            detect_cookies_diagnostic(&safari),
            Some(CookiesDiagnostic::PermissionDenied)
        );

        let success = vec!["Extracted 42 cookies from firefox".to_string()];
        assert_eq!(
            detect_cookies_diagnostic(&success),
            Some(CookiesDiagnostic::Imported)
        );

        let unrelated = vec!["[download] 100% of 10MiB".to_string()];
        assert_eq!(detect_cookies_diagnostic(&unrelated), None);
    }
}
