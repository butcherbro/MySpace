//! Link Card metadata enrichment.
//!
//! Conversion from Note to Embed is intentionally local and immediate. This
//! service runs later: fetches bounded web metadata, imports preview/favicons
//! as managed assets, then applies a short revision-guarded DB transaction.

use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde_json::Value;
use url::{form_urlencoded, Host, Url};

use crate::domain::asset_service;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::ApplyEmbedMetadataInput;
use crate::repositories::workspace_repository;

use rusqlite::OptionalExtension;

const MAX_REDIRECTS: usize = 5;
const TEXT_LIMIT: usize = 2 * 1024 * 1024;
const IMAGE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct LinkMetadata {
    pub final_url: String,
    pub site_name: Option<String>,
    pub title: Option<String>,
    pub provider: Option<String>,
    pub description: Option<String>,
    pub preview_url: Option<String>,
    pub favicon_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FetchResponse {
    pub final_url: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FetchError {
    InvalidUrl(String),
    BlockedUrl(String),
    Network(String),
    TooLarge { limit: usize, actual: usize },
    UnsupportedMime(String),
    InvalidBody(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::InvalidUrl(m) => write!(f, "invalid url: {m}"),
            FetchError::BlockedUrl(m) => write!(f, "blocked url: {m}"),
            FetchError::Network(m) => write!(f, "network error: {m}"),
            FetchError::TooLarge { limit, actual } => {
                write!(f, "response too large: {actual} bytes > {limit} bytes")
            }
            FetchError::UnsupportedMime(m) => write!(f, "unsupported mime type: {m}"),
            FetchError::InvalidBody(m) => write!(f, "invalid body: {m}"),
        }
    }
}

pub trait MetadataFetcher {
    fn fetch_text(&self, url: &str) -> Result<FetchResponse, FetchError>;
    fn fetch_image(&self, url: &str) -> Result<FetchResponse, FetchError>;
}

pub struct ReqwestMetadataFetcher;

impl ReqwestMetadataFetcher {
    pub fn new() -> Result<Self, WorkspaceError> {
        Ok(Self)
    }

    fn client_for(url: &Url) -> Result<Client, FetchError> {
        let addresses = resolve_public_addresses(url)?;
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(10))
            .redirect(Policy::none())
            .user_agent("MySpace/0.1 link-preview");
        if matches!(url.host(), Some(Host::Domain(_))) {
            let host = url
                .host_str()
                .ok_or_else(|| FetchError::InvalidUrl("missing host".to_string()))?;
            // Закрепляем проверенные адреса за host: повторный DNS lookup внутри
            // HTTP-клиента не должен превратить проверку в DNS-rebinding дыру.
            builder = builder.resolve_to_addrs(host, &addresses);
        }
        builder
            .build()
            .map_err(|e| FetchError::Network(e.to_string()))
    }

    fn fetch_bounded(&self, source: &str, limit: usize) -> Result<FetchResponse, FetchError> {
        let mut url = Url::parse(source).map_err(|e| FetchError::InvalidUrl(e.to_string()))?;
        for _ in 0..=MAX_REDIRECTS {
            let client = Self::client_for(&url)?;

            let mut response = client
                .get(url.clone())
                .send()
                .map_err(|e| FetchError::Network(e.to_string()))?;

            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| FetchError::Network("redirect without Location".to_string()))?;
                url = url
                    .join(location)
                    .map_err(|e| FetchError::InvalidUrl(e.to_string()))?;
                continue;
            }

            let status = response.status();
            if !status.is_success() {
                return Err(FetchError::Network(format!("HTTP {status}")));
            }

            if let Some(len) = response.content_length() {
                if len as usize > limit {
                    return Err(FetchError::TooLarge {
                        limit,
                        actual: len as usize,
                    });
                }
            }

            let final_url = response.url().to_string();
            let mime_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .split(';')
                .next()
                .unwrap_or("application/octet-stream")
                .trim()
                .to_ascii_lowercase();
            let mut bytes = Vec::with_capacity(
                response.content_length().unwrap_or(0).min(limit as u64) as usize,
            );
            response
                .by_ref()
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| FetchError::Network(e.to_string()))?;
            if bytes.len() > limit {
                return Err(FetchError::TooLarge {
                    limit,
                    actual: bytes.len(),
                });
            }

            return Ok(FetchResponse {
                final_url,
                mime_type,
                bytes,
            });
        }

        Err(FetchError::Network("too many redirects".to_string()))
    }
}

