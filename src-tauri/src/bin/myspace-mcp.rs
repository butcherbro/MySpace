//! Development entry point for the MCP server (`cargo run --bin myspace-mcp`).
//! Installed apps run the same server as `myspace --mcp`; see `myspace_lib::mcp`.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(myspace_lib::mcp::run(&args));
}
