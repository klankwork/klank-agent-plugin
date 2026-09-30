#!/usr/bin/env node
// Offline validation of the Klank agent plugin package. No dependencies: it
// runs anywhere node does, including a clean checkout with no network.
//
// What it proves:
//   1. every JSON file in the repository parses
//   2. no root Agent Plugins manifest (Codex would take its version and MCP
//      servers from it instead of .codex-plugin)
//   3. every MCP server the package declares is the literal production URL (no
//      headers, no variables, no key: clients sign in through the browser), and
//      the vendor manifests carry their listings and paths but no credential
//   4. every skill's frontmatter is a valid Agent Skills header
//   5. no credential material is checked in
//   6. every tool name a skill mentions is a real, frozen Klank tool
//   7. every script parses and is executable
//
// Check 6 is the one that earns its keep: skills are read by a model on every
// relevant turn, and a mistyped tool name is a call the client cannot make. So
// EVERY backticked bare identifier in `skills/**` must be either a frozen tool
// name (test/tool-names.json, kept in sync with the core repo's TOOLS.md) or
// listed in NON_TOOL_IDENTIFIERS below. Adding a field name to a skill means
// adding it there — that is the point: a typo has nowhere to hide.

import { readFileSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const notes = [];

const fail = (where, message) => errors.push(`${where}: ${message}`);
const rel = (path) => relative(ROOT, path) || ".";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const readText = (path) => readFileSync(path, "utf8");
const PRODUCTION_MCP = "https://api.klank.fun/mcp";

function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch (error) {
    fail(rel(path), `is not valid JSON — ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. every JSON file parses
// ---------------------------------------------------------------------------
const jsonFiles = files.filter((f) => f.endsWith(".json"));
const parsed = new Map();
for (const file of jsonFiles) {
  const value = readJson(file);
  if (value !== null) parsed.set(rel(file), value);
}

const requireFile = (name) => {
  const value = parsed.get(name);
  if (value === undefined) fail(name, "is missing (or did not parse)");
  return value;
};

// ---------------------------------------------------------------------------
// 2. no root Agent Plugins manifest
// ---------------------------------------------------------------------------
// Codex 0.153.4 takes the version and MCP servers from a root plugin.json +
// mcp.json (Agent Plugins) instead of .codex-plugin/plugin.json, so a root
// manifest silently overrides the Codex one. Every client this plugin targets
// reads its own manifest, so the root serves none of them.
for (const name of ["plugin.json", "mcp.json"]) {
  if (files.some((f) => rel(f) === name)) {
    fail(name, "must not exist at the root: Codex would load it over .codex-plugin/plugin.json");
  }
}

// Every MCP server the package declares, wherever it is declared, must be the
// production URL and nothing else: no headers, no env var, no key reference.
function checkServers(where, servers, type) {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    fail(where, "mcpServers must be an object");
    return;
  }
  const names = Object.keys(servers);
  if (names.length !== 1 || names[0] !== "klank") fail(where, 'mcpServers must hold exactly one server, "klank"');
  const server = servers.klank;
  if (!server) return;
  const keys = Object.keys(server).sort().join(",");
  if (keys !== "type,url") fail(where, `mcpServers.klank must hold only "type" and "url" (found ${keys})`);
  if (server.type !== type) fail(where, `mcpServers.klank.type must be "${type}"`);
  if (server.url !== PRODUCTION_MCP) fail(where, `mcpServers.klank.url must be the literal ${PRODUCTION_MCP}`);
}

// Every vendor manifest uses .mcp.json, with the transport spelled "http".
const dotMcp = requireFile(".mcp.json");
if (dotMcp) {
  const extra = Object.keys(dotMcp).filter((key) => key !== "mcpServers");
  if (extra.length) fail(".mcp.json", `only "mcpServers" is allowed (found ${extra.join(", ")})`);
  checkServers(".mcp.json", dotMcp.mcpServers, "http");
}

// ---------------------------------------------------------------------------
// 3. vendor manifests: listings and paths, no credential wiring
// ---------------------------------------------------------------------------
const VENDOR_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", ".plugin/plugin.json"];
for (const where of VENDOR_MANIFESTS) {
  const manifest = requireFile(where);
  if (!manifest) continue;
  if (manifest.name !== "klank") fail(where, `"name" must be "klank"`);
  // Claude Code's userConfig and Cursor's variables existed only to carry a key.
  for (const key of ["userConfig", "variables"]) {
    if (manifest[key] !== undefined) fail(where, `"${key}" must not exist: the plugin carries no credential`);
  }
  const mcp = manifest.mcpServers;
  if (typeof mcp === "object" && mcp !== null) checkServers(where, mcp, "http");
  else if (mcp !== undefined && mcp !== "./.mcp.json") fail(where, 'mcpServers must be "./.mcp.json" when set');
}
// Codex and Copilot name their MCP file; Claude Code and Cursor find .mcp.json.
for (const where of [".codex-plugin/plugin.json", ".plugin/plugin.json"]) {
  if (parsed.get(where) && parsed.get(where).mcpServers !== "./.mcp.json") fail(where, 'mcpServers must be "./.mcp.json"');
}

const marketplace = requireFile(".claude-plugin/marketplace.json");
if (marketplace) {
  const where = ".claude-plugin/marketplace.json";
  if (!marketplace.name) fail(where, "\"name\" is required");
  if (!marketplace.owner?.name) fail(where, "\"owner.name\" is required");
  const entry = (marketplace.plugins ?? [])[0];
  if (!entry) fail(where, "plugins[] must list the plugin");
  else if (!entry.name || !entry.source) fail(where, "plugins[0] needs name and source");
}

const codex = parsed.get(".codex-plugin/plugin.json");
if (codex) {
  const where = ".codex-plugin/plugin.json";
  if (codex.skills !== "./skills/") fail(where, 'skills must be "./skills/"');
  const iface = codex.interface;
  if (!iface) fail(where, "interface is missing");
  else {
    for (const key of ["displayName", "shortDescription", "longDescription", "developerName", "category", "brandColor"]) {
      if (!iface[key]) fail(where, `interface.${key} is missing`);
    }
    if (!Array.isArray(iface.capabilities) || iface.capabilities.length === 0) {
      fail(where, "interface.capabilities must be a non-empty array");
    }
    if (!Array.isArray(iface.defaultPrompt) || iface.defaultPrompt.length < 3) {
      fail(where, "interface.defaultPrompt must list at least three prompts");
    }
    for (const key of ["logo", "logoDark", "composerIcon"]) {
      if (iface[key]) fail(where, `interface.${key} names an image this package does not ship`);
    }
  }
}

const copilot = parsed.get(".plugin/plugin.json");
if (copilot) {
  if (copilot.skills !== "skills/") fail(".plugin/plugin.json", 'skills must be "skills/"');
  if (copilot.commands !== "commands/") fail(".plugin/plugin.json", 'commands must be "commands/"');
}

// Every path a manifest points at must exist.
for (const manifest of VENDOR_MANIFESTS) {
  for (const key of ["skills", "commands", "mcpServers"]) {
    const target = parsed.get(manifest)?.[key];
    if (typeof target !== "string") continue;
    try {
      statSync(join(ROOT, target));
    } catch {
      fail(manifest, `${key} points at ${target}, which does not exist`);
    }
  }
}

const codexMarketplace = requireFile(".agents/plugins/marketplace.json");
if (codexMarketplace) {
  const entry = (codexMarketplace.plugins ?? [])[0];
  if (codexMarketplace.name !== "klank" || entry?.name !== "klank") {
    fail(".agents/plugins/marketplace.json", 'must list the "klank" plugin in the "klank" marketplace');
  }
}

const versions = new Map(
  [...VENDOR_MANIFESTS, "package.json"].map((name) => [name, parsed.get(name)?.version]),
);
if (new Set(versions.values()).size !== 1) {
  fail("versions", `every manifest must carry the same version: ${JSON.stringify(Object.fromEntries(versions))}`);
}

// The setup skill states its own version so an agent can compare it with the
// latest release named by get_self's hint.
const setupSkill = readFileSync(join(ROOT, "skills/klank-setup/SKILL.md"), "utf8");
const statedVersion = setupSkill.match(/ships with Klank plugin \*\*([^*]+)\*\*/)?.[1];
if (statedVersion !== versions.get(".claude-plugin/plugin.json")) {
  fail("skills/klank-setup/SKILL.md", `must say "ships with Klank plugin **${versions.get(".claude-plugin/plugin.json")}**" (found ${statedVersion})`);
}

// ---------------------------------------------------------------------------
// 4. skills
// ---------------------------------------------------------------------------
const skillsDir = join(ROOT, "skills");
const EXPECTED_SKILLS = ["klank-api", "klank-artifacts", "klank-ceo", "klank-setup", "klank-worker"];
let skillDirs = [];
try {
  skillDirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory()).sort();
} catch {
  fail("skills/", "is missing");
}
for (const expected of EXPECTED_SKILLS) {
  if (!skillDirs.includes(expected)) fail("skills/", `skills/${expected} is missing`);
}

const skillBodies = new Map();
for (const dir of skillDirs) {
  const path = join(skillsDir, dir, "SKILL.md");
  const where = `skills/${dir}/SKILL.md`;
  let text;
  try {
    text = readText(path);
  } catch {
    fail(where, "is missing");
    continue;
  }
  skillBodies.set(where, text);

  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    fail(where, "has no YAML frontmatter delimited by --- lines");
    continue;
  }
  const front = match[1];
  const nameLine = front.match(/^name:[ \t]*(.*)$/m);
  const descLine = front.match(/^description:[ \t]*(.*)$/m);
  if (!nameLine) fail(where, "frontmatter has no name:");
  else if (nameLine[1].trim() !== dir) {
    fail(where, `frontmatter name "${nameLine[1].trim()}" must equal the directory name "${dir}"`);
  }
  if (!descLine) fail(where, "frontmatter has no description:");
  else {
    const description = descLine[1].trim();
    if (description.length === 0) fail(where, "description is empty");
    if (description.length > 1024) fail(where, `description is ${description.length} chars (max 1024)`);
    if (/^[>|]/.test(description)) fail(where, "description must be a single-line scalar, not a block");
    const yamlProblem = plainScalarProblem(description);
    if (yamlProblem) fail(where, `description ${yamlProblem}`);
  }
  for (const key of Object.keys(
    Object.fromEntries(
      front.split("\n").filter((l) => /^[A-Za-z-]+:/.test(l)).map((l) => [l.split(":")[0], true]),
    ),
  )) {
    if (!["name", "description", "license", "compatibility", "metadata", "allowed-tools"].includes(key)) {
      fail(where, `frontmatter key "${key}" is not in the Agent Skills field set`);
    }
  }
  // Claude Code namespaces plugin skills as /klank:<name>; other clients do
  // not. A skill that names its own command is wrong somewhere.
  const slash = text.match(/(?:^|\s)\/(klank[a-z:-]*)/m);
  if (slash) fail(where, `names a slash command ("/${slash[1]}"); skills must not`);
}

// ---------------------------------------------------------------------------
// 5. no credential material
// ---------------------------------------------------------------------------
// Assembled rather than written out, so this file can scan itself.
const CREDENTIAL_PREFIX = ["klank", "agent", ""].join("_");
for (const file of files) {
  let text;
  try {
    text = readText(file);
  } catch {
    continue;
  }
  if (text.includes(CREDENTIAL_PREFIX)) {
    fail(rel(file), `contains the literal agent-credential prefix; write "<your key>" instead`);
  }
}

// ---------------------------------------------------------------------------
// 6. tool names used in skills
// ---------------------------------------------------------------------------
const vendored = requireFile("test/tool-names.json");
// `session` tools exist only on a signed-in (OAuth) connection.
const TOOLS = vendored
  ? new Set([...vendored.worker, ...vendored.ceo, ...vendored.always, ...vendored.session])
  : new Set();

// The core repo's frozen list, when this checkout sits beside it. Drift is an
// error: the vendored copy is what CI validates against.
const TOOLS_MD =
  process.env.KLANK_TOOLS_MD ?? resolve(ROOT, "../klank/apps/api/src/mcp/TOOLS.md");
// In CI the sibling checkout does not exist, so the drift check would silently
// not run; require the override there.
if (process.env.CI && !process.env.KLANK_TOOLS_MD) {
  fail("KLANK_TOOLS_MD", "must point at the core repository's apps/api/src/mcp/TOOLS.md in CI");
}
try {
  const md = readText(TOOLS_MD);
  const upstream = new Set();
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*`([a-z_][a-z0-9_]*)`\s*\|/);
    if (m) upstream.add(m[1]);
  }
  if (upstream.size === 0) {
    fail(rel(TOOLS_MD), "was readable but no tool rows were found in it");
  } else {
    for (const name of upstream) {
      if (!TOOLS.has(name)) fail("test/tool-names.json", `is missing "${name}" from TOOLS.md`);
    }
    for (const name of TOOLS) {
      if (!upstream.has(name)) fail("test/tool-names.json", `lists "${name}", which TOOLS.md does not`);
    }
    notes.push(`tool names cross-checked against ${TOOLS_MD} (${upstream.size} tools)`);
  }
} catch {
  notes.push(`TOOLS.md not readable at ${TOOLS_MD}; validated against the vendored copy only`);
}

// The README's tool list is documentation people install from; it must name
// exactly the frozen tools.
{
  const readme = readText(join(ROOT, "README.md"));
  const section = readme.split(/^## Tools$/m)[1]?.split(/^## /m)[0] ?? "";
  const listed = new Set([...section.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map((m) => m[1]));
  if (listed.size === 0) fail("README.md", 'has no "## Tools" section listing the tools');
  for (const name of TOOLS) if (!listed.has(name)) fail("README.md", `## Tools is missing \`${name}\``);
  for (const name of listed) if (!TOOLS.has(name)) fail("README.md", `## Tools lists \`${name}\`, which is not a Klank tool`);
}

// Backticked bare identifiers in skills that are deliberately NOT tool names:
// request/response fields, problem codes, enum values, path segments and
// external commands. Anything not here and not a tool name is a typo.
const NON_TOOL_IDENTIFIERS = new Set([
  "video_id", "image_id", "poster_url",
  // the webhook delivery body (klank-setup step 1)
  "agent", "community", "task", "event_type", "data", "null",
  // result fields and the batch ack argument
  "key", "version", "inbox_item_ids", "requests",
  // request and response fields
  "review_epoch_id", "collecting", "verifying", "needs_dispatch", "held", "decided",
  "after", "agent_ids", "artifacts", "assignment_ids", "base_sha", "bio", "blocks", "branch",
  "claim_token", "granted", "already_running",
  "body", "brief", "content", "criteria", "current_version", "declared_tags",
  "duplicate_of", "expected_version", "has_more", "idempotency_key",
  "initiative_id", "instructions", "kind", "limit", "max_assignees", "meta",
  "name", "next_cursor", "options", "path", "primary", "primary_taxonomy_node_id",
  "provider", "query", "rationale", "ready", "reason", "reasons", "related_task_id",
  "related_task_key", "repository_id", "request_id", "required_checks",
  "response_due_at", "response_window_seconds", "reward_atomic", "runtime_kind", "search",
  "sha256", "size_bytes", "status", "tags", "taxonomy_tag_ids", "title", "url",
  "usage", "winning_submission_id", "workspace_head_sha",
  // the two reference arguments every scoped tool takes, and the path-style
  // ids that sit alongside them
  "assignment_id", "artifact_id", "community", "relation_id", "submission_id",
  "task", "task_id", "work_request_id",
  // further request fields
  "content_type", "filename", "head_sha", "method", "note", "state", "taxonomy",
  // MCP tool-result envelope fields and row fields the skills tell a model to read
  "acknowledged", "capabilities", "data", "hint", "replayed", "source_id",
  "total", "poll_after_seconds", "upload", "id",
  // describe_api rows
  "summary", "roles", "body_schema", "query_schema",
  // get_self and list_my_agents
  "auth", "oauth", "memberships", "ceo_of", "communities", "payout_address",
  // assignment, work request and task reads
  "task_key", "task_title", "task_status", "repository", "default_branch",
  "target_branch", "target_head_sha",
  // list_repositories and get_repository_credential
  "clone_url", "remote_url",
  "payment", "ended", "all",
  // list_assignable_agents rows and reason codes
  "score_bps", "win_rate_bps", "rated_count", "active_assignments", "matched_tags",
  "won_here", "won_elsewhere", "no_wins", "no_history", "tag_match", "top_earner", "busy",
  // list_task_submissions rows
  "verification_status", "eligible", "links", "code_review", "outcome", "merge_state",
  // problem codes
  "artifact_invalid", "blocked", "blocker_not_in_base", "branch_not_found",
  "ceo_binding_required", "human_request_open",
  "image_blocked", "invite_required", "moderation_unavailable",
  "idempotency_conflict", "internal_error", "not_found", "provider_unavailable",
  "rate_limited", "relation_cycle", "agent_not_selected", "request_already_active", "request_expired",
  "request_not_active", "revision_frozen", "scope_denied", "validation_failed",
  "version_conflict", "workspace_invalid",
  // enum and literal values
  "artifact", "code", "decision", "draft", "duplicate", "external", "not_needed",
  "planned", "related", "review", "work",
  "open", "active", "completed", "archived", "human_review", "human_blocked",
  // external commands and hosts named in prose
  "agent", "curl", "https", "jq", "python3",
]);

const backticked = /`([a-z][a-z0-9_]*)`/g;
for (const [where, text] of skillBodies) {
  const seen = new Set();
  let m;
  while ((m = backticked.exec(text)) !== null) {
    const token = m[1];
    if (seen.has(token) || TOOLS.has(token) || NON_TOOL_IDENTIFIERS.has(token)) continue;
    seen.add(token);
    const near = [...TOOLS].filter((tool) => distance(tool, token) <= 2);
    fail(
      where,
      `\`${token}\` is neither a frozen tool name nor a known identifier` +
        (near.length ? ` — did you mean ${near.map((n) => `\`${n}\``).join(" or ")}?` : ""),
    );
  }
}

// The reverse: an identifier no skill mentions any more is a removed field
// waiting to creep back in unchecked. Drop it from the list.
{
  const used = new Set();
  for (const text of skillBodies.values()) {
    for (const m of text.matchAll(backticked)) used.add(m[1]);
  }
  for (const token of NON_TOOL_IDENTIFIERS) {
    if (!used.has(token)) fail("test/validate.mjs", `NON_TOOL_IDENTIFIERS lists \`${token}\`, which no skill mentions; remove it`);
  }
}

function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

// ---------------------------------------------------------------------------
// 7. scripts
// ---------------------------------------------------------------------------
const SCRIPTS = ["scripts/klank-upload", "scripts/klank-check", "scripts/klank-image-upload", "scripts/klank-video-upload", "scripts/klank-git-credential"];
for (const script of SCRIPTS) {
  const path = join(ROOT, script);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    fail(script, "is missing or not executable (chmod +x)");
    continue;
  }
  // Parse with the interpreter the shebang names, without running the script.
  const python = readText(path).startsWith("#!/usr/bin/env python3");
  const [cmd, args] = python
    ? ["python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path]]
    : ["sh", ["-n", path]];
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
  } catch (error) {
    fail(script, `${cmd} parse failed — ${String(error.stderr ?? error.message).trim()}`);
  }
}

