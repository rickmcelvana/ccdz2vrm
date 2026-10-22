//! The conversion as Blender runs: the same commands README.md gives for the CLI, planned here
//! from the person's choices and run one after another with their output streamed to the page.

use crate::fbx::Kind;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    /// 3-8 MB: what latentPresence and most web apps want.
    Web,
    /// 1K textures, full meshes.
    Desktop,
    /// 2K textures, arm twist split (Daz), for players that run node constraints.
    Max,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub fbx: String,
    pub kind: Kind,
    pub name: String,
    pub out_dir: String,
    pub quality: Quality,
    pub spring_bones: bool,
    pub twist_split: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stage {
    pub label: &'static str,
    pub args: Vec<String>,
}

/// Where the finished VRM goes: `<name>.web.vrm`, `<name>.vrm`, `<name>.max.vrm`.
pub fn output_path(req: &ConvertRequest) -> PathBuf {
    let suffix = match req.quality {
        Quality::Web => ".web",
        Quality::Desktop => "",
        Quality::Max => ".max",
    };
    Path::new(&req.out_dir).join(format!("{}{suffix}.vrm", req.name))
}

fn s(p: &Path) -> String {
    p.display().to_string()
}

/// The Blender invocations for one conversion. `scripts` holds src/blender/*.py, `job` is a
/// scratch folder for the intermediate .blend (and the web tier's unshrunk VRM).
pub fn plan(req: &ConvertRequest, scripts: &Path, job: &Path) -> Result<Vec<Stage>, String> {
    let adapter = match req.kind {
        Kind::Daz => "adapt_daz.py",
        Kind::Cc => "adapt_cc.py",
        Kind::Unknown => {
            return Err("This file is not a Daz Genesis or Character Creator export.".into());
        }
    };
    let blend = job.join("character.blend");
    let dst = output_path(req);
    let finished = if req.quality == Quality::Web {
        job.join("webbase.vrm")
    } else {
        dst.clone()
    };
    // --factory-startup keeps the person's own add-ons out of every step that does not need the
    // VRM add-on; the finisher loads their preferences so the add-on is found.
    let bg = |v: &[String]| -> Vec<String> {
        let mut a = vec![
            "--background".into(),
            "--factory-startup".into(),
            "--python-exit-code".into(),
            "1".into(),
        ];
        a.extend_from_slice(v);
        a
    };
    let mut stages = vec![Stage {
        label: "Reading your character",
        args: bg(&[
            "--python".into(),
            s(&scripts.join(adapter)),
            "--".into(),
            req.fbx.clone(),
            s(&blend),
            "--name".into(),
            req.name.clone(),
        ]),
    }];

    let mut finisher = vec![
        "--background".into(),
        "--python-exit-code".into(),
        "1".into(),
        s(&blend),
        "--python".into(),
        s(&scripts.join("vrm_export.py")),
        "--".into(),
        s(&finished),
        "--name".into(),
        req.name.clone(),
        "--max-texture".into(),
        if req.quality == Quality::Max {
            "2048"
        } else {
            "1024"
        }
        .into(),
    ];
    // Daz hair is the bulk of a web file and must be reduced before export (README).
    if req.quality == Quality::Web && req.kind == Kind::Daz {
        finisher.extend(["--max-mesh-verts".into(), "50000".into()]);
    }
    if req.twist_split && req.kind == Kind::Daz {
        finisher.push("--twist-split".into());
    }
    if req.spring_bones {
        finisher.push("--spring-bones".into());
    }
    stages.push(Stage {
        label: "Building the VRM",
        args: finisher,
    });

    if req.quality == Quality::Web {
        stages.push(Stage {
            label: "Shrinking it for the web",
            args: bg(&[
                "--python".into(),
                s(&scripts.join("glb_web.py")),
                "--".into(),
                s(&finished),
                s(&dst),
            ]),
        });
    }
    stages.push(Stage {
        label: "Checking the result",
        args: bg(&[
            "--python".into(),
            s(&scripts.join("vrm_check.py")),
            "--".into(),
            s(&dst),
        ]),
    });
    Ok(stages)
}

