/**
 * Repo-scoped, read-only diff access for the mobile bridge (Portkey Layer 1). Backs the
 * `/changes` and `/diff` routes, containment-guarded to the session's repo root. Diffs use a
 * "PR view" baseline — the merge-base with the repo's default branch — so a branch's COMMITTED
 * work shows, not just uncommitted edits. Every `git` call uses `.nothrow().quiet()` and
 * branches on `exitCode`: `git diff --no-index` returns non-zero WHEN A DIFF EXISTS, which
 * `Bun.$` would otherwise throw on.
 */

import { statSync, realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { resolveSessionPane } from "./session-api";
import { resolveTranscriptPath, latestTranscriptCwd } from "./last-turn";
import { listPanes } from "./tmux";

// git's empty-tree object — diff target for an unborn HEAD (repo with no commits).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Ship at most this much per file: a lockfile/minified diff or huge blob isn't worth
// pushing whole over Tailscale to a phone.
const SIZE_CAP = 512 * 1024;

export interface FileDiff {
  branch: string;
  base: string; // default-branch name diffed against ("" when falling back to HEAD/empty)
  status?: string; // single-letter status vs base: A(dded) / M(odified) / D(eleted). Absent when empty.
  orig?: string; // for a rename (status R), the OLD path — the view says "renamed from …"
  add: number;
  del: number;
  patch?: string;
  binary?: boolean;
  tooLarge?: boolean;
  empty?: boolean;
}

/**
 * Resolve a session's live repo root: session cwd → `git rev-parse --show-toplevel`.
 * The cwd prefers the transcript's last-recorded `cwd` (which tracks `/cd`) over the tmux
 * pane's cwd — `/cd` moves Claude's directory forward but not the launching shell's, so the
 * pane still reports the original dir. Falls back to the pane cwd when no transcript is found.
 */
export async function repoRootForSession(sessionId: string): Promise<string | null> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return null;
  const transcript = await resolveTranscriptPath(sessionId);
  const claudeCwd = transcript ? await latestTranscriptCwd(transcript) : null;
  const pane = (await listPanes()).find((p) => p.paneId === paneId);
  const cwd = claudeCwd ?? pane?.currentPath;
  if (!cwd) return null;
  const r = await Bun.$`git -C ${cwd} rev-parse --show-toplevel`.nothrow().quiet();
  if (r.exitCode !== 0) return null;
  const root = r.stdout.toString().trim();
  if (!root) return null;
  // Canonicalize so paths from `safeRepoPath` (which realpaths the root) are relative to the
  // same base — otherwise a symlinked repo path (e.g. /tmp → /private/tmp) desyncs the two.
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Containment guard: resolve `rel` under `root` and require the result to stay inside the
 * repo. Tolerates a non-existent target (deleted/renamed files must still validate) by
 * realpath-ing the DEEPEST EXISTING ANCESTOR — the non-existent tail can't hold a symlink,
 * so this stays safe against `../`, absolute paths, and symlink escapes. Returns the
 * resolved absolute path, or null if it escapes.
 */
export function safeRepoPath(root: string, rel: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const abs = resolve(realRoot, rel);
  // Walk up to the deepest ancestor that exists on disk, realpath it (resolves any symlink
  // in the existing prefix), then re-attach the non-existent tail.
  let existing = abs;
  const tail: string[] = [];
  // Guard against an unbounded loop on a malformed path — dirname eventually fixes at "/".
  while (existing !== dirname(existing)) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      tail.unshift(existing.slice(dirname(existing).length + 1));
      existing = dirname(existing);
    }
  }
  const real = tail.length ? resolve(existing, ...tail) : existing;
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  return real;
}

/**
 * Wrap a path as a LITERAL git pathspec. Git pathspecs are wildmatch globs by default, so a
 * real filename containing `[`, `*` or `?` (e.g. Next.js's `app/[slug]/page.tsx`) matches
 * some OTHER file — or nothing — and the diff renders the wrong file's patch under the
 * requested name. `:(literal)` turns off all magic for that pathspec.
 */
const literal = (p: string) => `:(literal)${p}`;

