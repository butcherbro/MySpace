//! Pixel size of an image from its header bytes (PNG, GIF, JPEG, WebP).
//!
//! The UI measures images in the browser; backend writers (the MCP adapter)
//! need the size to give an image card its aspect ratio. Only headers are
//! parsed, so a caller can pass the first [`HEADER_PROBE_BYTES`] of a file.
//! JPEG EXIF orientation is ignored: a rotated photo gets a letterboxed card,
//! never a cropped one (`object-fit: contain`).

/// Enough for a JPEG whose SOF marker follows a large EXIF/ICC block.
pub const HEADER_PROBE_BYTES: usize = 512 * 1024;

/// Returns `(width, height)` in pixels, or `None` for an unknown or truncated
/// header.
pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let size = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        png(bytes)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some((le16(bytes, 6)? as u32, le16(bytes, 8)? as u32))
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        jpeg(bytes)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        webp(bytes)
    } else {
        None
    }?;
    (size.0 > 0 && size.1 > 0).then_some(size)
}

fn le16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn le24(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        0,
    ]))
}

fn png(b: &[u8]) -> Option<(u32, u32)> {
    if b.get(12..16)? != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(b.get(16..20)?.try_into().ok()?);
    let h = u32::from_be_bytes(b.get(20..24)?.try_into().ok()?);
    Some((w, h))
}

fn jpeg(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    loop {
        // Markers may be padded with any number of 0xFF fill bytes.
        while *b.get(i)? == 0xFF && *b.get(i + 1)? == 0xFF {
            i += 1;
        }
        if *b.get(i)? != 0xFF {
            return None;
        }
        let marker = *b.get(i + 1)?;
        // Standalone markers carry no length.
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = be16(b, i + 2)? as usize;
        let is_sof = matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF);
        if is_sof {
            let h = be16(b, i + 5)? as u32;
            let w = be16(b, i + 7)? as u32;
            return Some((w, h));
        }
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
}

fn webp(b: &[u8]) -> Option<(u32, u32)> {
    match b.get(12..16)? {
        b"VP8 " => {
            // Keyframe start code, then 14-bit width and height.
            if b.get(23..26)? != [0x9D, 0x01, 0x2A] {
                return None;
            }
            Some((
                (le16(b, 26)? & 0x3FFF) as u32,
                (le16(b, 28)? & 0x3FFF) as u32,
            ))
        }
        b"VP8L" => {
            if *b.get(20)? != 0x2F {
                return None;
            }
            let bits = u32::from_le_bytes(b.get(21..25)?.try_into().ok()?);
            Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
        }
        b"VP8X" => Some((le24(b, 24)? + 1, le24(b, 27)? + 1)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b
    }

    #[test]
    fn reads_png() {
        assert_eq!(image_dimensions(&png_header(640, 480)), Some((640, 480)));
    }

    #[test]
    fn reads_gif() {
        let mut b = b"GIF89a".to_vec();
        b.extend_from_slice(&300u16.to_le_bytes());
        b.extend_from_slice(&200u16.to_le_bytes());
        assert_eq!(image_dimensions(&b), Some((300, 200)));
    }

    #[test]
    fn reads_jpeg_after_an_app_segment() {
        let mut b = vec![0xFF, 0xD8];
        // APP1 with a 4-byte payload, then SOF0: len, precision, height, width.
        b.extend_from_slice(&[0xFF, 0xE1, 0x00, 0x06, 1, 2, 3, 4]);
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&720u16.to_be_bytes());
        b.extend_from_slice(&1280u16.to_be_bytes());
        assert_eq!(image_dimensions(&b), Some((1280, 720)));
    }

    #[test]
    fn reads_webp_variants() {
        let riff = |chunk: &[u8], body: &[u8]| {
            let mut b = b"RIFF\x00\x00\x00\x00WEBP".to_vec();
            b.extend_from_slice(chunk);
            b.extend_from_slice(&[0, 0, 0, 0]);
            b.extend_from_slice(body);
            b
        };
        let mut vp8 = vec![0, 0, 0, 0x9D, 0x01, 0x2A];
        vp8.extend_from_slice(&400u16.to_le_bytes());
        vp8.extend_from_slice(&300u16.to_le_bytes());
        assert_eq!(image_dimensions(&riff(b"VP8 ", &vp8)), Some((400, 300)));

        let bits: u32 = (100 - 1) | ((50 - 1) << 14);
        let mut vp8l = vec![0x2F];
        vp8l.extend_from_slice(&bits.to_le_bytes());
        assert_eq!(image_dimensions(&riff(b"VP8L", &vp8l)), Some((100, 50)));

        let mut vp8x = vec![0, 0, 0, 0];
        vp8x.extend_from_slice(&[0xFF, 0x03, 0x00]); // 1024 - 1
        vp8x.extend_from_slice(&[0xFF, 0x02, 0x00]); // 768 - 1
        assert_eq!(image_dimensions(&riff(b"VP8X", &vp8x)), Some((1024, 768)));
    }

    #[test]
    fn rejects_unknown_truncated_and_empty() {
        assert_eq!(image_dimensions(b"not an image"), None);
        assert_eq!(image_dimensions(&png_header(640, 480)[..18]), None);
        assert_eq!(image_dimensions(&png_header(0, 480)), None);
        assert_eq!(image_dimensions(&[0xFF, 0xD8, 0xFF]), None);
    }
}
