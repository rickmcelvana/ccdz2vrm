//! Finding the user's Blender, and whether it can run the pipeline.
//!
//! The app ships no Blender (GPL, ~400 MB, and people who make Daz/CC characters often have one).
//! It needs 4.2+ (extensions, where the VRM add-on lives) and the VRM add-on itself; the pipeline
//! was verified on 5.2.2 with add-on 4.7.1 (docs/ENVIRONMENT.md).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Oldest Blender with the extensions platform the VRM add-on installs from.
pub const MIN_VERSION: (u32, u32) = (4, 2);

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlenderStatus {
    /// The blender executable in use, if any was found or chosen.
    pub path: Option<String>,
    /// "5.2.2" -- from `blender --version`.
    pub version: Option<String>,
    pub version_ok: bool,
    /// The VRM add-on's version, when installed.
    pub vrm_addon: Option<String>,
    /// Every Blender found on this machine, newest first, for the picker.
    pub found: Vec<String>,
    /// One sentence for the person when something is wrong.
    pub problem: Option<String>,
}

impl BlenderStatus {
    pub fn ready(&self) -> bool {
        self.path.is_some() && self.version_ok && self.vrm_addon.is_some()
    }
}

/// A `Command` for Blender that opens no console window on Windows.
pub fn command(exe: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Every blender executable in the usual install places, newest version first.
pub fn discover() -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let exe = if cfg!(windows) {
        "blender.exe"
    } else {
        "blender"
    };
    if cfg!(windows) {
        for root in ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"] {
            if let Ok(dir) = std::env::var(root) {
                let foundation = Path::new(&dir).join("Blender Foundation");
                if let Ok(entries) = std::fs::read_dir(&foundation) {
                    for e in entries.flatten() {
                        found.push(e.path().join(exe));
                    }
                }
            }
        }
        for root in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Ok(dir) = std::env::var(root) {
                found.push(
                    Path::new(&dir)
                        .join(r"Steam\steamapps\common\Blender")
                        .join(exe),
                );
            }
        }
    } else if cfg!(target_os = "macos") {
        found.push(PathBuf::from(
            "/Applications/Blender.app/Contents/MacOS/Blender",
        ));
    } else {
        found.push(PathBuf::from("/snap/bin/blender"));
        found.push(PathBuf::from("/usr/bin/blender"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            found.push(dir.join(exe));
        }
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|p| p.is_file() && seen.insert(p.canonicalize().unwrap_or_else(|_| p.clone())));
    // Newest first, read from the folder name ("Blender 5.2") where there is one.
    found.sort_by_key(|p| {
        std::cmp::Reverse(
            p.parent()
                .and_then(|d| d.file_name())
                .and_then(|n| parse_version(&n.to_string_lossy()))
                .unwrap_or((0, 0, 0)),
        )
    });
    found
}

/// "Blender 5.2.2 LTS" or "Blender 5.2" -> (5, 2, 2) / (5, 2, 0).
pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let rest = &text[text.find("Blender")? + "Blender".len()..];
    let token = rest.split_whitespace().next()?;
    let mut parts = token.split('.').map(|p| p.parse::<u32>().ok());
    let major = parts.next()??;
    let minor = parts.next()??;
    let patch = parts.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

fn run(exe: &Path, args: &[&str]) -> std::io::Result<Output> {
    command(exe).args(args).output()
}

/// The Python run inside Blender to read the VRM add-on's version. Prints one `CCDZ {json}` line.
const ADDON_PROBE: &str = "import addon_utils, json\n\
v = None\n\
for m in addon_utils.modules():\n    \
if m.__name__ in ('bl_ext.blender_org.vrm', 'io_scene_vrm'):\n        \
v = '.'.join(map(str, addon_utils.module_bl_info(m).get('version', ())))\n\
print('CCDZ ' + json.dumps({'vrm': v or None}))\n";

/// Everything the setup card shows, for one executable (or the best one found).
pub fn status(chosen: Option<&Path>) -> BlenderStatus {
    let found = discover();
    let mut s = BlenderStatus {
        found: found.iter().map(|p| p.display().to_string()).collect(),
        ..Default::default()
    };
    let Some(exe) = chosen
        .map(Path::to_path_buf)
        .or_else(|| found.first().cloned())
    else {
        s.problem = Some("Blender was not found on this computer.".into());
        return s;
    };
    s.path = Some(exe.display().to_string());
    if !exe.is_file() {
        s.problem = Some("That Blender is no longer there. Choose it again.".into());
        return s;
    }
    let version = run(&exe, &["--version"])
        .ok()
        .and_then(|o| parse_version(&String::from_utf8_lossy(&o.stdout)));
    let Some((major, minor, patch)) = version else {
        s.problem = Some("That file did not answer like Blender does.".into());
        return s;
    };
    s.version = Some(format!("{major}.{minor}.{patch}"));
    s.version_ok = (major, minor) >= MIN_VERSION;
    if !s.version_ok {
        s.problem = Some(format!(
            "Blender {major}.{minor} is too old: the VRM add-on needs {}.{} or newer.",
            MIN_VERSION.0, MIN_VERSION.1
        ));
        return s;
    }
    s.vrm_addon = vrm_addon(&exe);
    if s.vrm_addon.is_none() {
        s.problem =
            Some("Blender needs the VRM add-on (free, from extensions.blender.org).".into());
    }
    s
}

fn vrm_addon(exe: &Path) -> Option<String> {
    let out = run(
        exe,
        &[
            "--background",
            "--factory-startup",
            "--python-expr",
            ADDON_PROBE,
        ],
    )
    .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find_map(|l| l.strip_prefix("CCDZ "))?;
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get("vrm")?.as_str().map(str::to_owned)
}

/// Install and enable "VRM format" from extensions.blender.org with Blender's own CLI.
/// Returns Blender's output when it fails.
pub fn install_vrm_addon(exe: &Path) -> Result<(), String> {
    let out = run(
        exe,
        &[
            "--command",
            "extension",
            "install",
            "--sync",
            "--enable",
            "vrm",
        ],
    )
    .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        Err(text.trim().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_versions_from_blender_and_folder_names() {
        assert_eq!(
            parse_version("Blender 5.2.2 LTS\n\tbuild date: 2026"),
            Some((5, 2, 2))
        );
        assert_eq!(parse_version("Blender 4.2"), Some((4, 2, 0)));
        assert_eq!(parse_version("Blender Foundation"), None);
        assert_eq!(parse_version("nothing"), None);
    }

    #[test]
    fn version_gate() {
        assert!((4, 2) >= MIN_VERSION);
        assert!((5, 0) >= MIN_VERSION);
        assert!((4, 1) < MIN_VERSION);
        assert!((3, 6) < MIN_VERSION);
    }
}
