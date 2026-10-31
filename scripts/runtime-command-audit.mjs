import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function readRuntimeAuditSources(root) {
  const files = (await readdir(resolve(root, 'src/background'))).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  const modules = Object.fromEntries(await Promise.all(files.map(async name => [`./${name.slice(0, -3)}`, await readFile(resolve(root, 'src/background', name), 'utf8')])));
  return { entry: modules['./index'], composition: modules['./composition'], events: modules['./events'],
    executor: modules['./command-router'], access: modules['./request-access'], modules,
    messages: await readFile(resolve(root, 'src/runtime/messages.ts'), 'utf8') };
}

const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
const uncast = node => ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? uncast(node.expression) : node;
const nameOf = node => node && ts.isIdentifier(uncast(node)) ? uncast(node).text : undefined;
const callOf = (node, name) => node && ts.isCallExpression(node) && nameOf(node.expression) === name;
const fn = (ast, name) => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
const declaration = (statements, name) => statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => nameOf(node.name) === name);
const statementCalls = (statement, name) => statement && ts.isExpressionStatement(statement) && callOf(statement.expression, name);
const fail = message => { throw new Error(`Runtime command audit: ${message}`); };
const compact = value => value.replace(/\s+/g, '');
function actualCalls(node, ast, includeDeclarations = false) {
  const calls = [];
  const walk = current => {
    if (ts.isFunctionDeclaration(current) && !includeDeclarations) return;
    if (ts.isCallExpression(current)) calls.push(current);
    ts.forEachChild(current, walk);
  };
  walk(node);
  return calls;
}
function inputValue(input, name, ast) {
  const property = input.properties.find(node => node.name?.getText(ast) === name);
  return property && (ts.isShorthandPropertyAssignment(property) ? property.name.text : ts.isPropertyAssignment(property) ? property.initializer.getText(ast)
    : ts.isGetAccessor(property) && ts.isReturnStatement(property.body?.statements[0]) ? property.body.statements[0].expression.getText(ast) : undefined);
}

function requireReturnCall(statements, name) {
  const last = statements.at(-1);
  if (!last || !ts.isReturnStatement(last) || !callOf(last.expression, name)) fail(`actual return must invoke ${name}`);
  return last.expression;
}

function requireImport(ast, path, symbol) {
  const imported = ast.statements.some(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === path
    && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(element => element.name.text === symbol));
  if (!imported) fail(`wired import ${symbol} from ${path} is missing`);
}

/** Audit only the handlers selected by the production dispatcher. A matching
 * branch in an uncalled module or dead function cannot satisfy coverage. */
