// The GitHub repos cloned on this Mac, for the repo menu's "local" tags. Finding them
// means walking the home folder (3,387 directories for 34 repos on 2026-10-22, 2.5-6s),
// so the walk is asynchronous, never holding up other requests, and its result is saved
// so a restarted server answers at once and walks again in the background.
import fs from "node:fs";
import path from "node:path";

// Directory reads share Node's four worker threads with DNS lookups, so more at once
// starves GitHub calls: at 32, a cold-start /user took 9s. Two was the fastest walk too.
const DEPTH = 6, PARALLEL = 2;
export const MAX_AGE_MS = 10 * 60 * 1000;

async function remoteRepo(dir) {
  try {
    const m = (await fs.promises.readFile(path.join(dir, ".git", "config"), "utf8")).match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    const u = m && m[1].match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
    return u ? u[1] : null;
  } catch { return null; }
}

// Walks `roots` for git checkouts, reading PARALLEL directories at a time.
export async function scanRepos(roots, skip, home = process.env.HOME) {
  const out = new Map();
  let active = 0;
  const waiting = [];
  const slot = () => (active < PARALLEL ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const free = () => { const next = waiting.shift(); if (next) next(); else active--; };
  async function visit(dir, depth) {
    if (depth < 0) return;
    await slot();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { entries = null; } finally { free(); }
    if (!entries) return;
    if (entries.some((e) => e.name === ".git")) { const r = await remoteRepo(dir); if (r) out.set(r.toLowerCase(), { repo: r, path: dir }); return; }
    await Promise.all(entries.filter((e) => e.isDirectory() && !skip.has(e.name) && !(e.name.startsWith(".") && dir === home)).map((e) => visit(path.join(dir, e.name), depth - 1)));
  }
  await Promise.all(roots.map((r) => visit(r, DEPTH)));
  return [...out.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

// list() answers with the saved repos when there are any, starting a fresh walk in the
// background once they are older than MAX_AGE_MS; with none saved it waits for the walk.
export function createRepoScanner({ roots, skip, file, home = process.env.HOME, maxAgeMs = MAX_AGE_MS, scan = scanRepos, log = () => {} }) {
  let saved = null, walking = null;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  function walk() {
    walking ??= scan(roots, skip, home).then((list) => {
      saved = { at: Date.now(), list };
      fs.promises.writeFile(file, JSON.stringify(saved)).catch((e) => log(`could not save the local repo list: ${e.message}`));
      return list;
    }).finally(() => { walking = null; });
    return walking;
  }
  return {
    async list() {
      if (!saved) return walk();
      if (Date.now() - saved.at >= maxAgeMs) walk().catch((e) => log(`local repo scan failed: ${e.message}`));
      return saved.list;
    },
  };
}
