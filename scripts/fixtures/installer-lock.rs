//! Windows installer regression fixture: a parent with a child holding an exclusive file handle.
use std::os::windows::fs::OpenOptionsExt;
use std::{env, fs, process::Command, thread, time::Duration};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args[1] == "parent" {
        let mut child = Command::new(&args[2])
            .args(["child", &args[3], &args[4]])
            .spawn()
            .unwrap();
        let _ = child.wait();
    } else {
        let _file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&args[2])
            .unwrap();
        fs::write(&args[3], std::process::id().to_string()).unwrap();
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
}