impl MetadataFetcher for ReqwestMetadataFetcher {
    fn fetch_text(&self, url: &str) -> Result<FetchResponse, FetchError> {
        self.fetch_bounded(url, TEXT_LIMIT)
    }

    fn fetch_image(&self, url: &str) -> Result<FetchResponse, FetchError> {
        let response = self.fetch_bounded(url, IMAGE_LIMIT)?;
        if !is_supported_image_mime(&response.mime_type) {
            return Err(FetchError::UnsupportedMime(response.mime_type));
        }
        Ok(response)
    }
}

pub fn validate_public_http_url(source: &str) -> Result<(), FetchError> {
    let url = Url::parse(source).map_err(|e| FetchError::InvalidUrl(e.to_string()))?;
    validate_public_url_without_dns(&url)
}

pub fn youtube_oembed_url(source: &str) -> Option<String> {
    let url = Url::parse(source).ok()?;
    let host = url.host_str()?.trim_start_matches("www.");
    let is_youtube = host == "youtube.com" || host == "m.youtube.com" || host == "youtu.be";
    if !is_youtube {
        return None;
    }
    let encoded: String = form_urlencoded::byte_serialize(source.as_bytes()).collect();
    Some(format!(
        "https://www.youtube.com/oembed?url={encoded}&format=json"
    ))
}

pub fn youtube_channel_feed_url(source: &str) -> Option<String> {
    let url = Url::parse(source).ok()?;
    let host = url.host_str()?.trim_start_matches("www.");
    if host != "youtube.com" && host != "m.youtube.com" {
        return None;
    }
    let segments: Vec<_> = url.path_segments()?.collect();
    if segments.len() != 2 || segments[0] != "channel" || segments[1].is_empty() {
        return None;
    }
    Some(format!(
        "https://www.youtube.com/feeds/videos.xml?channel_id={}",
        segments[1]
    ))
}

pub fn extract_youtube_feed_metadata(
    source_url: &str,
    feed: &str,
) -> Result<LinkMetadata, FetchError> {
    let source = Url::parse(source_url).map_err(|e| FetchError::InvalidUrl(e.to_string()))?;
    let title = tag_text(feed, "title");
    if title.as_deref().unwrap_or_default().is_empty() {
        return Err(FetchError::InvalidBody(
            "YouTube channel feed has no title".to_string(),
        ));
    }
    let preview_url = find_tags(feed, "media:thumbnail")
        .into_iter()
        .find_map(|tag| attr(&tag, "url"))
        .and_then(|value| resolve_url(&source, &value));

    Ok(LinkMetadata {
        final_url: source_url.to_string(),
        site_name: Some("YouTube".to_string()),
        title,
        provider: Some("YouTube".to_string()),
        description: Some("YouTube channel".to_string()),
        preview_url,
        favicon_url: Some("https://www.youtube.com/favicon.ico".to_string()),
    })
}