// A plain (unquoted) YAML scalar may not contain ": " or " #", and may not
// start with an indicator character. Claude Code tolerates both; strict
// parsers (Devin) reject the whole frontmatter and drop the skill.
function plainScalarProblem(value) {
  if (/^["']/.test(value)) return null;
  if (/: |:$/.test(value)) return 'contains ": " unquoted; wrap the value in double quotes';
  if (/ #/.test(value)) return 'contains " #" unquoted (a YAML comment); wrap the value in double quotes';
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(value)) return "starts with a YAML indicator; wrap the value in double quotes";
  return null;
}


// ---------------------------------------------------------------------------
// commands: a one-line description each
// ---------------------------------------------------------------------------
for (const command of ["klank-inbox", "klank-work", "klank-attention"]) {
  const where = `commands/${command}.md`;
  try {
    const text = readText(join(ROOT, where));
    if (!/^---\n[\s\S]*?^description:[ \t]*\S/m.test(text)) {
      fail(where, "needs a frontmatter description:");
    }
    const value = text.match(/^description:[ \t]*(.*)$/m)?.[1].trim() ?? "";
    const yamlProblem = plainScalarProblem(value);
    if (yamlProblem) fail(where, `description ${yamlProblem}`);
  } catch {
    fail(where, "is missing");
  }
}

// ---------------------------------------------------------------------------
for (const note of notes) console.log(`note: ${note}`);
if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `ok: ${jsonFiles.length} JSON files, ${skillBodies.size} skills, ${TOOLS.size} tool names, ${SCRIPTS.length} scripts`,
);
