use super::*;
use std::io::Cursor;

#[test]
fn full_read_hash_is_sha256_and_requires_a_complete_strict_read() {
    assert_eq!(
        full_read_content_hash("abc", 0, false, true).as_deref(),
        Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    );
    assert_eq!(
        full_read_content_hash("", 0, false, true).as_deref(),
        Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    );
    assert_eq!(full_read_content_hash("abc", 1, false, true), None);
    assert_eq!(full_read_content_hash("abc", 0, true, true), None);
    assert_eq!(full_read_content_hash("abc", 0, false, false), None);
}

#[tokio::test]
async fn destination_hash_rejects_same_size_same_mtime_rewrite() {
    let mut original = Cursor::new(b"old bytes");
    let baseline = hash_editor_destination(&mut original)
        .await
        .unwrap()
        .unwrap();
    let mut changed = Cursor::new(b"new bytes");
    let actual = hash_editor_destination(&mut changed)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(baseline, actual);
    assert_eq!(baseline, sftp_content_hash(b"old bytes"));
    assert_eq!(actual, sftp_content_hash(b"new bytes"));
}

#[tokio::test]
async fn destination_hash_accepts_limit_and_bounds_oversized_reads() {
    let data = vec![b'x'; SFTP_EDIT_TEXT_MAX_BYTES + 1024];
    let mut exact = Cursor::new(&data[..SFTP_EDIT_TEXT_MAX_BYTES]);
    assert_eq!(
        hash_editor_destination(&mut exact).await.unwrap(),
        Some(sftp_content_hash(&data[..SFTP_EDIT_TEXT_MAX_BYTES]))
    );
    let mut oversized = Cursor::new(data);
    assert_eq!(hash_editor_destination(&mut oversized).await.unwrap(), None);
    assert_eq!(oversized.position(), SFTP_EDIT_TEXT_MAX_BYTES as u64 + 1);
}

#[tokio::test]
async fn strict_full_read_accepts_exactly_sixteen_mib_of_utf8() {
    let text = "🦀".repeat(SFTP_EDIT_TEXT_MAX_BYTES / 4);
    let size = text.len() as u64;
    let mut file = Cursor::new(text.as_bytes());
    let (content, offset, bytes, truncated) =
        read_text_page(&mut file, 0, SFTP_EDIT_TEXT_MAX_BYTES, size, true)
            .await
            .unwrap();
    assert_eq!(content, text);
    assert_eq!(offset, 0);
    assert_eq!(bytes, SFTP_EDIT_TEXT_MAX_BYTES);
    assert!(!truncated);
    assert!(validate_editor_text_size(bytes).is_ok());
    assert!(validate_editor_text_size(bytes + 1).is_err());
}

#[tokio::test]
async fn oversized_strict_full_read_is_marked_truncated() {
    let text = "x".repeat(SFTP_EDIT_TEXT_MAX_BYTES + 1);
    let mut file = Cursor::new(text.as_bytes());
    let (content, offset, bytes, truncated) = read_text_page(
        &mut file,
        0,
        SFTP_EDIT_TEXT_MAX_BYTES,
        text.len() as u64,
        true,
    )
    .await
    .unwrap();
    assert_eq!(offset, 0);
    assert_eq!(bytes, SFTP_EDIT_TEXT_MAX_BYTES);
    assert_eq!(content.len(), bytes);
    assert!(truncated);
}

#[tokio::test]
async fn strict_pages_reassemble_a_long_line_without_loss_or_duplicate_bytes() {
    let text = "aé中🦀".repeat(110_000);
    let mut file = Cursor::new(text.as_bytes());
    let mut next = 0;
    let mut assembled = String::new();
    loop {
        let (content, offset, bytes, truncated) =
            read_text_page(&mut file, next, 256 * 1024, text.len() as u64, true)
                .await
                .unwrap();
        assert_eq!(offset, next);
        assert!(bytes <= 256 * 1024);
        assert_eq!(bytes, content.len());
        assert!(text.is_char_boundary(offset as usize));
        next = offset + bytes as u64;
        assert!(text.is_char_boundary(next as usize));
        assembled.push_str(&content);
        if !truncated {
            break;
        }
        assert!(bytes > 0, "truncated pages must advance");
        assert!(file.position() <= next + 10, "lookaround must be bounded");
    }
    assert_eq!(next, text.len() as u64);
    assert_eq!(assembled, text);
}

