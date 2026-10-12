import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { createLoginItem, type LoginItem, type PasskeyItem, type VaultItem } from '../../src/core/model';
import { BITWARDEN_TRANSFER_MARKER } from '../../src/providers/bitwarden/bitwarden-transfer-cipher';
import { temporaryNativeHost } from './fixtures/native-host';
import { resolveBitwardenCipherKey } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { decryptBitwardenSymmetricKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../../src/core/project-credentials';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { encryptAndroidBackup } from '../../src/providers/webdav/android-backup-crypto';
import { vaultItemToAndroidRecord } from '../../src/providers/webdav/android-backup-codec';

const stamp = '2026-10-12T00:00:00.000Z', password = 'Synthetic portable password', email = 'portable@example.invalid';
const origin = 'https://portable.example.test', challenge = Buffer.alloc(32, 41).toString('base64url');
const options = { locale: 'zh-CN', colorScheme: 'dark' as const, viewport: { width: 1180, height: 950 },
  args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] };
async function send(page: Page, request: object): Promise<any> { const response = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(response.ok, response.error).toBe(true); return response.data; }

for (const sourceKind of ['local', 'mdbx', 'keepass', 'webdav'] as const) test(`a browser-created ${sourceKind} Passkey survives Bitwarden copy interruption and authenticates on a fresh Edge client`, async ({}, info) => {
  test.skip(sourceKind === 'mdbx' && !process.env.MONICA_317_NATIVE_PASSKEY_FIXTURE, 'Requires an explicitly selected verified synthetic MDBX fixture');
  test.setTimeout(180_000);
  let nativeHost: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined, sourceProviderId: string | undefined;
  const appData = path.resolve('.tmp', `mdbx-bitwarden-${randomUUID().slice(0, 12)}`, 'appdata');
  if (sourceKind === 'mdbx') await mkdir(appData, { recursive: true });
  const attachment = Buffer.from('synthetic encrypted MDBX attachment\n保留原字节'), files = new Map<string, Buffer>();
  const key = { encKey: new Uint8Array(32).fill(11), macKey: new Uint8Array(32).fill(22) };
  const protectedKey = await new BitwardenClient().protectVaultKey(key,
    await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(password, email, { type: 0, iterations: 10_000 })), new Uint8Array(16));
  const rows: Record<string, unknown>[] = [], unexpected: string[] = []; let posts = 0;
  const projectId = randomUUID(), credentialGroupId = randomUUID(), expectedCopies = sourceKind === 'local' ? 2 : 3;
  const secondRecovery = sourceKind === 'keepass' ? 'Second recovery' : 'Recovery';
  const backups = new Map<string, Buffer>(), davMethods: string[] = [];
  if (sourceKind === 'webdav') backups.set('monica_backup_initial.enc.zip', Buffer.from(await encryptAndroidBackup(zipSync({}), 'Synthetic WebDAV backup')));
  const archiveHashes = () => [...backups].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]);
  const projectField = (index: number) => ({ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1,
    projectId, groupId: credentialGroupId, passwordId: randomUUID(), label: `Account ${index}`, primary: index === 0, groupOrder: 0, passwordOrder: index }) });
  const server = createServer(async (request, response) => {
    try {
    const json = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
    const body = async () => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/dav/')) {
      davMethods.push(request.method!);
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('synthetic:synthetic').toString('base64')}`);
      if (request.method === 'PROPFIND') {
        response.writeHead(207, { 'Content-Type': 'application/xml' });
        response.end(`<d:multistatus xmlns:d="DAV:">${[...backups].map(([name, bytes], index) => `<d:response><d:href>/dav/Monica_Backups/${name}</d:href><d:propstat><d:prop>
          <d:getetag>"${createHash('sha256').update(bytes).digest('hex')}"</d:getetag><d:getcontentlength>${bytes.length}</d:getcontentlength>
          <d:getlastmodified>${new Date(Date.parse(stamp) + index * 1000).toUTCString()}</d:getlastmodified></d:prop></d:propstat></d:response>`).join('')}</d:multistatus>`); return;
      }
      const name = url.pathname.split('/').pop()!;
      if (request.method === 'PUT') {
        expect(request.headers['if-none-match']).toBe('*'); expect(backups.has(name)).toBe(false);
        backups.set(name, await body()); response.writeHead(201); response.end(); return;
      }
      if (request.method === 'GET' && backups.has(name)) {
        const bytes = backups.get(name)!, etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
        if (request.headers['if-match']) expect(request.headers['if-match']).toBe(etag);
        response.writeHead(200, { etag, 'last-modified': new Date(Date.parse(stamp) + [...backups.keys()].indexOf(name) * 1000).toUTCString() });
        response.end(bytes); return;
      }
    }
    if (url.pathname === '/identity/accounts/prelogin/password') return json({ Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === '/identity/connect/token') return json({ access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, Key: protectedKey });
    if (url.pathname === '/api/sync') return json({ Profile: { Id: 'portable-user', Email: email }, Ciphers: rows, Folders: [] });
    if (url.pathname === '/api/folders' && request.method === 'GET') return json({ Data: [] });
    if (url.pathname === '/api/accounts/revision-date') return json(Date.parse(stamp));
    if (url.pathname === '/api/ciphers' && request.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = { ...JSON.parse(Buffer.concat(chunks).toString()), id: `copy-${posts++}`, revisionDate: stamp, creationDate: stamp }; rows.push(raw);
      if (posts === 1) { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        response.flushHeaders(); response.write('{"lost":'); setImmediate(() => response.destroy()); return; }
      return json(raw);
    }
    const detail = /^\/api\/ciphers\/([^/]+)\/details$/.exec(url.pathname);
    if (detail) return json(rows.find(row => row.id === detail[1]));
    const begin = /^\/api\/ciphers\/([^/]+)\/attachment\/v2$/.exec(url.pathname);
    if (begin && request.method === 'POST') {
      const data = JSON.parse((await body()).toString()), raw = rows.find(row => row.id === begin[1])!, id = 'copied-file';
      raw.attachments = [{ id, fileName: data.fileName, key: data.key, size: String(data.fileSize) }];
      raw.revisionDate = '2026-10-12T00:00:01.000Z';
      return json({ attachmentId: id, fileUploadType: 0, url: '', cipherResponse: raw });
    }
    const file = /^\/api\/ciphers\/([^/]+)\/attachment\/(copied-file)$/.exec(url.pathname);
    if (file && request.method === 'POST') {
      const form = await new Response(await body(), { headers: { 'content-type': request.headers['content-type']! } }).formData();
      files.set(file[2], Buffer.from(await (form.get('data') as Blob).arrayBuffer())); response.end(); return;
    }
    if (file && request.method === 'GET') return json({ ...(rows.find(row => row.id === file[1])!.attachments as object[])[0], url: `${host}/download/${file[2]}` });
    if (url.pathname === '/download/copied-file') {
      expect(request.headers.authorization).toBe('Bearer synthetic'); response.end(files.get('copied-file')); return;
    }
    unexpected.push(`${request.method} ${url.pathname}`); response.writeHead(404); response.end();
    } catch { unexpected.push('Synthetic HTTP handler failed'); response.destroy(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let context: BrowserContext | undefined;
  const open = async (profile: string) => {
    context = await launchEdgeContext(info.outputPath(profile), { ...options, ...(sourceKind === 'mdbx' ? { env: { ...process.env, LOCALAPPDATA: appData } } : {}) });
    await context.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic portable Passkey</title>
      <button id="register">Register</button><button id="login">Sign in</button><output id="result"></output><script>
      window.credentialId='';register.onclick=async()=>{try{const c=await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON({
        challenge:'${challenge}',rp:{id:'portable.example.test',name:'Portable passkey'},user:{id:'dXNlcg',name:'synthetic',displayName:'Synthetic'},
        pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'${sourceKind === 'local' ? 'required' : 'discouraged'}',userVerification:'required'}})});
        window.registration=c.toJSON();result.textContent='registered';}catch(e){result.textContent=e.name+':'+e.message;}};
      login.onclick=async()=>{try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',
        rpId:'portable.example.test',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'discouraged'})});
        window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent=e.name+':'+e.message;}};</script>` }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); return page;
  };
  const confirm = async (website: Page, create: boolean) => {
    await expect(website.locator('#monica-passkey-prompt-host')).toHaveCount(1);
    await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe('monica-passkey-prompt-host');
    if (!create) { await website.keyboard.press('Home'); await website.keyboard.press('Tab'); await website.keyboard.press('Tab'); }
    const opened = context!.waitForEvent('page'); await website.keyboard.press('Enter'); const confirmation = await opened;
    await confirmation.getByLabel('Monica 主密码', { exact: true }).fill(password);
    await confirmation.getByRole('button', { name: '确认', exact: true }).click();
  };
  const setup = async (page: Page) => {
    await send(page, { type: 'VAULT_SETUP', masterPassword: password });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
  };
  const login = (page: Page) => send(page, { type: 'BITWARDEN_LOGIN', name: 'Synthetic portable target', vaultUrl: host, email, masterPassword: password });
  try {
    let page = await open('original'); await setup(page);
    if (sourceKind === 'mdbx') {
      const fixtureRoot = process.env.MONICA_317_NATIVE_PASSKEY_FIXTURE!, fixture = path.join(fixtureRoot, 'edge-passkeys.mdbx');
      const evidence = JSON.parse(await readFile(path.join(fixtureRoot, 'evidence.json'), 'utf8'));
      expect(evidence.status).toBe('passed'); expect(createHash('sha256').update(await readFile(fixture)).digest('hex')).toBe(evidence.exportSha256);
      nativeHost = await temporaryNativeHost(new URL(page.url()).host, info.outputPath('native'));
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await page.locator('m3e-list-action').filter({ hasText: '连接 MDBX2 保险库' }).click();
      const connect = page.locator('.mdbx2-dialog[role="dialog"]');
      await connect.getByLabel('显示名称', { exact: true }).fill('Synthetic MDBX source');
      await connect.getByLabel('MDBX2 可移植备份', { exact: true }).setInputFiles(fixture);
      await connect.getByLabel('保险库密码（可留空）', { exact: true }).fill('Synthetic transfer fixture password');
      await connect.locator('label').filter({ hasText: '设为新项目的默认保存目标' }).click();
      await connect.getByRole('button', { name: '验证、解锁并导入', exact: true }).click(); await expect(connect).toHaveCount(0, { timeout: 60000 });
      const source = (await send(page, { type: 'PROVIDER_LIST' })).find((row: any) => row.name === 'Synthetic MDBX source');
      expect(source.isDefaultSaveTarget).toBe(true); sourceProviderId = source.id;
    }
    if (sourceKind === 'keepass') {
      const helper = info.outputPath('keepass-fixture.cjs');
      await build({ stdin: { contents: "export {buildKeePassFixture} from './src/providers/keepass/keepass-fixture';", resolveDir: process.cwd() },
        outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
      const api = createRequire(import.meta.url)(helper) as typeof import('../../src/providers/keepass/keepass-fixture');
      const bytes = await api.buildKeePassFixture({ password: 'Synthetic source KDBX', entries: [] });
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await page.locator('m3e-list-action').filter({ hasText: '连接 KeePass' }).click();
      const connect = dialogContent(page, { name: /KeePass/ });
      await connect.getByLabel('显示名称', { exact: true }).fill('Synthetic KeePass source');
      await connect.getByLabel('KeePass 数据库文件', { exact: true }).setInputFiles({ name: 'synthetic.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
      await connect.getByLabel('数据库密码（可留空）', { exact: true }).fill('Synthetic source KDBX');
      await connect.locator('label').filter({ hasText: '设为新项目的默认保存目标' }).click();
      await connect.getByRole('button', { name: '解锁并连接', exact: true }).click(); await expect(connect).toHaveCount(0);
      const source = (await send(page, { type: 'PROVIDER_LIST' })).find((row: any) => row.name === 'Synthetic KeePass source');
      expect(source.isDefaultSaveTarget).toBe(true); sourceProviderId = source.id;
    }
    if (sourceKind === 'webdav') {
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await page.locator('m3e-list-action').filter({ hasText: '连接 Monica Android WebDAV' }).click();
      const connect = page.getByRole('dialog', { name: '连接 Monica Android WebDAV', exact: true });
      await connect.getByLabel('显示名称', { exact: true }).fill('Synthetic WebDAV source');
      await connect.getByLabel('WebDAV 地址 *', { exact: true }).fill(`${host}/dav`);
      await connect.getByLabel('用户名', { exact: true }).fill('synthetic');
      await connect.getByLabel('WebDAV 密码', { exact: true }).fill('synthetic');
      await connect.getByLabel('Android 备份加密密码（可选）', { exact: true }).fill('Synthetic WebDAV backup');
      await connect.locator('label').filter({ hasText: '设为新项目的默认保存目标' }).click();
      await connect.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(connect).toHaveCount(0);
      const source = (await send(page, { type: 'PROVIDER_LIST' })).find((row: any) => row.name === 'Synthetic WebDAV source');
      expect(source.isDefaultSaveTarget).toBe(true); sourceProviderId = source.id;
      await send(page, { type: 'PROVIDER_SYNC', providerId: sourceProviderId });
    }
    let website = await context!.newPage(); await website.goto(origin);
    await website.locator('#register').click(); await confirm(website, true); await expect(website.locator('#result')).toHaveText('registered');
    const original = (await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(row => row.kind === 'passkey' && row.rpId === 'portable.example.test') as PasskeyItem;
    expect(original).toMatchObject({ sourceMode: 'browser-local', signCount: 0, userVerificationRequired: true, discoverable: sourceKind === 'local' });
    expect(original.providerRefs.map(row => row.providerId)).toEqual(sourceProviderId && sourceKind !== 'webdav' ? [sourceProviderId] : []);
    if (sourceKind === 'webdav') {
      // Legacy snapshot providers are not direct WebAuthn registration targets.
      // Import an encrypted native backup of this genuinely registered key.
      backups.set('monica_backup_registered.enc.zip', Buffer.from(await encryptAndroidBackup(zipSync({
        'passkeys/passkey_registered.json': strToU8(JSON.stringify(vaultItemToAndroidRecord(original, undefined, undefined, { allowPortablePasskeys: true })))
      }), 'Synthetic WebDAV backup')));
      await send(page, { type: 'VAULT_DELETE_ITEM', itemId: original.id });
      await send(page, { type: 'PROVIDER_SYNC', providerId: sourceProviderId });
      const native = (await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(row => row.kind === 'passkey' && row.providerRefs[0]?.providerId === sourceProviderId) as PasskeyItem;
      expect(native).toMatchObject({ credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, signCount: 0 });
    }
    const rich: LoginItem = { ...createLoginItem({ title: 'Rich portable password', username: 'synthetic', password: 'synthetic-secret', uris: [origin] }),
      loginType: 'PASSWORD', appPackageName: 'test.portable', appName: 'Portable', email: 'user@example.test', phone: '+000123',
      addressLine: 'Synthetic street', city: 'City', state: 'State', zipCode: '1234', country: 'XX',
      customFields: [{ name: 'Recovery', value: 'first', protected: true }, { name: secondRecovery, value: 'second', protected: true, fieldType: 'HIDDEN' }],
      passwordHistory: sourceKind === 'local' || sourceKind === 'webdav' ? [{ password: 'synthetic-older', lastUsedAt: stamp }] : undefined,
      providerRefs: sourceProviderId ? [{ providerId: sourceProviderId }] : [], mdbxFolderId: original.mdbxFolderId };
    if (sourceProviderId) { rich.passwordGroupId = projectId; rich.customFields.push(projectField(0)); }
    await send(page, { type: 'VAULT_UPSERT_ITEM', item: rich });
    if (sourceProviderId) {
      await send(page, { type: 'VAULT_UPSERT_ITEM', item: { ...rich, id: randomUUID(), title: 'Second project account',
        username: 'second', password: 'synthetic-second-secret', customFields: [projectField(1)] } });
      await send(page, { type: 'PROVIDER_SYNC', providerId: sourceProviderId });
      const upload = await send(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_BEGIN', providerId: sourceProviderId, itemId: rich.id,
        fileName: 'recovery.txt', sizeBytes: attachment.length, sha256: createHash('sha256').update(attachment).digest('hex') });
      await send(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_CHUNK', providerId: sourceProviderId, transferId: upload.transferId, offset: 0, dataBase64: attachment.toString('base64') });
      await send(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_FINISH', providerId: sourceProviderId, itemId: rich.id, transferId: upload.transferId });
      await send(page, { type: 'PROVIDER_SYNC', providerId: sourceProviderId });
    }
    // Native sync adds committed remote identity and revision. Compare against
    // that committed source snapshot, while original key bytes stay anchored to registration.
    const sourcesBeforeCopy = await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[];
    const archivesBeforeCopy = archiveHashes();
    if (sourceKind === 'keepass') await info.attach('source-shape', { contentType: 'application/json', body: JSON.stringify(sourcesBeforeCopy.map(row => {
      const base = JSON.parse(row.providerRefs[0]?.etag || '{}');
      return { kind: row.kind, database: row.keepassDatabaseId, baselineDatabase: base.keepassDatabaseId,
        algorithm: row.kind === 'passkey' ? row.keyAlgorithm : undefined, baselineAlgorithm: base.keyAlgorithm,
        aaguid: row.kind === 'passkey' ? row.aaguid : undefined, baselineAaguid: base.aaguid };
    })) });
    const { providerId } = await login(page); await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator('[data-home-provider-id]').filter({ has: page.getByRole('heading', { name: 'Synthetic portable target', exact: true }) })
      .getByRole('button', { name: '批量传输', exact: true }).click();
    const dialog = dialogContent(page, { name: '复制或移动项目' });
    await dialog.getByRole('checkbox', { name: /Portable passkey/ }).check(); await dialog.getByRole('checkbox', { name: /Rich portable password/ }).check();
    const davStart = davMethods.length;
    await dialog.getByRole('button', { name: '检查并生成计划', exact: true }).click();
    await expect(dialog.getByText(`${expectedCopies} 个可传输，0 个被阻断`, { exact: true })).toBeVisible();
    if (sourceKind === 'webdav') expect(davMethods.slice(davStart)).toEqual(['PROPFIND', 'GET', 'PROPFIND']);
    await dialog.getByRole('button', { name: '执行复制', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '恢复传输', exact: true })).toBeVisible(); expect(posts).toBe(1);
    const pending = await send(page, { type: 'BITWARDEN_PENDING_TRANSFERS', providerId }); expect(pending).toHaveLength(1);
    await send(page, { type: 'VAULT_LOCK' }); await context!.close(); context = undefined;
    page = await open('original'); await send(page, { type: 'VAULT_UNLOCK', masterPassword: password });
    expect(await send(page, { type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: pending[0].request })).toMatchObject({ completedCount: expectedCopies, failedCount: 0 });
    expect(posts).toBe(expectedCopies);
    const afterCopy = await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[];
    for (const source of sourcesBeforeCopy) expect(afterCopy.find(row => row.id === source.id)).toEqual(source);
    if (sourceKind === 'webdav') {
      expect(archiveHashes()).toEqual(archivesBeforeCopy);
      expect(davMethods.slice(davStart)).toEqual(['PROPFIND', 'GET', 'PROPFIND', 'PROPFIND', 'GET', 'PROPFIND']);
    }
    await context!.close(); context = undefined;

    // Independent installation has no local policy/identity cache from registration.
    page = await open('fresh-client'); await setup(page); const fresh = await login(page);
    await send(page, { type: 'PROVIDER_SYNC', providerId: fresh.providerId });
    const imported: VaultItem[] = await send(page, { type: 'VAULT_LIST_ITEMS' });
    const passkey = imported.find(row => row.kind === 'passkey') as PasskeyItem;
    expect(passkey).toMatchObject({ credentialId: original.credentialId, signCount: 0, userVerificationRequired: true, discoverable: sourceKind === 'local' });
    expect(Buffer.from(passkey.privateKeyPkcs8!, 'base64')).toEqual(Buffer.from(original.privateKeyPkcs8!, 'base64'));
    const passwordItem = imported.find(row => row.title === rich.title) as LoginItem;
    for (const field of ['username','password','uris','passwordHistory','appPackageName','appName','email','phone','addressLine','city','state','zipCode','country'] as const)
      if (!(sourceKind === 'keepass' && field === 'passwordHistory')) expect(passwordItem[field], field).toEqual(rich[field]);
    if (sourceKind === 'keepass') expect(passwordItem.passwordHistory).toEqual([{ password: rich.password, lastUsedAt: expect.any(String) }]);
    expect(passwordItem.customFields.filter(row => row.name !== PROJECT_CREDENTIAL_FIELD)).toEqual([{ name: 'Recovery', value: 'first', protected: true }, { name: secondRecovery, value: 'second', protected: true },
      { name: BITWARDEN_TRANSFER_MARKER, value: expect.any(String), protected: true }]);
    expect(JSON.parse(passwordItem.customFields.find(row => row.name === BITWARDEN_TRANSFER_MARKER)!.value)).toMatchObject({ version: 1, operationId: pending[0].request.operationId });
    if (sourceProviderId) {
      const sibling = imported.find(row => row.title === 'Second project account') as LoginItem;
      expect(sibling).toMatchObject({ username: 'second', password: 'synthetic-second-secret', passwordGroupId: passwordItem.passwordGroupId });
      expect(passwordItem.passwordGroupId).toBeTruthy(); expect(passwordItem.passwordGroupId).not.toBe(projectId);
      expect(readProjectCredential(passwordItem.customFields)).toEqual({ ...readProjectCredential(rich.customFields), projectId: passwordItem.passwordGroupId });
      expect(readProjectCredential(sibling.customFields)).toMatchObject({ projectId: passwordItem.passwordGroupId, groupId: credentialGroupId, passwordOrder: 1 });
      const catalog = await send(page, { type: 'PROVIDER_ATTACHMENT_LIST', providerId: fresh.providerId, itemId: passwordItem.id });
      expect(catalog.items).toHaveLength(1); expect(catalog.items[0].fileName).toBe('recovery.txt');
      const download = await send(page, { type: 'PROVIDER_ATTACHMENT_READ_BEGIN', providerId: fresh.providerId, itemId: passwordItem.id,
        attachmentId: catalog.items[0].attachmentId });
      try {
        const chunk = await send(page, { type: 'PROVIDER_ATTACHMENT_READ_CHUNK', providerId: fresh.providerId, readHandle: download.readHandle, offset: 0 });
        expect(chunk.eof).toBe(true); expect(Buffer.from(chunk.dataBase64, 'base64')).toEqual(attachment);
      } finally { await send(page, { type: 'PROVIDER_ATTACHMENT_READ_RELEASE', providerId: fresh.providerId, readHandle: download.readHandle }); }
      const raw = rows.find(row => (row.attachments as unknown[])?.length)!;
      const cipherKey = await resolveBitwardenCipherKey(raw, key), file = (raw.attachments as Record<string, string>[])[0];
      try {
        const fileKey = await decryptBitwardenSymmetricKey(file.key, cipherKey), wire = Uint8Array.from(files.get('copied-file')!);
        try {
          const mac = await crypto.subtle.importKey('raw', fileKey.macKey as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
          expect(await crypto.subtle.verify('HMAC', mac, wire.subarray(17, 49), Buffer.concat([wire.subarray(1, 17), wire.subarray(49)]))).toBe(true);
          const aes = await crypto.subtle.importKey('raw', fileKey.encKey as BufferSource, 'AES-CBC', false, ['decrypt']);
          expect(Buffer.from(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: wire.subarray(1, 17) }, aes, wire.subarray(49)))).toEqual(attachment);
        } finally { fileKey.encKey.fill(0); fileKey.macKey.fill(0); }
      } finally { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); }
    }
    website = await context!.newPage(); await website.goto(origin); await website.evaluate(id => { (window as any).credentialId = id; }, original.credentialId);
    await website.locator('#login').click(); await confirm(website, false); await expect(website.locator('#result')).toHaveText('authenticated');
    const assertion = await website.evaluate(() => (window as any).assertion);
    expect(assertion.id).toBe(original.credentialId);
    const auth = Buffer.from(assertion.response.authenticatorData, 'base64url'), client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
    expect(auth.readUInt32BE(33)).toBe(0); expect(auth[32] & 0x1c).toBe(0x1c);
    expect(JSON.parse(client.toString())).toMatchObject({ origin, challenge, type: 'webauthn.get' });
    expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
      createPublicKey({ key: Buffer.from(original.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    expect(posts).toBe(expectedCopies); expect(unexpected).toEqual([]);
    await info.attach('acceptance', { contentType: 'application/json', body: JSON.stringify({ browserRegistration: true, interruptedCreate: true,
      fullRestart: true, independentFreshClient: true, preservedSources: true, remoteCiphers: posts, zeroCounter: true,
      sourceKind, verificationRequiredWhenRpDiscourages: true, independentlyVerifiedAssertion: true, richPasswordFields: true, nativeAttachment: !!sourceProviderId,
      nativeProjectMembers: sourceProviderId ? 2 : 0, freshClientAttachmentRead: !!sourceProviderId }) });
  } finally {
    try { await context?.close(); } finally {
      try { await nativeHost?.restore(); } finally {
        server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); key.encKey.fill(0); key.macKey.fill(0);
      }
    }
  }
});
