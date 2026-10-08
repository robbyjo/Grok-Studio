#![windows_subsystem = "windows"]
use std::os::windows::process::CommandExt;
use std::{
    env,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 3 {
        return;
    }
    let worker = PathBuf::from(&args[0]);
    let journal = PathBuf::from(&args[1]);
    let log = PathBuf::from(&args[2]);
    if worker.parent() != journal.parent() || journal.parent() != log.parent() {
        return;
    }
    let Some(root) = journal.parent() else {
        return;
    };
    let Ok(mut output) = OpenOptions::new().append(true).create(true).open(&log) else {
        return;
    };
    let Ok(stderr) = output.try_clone() else {
        return;
    };
    let Ok(stdout) = output.try_clone() else {
        return;
    };
    let system = env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let powershell = PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    // This GUI bootstrapper is launched detached from Node's kill-on-exit job.
    // PowerShell itself must have ordinary (hidden) console startup, not DETACHED_PROCESS.
    let result = Command::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&worker)
        .arg("-Journal")
        .arg(&journal)
        .arg("-LauncherPid")
        .arg(std::process::id().to_string())
        .current_dir(root)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .and_then(|mut child| child.wait());
    match result {
        Ok(status) if status.success() => {}
        Ok(status) => {
            let _ = writeln!(output, "Updater worker exited: {status}");
        }
        Err(error) => {
            let _ = writeln!(output, "Updater worker launch failed: {error}");
        }
    }
}
