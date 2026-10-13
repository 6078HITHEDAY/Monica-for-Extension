import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** Source dependency notices complement the npm SBOM; this includes Rust build
 * dependencies as well as runtime crates, not a claim that every crate is linked. */
export async function browserDependencyNotices(root) {
  const metadata = JSON.parse(execFileSync('cargo', ['+1.97.0', 'metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', 'wasm32-unknown-emscripten', '--manifest-path', 'native/mdbx2-browser/Cargo.toml'], { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const packages = [];
  for (const pkg of metadata.packages) {
    const directory = dirname(pkg.manifest_path);
    const names = (await readdir(directory)).filter(name => /^(?:license|licence|copying|notice)(?:[._-].*)?$/i.test(name));
    if (pkg.license_file) names.push(pkg.license_file);
    const notices = [];
    for (const name of [...new Set(names)].sort()) {
      const target = resolve(directory, name), rel = relative(directory, target);
      if (isAbsolute(rel) || rel.startsWith('..')) throw Error('A crate license escapes its source directory.');
      try { notices.push({ file: rel.replaceAll('\\', '/'), text: await readFile(target, 'utf8') }); }
      catch (error) { if (error.code !== 'EISDIR') throw error; }
    }
    if (!pkg.license && !notices.length) throw Error(`Missing browser dependency license: ${pkg.name}`);
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.source || 'vendored workspace source', notices });
  }
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  return { schema: 1, scope: 'Locked wasm32-unknown-emscripten source dependency graph, including build tools', packages };
}
