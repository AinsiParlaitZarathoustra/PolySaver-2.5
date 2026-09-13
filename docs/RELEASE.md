# PolySaver 2.5 — Release & CI notes

Operational notes for the release pipeline. Written on 2026-09-13.

## Hidden prerequisites

### 1. The release needs a minisign signing key

`release.yml` refuses to start when `TAURI_SIGNING_PRIVATE_KEY` is missing, and the
updater cannot work without it. The secret must be set on **the repository that
runs the release workflow** (`PolySaver-2.5`), not on the old `PolySaver` repo:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The **full content** of the minisign private key file (never a hash or a re-encoded base64 blob) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password, or an empty value when the key has none |

The public half must match `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
If the key is regenerated, the pubkey must be replaced in the same commit —
otherwise every existing installation silently stops receiving updates.

### 2. The updater endpoint must point at a **public** repository

The configured endpoint is:

```
https://github.com/AinsiParlaitZarathoustra/PolySaver-2.5/releases/latest/download/latest.json
```

GitHub requires authentication to read releases of a **private** repository, so this
URL only works while `PolySaver-2.5` is public.

> **Open decision (owner).** The owner asked for a private repository, but a private
> repository breaks the auto-updater for end users. The recommended split is:
> keep the **development** repository private and publish **releases** to a public
> repository (the existing `PolySaver`, or a dedicated `PolySaver-releases`).
> If that split is adopted, this endpoint must be changed to the public repository.
> Publishing a release from a private repository without this split ships an app
> that can never update itself.

### 3. Sidecars must be provisioned before any cargo command

`tauri.conf.json` declares `resources/bin/*` as a bundle resource, and `tauri-build`
fails with `GlobPathNotFound` when that glob matches nothing. Since
`src-tauri/resources/bin/` is gitignored, **every** job that runs cargo must call
`bash scripts/prepare-sidecars.sh <platform>` first. This was the root cause of the
previously broken `e2e-downloads.yml`.

`prepare-sidecars.sh` deletes and recreates the target directory on every run, so
caching `src-tauri/resources/bin` is pointless: the CI caches the expensive
**macOS ffmpeg build** (`/tmp/polysaver_macos-aarch64_ffmpeg`, `..._ffprobe`) instead
and lets the yt-dlp download re-run (it is small and always hash-verified).

## Publishing a release

1. Make sure `Cargo.toml` (`[workspace.package] version`), `package.json` and
   `src-tauri/tauri.conf.json` all carry the same version — the `validate` job fails
   otherwise.
2. Trigger the `Release` workflow with `version: 2.5.0`, or push a `v2.5.0` tag.
3. The three platform jobs build and stage the assets; `publish` assembles them,
   regenerates `latest.json` + `SHA256SUMS.txt`, verifies the checksums of what
   GitHub actually stored, then publishes with `--latest`.

Expected release content is **exactly 12 assets**:

```
PolySaver_<v>_macOS_arm64.dmg
PolySaver_<v>_macOS_arm64.app.tar.gz          + .sig
PolySaver_<v>_Windows_x64_Setup.exe           + .sig
PolySaver_<v>_Windows_x64.msi                 + .sig
PolySaver_<v>_Linux_x64.AppImage              + .sig
PolySaver_<v>_Linux_x64.deb
latest.json
SHA256SUMS.txt
```

`scripts/generate-release-metadata.mjs` validates all of this locally. Its
`--self-test` mode replays the generation on synthetic fixtures and asserts the
failure paths (truncated signature, missing asset), so the script can be checked in
CI without a build:

```bash
node scripts/generate-release-metadata.mjs --self-test
```

`latest.json` is validated **as a whole** by the Tauri updater before it compares
versions: one malformed platform entry breaks updates for every platform. That is
why the script now verifies each `.sig` is a structurally valid minisign block
(`untrusted comment:` + base64 payload starting with the `Ed` algorithm marker)
instead of only checking that it is non-empty.

## Windows/Linux sidecars depend on a third-party build that expires

The Windows and Linux ffmpeg binaries come from the `BtbN/FFmpeg-Builds` project, which
**prunes its old `autobuild-*` tags**. A pinned tag that works today can return 404 in a
few weeks, and that is exactly how both non-macOS CI legs were broken without anyone
noticing — they had never been executed.

When `prepare-sidecars.sh` fails on a 404 for `BtbN/FFmpeg-Builds`:

1. Open <https://github.com/BtbN/FFmpeg-Builds/releases> and pick the newest
   `autobuild-*` tag.
2. Read its `checksums.sha256` asset and copy the line for the wanted artifact.
3. Update both `FFMPEG_ZIP_URL`/`FFMPEG_ZIP_SHA256` (Windows) or
   `FFMPEG_TAR_URL`/`FFMPEG_TAR_SHA256` (Linux) in `scripts/prepare-sidecars.sh`.
4. Verify locally with `shasum -a 256 <downloaded-file>`.

The script now prints these instructions itself when a download fails, instead of
surfacing a bare curl error.

## Tests must wait for state, never sleep a fixed duration

The download pipeline runs in a background task. Tests that assert on its outcome
must poll for the expected state (`wait_for_terminal`, `wait_for_history`,
`wait_until` in `crates/polysaver-core/tests/invariants.rs`), never `sleep` for a
fixed number of milliseconds. Fixed sleeps are what made the Linux CI leg fail
while macOS passed on the very same commit: the runner was simply slower than the
development machine. The polling helpers allow up to 10 s and return as soon as the
state is reached, so they are both faster locally and reliable on CI.

## Runner notes

- `ubuntu-22.04` is used deliberately for the Linux build: it is the last runner
  providing glibc 2.35, which is the compatibility floor for our AppImage/deb.
  GitHub announced its deprecation on **2026-09-17** and removal on **2027-04-17**
  (with job brownouts in between). Before then, move that job into a `debian:12` or
  `ubuntu:22.04` container running on `ubuntu-24.04` to keep the same glibc floor.
- `ubuntu-22.04-arm` only exists for public repositories and is intentionally absent
  from the CI matrix.
- Node is pinned through `node-version.txt` (single source of truth shared with the
  JavaScript runtime installer); do not hardcode a Node version in workflows.
