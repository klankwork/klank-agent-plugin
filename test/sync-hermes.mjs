#!/usr/bin/env node
// Copies skills/ and the REST scripts into hermes/, the Hermes package.
//
// Hermes loads a portable Agent Plugins package from a folder with a root
// plugin.json and mcp.json. This repository's root cannot carry those (Codex
// would load them over .codex-plugin), and Hermes refuses symlinks that leave
// the package folder, so hermes/ holds copies. `npm test` fails when they
// drift; run `npm run sync:hermes` after editing skills/ or scripts/.

import { cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const dir of ["skills", "scripts"]) {
  rmSync(join(ROOT, "hermes", dir), { recursive: true, force: true });
  cpSync(join(ROOT, dir), join(ROOT, "hermes", dir), { recursive: true });
}
console.log("hermes/skills and hermes/scripts synced");
