# Peer OpenCode Plugin

Exposes `peer`'s deterministic Rust PR engine (`peer_analyze`, `peer_finalize`, `peer_publish`) as native OpenCode tools using OpenCode's own active model and session.

## Installation

1. Build and install the `peer` binary into your `PATH`:
   ```bash
   bun run build && cp dist/peer ~/.local/bin/peer
   ```
2. Copy or symlink `plugins/opencode/index.ts` into your project's `.opencode/plugins/peer.ts` (or `~/.config/opencode/plugins/peer.ts`).