/** Current branch (empty on detached HEAD). */
async function currentBranch(root: string): Promise<string> {
  const r = await Bun.$`git -C ${root} branch --show-current`.nothrow().quiet();
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

/** Parse `--numstat` output: `add\tdel\tpath`, with `-\t-` marking a binary file. */
function parseNumstat(out: string): { add: number; del: number; binary: boolean } {
  const line = out.trim().split("\n").filter(Boolean)[0];
  if (!line) return { add: 0, del: 0, binary: false };
  const [a, d] = line.split("\t");
  if (a === "-" && d === "-") return { add: 0, del: 0, binary: true };
  return { add: Number(a) || 0, del: Number(d) || 0, binary: false };
}

/**
 * Numstat for an untracked file without a subprocess: every line is an addition. Mirrors
 * git's rules — a NUL in the first 8000 bytes makes it binary, a last line with no newline
 * still counts, a symlink diffs as its one-line target. Unreadable → 0/0, like a failed diff.
 */
async function untrackedNumstat(abs: string): Promise<{ add: number; del: number; binary: boolean }> {
  try {
    if ((await lstat(abs)).isSymbolicLink()) return { add: 1, del: 0, binary: false };
    let add = 0;
    let seen = 0;
    let last = 10; // '\n': an empty file adds no lines
    for await (const chunk of Bun.file(abs).stream()) {
      if (seen < 8000 && chunk.subarray(0, 8000 - seen).includes(0)) return { add: 0, del: 0, binary: true };
      seen += chunk.length;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) add++;
      last = chunk[chunk.length - 1] ?? last;
    }
    if (last !== 10) add++;
    return { add, del: 0, binary: false };
  } catch {
    return { add: 0, del: 0, binary: false };
  }
}

/**
 * The commit to diff a branch against for a "PR view": the merge-base of HEAD and the repo's
 * default branch (origin/HEAD → origin/main, else a local main/master). Diffing from here to
 * the working tree captures the branch's committed AND uncommitted changes. Falls back to the
 * empty tree (unborn HEAD) or HEAD itself (no discoverable base → uncommitted-only). `label`
 * is the short base-branch name for the UI ("" when falling back to HEAD/empty).
 */
