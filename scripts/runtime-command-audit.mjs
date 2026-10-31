import ts from 'typescript';

const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
const uncast = node => ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? uncast(node.expression) : node;
const nameOf = node => node && ts.isIdentifier(uncast(node)) ? uncast(node).text : undefined;
const callOf = (node, name) => node && ts.isCallExpression(node) && nameOf(node.expression) === name;
const fn = (ast, name) => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
const declaration = (statements, name) => statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => nameOf(node.name) === name);
const statementCalls = (statement, name) => statement && ts.isExpressionStatement(statement) && callOf(statement.expression, name);
const fail = message => { throw new Error(`Runtime command audit: ${message}`); };

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
  const entry = parse('index.ts', sources.entry), executor = parse('command-router.ts', sources.executor);
  const access = parse('request-access.ts', sources.access), message = parse('messages.ts', sources.messages);
  requireImport(entry, './command-router', 'createCommandExecutor');
  requireImport(executor, './request-access', 'WEB_PAGE_REQUEST_TYPES');
  requireImport(executor, './request-access', 'assertExtensionPage');
  requireImport(executor, './request-access', 'assertManagerPage');
  const command = declaration(entry.statements, 'executeCommand');
  if (!callOf(command?.initializer, 'createCommandExecutor')) fail('executor is not constructed');
  const handling = requireReturnCall(fn(entry, 'handleRequest')?.body?.statements || [], 'executeCommand');
  if (nameOf(handling.arguments[0]) !== 'request' || nameOf(handling.arguments[1]) !== 'sender'
    || nameOf(handling.arguments[2]) !== 'routeRequest') fail('request does not cross the executor');

  const executorFactory = fn(executor, 'createCommandExecutor');
  const execution = executorFactory?.body?.statements.find(node => ts.isReturnStatement(node) && ts.isFunctionExpression(node.expression))?.expression;
  const first = execution?.body?.statements[0];
  if (!first || !ts.isIfStatement(first) || first.expression.getText(executor) !== '!WEB_PAGE_REQUEST_TYPES.has(request.type)'
    || !statementCalls(first.thenStatement, 'assertExtensionPage')) fail('default-deny must precede handler invocation');
  const native = execution.body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(executor).includes('nativeProvider'));
  const protectedStatements = native?.thenStatement && ts.isBlock(native.thenStatement) ? native.thenStatement.statements : [];
  if (!statementCalls(protectedStatements[0], 'assertManagerPage')) fail('native writes must require the manager');
  const queued = protectedStatements[1]?.expression;
  if (!queued || !ts.isCallExpression(queued) || queued.expression.getText(executor) !== 'providerOperations.run') fail('native writes must hold the provider queue');
  const work = queued.arguments[1]?.body?.statements;
  for (const [index, guard] of ['assertNoBitwardenMdbxMove', 'assertNoNearbyNativeSequence'].entries()) {
    const expression = work?.[index]?.expression;
    if (!expression || !ts.isAwaitExpression(expression) || !ts.isCallExpression(expression.expression)
      || expression.expression.expression.getText(executor) !== `service.${guard}`) fail(`native write guard ${guard} missing`);
  }
  const invocation = requireReturnCall(work || [], 'handler');
  if (invocation.arguments[2]?.kind !== ts.SyntaxKind.TrueKeyword) fail('native ownership metadata missing');
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
  const route = fn(entry, 'routeRequest')?.body?.statements;
  if (!route) fail('routeRequest missing');
  for (const [instance, factory, path, source] of [
    ['attachmentRuntime', 'createAttachmentRuntime', './attachment-runtime', sources.attachments],
    ['bitwardenSendRuntime', 'createBitwardenSendRuntime', './bitwarden-send-runtime', sources.sends],
    ['providerSync', 'createProviderSyncRuntime', './provider-sync-runtime', sources.sync]
  ]) {
    requireImport(entry, path, factory);
    const construction = declaration(entry.statements, instance)?.initializer;
    if (!callOf(construction, factory)) fail(`${instance} is not constructed`);
    if (instance === 'attachmentRuntime' && (!ts.isObjectLiteralExpression(construction.arguments[0])
      || !construction.arguments[0].properties.some(node => ts.isShorthandPropertyAssignment(node) && node.name.text === 'executeCommand'))) fail('internal attachment writes must use the wired executor');
    const selection = route.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node =>
      callOf(node.initializer, 'commandHandler') && node.initializer.arguments[0]?.getText(entry) === `${instance}.handlers`);
    const selectedName = nameOf(selection?.name);
    const branch = route.find(node => ts.isIfStatement(node) && nameOf(node.expression) === selectedName);
    if (!selectedName || !branch || !ts.isReturnStatement(branch.thenStatement)
      || !callOf(branch.thenStatement.expression, selectedName)) fail(`${instance} handlers are not invoked`);
    const module = parse(path, source), body = fn(module, factory)?.body?.statements;
    const table = declaration(body || [], 'handlers')?.initializer;
    const returned = body?.at(-1)?.expression;
    if (!table || !ts.isObjectLiteralExpression(table) || !returned || !ts.isObjectLiteralExpression(returned)
      || !returned.properties.some(node => ts.isShorthandPropertyAssignment(node) && node.name.text === 'handlers')) fail(`${factory} does not return its actual table`);
    for (const property of table.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isArrowFunction(property.initializer)) fail('handlers require explicit names and implementations');
      add(property.name.text, property.initializer.body.getText(module));
    }
    if (instance === 'attachmentRuntime') {
      const invocation = requireReturnCall(body.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'invokeAttachment')?.body?.statements || [], 'executeCommand');
      if (nameOf(invocation.arguments[0]) !== 'request' || nameOf(invocation.arguments[2]) !== 'handler') fail('internal attachment guard is bypassed');
    }
  }
  requireReturnCall(route, 'routeCoreRequest');
  const core = fn(entry, 'routeCoreRequest');
  const dispatch = core?.body?.statements.find(node => ts.isSwitchStatement(node) && node.expression.getText(entry) === 'request.type');
  if (!dispatch) fail('core dispatcher missing');
  for (const clause of dispatch.caseBlock.clauses) {
    if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) add(clause.expression.text, clause.statements.map(node => node.getText(entry)).join('\n'));
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
  return { declaredTypes, handlers, webTypes, allowlistBlock: allowlist.getText(access) };
}