pub fn extract_html_metadata(base_url: &str, html: &str) -> Result<LinkMetadata, FetchError> {
    let base = Url::parse(base_url).map_err(|e| FetchError::InvalidUrl(e.to_string()))?;
    let title = meta_content(html, "property", "og:title")
        .or_else(|| meta_content(html, "name", "twitter:title"))
        .or_else(|| tag_text(html, "title"));
    let description = meta_content(html, "property", "og:description")
        .or_else(|| meta_content(html, "name", "description"))
        .or_else(|| meta_content(html, "name", "twitter:description"));
    let site_name = meta_content(html, "property", "og:site_name");
    let preview_url = meta_content(html, "property", "og:image")
        .or_else(|| meta_content(html, "name", "twitter:image"))
        .and_then(|url| resolve_url(&base, &url));
    let favicon_url = link_href(html, "icon")
        .or_else(|| link_href(html, "shortcut icon"))
        .and_then(|url| resolve_url(&base, &url))
        .or_else(|| resolve_url(&base, "/favicon.ico"));

    Ok(LinkMetadata {
        final_url: base.to_string(),
        site_name,
        title,
        provider: None,
        description,
        preview_url,
        favicon_url,
    })
}

/// Collapses existing duplicate favicons: for each distinct favicon `source_url`
/// that multiple Link Cards referenced, re-point every card to the first stored
/// asset and record it in the dedup cache. Runs once at startup; orphaned files
/// are cleaned by the regular asset GC.
pub fn collapse_favicon_duplicates(conn: &mut rusqlite::Connection) -> Result<i64, WorkspaceError> {
    // Favicon URLs live only in embed_cards (enrichment refreshes them); the
    // simplest deterministic dedup is: per source_url, keep the lowest asset id
    // among current favicon_asset_id values, re-point the rest, and fill cache.
    let groups: Vec<(String, Vec<String>)> = {
        let mut stmt = conn
            .prepare(
                "SELECT e.source_url, a.id FROM embed_cards e
                 JOIN assets a ON a.id = e.favicon_asset_id
                 WHERE e.favicon_asset_id IS NOT NULL AND e.source_url <> ''
                 ORDER BY e.source_url, a.id",
            )
            .map_err(WorkspaceError::from)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(WorkspaceError::from)?;
        let mut map: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for row in rows.flatten() {
            map.entry(row.0).or_default().push(row.1);
        }
        map.into_iter().collect()
    };

    let mut collapsed = 0i64;
    let tx = conn.transaction().map_err(WorkspaceError::from)?;
    for (source_url, asset_ids) in &groups {
        let Some(first) = asset_ids.first() else {
            continue;
        };
        // Record the canonical mapping for future enrichment.
        tx.execute(
            "INSERT OR REPLACE INTO favicon_cache (source_url, asset_id) VALUES (?1, ?2)",
            rusqlite::params![source_url, first],
        )
        .map_err(WorkspaceError::from)?;
        // Re-point any embed that uses a later asset id.
        for asset_id in asset_ids.iter().skip(1) {
            let changed = tx
                .execute(
                    "UPDATE embed_cards SET favicon_asset_id = ?1 WHERE favicon_asset_id = ?2",
                    rusqlite::params![first, asset_id],
                )
                .map_err(WorkspaceError::from)?;
            collapsed += changed as i64;
        }
    }
    tx.commit().map_err(WorkspaceError::from)?;
    Ok(collapsed)
}