export async function baseRef(root: string): Promise<{ ref: string; label: string }> {
  const headOk =
    (await Bun.$`git -C ${root} rev-parse --verify HEAD`.nothrow().quiet()).exitCode === 0;
  if (!headOk) return { ref: EMPTY_TREE, label: "" };
  let def = "";
  const sym = await Bun.$`git -C ${root} symbolic-ref --quiet refs/remotes/origin/HEAD`
    .nothrow()
    .quiet();
  if (sym.exitCode === 0) {
    const named = sym.stdout.toString().trim().replace(/^refs\/remotes\//, ""); // e.g. "origin/main"
    // The symref survives a default-branch rename (master → main) pointing at a ref that no
    // longer exists. Trusting it blind makes `merge-base` fail and silently collapses the PR
    // view to uncommitted-only — every commit the agent made vanishes from the phone. Verify
    // before use, and fall through to the candidates when it's dangling.
    if (
      named &&
      (await Bun.$`git -C ${root} rev-parse --verify --quiet ${named}`.nothrow().quiet()).exitCode === 0
    ) {
      def = named;
    }
  }
  if (!def) {
    for (const cand of ["origin/main", "origin/master", "origin/develop", "origin/trunk", "main", "master", "develop", "trunk"]) {
      if (
        (await Bun.$`git -C ${root} rev-parse --verify --quiet ${cand}`.nothrow().quiet())
          .exitCode === 0
      ) {
        def = cand;
        break;
      }
    }
  }
  // No discoverable base branch → diff vs HEAD (uncommitted-only). Label "HEAD" (not "")
  // so the UI honestly shows "vs HEAD" rather than silently implying a full branch diff.
  if (!def) return { ref: "HEAD", label: "HEAD" };
  const mb = await Bun.$`git -C ${root} merge-base HEAD ${def}`.nothrow().quiet();
  if (mb.exitCode !== 0) return { ref: "HEAD", label: "HEAD" }; // unrelated histories → uncommitted-only
  return { ref: mb.stdout.toString().trim(), label: def.replace(/^origin\//, "") };
}

/**
 * Diff for one file: branch vs its base (committed + uncommitted). Handles: unborn HEAD /
 * no-base (falls back to empty-tree / HEAD via `baseRef`), untracked new files (fall back to
 * `--no-index` vs `/dev/null` so they render as all-additions), binary files, and an oversized
 * patch. `--no-renames` keeps paths literal so numstat parses cleanly. `abs` is the
 * pre-validated absolute path (from `safeRepoPath`); `rel` is repo-relative. Every pathspec
 * goes through `literal()` — a real filename can contain glob metacharacters.
 *
 * `refOverride` replaces the base with another ref-vs-worktree endpoint — the "uncommitted"
 * tier passes `HEAD` so the patch shown is the one that tier's LOC was measured over.
 */
export async function fileDiff(
  root: string,
  abs: string,
  rel: string,
  orig?: string,
  refOverride?: { ref: string; label: string },
): Promise<FileDiff> {
  const branch = await currentBranch(root);
  const { ref, label } = refOverride ?? (await baseRef(root));

  // Rename: diff BOTH endpoints (`-M`) so the true content churn shows, not the whole new file
  // as a fresh add. `changedFiles` supplies `orig` (the old path) for its status-R rows.
  if (orig && orig !== rel) {
    const [origSpec, relSpec] = [literal(orig), literal(rel)];
    const patch = (
      await Bun.$`git -C ${root} diff -M ${ref} -- ${origSpec} ${relSpec}`.nothrow().quiet()
    ).stdout.toString();
    if (patch.trim()) {
      const numstat = (
        await Bun.$`git -C ${root} diff -M --numstat ${ref} -- ${origSpec} ${relSpec}`.nothrow().quiet()
      ).stdout.toString();
      const { add, del, binary } = parseNumstat(numstat);
      if (binary) return { branch, base: label, status: "R", orig, add, del, binary: true };
      if (patch.length > SIZE_CAP) return { branch, base: label, status: "R", orig, add, del, tooLarge: true };
      return { branch, base: label, status: "R", orig, add, del, patch };
    }
  }

  // Resolve the ref-vs-worktree diff for ONE pathspec form, or null if it yields no diff.
  // Empty patch is ambiguous: unchanged, OR an untracked new file (never in `git diff <ref>`)
  // — only the latter gets the `--no-index` vs /dev/null fallback (renders as all-additions).
  // Exit 1 = has-diff, not an error (hence `.nothrow()`).
  const resolve = async (pathspec: string, absPath: string) => {
    // `literal()` here rather than at the call sites: the NFD/NFC retry below feeds this a
    // re-normalized path, and the pathspec magic has to wrap whichever form is actually used.
    const spec = literal(pathspec);
    let patch = (
      await Bun.$`git -C ${root} diff --no-renames ${ref} -- ${spec}`.nothrow().quiet()
    ).stdout.toString();
    let numstat = (
      await Bun.$`git -C ${root} diff --no-renames --numstat ${ref} -- ${spec}`.nothrow().quiet()
    ).stdout.toString();
    const untracked =
      !patch.trim() &&
      (await Bun.$`git -C ${root} ls-files --others --exclude-standard -- ${spec}`.nothrow().quiet())
        .stdout.toString()
        .trim() !== "";
    if (untracked) {
      patch = (
        await Bun.$`git -C ${root} diff --no-index --no-renames -- /dev/null ${absPath}`.nothrow().quiet()
      ).stdout.toString();
      numstat = (
        await Bun.$`git -C ${root} diff --no-index --numstat --no-renames -- /dev/null ${absPath}`
          .nothrow()
          .quiet()
      ).stdout.toString();
    }
    return patch.trim() ? { patch, numstat, untracked } : null;
  };

  // macOS keeps the committed tree and the working copy in DIFFERENT Unicode forms (tree NFC
  // via core.precomposeUnicode, working copy NFD on disk), and `git diff <ref> -- <path>`
  // matches the pathspec against the WORKING COPY — so the path `changedFiles` emitted (NFC)
  // can miss and return an empty diff. Try the given form, then the alternate normalizations,
  // and use whichever actually matches. No-op cost for ASCII paths (first form always matches).
  let resolved = await resolve(rel, abs);
  for (const form of ["NFD", "NFC"] as const) {
    if (resolved) break;
    const alt = rel.normalize(form);
    if (alt !== rel) resolved = await resolve(alt, abs.normalize(form));
  }
  if (!resolved) return { branch, base: label, add: 0, del: 0, empty: true };
  const { patch, numstat, untracked } = resolved;

  // Status letter from the patch's file header (`--no-renames`, so renames split into D+A):
  // an untracked or "new file mode" is Added, "deleted file mode" is Deleted, else Modified.
  const status = untracked || /^new file mode/m.test(patch) ? "A" : /^deleted file mode/m.test(patch) ? "D" : "M";
  const { add, del, binary } = parseNumstat(numstat);
  if (binary) return { branch, base: label, status, add, del, binary: true };
  if (patch.length > SIZE_CAP) return { branch, base: label, status, add, del, tooLarge: true };
  return { branch, base: label, status, add, del, patch };
}

/** Shorten a raw commit sha for a UI label; named refs pass through untouched. */
const shortRef = (r: string) => (/^[0-9a-f]{40}$/.test(r) ? r.slice(0, 7) : r);

/**
 * Diff for one file over a REF-TO-REF range — the "committed, not pushed" and "on GitHub"
 * tiers. Same three-dot rule as `changedFiles`'s range mode, so the patch is measured over
 * exactly the range its row's LOC came from. None of `fileDiff`'s working-tree machinery
 * applies here (an untracked file is by definition in neither ref, and the NFD/NFC pathspec
 * retry exists because git matches the pathspec against the working copy, not a ref).
 */
export async function rangeDiff(
  root: string,
  from: string,
  to: string,
  rel: string,
  orig?: string,
): Promise<FileDiff> {
  const branch = await currentBranch(root);
  const label = `${shortRef(from)}…${shortRef(to)}`;
  const range = `${from}...${to}`;
  const isRename = !!orig && orig !== rel;
  const specs = isRename ? [literal(orig!), literal(rel)] : [literal(rel)];
  const patch = (await Bun.$`git -C ${root} diff -M ${range} -- ${specs}`.nothrow().quiet()).stdout.toString();
  if (!patch.trim()) return { branch, base: label, add: 0, del: 0, empty: true };
  const numstat = (
    await Bun.$`git -C ${root} diff -M --numstat ${range} -- ${specs}`.nothrow().quiet()
  ).stdout.toString();
  const { add, del, binary } = parseNumstat(numstat);
  const status = isRename
    ? "R"
    : /^new file mode/m.test(patch)
      ? "A"
      : /^deleted file mode/m.test(patch)
        ? "D"
        : "M";
  const head = { branch, base: label, status, add, del, ...(isRename ? { orig } : {}) };
  if (binary) return { ...head, binary: true };
  if (patch.length > SIZE_CAP) return { ...head, tooLarge: true };
  return { ...head, patch };
}

export interface ChangedFile {
  path: string; // for a rename, the NEW path
  status: string; // git status vs base: A(dded) / M(odified) / D(eleted) / R(enamed) / T(ype)
  orig?: string; // for a rename (status R), the OLD path — lets the diff view render the true rename
  add: number;
  del: number;
  binary: boolean;
}

/**
 * Every file changed from `ref` to the working tree (committed on the branch + uncommitted),
 * plus untracked new files as all-additions. Each carries a status letter vs base (A/M/D/R) —
 * consistent with the diff, NOT `git status --porcelain` (which would be blank for committed
 * branch files). Renames are DETECTED (`-M`) and collapsed to one `R` row (new path + real
 * churn), instead of a misleading delete+add pair. `-z` gives NUL-delimited, raw (unquoted,
 * un-normalized) UTF-8 paths so non-ASCII names parse cleanly and round-trip to a reachable
 * diff. Deduped/keyed by the new path.
 *
 * With `to`, this is a REF-TO-REF range instead (a tier of the sync chain): the working tree
 * isn't an endpoint, so the untracked pass is skipped. The two refs are passed as ONE
 * three-dot revspec, never as two arguments — `git diff A B` means `A..B`, which compares the
 * tips directly and reports everything the far side has and this side lacks as a *deletion*,
 * inventing phantom `D` rows for files that only ever existed on the remote.
 */
export async function changedFiles(root: string, ref: string, to?: string): Promise<ChangedFile[]> {
  const range = to ? `${ref}...${to}` : ref;
  const [numstatR, statusR] = await Promise.all([
    Bun.$`git -C ${root} diff -M -z --numstat ${range}`.nothrow().quiet(),
    Bun.$`git -C ${root} diff -M -z --name-status ${range}`.nothrow().quiet(),
  ]);
  // `-z` records are NUL-separated. A rename spans THREE tokens: the status/counts token, then
  // the old path, then the new path (numstat's counts token ends with an empty path field;
  // name-status's token is `R<score>`). Everything else is a two-token (meta, path) pair.
  const nsTokens = numstatR.stdout.toString().split("\0").filter(Boolean);
  const stTokens = statusR.stdout.toString().split("\0").filter(Boolean);

  const origByPath = new Map<string, string>(); // new path → old path (renames only)
  const statusByPath = new Map<string, string>();
  for (let i = 0; i < stTokens.length; ) {
    const st = stTokens[i++]!;
    if (st[0] === "R" || st[0] === "C") {
      const oldP = stTokens[i++]!;
      const newP = stTokens[i++]!;
      statusByPath.set(newP, "R");
      origByPath.set(newP, oldP);
    } else {
      const path = stTokens[i++];
      if (path) statusByPath.set(path, st[0] || "M");
    }
  }
  const map = new Map<string, ChangedFile>();
  for (let i = 0; i < nsTokens.length; ) {
    const parts = nsTokens[i++]!.split("\t");
    const [a, d] = parts;
    // A rename's counts token has an EMPTY third field, with the old + new paths as the next
    // two tokens; a normal entry carries its path inline as the third field.
    let path = parts[2] || "";
    if (!path) {
      i++; // skip the old path token
      path = nsTokens[i++] || ""; // the new path
    }
    if (!path) continue;
    const binary = a === "-" && d === "-";
    map.set(path, {
      path,
      status: statusByPath.get(path) || "M",
      ...(origByPath.has(path) ? { orig: origByPath.get(path) } : {}),
      add: binary ? 0 : Number(a) || 0,
      del: binary ? 0 : Number(d) || 0,
      binary,
    });
  }
  if (to) return [...map.values()]; // ref-to-ref range: the working tree isn't an endpoint
  // Untracked new files aren't in `git diff <ref>`; add them as all-additions (status A).
  const untracked = (
    await Bun.$`git -C ${root} ls-files -z --others --exclude-standard`.nothrow().quiet()
  ).stdout
    .toString()
    .split("\0")
    .filter(Boolean);
  // In-process and one at a time on purpose: a subprocess per untracked file fans out to
  // thousands of concurrent shells in a worktree full of generated output (ADR 1 addendum).
  for (const path of untracked) {
    if (map.has(path)) continue;
    // A nested git repo (vendored clone, a package with its own .git) is reported as a
    // single DIRECTORY token, `sub/`. It has no basename to render and no diff to open,
    // so it would show as a nameless row that opens to nothing.
    if (path.endsWith("/")) continue;
    map.set(path, { path, status: "A", ...(await untrackedNumstat(`${root}/${path}`)) });
  }
  return [...map.values()];
}

/** Most-recently-modified first, so the phone's card previews the latest edits. */
function sortByMtime(root: string, files: ChangedFile[]): ChangedFile[] {
  return files
    .map((f) => {
      let mtime = 0;
      try {
        mtime = statSync(`${root}/${f.path}`).mtimeMs; // deleted files sort last (mtime 0)
      } catch {}
      return { f, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
}

export type TierKey = "uncommitted" | "unpushed" | "pushed";

export interface ChangeTier {
  key: TierKey;
  /** Diff endpoints for this tier. `to: ""` means the working tree. */
  from: string;
  to: string;
  files: ChangedFile[];
  add: number;
  del: number;
}

/**
 * How far this branch's work has travelled, as a CHAIN of three adjacent ranges rather than a
 * set of overlapping filters:
 *
 *     base ──────► origin/<branch> ──────► HEAD ──────► working tree
 *           pushed          committed,          uncommitted
 *                           not pushed
 *
 * Each link is a real diff range, so each has its own file list, its own per-file LOC and its
 * own openable patch. A file pushed and then edited again appears in more than one tier, with
 * the LOC of THAT segment in each — the same way an editor's SCM panel lists a file under both
 * staged and unstaged. Empty tiers are dropped.
 *
 * The comparison ref is `origin/<branch>` BY NAME, not `@{upstream}` and not `@{push}`: two
 * repos on this machine point a feature branch's upstream at `origin/main` (which would report
 * the branch as hundreds of files out of sync with itself), and `@{push}` fails outright on
 * those same two ("cannot resolve 'simple' push to a single destination").
 *
 * `base` is the caller's already-resolved `baseRef` ref (threaded in rather than re-derived —
 * `baseRef` costs several git calls). Null on a detached HEAD or an unborn HEAD: neither has a
 * branch to push, so there is no chain to draw and the flat list stands alone.
 */
export async function syncTiers(
  root: string,
  base: string,
): Promise<{ tiers: ChangeTier[]; pushed: boolean; unpushedCount: number } | null> {
  const branch = await currentBranch(root);
  if (!branch) return null;
  if ((await Bun.$`git -C ${root} rev-parse --verify --quiet HEAD`.nothrow().quiet()).exitCode !== 0) return null;

  const remote = `origin/${branch}`;
  const pushed =
    (await Bun.$`git -C ${root} rev-parse --verify --quiet ${remote}`.nothrow().quiet()).exitCode === 0;
  // Never pushed → the "committed, not pushed" tier starts at the base instead: every commit
  // on this branch is unpushed, and the pushed tier is empty. Same chain, one link missing.
  const landed = pushed ? remote : base;

  const [uncommitted, unpushed, pushedFiles] = await Promise.all([
    changedFiles(root, "HEAD"), // includes untracked, as all-additions
    changedFiles(root, landed, "HEAD"),
    pushed ? changedFiles(root, base, remote) : Promise.resolve([] as ChangedFile[]),
  ]);

  const tier = (key: TierKey, from: string, to: string, files: ChangedFile[]): ChangeTier => ({
    key,
    from,
    to,
    files: sortByMtime(root, files),
    add: files.reduce((s, f) => s + f.add, 0),
    del: files.reduce((s, f) => s + f.del, 0),
  });
  const tiers = [
    tier("uncommitted", "HEAD", "", uncommitted),
    tier("unpushed", landed, "HEAD", unpushed),
    tier("pushed", base, remote, pushedFiles),
  ].filter((t) => t.files.length > 0);

  // The DISTINCT union of the two un-landed tiers — a file that is both committed-unpushed and
  // dirty is one file the Mac still holds, not two. Summing the tier sizes would say otherwise.
  const notLanded = new Set([...uncommitted, ...unpushed].map((f) => f.path));
  return { tiers, pushed, unpushedCount: notLanded.size };
}

/**
 * The files this branch changed vs its base — the "PR view" (committed + uncommitted). Uses
 * `baseRef` (merge-base with the default branch), so committed work shows, not just
 * working-tree edits. Ordered most-recently-modified first so the phone's card previews the
 * latest edits. `base` is the base-branch name for the UI. `tiers` splits the same work by how
 * far it has travelled (see `syncTiers`); the flat `files` list stays authoritative for the
 * card's totals and `/diff`'s rename lookup. Null when the session has no live repo.
 */
export async function branchChanges(sessionId: string): Promise<{
  root: string;
  branch: string;
  base: string;
  files: ChangedFile[];
  tiers?: ChangeTier[];
  pushed?: boolean;
  unpushedCount?: number;
} | null> {
  const root = await repoRootForSession(sessionId);
  if (!root) return null;
  const { ref, label } = await baseRef(root);
  const [files, sync] = await Promise.all([changedFiles(root, ref), syncTiers(root, ref)]);
  return {
    root,
    branch: await currentBranch(root),
    base: label,
    files: sortByMtime(root, files),
    ...(sync ? { tiers: sync.tiers, pushed: sync.pushed, unpushedCount: sync.unpushedCount } : {}),
  };
}
