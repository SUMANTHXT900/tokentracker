//! CLI helper used by the Vite dev server to serve 100% real `tokscale-core`
//! snapshots when previewing in a browser outside the Tauri WebView.

use tokentracker_lib::adapter::parse_to_snapshot_async;

#[tokio::main]
async fn main() {
    let mut clients: Option<Vec<String>> = None;
    let mut since: Option<String> = None;
    let mut until: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--clients" => {
                if let Some(val) = args.next() {
                    let list: Vec<String> = val
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    if !list.is_empty() {
                        clients = Some(list);
                    }
                }
            }
            "--since" => {
                if let Some(val) = args.next() {
                    if !val.trim().is_empty() {
                        since = Some(val);
                    }
                }
            }
            "--until" => {
                if let Some(val) = args.next() {
                    if !val.trim().is_empty() {
                        until = Some(val);
                    }
                }
            }
            _ => {}
        }
    }

    match parse_to_snapshot_async(None, clients, since, until, None).await {
        Ok(mut snap) => {
            snap.rows.clear();
            match serde_json::to_string(&snap) {
                Ok(json) => print!("{json}"),
                Err(e) => {
                    eprintln!("Failed to serialize snapshot: {e}");
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to parse snapshot: {e}");
            std::process::exit(1);
        }
    }
}
