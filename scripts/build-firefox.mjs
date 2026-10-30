import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const destination = path.join(root, 'dist-firefox');
// Fixed build output under this package; never retain obsolete hashed assets.
await rm(destination, { recursive: true, force: true });
await cp(path.join(root, 'dist'), destination, { recursive: true, force: true });
const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
delete manifest.key;
delete manifest.minimum_chrome_version;
delete manifest.side_panel;
manifest.permissions = manifest.permissions.filter(name => !['offscreen', 'sidePanel', 'favicon'].includes(name));
manifest.background = { scripts: ['background.js'] };
// Firefox runs the private engine frame inside its event page. Only this
// extension may frame its pages; none of these pages is web-accessible.
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace("frame-ancestors 'none'", "frame-ancestors 'self'");
manifest.sidebar_action = { default_title: '__MSG_extensionName__', default_panel: 'index.html?surface=sidepanel', default_icon: manifest.icons };
manifest.browser_specific_settings = { gecko: { id: 'monica@monica-pass.github.io', strict_min_version: '153.0' } };
for (const resource of manifest.web_accessible_resources || []) delete resource.use_dynamic_url;
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Firefox ${manifest.version} built at dist-firefox (Firefox 153+, document-bound sensitive operations).`);