pub fn enrich_embed_with_metadata(
    conn: &mut rusqlite::Connection,
    asset_dir: &Path,
    fetcher: &dyn MetadataFetcher,
    id: &str,
    expected_revision: i64,
) -> Result<crate::domain::models::EmbedCardDto, WorkspaceError> {
    let embed = workspace_repository::load_embed_for_metadata(conn, id, expected_revision)?;
    let source_url = embed.source_url.clone();

    let result = fetch_link_metadata(fetcher, &source_url);
    let update = match result {
        Ok(metadata) => {
            let preview_asset_id = download_optional_image(
                conn,
                asset_dir,
                fetcher,
                metadata.preview_url.as_deref(),
                "preview",
                None,
            )?;
            let favicon_asset_id = download_optional_image(
                conn,
                asset_dir,
                fetcher,
                metadata.favicon_url.as_deref(),
                "favicon",
                metadata.favicon_url.as_deref(),
            )?;
            // A user-authored description is authoritative and never overwritten
            // by site metadata. Fall back to the site description only when empty.
            let user_description = embed.description_plain_text.trim();
            let is_user_origin = embed.description_origin.as_deref() == Some("user");
            let (description, description_origin) =
                if !user_description.is_empty() && is_user_origin {
                    (user_description.to_string(), Some("user".to_string()))
                } else if user_description.is_empty() {
                    let site = metadata.description.unwrap_or_default();
                    (
                        site.clone(),
                        if site.is_empty() {
                            None
                        } else {
                            Some("site".to_string())
                        },
                    )
                } else {
                    // Non-empty but not user-marked (legacy rows): keep it, mark as user.
                    (user_description.to_string(), Some("user".to_string()))
                };
            ApplyEmbedMetadataInput {
                id: id.to_string(),
                expected_revision,
                display_url: display_url(&metadata.final_url).unwrap_or(embed.display_url),
                site_name: metadata.site_name,
                title: metadata.title.unwrap_or(embed.title),
                provider: metadata.provider,
                description_json: plain_text_document(&description),
                description_plain_text: description,
                description_origin,
                preview_asset_id,
                favicon_asset_id,
                metadata_status: "ready".to_string(),
                metadata_error: None,
            }
        }
        Err(error) => ApplyEmbedMetadataInput {
            id: id.to_string(),
            expected_revision,
            display_url: embed.display_url,
            site_name: None,
            title: embed.title,
            provider: None,
            description_json: plain_text_document(&embed.description_plain_text),
            description_plain_text: embed.description_plain_text.clone(),
            description_origin: embed.description_origin.clone(),
            preview_asset_id: None,
            favicon_asset_id: None,
            metadata_status: "failed".to_string(),
            metadata_error: Some(error.to_string()),
        },
    };

    workspace_repository::apply_embed_metadata(conn, &update)
}

fn fetch_link_metadata(
    fetcher: &dyn MetadataFetcher,
    source_url: &str,
) -> Result<LinkMetadata, FetchError> {
    if let Some(oembed_url) = youtube_oembed_url(source_url) {
        if let Ok(response) = fetcher.fetch_text(&oembed_url) {
            if let Ok(metadata) = parse_oembed(source_url, &response) {
                return Ok(metadata);
            }
        }
    }

    // Official YouTube oEmbed does not support /channel/<id>. The public Atom
    // feed still provides a stable channel title and latest-video thumbnail,
    // without API keys or consent-page scraping.
    if let Some(feed_url) = youtube_channel_feed_url(source_url) {
        if let Ok(response) = fetcher.fetch_text(&feed_url) {
            if let Ok(feed) = String::from_utf8(response.bytes) {
                if let Ok(metadata) = extract_youtube_feed_metadata(source_url, &feed) {
                    return Ok(metadata);
                }
            }
        }
    }

    validate_public_http_url(source_url)?;
    let response = fetcher.fetch_text(source_url)?;
    let html = String::from_utf8_lossy(&response.bytes);
    extract_html_metadata(&response.final_url, &html)
}

fn parse_oembed(source_url: &str, response: &FetchResponse) -> Result<LinkMetadata, FetchError> {
    let json: Value = serde_json::from_slice(&response.bytes)
        .map_err(|e| FetchError::InvalidBody(e.to_string()))?;
    Ok(LinkMetadata {
        final_url: source_url.to_string(),
        site_name: json
            .get("provider_name")
            .and_then(Value::as_str)
            .map(clean_text),
        title: json.get("title").and_then(Value::as_str).map(clean_text),
        provider: json
            .get("provider_name")
            .and_then(Value::as_str)
            .map(clean_text),
        description: json
            .get("author_name")
            .and_then(Value::as_str)
            .map(|author| format!("Channel: {}", clean_text(author))),
        preview_url: json
            .get("thumbnail_url")
            .and_then(Value::as_str)
            .and_then(|url| resolve_url(&Url::parse(source_url).ok()?, url)),
        favicon_url: Url::parse(source_url)
            .ok()
            .and_then(|url| resolve_url(&url, "/favicon.ico")),
    })
}

