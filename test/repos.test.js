const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanRepos, createRepoScanner } = require("../repos.mjs");

// A home folder with two clones, one skipped folder, a dot-folder and a non-GitHub repo.
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghdash-repos-"));
  const clone = (dir, url) => { fs.mkdirSync(path.join(root, dir, ".git"), { recursive: true }); fs.writeFileSync(path.join(root, dir, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`); };
  clone("github/web", "git@github.com:acme/web.git");
  clone("Studio/deep/app", "https://github.com/acme/app");
  clone("node_modules/dep", "https://github.com/someone/dep.git");
  clone(".config/tool", "https://github.com/someone/tool.git");
  clone("other/gitlab", "https://gitlab.com/acme/x.git");
  return root;
}

test("finds GitHub clones, skipping listed folders, dot-folders at home and other hosts", async () => {
  const root = home();
  const list = await scanRepos([root], new Set(["node_modules"]), root);
  assert.deepEqual(list.map((r) => r.repo), ["acme/app", "acme/web"]);
  assert.equal(list[1].path, path.join(root, "github/web"));
});

test("regression: the walk doesn't hold up other work while it runs", async () => {
  // It used to read every directory synchronously, so for 2.5-6s the server answered
  // nothing else; every page request waited about 14s on a cold start.
  const root = home();
  for (let i = 0; i < 300; i++) fs.mkdirSync(path.join(root, "bulk", `d${i}`, "x"), { recursive: true });
  let turns = 0, walking = true;
  const tick = () => { if (walking) { turns++; setImmediate(tick); } };
  setImmediate(tick);
  await scanRepos([root], new Set(), root);
  walking = false;
  assert.ok(turns > 10, `other work ran ${turns} times during the walk`);
});

test("answers from the saved list at once, and walks again in the background once it is stale", async () => {
  const root = home(), file = path.join(root, "saved.json");
  let walks = 0, finish;
  const scan = () => { walks++; return new Promise((r) => (finish = r)); };
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() - 60e3, list: [{ repo: "acme/old", path: "/x" }] }));
  const fresh = createRepoScanner({ roots: [root], skip: new Set(), file, maxAgeMs: 120e3, scan });
  assert.deepEqual((await fresh.list()).map((r) => r.repo), ["acme/old"]);
  assert.equal(walks, 0, "a fresh saved list needs no walk");
  const stale = createRepoScanner({ roots: [root], skip: new Set(), file, maxAgeMs: 30e3, scan });
  assert.deepEqual((await stale.list()).map((r) => r.repo), ["acme/old"], "a stale one is still answered at once");
  assert.equal(walks, 1, "while a walk starts");
  await stale.list();
  assert.equal(walks, 1, "and only one walk runs at a time");
  finish([{ repo: "acme/new", path: "/y" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await stale.list()).map((r) => r.repo), ["acme/new"]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).list[0].repo, "acme/new", "and saved for the next start");
});

test("with nothing saved, the first ask waits for the walk", async () => {
  const root = home();
  const scanner = createRepoScanner({ roots: [root], skip: new Set(["node_modules"]), file: path.join(root, "none.json"), home: root });
  assert.deepEqual((await scanner.list()).map((r) => r.repo), ["acme/app", "acme/web"]);
});
