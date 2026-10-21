import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const script = readFileSync(new URL('../../scripts/build-identity.mjs', import.meta.url), 'utf8');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'monica-build-id-'));
  roots.push(root);
  const files: Record<string, string | Buffer> = {
    'scripts/build-identity.mjs': script,
    'scripts/build-workers.mjs': 'export {};\n',
    'vite.config.ts': 'export default {};\n',
    'package.json': '{"version":"1.0.101"}\n',
    'package-lock.json': '{"version":"1.0.101","packages":{"":{"version":"1.0.101"}}}\n',
    'public/manifest.json': '{"version":"1.0.101"}\n',
    'src/runtime/build-id.json': '{"buildId":"old"}\n',
    'src/App.vue': '<template>\n  <p>Monica</p>\n</template>\n',
    'public/icon.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), bytes);
  }
  const build = () => {
    execFileSync(process.execPath, [join(root, 'scripts/build-identity.mjs')], { windowsHide: true });
    return JSON.parse(readFileSync(join(root, 'src/runtime/build-id.json'), 'utf8')).buildId as string;
  };
  return { root, files, build };
}

it('produces the same build identity for LF and CRLF checkouts and repeated builds', () => {
  const { root, files, build } = fixture();
  const expected = build();
  expect(build()).toBe(expected);
  const generatedPath = join(root, 'src/runtime/build-id.json');
  const checkoutBytes = readFileSync(generatedPath, 'utf8').replace(/\n/g, '\r\n');
  writeFileSync(generatedPath, checkoutBytes);
  expect(build()).toBe(expected);
  expect(readFileSync(generatedPath, 'utf8')).toBe(checkoutBytes);
  for (const [name, bytes] of Object.entries(files)) {
    if (typeof bytes === 'string') writeFileSync(join(root, name), bytes.replace(/\n/g, '\r\n'));
  }
  expect(build()).toBe(expected);
  expect(readFileSync(generatedPath, 'utf8')).toContain('\r\n');
});

it('changes the build identity for a real source edit', () => {
  const { root, build } = fixture();
  const before = build();
  writeFileSync(join(root, 'src/App.vue'), '<template>Changed</template>\n');
  expect(build()).not.toBe(before);
});

it('preserves CRLF bytes in binary resources', () => {
  const { root, files, build } = fixture();
  const before = build();
  const original = files['public/icon.png'] as Buffer;
  writeFileSync(join(root, 'public/icon.png'), Buffer.from(original.filter((_, index) => index !== 4)));
  expect(build()).not.toBe(before);
});
