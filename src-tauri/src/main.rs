// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `myspace --mcp`: the agent-facing MCP server over stdio, no window
    // (myspace_lib::mcp). Agent hosts launch the installed app this way.
    if args.iter().any(|a| a == "--mcp") {
        std::process::exit(myspace_lib::mcp::run(&args));
    }
    myspace_lib::run()
}