export function auditRuntimeCommands(sources) {
  const bootstrap = parse('index.ts', sources.entry), entry = parse('composition.ts', sources.composition), executor = parse('command-router.ts', sources.executor);
  const access = parse('request-access.ts', sources.access), message = parse('messages.ts', sources.messages);
  requireImport(bootstrap, './composition', 'startBackground');
  if (bootstrap.statements.filter(node => !ts.isImportDeclaration(node)).length !== 1
    || !statementCalls(bootstrap.statements.at(-1), 'startBackground')) fail('entry must start the actual composition');
  requireImport(entry, './command-router', 'createCommandExecutor');
  requireImport(executor, './request-access', 'WEB_PAGE_REQUEST_TYPES');
  requireImport(executor, './request-access', 'assertExtensionPage');
  requireImport(executor, './request-access', 'assertManagerPage');
  requireImport(executor, './mdbx-direct-write', 'mdbxDirectWriteProvider');
  for (const [name, trusted] of [['assertManagerPage', 'assertTrustedManagerPage'], ['assertExtensionPage', 'assertTrustedExtensionPage'], ['assertWebPageSender', 'requireTrustedWebPageSender']]) {
    requireImport(access, '../runtime/sender-policy', trusted);
    const implementation = fn(access, name)?.body;
    const last = implementation?.statements.at(-1);
    const call = last && (ts.isExpressionStatement(last) || ts.isReturnStatement(last)) ? last.expression : undefined;
    if (!callOf(call, trusted) || nameOf(call.arguments[0]) !== 'sender' || call.arguments[1]?.getText(access) !== 'chrome.runtime.id') fail(`${name} must directly invoke trusted sender authentication`);
  }
  const composed = fn(entry, 'startBackground')?.body?.statements || [];
  const command = declaration(composed, 'executeCommand');
  if (!callOf(command?.initializer, 'createCommandExecutor')) fail('executor is not constructed');
  const handling = requireReturnCall(composed.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleRequest')?.body?.statements || [], 'executeCommand');
  if (nameOf(handling.arguments[0]) !== 'request' || nameOf(handling.arguments[1]) !== 'sender'
    || nameOf(handling.arguments[2]) !== 'routeRequest') fail('request does not cross the executor');

  requireImport(entry, './events', 'installBackgroundEvents');
  const eventCall = composed.find(node => statementCalls(node, 'installBackgroundEvents'))?.expression;
  const eventInput = eventCall?.arguments[0];
  if (!eventInput || !ts.isObjectLiteralExpression(eventInput) || !eventInput.properties.some(node => ts.isShorthandPropertyAssignment(node) && node.name.text === 'handleRequest')) fail('browser messages are not wired to the guarded request handler');
  for (const [name, value] of Object.entries({
    nearbyOwner: 'nearbyOwner', clearPendingPasskeyRequests: 'passkeyRuntime.clearPendingPasskeyRequests',
    clearCredentialCaptures: 'credentialRuntime.clearCredentialCaptures', clearPendingUsernameContexts: 'credentialRuntime.clearPendingUsernameContexts',
    clearKeePassPendingPersistence: 'keePassRuntime.clearKeePassPendingPersistence', keePassProvider: 'keePassRuntime.keePassProvider',
    mdbx2Provider: 'mdbxRuntime.mdbx2Provider', mdbx2NativeClient: 'mdbxRuntime.mdbx2NativeClient', providerSync: 'providerSync',
    clearTransferSessions: 'transferRuntime.clearTransferSessions', clearTransferStatuses: 'transferRuntime.clearTransferStatuses'
  })) if (inputValue(eventInput, name, entry) !== value) fail(`actual lifecycle dependency ${name} is not wired`);
  for (const [event, method] of [['chrome.webNavigation.onCommitted.addListener', 'passkeyRuntime.navigationCommitted'], ['chrome.tabs.onRemoved.addListener', 'passkeyRuntime.tabRemoved']]) {
    if (!composed.some(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(entry) === event && node.expression.arguments[0]?.getText(entry) === method)) fail(`${event} must register the actual cancellation method`);
  }
  const events = parse('events.ts', sources.modules['./events']);
  const install = fn(events, 'installBackgroundEvents');
  const messageListener = install?.body?.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(events) === 'chrome.runtime.onMessage.addListener');
  const messageBody = messageListener?.expression.arguments[0]?.body;
  let browserCall = messageBody?.statements.find(node => ts.isExpressionStatement(node))?.expression;
  while (browserCall && ts.isCallExpression(browserCall) && ts.isPropertyAccessExpression(browserCall.expression) && ['catch', 'then'].includes(browserCall.expression.name.text)) browserCall = browserCall.expression.expression;
  if (!browserCall || !ts.isCallExpression(browserCall) || browserCall.expression.getText(events) !== 'deps.handleRequest'
    || browserCall.arguments.map(node => nameOf(node)).join(',') !== 'message,sender') fail('actual browser listener must invoke the guarded handler');
  for (const [event, required] of [
    ['chrome.runtime.onConnect.addListener', ['deps.nearbyOwner.attach']],
    ['chrome.runtime.onSuspend.addListener', ['deps.nearbyOwner.close']],
    ['chrome.storage.onChanged.addListener', ['deps.nearbyOwner.close', 'deps.nearbyOwner.sessionChanged']],
    ['chrome.alarms.onAlarm.addListener', ['deps.nearbyOwner.close', 'deps.clearPendingPasskeyRequests', 'deps.clearCredentialCaptures', 'deps.mdbx2Provider.lock', 'deps.keePassProvider.lock']]
  ]) {
    const registration = install?.body?.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(events) === event)?.expression;
    const callback = registration?.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) fail(`actual event registration missing: ${event}`);
    const calls = actualCalls(callback.body, events);
    for (const method of required) if (!calls.some(call => call.expression.getText(events) === method)) fail(`actual event cancellation missing: ${event} / ${method}`);
  }

  const executorFactory = fn(executor, 'createCommandExecutor');
  const execution = executorFactory?.body?.statements.find(node => ts.isReturnStatement(node) && ts.isFunctionExpression(node.expression))?.expression;
  const first = execution?.body?.statements[0];
  if (!first || !ts.isIfStatement(first) || first.expression.getText(executor) !== '!WEB_PAGE_REQUEST_TYPES.has(request.type)'
    || !statementCalls(first.thenStatement, 'assertExtensionPage')) fail('default-deny must precede handler invocation');
  const native = execution.body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(executor).includes('nativeProvider'));
  const classification = declaration(execution.body.statements, 'nativeProvider')?.initializer;
  if (!callOf(classification, 'mdbxDirectWriteProvider') || nameOf(classification.arguments[0]) !== 'request') fail('actual native classification missing');
  if (!native || compact(native.expression.getText(executor)) !== compact("nativeProvider && (await service.getProvider(nativeProvider))?.kind === 'mdbx2'")) fail('actual native write condition changed');
  const protectedStatements = native?.thenStatement && ts.isBlock(native.thenStatement) ? native.thenStatement.statements : [];
  if (!statementCalls(protectedStatements[0], 'assertManagerPage')) fail('native writes must require the manager');
  const queued = protectedStatements[1]?.expression;
  if (!queued || !ts.isCallExpression(queued) || queued.expression.getText(executor) !== 'providerOperations.run') fail('native writes must hold the provider queue');
  if (nameOf(queued.arguments[0]) !== 'nativeProvider') fail('native writes must queue the classified provider');
  const work = queued.arguments[1]?.body?.statements;
  for (const [index, guard] of ['assertNoBitwardenMdbxMove', 'assertNoNearbyNativeSequence'].entries()) {
    const expression = work?.[index]?.expression;
    if (!expression || !ts.isAwaitExpression(expression) || !ts.isCallExpression(expression.expression)
      || expression.expression.expression.getText(executor) !== `service.${guard}` || nameOf(expression.expression.arguments[0]) !== 'nativeProvider') fail(`native write guard ${guard} missing`);
  }
  const invocation = requireReturnCall(work || [], 'handler');
  if (nameOf(invocation.arguments[0]) !== 'request' || nameOf(invocation.arguments[1]) !== 'sender' || invocation.arguments[2]?.kind !== ts.SyntaxKind.TrueKeyword) fail('native ownership metadata missing');
  const direct = requireReturnCall(execution.body.statements, 'handler');
  if (direct.arguments[2]?.kind !== ts.SyntaxKind.FalseKeyword) fail('direct ownership metadata invalid');

  const allowlist = declaration(access.statements, 'WEB_PAGE_REQUEST_TYPES')?.initializer;
  if (!allowlist || !ts.isNewExpression(allowlist) || nameOf(allowlist.expression) !== 'Set'
    || !ts.isArrayLiteralExpression(allowlist.arguments?.[0])) fail('allowlist cannot be parsed');
  const webTypes = new Set(allowlist.arguments[0].elements.map(node => {
    if (!ts.isStringLiteral(node)) fail('allowlist must contain explicit command names');
    return node.text;
  }));

  const handlers = new Map();
  const add = (type, implementation) => {
    if (handlers.has(type)) fail(`duplicate handler ${type}`);
    handlers.set(type, implementation);
  };
  requireImport(entry, './command-router', 'createCommandDispatcher');
  const routing = declaration(composed, 'routeRequest')?.initializer;
  if (!callOf(routing, 'createCommandDispatcher') || nameOf(routing.arguments[0]) !== 'handlers') fail('actual dispatcher must use the aggregate table');
  const dispatcher = fn(executor, 'createCommandDispatcher')?.body?.statements[0]?.expression;
  const route = dispatcher?.body?.statements;
  const lookup = declaration(route || [], 'handler')?.initializer;
  if (!callOf(lookup, 'commandHandler') || nameOf(lookup.arguments[0]) !== 'handlers' || nameOf(lookup.arguments[1]) !== 'request') fail('dispatcher must select from its actual table');
  const guard = route?.[1];
  if (!guard || !ts.isIfStatement(guard) || guard.expression.getText(executor) !== '!handler' || !ts.isThrowStatement(guard.thenStatement)) fail('unknown commands must fail closed');
  const routed = requireReturnCall(route, 'handler');
  if (routed.arguments.map(node => nameOf(node)).join(',') !== 'request,sender,nativeWriteLocked') fail('dispatcher must forward native queue ownership');
  const aggregate = declaration(composed, 'handlers')?.initializer;
  if (!aggregate || !ts.isObjectLiteralExpression(aggregate)) fail('aggregate table missing');
  const wiredModules = new Map();
  for (const spread of aggregate.properties) {
    const value = spread.expression;
    if (!ts.isSpreadAssignment(spread) || !ts.isPropertyAccessExpression(value) || value.name.text !== 'handlers') fail('aggregate requires explicit module tables');
    const instance = nameOf(value.expression);
    const construction = declaration(composed, instance)?.initializer;
    const factory = nameOf(construction?.expression);
    const imported = entry.statements.find(node => ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(element => element.name.text === factory));
    const path = imported?.moduleSpecifier.text;
    const source = sources.modules[path];
    if (!instance || !factory || !path || !source) fail('handler factory must be imported and constructed in the composition');
    requireImport(entry, path, factory);
    if (!callOf(construction, factory)) fail(`${instance} is not constructed`);
    const input = construction.arguments[0];
    if (!input || !ts.isObjectLiteralExpression(input)) fail(`${instance} requires explicit dependency wiring`);
    for (const [name, value] of Object.entries({ nearbyOwner: 'nearbyOwner', service: 'service', providerOperations: 'providerOperations', providerSync: 'providerSync',
      clearPendingPasskeyRequests: 'passkeyRuntime.clearPendingPasskeyRequests', clearPendingUsernameContexts: 'credentialRuntime.clearPendingUsernameContexts',
      clearCredentialCaptures: 'credentialRuntime.clearCredentialCaptures', clearKeePassPendingPersistence: 'keePassRuntime.clearKeePassPendingPersistence',
      mdbx2Provider: 'mdbxRuntime.mdbx2Provider', mdbx2NativeClient: 'mdbxRuntime.mdbx2NativeClient', keePassProvider: 'keePassRuntime.keePassProvider' })) {
      if (input.properties.some(property => property.name?.getText(entry) === name) && inputValue(input, name, entry) !== value) fail(`actual ${instance} dependency ${name} is not wired`);
    }
    if (instance === 'attachmentRuntime' && (!ts.isObjectLiteralExpression(construction.arguments[0])
      || !construction.arguments[0].properties.some(node => ts.isShorthandPropertyAssignment(node) && node.name.text === 'executeCommand'))) fail('internal attachment writes must use the wired executor');
    const module = parse(path, source), body = fn(module, factory)?.body?.statements;
    for (const symbol of ['assertManagerPage', 'assertExtensionPage', 'assertWebPageSender']) {
      if (body?.some(node => actualCalls(node, module, true).some(call => nameOf(call.expression) === symbol))) requireImport(module, './request-access', symbol);
    }
    const table = declaration(body || [], 'handlers')?.initializer;
    const returned = body?.at(-1)?.expression;
    if (!table || !ts.isObjectLiteralExpression(table) || !returned || !ts.isObjectLiteralExpression(returned)
      || !returned.properties.some(node => ts.isShorthandPropertyAssignment(node) && node.name.text === 'handlers')) fail(`${factory} does not return its actual table`);
    for (const property of table.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isArrowFunction(property.initializer)) fail('handlers require explicit names and implementations');
      add(property.name.text, property.initializer.body.getText(module).replace(/\bdeps\./g, ''));
    }
    if (instance === 'attachmentRuntime') {
      const invocation = requireReturnCall(body.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'invokeAttachment')?.body?.statements || [], 'executeCommand');
      if (nameOf(invocation.arguments[0]) !== 'request' || nameOf(invocation.arguments[2]) !== 'handler') fail('internal attachment guard is bypassed');
    }
    wiredModules.set(path, source);
  }
  const declaredTypes = new Set();
  const union = message.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'ExtensionRequest')?.type;
  if (!union || !ts.isUnionTypeNode(union)) fail('request union missing');
  const collectDeclarations = variant => {
    if (ts.isParenthesizedTypeNode(variant)) return collectDeclarations(variant.type);
    if (ts.isIntersectionTypeNode(variant)) { variant.types.forEach(collectDeclarations); return; }
    for (const member of ts.isTypeLiteralNode(variant) ? variant.members : []) {
      if (ts.isPropertySignature(member) && member.name.getText(message) === 'type' && member.type && ts.isLiteralTypeNode(member.type)
        && ts.isStringLiteral(member.type.literal)) declaredTypes.add(member.type.literal.text);
    }
  };
  union.types.forEach(collectDeclarations);
  if (!declaredTypes.size) fail('request declarations missing');
  for (const type of declaredTypes) if (!handlers.has(type)) fail(`missing handler ${type}`);
  for (const type of handlers.keys()) if (!declaredTypes.has(type)) fail(`undeclared handler ${type}`);
  for (const type of webTypes) if (!declaredTypes.has(type)) fail(`undeclared web command ${type}`);
  for (const [type, implementation] of handlers) {
    if (/^(?:MDBX2_|PROVIDER_ATTACHMENT_|BITWARDEN_SEND_|KEEPASS_|VAULT_PASSWORD_PROJECT_|VAULT_KEEPASS_PROJECT_)/.test(type)
      || ['VAULT_BATCH_MUTATE', 'VAULT_AUTHENTICATED_EXPORT', 'VAULT_STORAGE_OVERVIEW', 'VAULT_RECOVERY_CLEAR',
        'BITWARDEN_PENDING_TRANSFERS', 'BITWARDEN_CANCEL_UNWRITTEN_TRANSFER', 'BITWARDEN_KEEP_BOTH_TRANSFER',
        'PROVIDER_SYNC', 'PROVIDER_SYNC_CANCEL', 'BITWARDEN_SYNC_ALL'].includes(type)) {
      if (webTypes.has(type) || !/^\s*\{?\s*assertManagerPage\(sender\);/.test(implementation)) fail(`${type} must require the manager before side effects`);
    }
  }
  for (const type of ['VAULT_RECOVERY_CLEAR', 'VAULT_PASSWORD_PROJECT_REMOVE', 'VAULT_PASSWORD_PROJECT_RESTORE',
    'VAULT_KEEPASS_PROJECT_REMOVE', 'VAULT_KEEPASS_PROJECT_RESOLVE', 'VAULT_KEEPASS_PROJECT_RECOVERY_DELETE',
    'PROVIDER_ATTACHMENT_DELETE', 'BITWARDEN_SEND_DELETE', 'BITWARDEN_SEND_REMOVE_PASSWORD']) {
    if (!handlers.get(type)?.includes('request.confirmed !== true')) fail(`${type} explicit confirmation missing`);
  }
  const productionBodies = new Map();
  const instances = [];
  for (const node of composed) {
    const calls = ts.isVariableStatement(node) ? [...node.declarationList.declarations].map(d => [nameOf(d.name), d.initializer])
      : ts.isExpressionStatement(node) ? [[undefined, node.expression]] : [];
    for (const [instance, call] of calls) {
      if (!call || !ts.isCallExpression(call)) continue;
      const factory = nameOf(call.expression);
      const imported = entry.statements.find(node => ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some(element => element.name.text === factory));
      const path = imported?.moduleSpecifier.text;
      if (!sources.modules[path]) continue;
      const ast = parse(path, sources.modules[path]), body = fn(ast, factory)?.body;
      if (!body) continue;
      productionBodies.set(path, body.getText(ast));
      if (instance) instances.push(instance);
    }
  }
  const normalize = text => instances.reduce((value, instance) => value.replaceAll(`${instance}.`, ''), text).replace(/\bdeps\./g, '').replace(/\s+/g, ' ');
  const productionSource = normalize(fn(entry, 'startBackground').body.getText(entry) + '\n' + [...productionBodies.values()].join('\n'));
  return { declaredTypes, handlers, webTypes, allowlistBlock: allowlist.getText(access), wiredModules, productionBodies, productionSource };
}
