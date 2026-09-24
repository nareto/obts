use std::fs;
use std::path::Path;
use std::process::Command;

use obts_bridge::root_ignore::{MAX_ROOT_IGNORE_BYTES, RootIgnoreError, RootIgnorePolicy};
use sha1::{Digest, Sha1};

fn command(program: &str, args: &[&str], root: &Path) -> std::process::Output {
    Command::new(program)
        .args(args)
        .current_dir(root)
        .output()
        .unwrap()
}

#[test]
fn matches_native_git_and_shared_js() {
    let vault = tempfile::tempdir().unwrap();
    assert!(
        command("git", &["init", "-q"], vault.path())
            .status
            .success()
    );
    let cases: &[(&str, &[(&str, bool)])] = &[
        (
            "\u{feff}*.md\n",
            &[("note.md", false), ("other.txt", false)],
        ),
        (
            "*.md\r\n!important.md\r\n",
            &[("note.md", false), ("important.md", false)],
        ),
        (
            "*.md\n!important.md\n",
            &[
                ("note.md", false),
                ("sub/note.md", false),
                ("important.md", false),
                ("sub/important.md", false),
            ],
        ),
        (
            "/root.txt\nsub/file.txt\n",
            &[
                ("root.txt", false),
                ("nested/root.txt", false),
                ("sub/file.txt", false),
                ("nested/sub/file.txt", false),
            ],
        ),
        (
            "cache/\n!cache/keep.txt\n",
            &[
                ("cache", true),
                ("cache/drop.txt", false),
                ("cache/keep.txt", false),
                ("deep/cache/drop.txt", false),
            ],
        ),
        (
            "cache/\n!cache/\n!cache/keep.txt\n",
            &[
                ("cache", true),
                ("cache/drop.txt", false),
                ("cache/keep.txt", false),
            ],
        ),
        (
            "**/logs/*.log\nfoo/**/draft?.md\n",
            &[
                ("logs/a.log", false),
                ("sub/logs/a.log", false),
                ("logs/sub/a.log", false),
                ("foo/draft1.md", false),
                ("foo/a/b/draft2.md", false),
            ],
        ),
        (
            "# comment\n\\#literal\n\\!literal\nname\\ with\\ space\ntrailing\\ \n",
            &[
                ("#literal", false),
                ("!literal", false),
                ("name with space", false),
                ("trailing ", false),
                ("comment", false),
            ],
        ),
        (
            "Case.md\nCafé.md\n",
            &[
                ("Case.md", false),
                ("case.md", false),
                ("Café.md", false),
                ("Cafe\u{301}.md", false),
            ],
        ),
        (
            "*.gitignore\n.gitignore\n",
            &[(".gitignore", false), ("folder/.gitignore", false)],
        ),
        (
            "foo\n!foo/bar\n",
            &[("foo", true), ("foo/bar", false), ("foo/bar/deep", false)],
        ),
        (
            "foo/\n",
            &[("foo", false), ("foo", true), ("foo/child", false)],
        ),
    ];
    let js_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/shared/rootIgnore.cjs");
    for &(rules, paths) in cases {
        fs::write(vault.path().join(".gitignore"), rules).unwrap();
        let policy = RootIgnorePolicy::read(vault.path()).unwrap();
        for &(path, is_dir) in paths {
            let normalized: String =
                unicode_normalization::UnicodeNormalization::nfc(path).collect();
            let git_path = format!("{normalized}{}", if is_dir { "/" } else { "" });
            let git = command(
                "git",
                &[
                    "-c",
                    "core.excludesFile=/dev/null",
                    "-c",
                    "core.ignoreCase=false",
                    "check-ignore",
                    "--no-index",
                    "-q",
                    "--",
                    &git_path,
                ],
                vault.path(),
            );
            assert!(
                matches!(git.status.code(), Some(0 | 1)),
                "git: {}",
                String::from_utf8_lossy(&git.stderr)
            );
            let expected = git.status.code() == Some(0) && normalized != ".gitignore";
            let js = Command::new("node")
                .arg("-e")
                .arg("const p=require(process.argv[1]).createRootIgnorePolicy(Buffer.from(process.argv[2])); process.stdout.write(String(p.ignores(process.argv[3],process.argv[4]==='true')))")
                .arg(&js_path).arg(rules).arg(path).arg(is_dir.to_string())
                .output().unwrap();
            assert!(
                js.status.success(),
                "JS: {}",
                String::from_utf8_lossy(&js.stderr)
            );
            assert_eq!(
                String::from_utf8(js.stdout).unwrap(),
                expected.to_string(),
                "JS: {rules:?} -> {path}"
            );
            assert_eq!(
                policy.ignores(path, is_dir).unwrap(),
                expected,
                "Rust: {rules:?} -> {path}"
            );
        }
    }
}

