// Local unsigned artifact. Production Firefox installs require Mozilla signing.
import { archiveAddon,root } from './firefox-harness.mjs';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
execFileSync(process.execPath,['scripts/verify-firefox.mjs'],{cwd:root,stdio:'inherit',windowsHide:true});
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const directory=path.join(root,'.artifacts/firefox');await mkdir(directory,{recursive:true});
const name=`monica-extension-${version}-firefox-unsigned.xpi`,file=path.join(directory,name);
await archiveAddon(path.join(root,'dist-firefox'),file);
const sha256=createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile(file+'.sha256',`${sha256}  ${name}\n`);
console.log(`Unsigned local Firefox artifact: ${file}\nSHA256 ${sha256}\nTemporary installation via about:debugging. Mozilla signing is required for normal Firefox distribution.`);