#[tokio::test]
async fn every_seek_position_aligns_forward_and_reports_original_byte_offsets() {
    let text = "é中🦀aé🦀中z";
    for requested in 0..=text.len() + 3 {
        let mut file = Cursor::new(text.as_bytes());
        let mut expected = requested;
        while expected < text.len() && !text.is_char_boundary(expected) {
            expected += 1;
        }
        let (content, offset, bytes, truncated) =
            read_text_page(&mut file, requested as u64, 4, text.len() as u64, true)
                .await
                .unwrap();
        assert_eq!(offset, expected as u64, "requested={requested}");
        assert_eq!(content.len(), bytes);
        assert!(bytes <= 4);
        if expected >= text.len() {
            assert!(content.is_empty());
            assert!(!truncated);
        } else {
            assert!(text[expected..].starts_with(&content));
            assert!(text.is_char_boundary(expected + bytes));
            assert_eq!(truncated, expected + bytes < text.len());
            if truncated {
                assert!(bytes > 0);
            }
        }
    }
}

#[tokio::test]
async fn seek_alignment_keeps_enough_lookahead_for_a_split_four_byte_scalar() {
    // Requested offset 1 advances to 4. The four-byte page ends after the
    // first byte of the second crab; verifying it needs three more bytes.
    let text = "🦀abc🦀tail";
    let mut file = Cursor::new(text.as_bytes());
    let (content, offset, bytes, truncated) =
        read_text_page(&mut file, 1, 4, text.len() as u64, true)
            .await
            .unwrap();
    assert_eq!(content, "abc");
    assert_eq!(offset, 4);
    assert_eq!(bytes, 3);
    assert!(truncated);
}

#[tokio::test]
async fn mixed_width_seek_pages_match_the_largest_complete_utf8_prefix() {
    let text = "🦀abc🦀é中z".repeat(64);
    for requested in 0..128 {
        let mut expected = requested;
        while !text.is_char_boundary(expected) {
            expected += 1;
        }
        for limit in 4..=17 {
            let mut end = expected + limit;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            let mut file = Cursor::new(text.as_bytes());
            let (content, offset, bytes, truncated) =
                read_text_page(&mut file, requested as u64, limit, text.len() as u64, true)
                    .await
                    .unwrap();
            assert_eq!(offset, expected as u64, "seek={requested}, limit={limit}");
            assert_eq!(
                content,
                &text[expected..end],
                "seek={requested}, limit={limit}"
            );
            assert_eq!(bytes, end - expected);
            assert!(bytes > 0);
            assert!(truncated);
            assert!(file.position() <= requested as u64 + limit as u64 + 7);
        }
    }
}