/// What the page hears while a conversion runs (`job` events).
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobEvent {
    Planned {
        labels: Vec<String>,
    },
    Stage {
        index: usize,
        state: &'static str,
        seconds: f64,
    },
    Log {
        line: String,
    },
    Done {
        output: String,
        bytes: u64,
        summary: serde_json::Value,
    },
    Failed {
        index: usize,
        message: String,
        log_tail: Vec<String>,
        job_dir: String,
    },
    Cancelled,
}

/// The running Blender, so Cancel can stop it.
#[derive(Default, Clone)]
pub struct Running {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
}

impl Running {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

/// The most useful line of a failed step: Python's `SystemExit("...")` message or the last
/// exception line, not Blender's "Error: script failed" or "Blender quit".
pub fn failure_message(lines: &[String]) -> String {
    let noise = |l: &str| {
        l.is_empty()
            || l.starts_with("Error: script failed")
            || l.starts_with("Blender quit")
            || l.starts_with("Exit with error")
            || l.starts_with("  ")
            || l.starts_with("Traceback")
    };
    lines
        .iter()
        .rev()
        .map(|l| l.trim_end())
        .find(|l| !noise(l))
        .unwrap_or("Blender stopped without saying why.")
        .to_owned()
}

/// Run every stage; `emit` gets each event. Blocking: call it on a thread of its own.
pub fn run(
    blender: &Path,
    req: &ConvertRequest,
    scripts: &Path,
    job: &Path,
    running: &Running,
    emit: &dyn Fn(JobEvent),
) {
    if running.busy.swap(true, Ordering::SeqCst) {
        emit(JobEvent::Failed {
            index: 0,
            message: "A conversion is already running.".into(),
            log_tail: vec![],
            job_dir: s(job),
        });
        return;
    }
    running.cancelled.store(false, Ordering::SeqCst);
    let result = run_inner(blender, req, scripts, job, running, emit);
    running.busy.store(false, Ordering::SeqCst);
    if let Err(ev) = result {
        emit(ev);
    }
}

fn run_inner(
    blender: &Path,
    req: &ConvertRequest,
    scripts: &Path,
    job: &Path,
    running: &Running,
    emit: &dyn Fn(JobEvent),
) -> Result<(), JobEvent> {
    let fail = |index: usize, message: String, log_tail: Vec<String>| JobEvent::Failed {
        index,
        message,
        log_tail,
        job_dir: s(job),
    };
    let stages = plan(req, scripts, job).map_err(|m| fail(0, m, vec![]))?;
    let _ = std::fs::remove_dir_all(job);
    std::fs::create_dir_all(job)
        .map_err(|e| fail(0, format!("Could not make a work folder: {e}"), vec![]))?;
    std::fs::create_dir_all(&req.out_dir)
        .map_err(|e| fail(0, format!("Could not make the output folder: {e}"), vec![]))?;
    emit(JobEvent::Planned {
        labels: stages.iter().map(|st| st.label.to_owned()).collect(),
    });

    let mut results = Vec::new();
    let mut check = None;
    for (index, stage) in stages.iter().enumerate() {
        let t0 = Instant::now();
        emit(JobEvent::Stage {
            index,
            state: "running",
            seconds: 0.0,
        });
        let lines = run_stage(blender, &stage.args, running, emit)
            .map_err(|e| fail(index, format!("Could not start Blender: {e}"), vec![]))?;
        if running.cancelled.load(Ordering::SeqCst) {
            return Err(JobEvent::Cancelled);
        }
        let (ok, log) = lines;
        if !ok {
            let tail = log.iter().rev().take(40).rev().cloned().collect();
            return Err(fail(index, failure_message(&log), tail));
        }
        for l in &log {
            if let Some(json) = l.strip_prefix("RESULT ")
                && let Ok(v) = serde_json::from_str::<serde_json::Value>(json)
            {
                results.push(v);
            }
            if l.starts_with("ok ") {
                check = Some(l.clone());
            }
        }
        emit(JobEvent::Stage {
            index,
            state: "done",
            seconds: t0.elapsed().as_secs_f64(),
        });
    }
    let dst = output_path(req);
    let bytes = std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
    // the .blend is 20-200 MB; a successful job needs nothing from the work folder
    let _ = std::fs::remove_dir_all(job);
    emit(JobEvent::Done {
        output: s(&dst),
        bytes,
        summary: summarize(&results, check.as_deref()),
    });
    Ok(())
}

/// What the page shows about a finished VRM: vrm_check's counts (`ok   <path>  {json}`) plus
/// the spring and twist results from the finisher's RESULT report.
pub fn summarize(results: &[serde_json::Value], check: Option<&str>) -> serde_json::Value {
    use serde_json::{Value, json};
    let mut out = check
        .and_then(|l| l.find('{').map(|i| &l[i..]))
        .and_then(|j| serde_json::from_str::<Value>(j).ok())
        .unwrap_or_else(|| json!({}));
    let springs = results
        .iter()
        .find_map(|r| r.pointer("/spring_export/springs").and_then(Value::as_u64))
        .unwrap_or(0);
    let twist = results.iter().any(|r| r.get("twist_constraints").is_some());
    let face = results
        .iter()
        .find_map(|r| r.get("face_source").cloned())
        .unwrap_or(Value::Null);
    if let Some(o) = out.as_object_mut() {
        o.insert("springs".into(), springs.into());
        o.insert("twistSplit".into(), twist.into());
        o.insert("faceSource".into(), face);
    }
    out
}

/// One Blender run. Returns (exit ok, every output line), streaming each line as a Log event.
fn run_stage(
    blender: &Path,
    args: &[String],
    running: &Running,
    emit: &dyn Fn(JobEvent),
) -> std::io::Result<(bool, Vec<String>)> {
    let mut child = crate::blender::command(blender)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let pump = |r: Box<dyn Read + Send>, tx: std::sync::mpsc::Sender<String>| {
        std::thread::spawn(move || {
            for line in BufReader::new(r).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })
    };
    let out = pump(Box::new(child.stdout.take().expect("piped")), tx.clone());
    let err = pump(Box::new(child.stderr.take().expect("piped")), tx);
    *running.child.lock().unwrap() = Some(child);
    if running.cancelled.load(Ordering::SeqCst) {
        running.cancel();
    }
    let mut log = Vec::new();
    for line in rx {
        // Blender's per-object progress lines are many and say nothing to a person
        if !line.starts_with("Fra:") {
            emit(JobEvent::Log { line: line.clone() });
        }
        log.push(line);
    }
    let _ = out.join();
    let _ = err.join();
    let status = running.child.lock().unwrap().take().map(|mut c| c.wait());
    let ok = matches!(status, Some(Ok(s)) if s.success());
    Ok((ok, log))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(kind: Kind, quality: Quality) -> ConvertRequest {
        ConvertRequest {
            fbx: "in.fbx".into(),
            kind,
            name: "alice".into(),
            out_dir: "out".into(),
            quality,
            spring_bones: true,
            twist_split: true,
        }
    }

    fn joined(st: &Stage) -> String {
        st.args.join(" ").replace('\\', "/")
    }

    #[test]
    fn web_daz_reduces_hair_then_shrinks() {
        let st = plan(
            &req(Kind::Daz, Quality::Web),
            Path::new("py"),
            Path::new("job"),
        )
        .unwrap();
        assert_eq!(st.len(), 4);
        assert!(
            joined(&st[0]).contains("py/adapt_daz.py -- in.fbx job/character.blend --name alice")
        );
        let fin = joined(&st[1]);
        assert!(
            fin.contains("job/webbase.vrm --name alice --max-texture 1024 --max-mesh-verts 50000")
        );
        assert!(fin.contains("--twist-split") && fin.contains("--spring-bones"));
        assert!(
            !fin.contains("--factory-startup"),
            "the finisher needs the VRM add-on from preferences"
        );
        assert!(joined(&st[2]).ends_with("py/glb_web.py -- job/webbase.vrm out/alice.web.vrm"));
        assert!(joined(&st[3]).ends_with("py/vrm_check.py -- out/alice.web.vrm"));
    }

    #[test]
    fn cc_skips_daz_only_flags() {
        let mut r = req(Kind::Cc, Quality::Max);
        r.spring_bones = false;
        let st = plan(&r, Path::new("py"), Path::new("job")).unwrap();
        assert_eq!(st.len(), 3);
        assert!(joined(&st[0]).contains("adapt_cc.py"));
        let fin = joined(&st[1]);
        assert!(fin.contains("out/alice.max.vrm --name alice --max-texture 2048"));
        assert!(
            !fin.contains("--twist-split")
                && !fin.contains("--spring-bones")
                && !fin.contains("--max-mesh-verts")
        );
    }

    #[test]
    fn desktop_writes_plain_name() {
        let r = req(Kind::Daz, Quality::Desktop);
        assert_eq!(output_path(&r), Path::new("out").join("alice.vrm"));
        assert!(
            plan(
                &req(Kind::Unknown, Quality::Web),
                Path::new("py"),
                Path::new("job")
            )
            .is_err()
        );
    }

    /// The real thing, through the runner the app uses: `CCDZ_TEST_FBX=<file> [CCDZ_TEST_QUALITY=
    /// web|desktop|max] cargo test -- --ignored --nocapture`. Needs Blender + the VRM add-on.
    #[test]
    #[ignore]
    fn converts_a_real_export() {
        let fbx = std::env::var("CCDZ_TEST_FBX").expect("set CCDZ_TEST_FBX");
        let info = crate::fbx::inspect(Path::new(&fbx)).unwrap();
        let quality = match std::env::var("CCDZ_TEST_QUALITY").as_deref() {
            Ok("desktop") => Quality::Desktop,
            Ok("max") => Quality::Max,
            _ => Quality::Web,
        };
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let r = ConvertRequest {
            fbx,
            kind: info.kind,
            name: info.suggested_name.clone(),
            out_dir: s(&root.join("out/app_test")),
            quality,
            spring_bones: true,
            twist_split: quality == Quality::Max,
        };
        let blender = crate::blender::discover()
            .into_iter()
            .next()
            .expect("no Blender found");
        let events = Mutex::new(Vec::new());
        let emit = |ev: JobEvent| {
            match &ev {
                JobEvent::Log { .. } => {}
                other => println!("{other:?}"),
            }
            events.lock().unwrap().push(ev);
        };
        run(
            &blender,
            &r,
            &root.join("src/blender"),
            &root.join("out/app_test/job"),
            &Running::default(),
            &emit,
        );
        let events = events.into_inner().unwrap();
        let last = events.last().unwrap();
        assert!(
            matches!(last, JobEvent::Done { bytes, .. } if *bytes > 1_000_000),
            "{last:?}"
        );
    }

    #[test]
    fn summary_keeps_what_the_page_shows() {
        let results = vec![
            serde_json::json!({"face_source": "facs_morphs", "meshes": {"a": 1}}),
            serde_json::json!({"spring_export": {"springs": 22}, "twist_constraints": 4}),
        ];
        let line = "ok   out/a.vrm  {\"bytes\": 6353228, \"human_bones\": 54, \"expressions\": 70}";
        let v = summarize(&results, Some(line));
        assert_eq!(v["bytes"], 6353228);
        assert_eq!(v["expressions"], 70);
        assert_eq!(v["springs"], 22);
        assert_eq!(v["twistSplit"], true);
        assert_eq!(v["faceSource"], "facs_morphs");
        assert_eq!(summarize(&[], None)["springs"], 0);
    }

    #[test]
    fn failure_message_finds_the_reason() {
        let log: Vec<String> = [
            "Traceback (most recent call last):",
            "  File \"adapt_daz.py\", line 55",
            "unsupported Daz rig family: genesis1_2",
            "Error: script failed, file: 'adapt_daz.py', exiting.",
            "",
            "Blender quit",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            failure_message(&log),
            "unsupported Daz rig family: genesis1_2"
        );
        assert_eq!(failure_message(&[]), "Blender stopped without saying why.");
    }
}
