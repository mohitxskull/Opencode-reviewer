import { join } from "node:path";

import { DEFAULT_PEER_TOML_TEMPLATE } from "../workspace/config.ts";

export async function runInitCommand(
  repoRoot: string,
  options: { fresh: boolean },
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): Promise<number> {
  const targetPath = join(repoRoot, "peer.toml");
  const file = Bun.file(targetPath);

  if ((await file.exists()) && !options.fresh) {
    writeErr(`Error: ${targetPath} already exists. Pass --fresh to overwrite.`);
    return 2;
  }

  await Bun.write(targetPath, DEFAULT_PEER_TOML_TEMPLATE);
  writeOut(`Created ${targetPath}`);
  return 0;
}