fn download_optional_image(
    conn: &mut rusqlite::Connection,
    asset_dir: &Path,
    fetcher: &dyn MetadataFetcher,
    url: Option<&str>,
    fallback_name: &str,
    cache_key: Option<&str>,
) -> Result<Option<String>, WorkspaceError> {
    let Some(url) = url else {
        return Ok(None);
    };
    validate_public_http_url(url)
        .map_err(|e| WorkspaceError::ConstraintViolation(e.to_string()))?;

    // Favicon dedup: reuse one stored asset per source URL.
    if let Some(key) = cache_key {
        let existing: Option<String> = conn
            .query_row(
                "SELECT asset_id FROM favicon_cache WHERE source_url = ?1",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(asset_id) = existing {
            // Confirm the asset row still exists (it may have been GC'd).
            let still = conn
                .query_row(
                    "SELECT COUNT(*) FROM assets WHERE id = ?1",
                    [&asset_id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0);
            if still > 0 {
                return Ok(Some(asset_id));
            }
        }
    }

    let response = match fetcher.fetch_image(url) {
        Ok(response) if is_supported_image_mime(&response.mime_type) => response,
        _ => return Ok(None),
    };
    let file_name =
        filename_from_url(&response.final_url).unwrap_or_else(|| fallback_name.to_string());
    let asset = asset_service::store_asset_bytes(
        conn,
        asset_dir,
        &file_name,
        &response.mime_type,
        &response.bytes,
    )?;
    if let Some(key) = cache_key {
        conn.execute(
            "INSERT OR REPLACE INTO favicon_cache (source_url, asset_id) VALUES (?1, ?2)",
            rusqlite::params![key, asset.id],
        )?;
    }
    Ok(Some(asset.id))
}

fn validate_public_url_without_dns(url: &Url) -> Result<(), FetchError> {
    match url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(FetchError::BlockedUrl(format!(
                "unsupported scheme: {scheme}"
            )))
        }
    }

    match url.host() {
        Some(Host::Ipv4(ip)) if is_public_ip(IpAddr::V4(ip)) => Ok(()),
        Some(Host::Ipv6(ip)) if is_public_ip(IpAddr::V6(ip)) => Ok(()),
        Some(Host::Ipv4(ip)) => Err(FetchError::BlockedUrl(format!("private address: {ip}"))),
        Some(Host::Ipv6(ip)) => Err(FetchError::BlockedUrl(format!("private address: {ip}"))),
        Some(Host::Domain(domain)) => {
            let normalized = domain.trim_end_matches('.').to_ascii_lowercase();
            if normalized == "localhost" || normalized.ends_with(".localhost") {
                Err(FetchError::BlockedUrl(normalized))
            } else {
                Ok(())
            }
        }
        None => Err(FetchError::InvalidUrl("missing host".to_string())),
    }
}

fn resolve_public_addresses(url: &Url) -> Result<Vec<SocketAddr>, FetchError> {
    validate_public_url_without_dns(url)?;
    let Some(host) = url.host_str() else {
        return Err(FetchError::InvalidUrl("missing host".to_string()));
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| FetchError::Network(format!("dns lookup failed: {e}")))?
        .collect();
    if addresses.is_empty() {
        return Err(FetchError::Network(
            "dns lookup returned no addresses".to_string(),
        ));
    }
    for address in &addresses {
        if !is_public_ip(address.ip()) {
            return Err(FetchError::BlockedUrl(format!(
                "private resolved address: {}",
                address.ip()
            )));
        }
    }
    Ok(addresses)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 224)
        }
        IpAddr::V6(ip) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local())
        }
    }
}

