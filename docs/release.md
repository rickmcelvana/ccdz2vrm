# Releasing

Two things ship, separately:

- **The Windows app** — a `v*` tag builds the installer in GitHub Actions
  (`.github/workflows/release.yml`) and attaches it to a **draft** release. Nothing reaches
  anyone until you publish the draft.
- **The website** — `https://ccdz2vrm.latentpresence.com`, the same page converting in the
  browser. Your server builds it from a checkout: [`deploy.md`](deploy.md).

The installer is **unsigned** (as latentPresence's): Windows SmartScreen asks "More info → Run
anyway" until code signing lands. There is no updater; a new version is a new download.

## Each release

1. Raise the version in **all three**: `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` (e.g. `0.2.0`). The release and the installer are named from
   `tauri.conf.json`.
2. Commit, push, and wait for the gate (Actions → **gate**).
3. Tag and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. Actions → **release** runs the gate again, then builds. Then GitHub → Releases: the draft
   `ccdz2vrm v0.2.0` should have `ccdz2vrm_0.2.0_x64-setup.exe`. Edit the notes if you like,
   then **Publish release**.
5. Update the website on the server (`deploy.md` §2) so the site and the app match.

Links that always point at the newest published release:

- the release page: `https://github.com/rickmcelvana/ccdz2vrm/releases/latest`
- the installer itself:
  `https://github.com/rickmcelvana/ccdz2vrm/releases/latest/download/ccdz2vrm_<version>_x64-setup.exe`
  (the file name carries the version, so this one changes each release; link the release page)

## If the release job fails

- **At the gate**: the same `pnpm gate` as on your machine; fix, commit, delete the tag
  (`git push origin :refs/tags/v0.2.0`, `git tag -d v0.2.0`) and tag again.
- **At the build**: re-run the job from Actions; a half-made draft is replaced by the next run
  for the same tag.