#[test]
fn validates_bytes_paths_and_git_blob_identity() {
    let absent = RootIgnorePolicy::from_bytes(None).unwrap();
    assert!(absent.blob_oid.is_none());
    assert!(!absent.ignores("notes.md", false).unwrap());
    let empty = RootIgnorePolicy::from_bytes(Some(b"")).unwrap();
    assert_eq!(
        empty.blob_oid.as_deref(),
        Some("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
    );
    let bytes = b"*.md\n";
    let mut sha = Sha1::new();
    sha.update(format!("blob {}\0", bytes.len()).as_bytes());
    sha.update(bytes);
    let policy = RootIgnorePolicy::from_bytes(Some(bytes)).unwrap();
    assert_eq!(policy.blob_oid, Some(format!("{:x}", sha.finalize())));
    let mut git = Command::new("git")
        .args(["hash-object", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    git.stdin.take().unwrap().write_all(bytes).unwrap();
    let git = git.wait_with_output().unwrap();
    assert!(git.status.success());
    assert_eq!(
        policy.blob_oid.as_deref(),
        Some(String::from_utf8(git.stdout).unwrap().trim())
    );
    for invalid in [&b"\xff"[..], &b"\xc0\x80"[..], &b"foo\0bar"[..]] {
        assert!(RootIgnorePolicy::from_bytes(Some(invalid)).is_err());
    }
    assert!(matches!(
        RootIgnorePolicy::from_bytes(Some(&vec![b'a'; MAX_ROOT_IGNORE_BYTES + 1])),
        Err(RootIgnoreError::TooLarge)
    ));
    let boundary = vec![b' '; MAX_ROOT_IGNORE_BYTES];
    assert!(RootIgnorePolicy::from_bytes(Some(&boundary)).is_ok());
    let js_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/shared/rootIgnore.cjs");
    for (kind, accepted) in [
        ("absent", true),
        ("empty", true),
        ("boundary", true),
        ("oversized", false),
        ("utf8", false),
        ("nul", false),
    ] {
        let js = Command::new("node")
            .arg("-e")
            .arg("const f=require(process.argv[1]).createRootIgnorePolicy; const k=process.argv[2]; const b=k==='absent'?null:k==='empty'?Buffer.alloc(0):k==='utf8'?Buffer.from([255]):k==='nul'?Buffer.from([0]):Buffer.alloc(k==='boundary'?1048576:1048577,32); try { f(b); process.stdout.write('ok') } catch(e) { process.stdout.write(e.code) }")
            .arg(&js_path).arg(kind).output().unwrap();
        assert!(
            js.status.success(),
            "JS: {}",
            String::from_utf8_lossy(&js.stderr)
        );
        assert_eq!(js.stdout == b"ok", accepted, "JS {kind}");
    }
    for path in [
        "",
        "/absolute",
        "../escape",
        "a//b",
        "a\\b",
        "a/./b",
        "a/",
        "a\0b",
    ] {
        assert!(
            matches!(
                policy.ignores(path, false),
                Err(RootIgnoreError::InvalidPath)
            ),
            "{path:?}"
        );
    }
    assert!(!policy.ignores(".gitignore", false).unwrap());
}

#[test]
fn reads_only_regular_root_policy() {
    let vault = tempfile::tempdir().unwrap();
    assert!(
        RootIgnorePolicy::read(vault.path())
            .unwrap()
            .blob_oid
            .is_none()
    );
    let path = vault.path().join(".gitignore");
    fs::create_dir(&path).unwrap();
    assert!(matches!(
        RootIgnorePolicy::read(vault.path()),
        Err(RootIgnoreError::NonRegular)
    ));
    fs::remove_dir(&path).unwrap();
    fs::write(&path, b"\xff").unwrap();
    assert!(matches!(
        RootIgnorePolicy::read(vault.path()),
        Err(RootIgnoreError::InvalidEncoding(_))
    ));
    fs::write(&path, vec![b'a'; MAX_ROOT_IGNORE_BYTES + 1]).unwrap();
    assert!(matches!(
        RootIgnorePolicy::read(vault.path()),
        Err(RootIgnoreError::TooLarge)
    ));
    fs::write(&path, b"*.md\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        if command("id", &["-u"], vault.path()).stdout != b"0\n" {
            assert!(matches!(
                RootIgnorePolicy::read(vault.path()),
                Err(RootIgnoreError::Io(_))
            ));
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(
        RootIgnorePolicy::read(vault.path())
            .unwrap()
            .ignores("test.md", false)
            .unwrap()
    );
    #[cfg(unix)]
    {
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("missing", &path).unwrap();
        assert!(matches!(
            RootIgnorePolicy::read(vault.path()),
            Err(RootIgnoreError::NonRegular)
        ));
        fs::remove_file(&path).unwrap();
        let outside = vault.path().join("outside.md");
        fs::write(&outside, b"*.md\n").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(matches!(
            RootIgnorePolicy::read(vault.path()),
            Err(RootIgnoreError::NonRegular)
        ));
        fs::remove_file(&path).unwrap();
        let mut fifo = Command::new("mkfifo").arg(&path).spawn().unwrap();
        assert!(fifo.wait().unwrap().success());
        assert!(matches!(
            RootIgnorePolicy::read(vault.path()),
            Err(RootIgnoreError::NonRegular)
        ));
    }
}