fn is_supported_image_mime(mime_type: &str) -> bool {
    matches!(
        mime_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "image/jpeg"
            | "image/jpg"
            | "image/png"
            | "image/webp"
            | "image/gif"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
    )
}

fn meta_content(html: &str, attr_name: &str, attr_value: &str) -> Option<String> {
    find_tags(html, "meta").into_iter().find_map(|tag| {
        let value = attr(&tag, attr_name)?;
        if value.eq_ignore_ascii_case(attr_value) {
            attr(&tag, "content").map(|value| clean_text(&value))
        } else {
            None
        }
    })
}

fn link_href(html: &str, rel: &str) -> Option<String> {
    find_tags(html, "link").into_iter().find_map(|tag| {
        let value = attr(&tag, "rel")?;
        if value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .eq_ignore_ascii_case(rel)
        {
            attr(&tag, "href").map(|value| clean_text(&value))
        } else {
            None
        }
    })
}

fn tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let start = lower.find(&open)?;
    let content_start = lower[start..].find('>')? + start + 1;
    let close = format!("</{tag}>");
    let content_end = lower[content_start..].find(&close)? + content_start;
    Some(clean_text(&html[content_start..content_end]))
}

fn find_tags(html: &str, tag: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("<{tag}");
    let mut tags = Vec::new();
    let mut offset = 0;
    while let Some(found) = lower[offset..].find(&needle) {
        let start = offset + found;
        let Some(end) = lower[start..].find('>') else {
            break;
        };
        tags.push(html[start..start + end + 1].to_string());
        offset = start + end + 1;
    }
    tags
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut offset = 0;
    let needle = name.to_ascii_lowercase();
    while let Some(found) = lower[offset..].find(&needle) {
        let start = offset + found;
        let before_ok = start == 0
            || lower.as_bytes()[start - 1].is_ascii_whitespace()
            || lower.as_bytes()[start - 1] == b'<';
        let after = start + needle.len();
        let after_ok = after < lower.len()
            && (lower.as_bytes()[after].is_ascii_whitespace() || lower.as_bytes()[after] == b'=');
        if before_ok && after_ok {
            let mut i = after;
            while i < lower.len() && lower.as_bytes()[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= lower.len() || lower.as_bytes()[i] != b'=' {
                return None;
            }
            i += 1;
            while i < lower.len() && lower.as_bytes()[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= lower.len() {
                return None;
            }
            let quote = lower.as_bytes()[i];
            if quote == b'"' || quote == b'\'' {
                i += 1;
                let value_start = i;
                while i < lower.len() && lower.as_bytes()[i] != quote {
                    i += 1;
                }
                return Some(decode_basic_entities(&tag[value_start..i]));
            }
            let value_start = i;
            while i < lower.len()
                && !lower.as_bytes()[i].is_ascii_whitespace()
                && lower.as_bytes()[i] != b'>'
            {
                i += 1;
            }
            return Some(decode_basic_entities(&tag[value_start..i]));
        }
        offset = after;
    }
    None
}

fn clean_text(value: &str) -> String {
    decode_basic_entities(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn decode_basic_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn resolve_url(base: &Url, value: &str) -> Option<String> {
    base.join(value).ok().map(|url| url.to_string())
}

fn filename_from_url(source: &str) -> Option<String> {
    let url = Url::parse(source).ok()?;
    let name = url.path_segments()?.next_back()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn display_url(source: &str) -> Option<String> {
    let url = Url::parse(source).ok()?;
    let host = url.host_str()?.trim_start_matches("www.");
    let path = url.path().trim_end_matches('/');
    if path.is_empty() || path == "/" {
        Some(host.to_string())
    } else {
        Some(format!("{host}{path}"))
    }
}

fn plain_text_document(text: &str) -> Value {
    if text.is_empty() {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]})
    } else {
        serde_json::json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": text }]
            }]
        })
    }
}