#[tokio::test]
async fn malformed_bytes_fail_even_in_truncated_pages_and_at_split_scalars() {
    let invalid: &[&[u8]] = &[
        b"abc\xffrest",
        b"abc\xe0\x80\x80rest",     // overlong scalar crossing the page edge
        b"abc\xed\xa0\x80rest",     // surrogate
        b"abc\xf4\x90\x80\x80rest", // beyond Unicode
        b"abc\xe2xrest",            // malformed continuation
        b"abc\xf0\x9f",             // incomplete at EOF
    ];
    for data in invalid {
        let mut file = Cursor::new(*data);
        assert!(read_text_page(&mut file, 0, 4, data.len() as u64, true)
            .await
            .is_err());
    }
    // A long run of continuation bytes cannot be skipped until a valid lead
    // happens to appear, including at seek positions deep within the run.
    let data = vec![0x80; 512 * 1024];
    for offset in [0, 1, 3, 4, 256 * 1024, data.len() as u64 - 1] {
        let mut file = Cursor::new(data.as_slice());
        assert!(
            read_text_page(&mut file, offset, 256 * 1024, data.len() as u64, true)
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn seeks_into_malformed_scalars_reject_every_continuation_position() {
    let invalid: &[&[u8]] = &[
        b"\xc0\xaf",         // overlong two-byte scalar
        b"\xe0\x80\x80",     // overlong three-byte scalar
        b"\xed\xa0\x80",     // surrogate
        b"\xf0\x80\x80\x80", // overlong four-byte scalar
        b"\xf4\x90\x80\x80", // beyond Unicode
        b"\xf5\x80\x80\x80", // invalid lead
        b"\xf0\x9f",         // incomplete scalar at EOF
    ];
    for scalar in invalid {
        let mut data = vec![b'a'; 16];
        data.extend_from_slice(scalar);
        for requested in 16..data.len() {
            let mut file = Cursor::new(data.as_slice());
            assert!(
                read_text_page(&mut file, requested as u64, 4, data.len() as u64, true)
                    .await
                    .is_err(),
                "scalar={scalar:?}, seek={requested}"
            );
        }
    }
}

#[tokio::test]
async fn malformed_long_line_after_a_valid_page_fails_on_the_next_page() {
    let mut data = vec![b'a'; 256 * 1024];
    data.extend_from_slice(b"\xf0\x80\x80\x80");
    let mut file = Cursor::new(data.as_slice());
    let (_, offset, bytes, truncated) =
        read_text_page(&mut file, 0, 256 * 1024, data.len() as u64, true)
            .await
            .unwrap();
    assert!(truncated);
    assert_eq!(bytes, 256 * 1024);
    assert!(read_text_page(
        &mut file,
        offset + bytes as u64,
        256 * 1024,
        data.len() as u64,
        true
    )
    .await
    .is_err());
}

#[tokio::test]
async fn basic_preview_keeps_lossy_decode_and_raw_byte_accounting() {
    let data = b"a\xff\xe4\xb8\xadz";
    let mut file = Cursor::new(data.as_slice());
    let (content, offset, bytes, truncated) =
        read_text_page(&mut file, 1, 3, data.len() as u64, false)
            .await
            .unwrap();
    assert_eq!(content, String::from_utf8_lossy(&data[1..4]));
    assert_eq!(offset, 1);
    assert_eq!(bytes, 3);
    assert!(truncated);
}

#[test]
fn large_file_conflicts_check_size_and_mtime_independently() {
    let entry = SftpEntry {
        path: "/large.txt".to_string(),
        name: "large.txt".to_string(),
        kind: "file".to_string(),
        size_bytes: SFTP_EDIT_TEXT_MAX_BYTES as u64,
        mtime: 1_700_000_000_000,
    };
    assert!(!is_write_conflict(
        Some(entry.mtime),
        Some(entry.size_bytes),
        &entry
    ));
    assert!(is_write_conflict(
        Some(entry.mtime),
        Some(entry.size_bytes - 1),
        &entry
    ));
    assert!(is_write_conflict(
        Some(entry.mtime - 1000),
        Some(entry.size_bytes),
        &entry
    ));
    assert!(!is_write_conflict(None, None, &entry));
    assert!(!is_write_conflict(Some(entry.mtime), None, &entry));
    assert!(!is_write_conflict(None, Some(entry.size_bytes), &entry));
    assert!(is_write_conflict(Some(entry.mtime - 1000), None, &entry));
    assert!(is_write_conflict(None, Some(entry.size_bytes + 1), &entry));
}

#[test]
fn atomic_rename_payload_encodes_utf8_byte_lengths_and_paths() {
    let payload = sftp_rename_payload("/tmp/临时", "/tmp/目标").unwrap();
    let from_len = u32::from_be_bytes(payload[..4].try_into().unwrap()) as usize;
    assert_eq!(&payload[4..4 + from_len], "/tmp/临时".as_bytes());
    let start = 4 + from_len;
    let to_len = u32::from_be_bytes(payload[start..start + 4].try_into().unwrap()) as usize;
    assert_eq!(&payload[start + 4..], "/tmp/目标".as_bytes());
    assert_eq!(payload.len(), start + 4 + to_len);
}
