// Content-addressed static artifacts. Values from the environment and .env files
// enter only the digest: never write them to cache metadata or diagnostic output.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function digestTree(root, excluded = new Set(), skipDependencies = false) {
  const hash = createHash('sha256');
  const visit = (file, rel) => {
    if (excluded.has(file)) return;
    const stat = fs.lstatSync(file);
    hash.update(rel + '\0' + (stat.mode & 0o777) + '\0');
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(file);
      // Inputs outside the checkout cannot be fingerprinted safely. Bundles must
      // also be self-contained, rather than point into a mutable worktree.
      const target = fs.realpathSync(file);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error('external symlink');
      hash.update('link\0' + link + '\0');
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (name === '.git' || (skipDependencies && name === 'node_modules')) continue;
        visit(path.join(file, name), path.join(rel, name));
      }
    } else if (stat.isFile()) {
      hash.update('file\0');
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let length;
        while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
      } finally { fs.closeSync(fd); }
    } else throw new Error('unsupported file');
  };
  visit(root, '.');
  return hash.digest('hex');
}

function key(label) {
  const workspace = fs.realpathSync(process.env.WORKSPACE || '/workspace');
  const plan = JSON.parse(fs.readFileSync(process.env.SANDBOXER_PLAN || '/sandboxer/plan.json', 'utf8'));
  const record = plan.services.find(s => s.kind === 'static' && s.label === label);
  if (!record?.cache) throw new Error('not enabled');
  const excluded = new Set(plan.services.filter(s => s.kind === 'static').map(s => path.resolve(workspace, s.root || '.', s.package || '.', s.out || 'dist')));
  const cacheDir = path.resolve(process.env.SANDBOXER_STATIC_CACHE || '/var/cache/sandboxer/static-builds');
  excluded.add(cacheDir);
  // Hash source bytes, including untracked/ignored files such as .env, instead
  // of trusting timestamps, a branch name or a clean Git index.
  const hash = createHash('sha256').update('static-cache-v1\0').update(JSON.stringify(record));
  hash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  for (const input of [...(record.cache_inputs || ['.'])].sort()) {
    const resolved = path.resolve(workspace, input);
    if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) throw new Error('input outside workspace');
    hash.update(input + '\0' + digestTree(resolved, excluded, true));
  }
  hash.update(JSON.stringify({ versions: process.versions, arch: process.arch, platform: process.platform }));
  for (const [name, value] of Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (['_', 'PWD', 'OLDPWD', 'SHLVL', 'SANDBOXER_FORCE_BUILD', 'SANDBOXER_STATIC_CACHE'].includes(name)) continue;
    hash.update(name + '\0' + value + '\0');
  }
  // Installed dependencies are managed by deps-init using the checked-in
  // lockfile. Their completion marker and npm's installed lock are additional
  // inputs; hand-patching node_modules requires SANDBOXER_FORCE_BUILD=true.
  if (plan.deps?.root) {
    const deps = path.resolve(workspace, plan.deps.root, 'node_modules');
    for (const file of ['.sandboxer-deps', '.package-lock.json']) {
      const filename = path.join(deps, file);
      if (fs.existsSync(filename)) hash.update(fs.readFileSync(filename));
    }
  }
  if (record.cache_git !== false && fs.existsSync(path.join(workspace, '.git'))) {
    // Builds can embed Git revision/branch. Do not reuse when Git metadata is
    // inaccessible in the container: the safe fallback is a normal build.
    for (const args of [['rev-parse', 'HEAD'], ['rev-parse', '--abbrev-ref', 'HEAD']]) {
      hash.update(execFileSync('git', ['-C', workspace, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }));
    }
  }
  return hash.digest('hex');
}

const [operation, first, second] = process.argv.slice(2);
try {
  if (operation === 'key') process.stdout.write(key(first));
  else if (operation === 'digest') process.stdout.write(digestTree(fs.realpathSync(first)));
  else if (operation === 'verify') {
    const expected = fs.readFileSync(path.join(first, 'digest'), 'utf8');
    if (digestTree(fs.realpathSync(path.join(first, 'files'))) !== expected) process.exit(1);
  } else if (operation === 'store') {
    const temp = fs.mkdtempSync(second + '.tmp-');
    try {
      fs.cpSync(first, path.join(temp, 'files'), { recursive: true, dereference: false });
      fs.writeFileSync(path.join(temp, 'digest'), digestTree(fs.realpathSync(path.join(temp, 'files'))));
      try { fs.renameSync(temp, second); }
      catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  } else process.exit(1);
} catch {
  // Caching is optional. Avoid logging paths or input values from a failed hash.
  process.exitCode = 1;
}
