//! What an FBX is, read in well under a second, before minutes of Blender.
//!
//! FBX keeps node and bone names as plain strings (only arrays are compressed), so a byte scan
//! tells the families apart with the same markers the adapters check after a full import:
//! `CC_Base_Hip` (adapt_cc), `lShldrBend` + `lEyelidUpper` (adapt_daz, Genesis 3/8/8.1),
//! `lShldr` without `Bend` (Genesis 1/2, which carry no blink or expression morph and are
//! refused -- ENVIRONMENT.md s23). Face markers: `facs_bs_` (8.1 FACS morphs exported, s26),
//! `A01_Brow_Inner_Up` (CC ARKit profile), `Eye_Blink_L` (CC Traditional profile, s24).

use memchr::memmem;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Daz,
    Cc,
    Unknown,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FbxInfo {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub kind: Kind,
    /// "Genesis 8.1", "Character Creator", ...
    pub family: String,
    /// How the face will be built, in the person's words.
    pub face: String,
    pub supported: bool,
    /// Things the person should know, or do in Daz/CC, before converting.
    pub notes: Vec<String>,
    pub suggested_name: String,
}

fn has(data: &[u8], needle: &str) -> bool {
    memmem::find(data, needle.as_bytes()).is_some()
}

/// `lShldr` followed by anything but `Bend` (Genesis 1/2's shoulder bone).
fn has_old_shoulder(data: &[u8]) -> bool {
    memmem::find_iter(data, b"lShldr").any(|i| data.get(i + 6) != Some(&b'B'))
}

/// A VRM name from a file name: letters, digits, `-` and `_` only.
pub fn suggest_name(file_stem: &str) -> String {
    let s: String = file_stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let s = s.trim_matches('_').to_owned();
    if s.is_empty() { "avatar".into() } else { s }
}

pub fn inspect_bytes(data: &[u8]) -> (Kind, String, String, bool, Vec<String>) {
    let mut notes = Vec::new();
    if has(data, "CC_Base_Hip") {
        let face = if has(data, "A01_Brow_Inner_Up") {
            "ARKit 52 expressions (best)"
        } else if has(data, "Eye_Blink_L") {
            notes.push(
                "This character uses CC's Traditional facial profile: it converts, with 33 of the \
                 52 face-tracking shapes. Switching it to the ARKit profile in CC gives all 52."
                    .into(),
            );
            "Traditional profile (33 of 52 shapes)"
        } else {
            notes.push(
                "No face morphs found. Re-export from CC with facial expressions included, or the \
                 avatar will not blink or talk."
                    .into(),
            );
            "none found"
        };
        return (
            Kind::Cc,
            "Character Creator".into(),
            face.into(),
            true,
            notes,
        );
    }
    let g38 = has(data, "lShldrBend") && has(data, "lEyelidUpper");
    if g38 {
        let family = if has(data, "Genesis8_1") {
            "Genesis 8.1"
        } else if has(data, "Genesis8") {
            "Genesis 8"
        } else if has(data, "Genesis3") {
            "Genesis 3"
        } else {
            "Genesis 3 / 8"
        };
        let face = if has(data, "facs_bs_") {
            "FACS morphs: all 52 ARKit shapes (best)"
        } else {
            if family == "Genesis 8.1" {
                notes.push(
                    "For the best face, re-export with the FACS morphs: in Daz's FBX export, open \
                     Edit Morph Export Rules and add a rule matching \"facs\" set to Export."
                        .into(),
                );
            }
            "posed from the face bones (26 of 52 shapes)"
        };
        return (Kind::Daz, family.into(), face.into(), true, notes);
    }
    if has_old_shoulder(data) {
        notes.push(
            "Genesis 1 and 2 exports carry no blink or expression morphs, so no converter can make \
             this face move. Use a Genesis 3, 8 or 8.1 figure."
                .into(),
        );
        return (
            Kind::Daz,
            "Genesis 1 / 2".into(),
            "no expressions in the file".into(),
            false,
            notes,
        );
    }
    notes.push(
        "This does not look like a Daz Genesis or Character Creator export (no Genesis or CC_Base \
         skeleton inside)."
            .into(),
    );
    (Kind::Unknown, "Unknown".into(), "-".into(), false, notes)
}

pub fn inspect(path: &Path) -> Result<FbxInfo, String> {
    let is_fbx = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("fbx"));
    if !is_fbx {
        return Err("Choose an .fbx file exported from Daz Studio or Character Creator.".into());
    }
    let data = std::fs::read(path).map_err(|e| format!("Could not read the file: {e}"))?;
    let (kind, family, face, supported, notes) = inspect_bytes(&data);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(FbxInfo {
        path: path.display().to_string(),
        file_name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size_bytes: data.len() as u64,
        kind,
        family,
        face,
        supported,
        notes,
        suggested_name: suggest_name(&stem),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_the_families_apart() {
        let cc = b"..CC_Base_Hip..A01_Brow_Inner_Up..Eye_Blink_L..";
        let (k, f, face, ok, notes) = inspect_bytes(cc);
        assert_eq!((k, f.as_str(), ok), (Kind::Cc, "Character Creator", true));
        assert!(face.starts_with("ARKit"));
        assert!(notes.is_empty());

        let (_, _, face, _, notes) = inspect_bytes(b"CC_Base_Hip Eye_Blink_L");
        assert!(face.starts_with("Traditional"));
        assert_eq!(notes.len(), 1);

        let g81 = b"Genesis8_1Female lShldrBend lEyelidUpper facs_bs_EyeBlinkL";
        let (k, f, face, ok, notes) = inspect_bytes(g81);
        assert_eq!((k, f.as_str(), ok), (Kind::Daz, "Genesis 8.1", true));
        assert!(face.starts_with("FACS"));
        assert!(notes.is_empty());

        // 8.1 without the morph rule: converts, with advice
        let (_, _, face, _, notes) = inspect_bytes(b"Genesis8_1Female lShldrBend lEyelidUpper");
        assert!(face.starts_with("posed"));
        assert_eq!(notes.len(), 1);

        let (_, f, _, _, _) = inspect_bytes(b"Genesis3Female lShldrBend lEyelidUpper");
        assert_eq!(f, "Genesis 3");

        // Genesis 1/2: lShldr with no Bend, refused
        let (k, _, _, ok, _) = inspect_bytes(b"Genesis2 lShldr\x00 lForeArm");
        assert_eq!((k, ok), (Kind::Daz, false));

        let (k, _, _, ok, _) = inspect_bytes(b"Mixamo:Hips");
        assert_eq!((k, ok), (Kind::Unknown, false));
    }

    #[test]
    fn names_are_file_safe() {
        assert_eq!(
            suggest_name("genesis8.1AliceTest_01"),
            "genesis8_1AliceTest_01"
        );
        assert_eq!(suggest_name("My Character (v2)"), "My_Character__v2");
        assert_eq!(suggest_name("***"), "avatar");
    }
}
