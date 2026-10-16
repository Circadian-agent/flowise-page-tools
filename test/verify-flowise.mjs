// Compatibility probe, not a full Flowise installation or a live gateway test.
// Downloads pinned official source, then executes the Custom Tool node/core and
// selected unchanged utility declarations with a mocked HTTP boundary and DB.
// No secrets or live API calls are needed. Upstream source is not vendored.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { NodeVM } from 'vm2';
import { z } from 'zod/v3';
import JSON5 from 'json5';
import lodash from 'lodash';

const require = createRequire(import.meta.url);
const commit = '9291856d1ea4a4ceea9f8fef8ce14f4f6c81e8eb';
const base = 'https://raw.githubusercontent.com/FlowiseAI/Flowise/' + commit + '/';
const files = {
    utils: 'packages/components/src/utils.ts',
    core: 'packages/components/nodes/tools/CustomTool/core.ts',
    node: 'packages/components/nodes/tools/CustomTool/CustomTool.ts',
    ui: 'packages/ui/src/views/tools/ToolDialog.jsx',
    loader: 'packages/server/src/services/marketplaces/index.ts'
};
const source = {};
const hashes = {};
for (const [name, path] of Object.entries(files)) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, path);
    source[name] = await response.text();
    hashes[path] = createHash('sha256').update(source[name]).digest('hex');
}

const tool = JSON.parse(await readFile(new URL('../tools/Circadian Page Tools.json', import.meta.url), 'utf8'));
const names = new Set([
    'defaultAllowExternalDependencies', 'defaultAllowBuiltInDep', 'availableDependencies',
    'getBaseClasses', 'convertSchemaToZod', 'prepareSandboxVars', 'parseJsonBody',
    'parseOutput', 'executeJavaScriptCode', 'createCodeExecutionSandbox', 'parseWithTypeConversion'
]);
const ast = ts.createSourceFile('utils.ts', source.utils, ts.ScriptTarget.Latest, true);
const selected = [];
for (const statement of ast.statements) {
    const declarationNames = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map(d => d.name.getText(ast))
        : statement.name ? [statement.name.getText(ast)] : [];
    if (declarationNames.some(name => names.has(name))) {
        selected.push(statement.getText(ast));
        declarationNames.forEach(name => names.delete(name));
    }
}
assert.deepEqual([...names], [], 'All required upstream declarations must be found');

let fixture = { status: 200, data: { ok: true, httpStatus: 200, truncated: false, markdown: 'Sample', openGraph: {} } };
const calls = [];
const safeProcess = { env: { CIRCADIAN_API_MARKET_KEY: 'fixture-key' } };
const globals = {
    NodeVM, z, JSON5, cloneDeep: lodash.cloneDeep, process: safeProcess,
    secureFetch: async (url, options) => {
        calls.push({ url, options });
        return { status: fixture.status, body: { destroy() {} }, json: async () => fixture.data };
    },
    secureAxiosRequest: async () => { throw Error('Unexpected axios request'); }
};
function load(code, dependencies = {}, extra = {}) {
    const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    runInNewContext(compiled, {
        ...globals, ...extra, module, exports: module.exports, __dirname: import.meta.dirname,
        console, require: (name) => {
            if (Object.hasOwn(dependencies, name)) return dependencies[name];
            if (name.startsWith('@langchain/core/') || name === 'zod/v3') return require(name);
            throw Error('Unexpected upstream import: ' + name);
        }
    }, { timeout: 10000 });
    return module.exports;
}
const utils = load(selected.join('\n'));
const core = load(source.core, { '../../../src/utils': utils });
const nodeUtils = { ...utils, getVars: async () => [{ name: 'CIRCADIAN_API_MARKET_KEY', type: 'runtime' }] };
const { nodeClass } = load(source.node, {
    '../../../src/utils': nodeUtils,
    './core': core,
    '../../../src/secureZodParser': { SecureZodSchemaParser: { parseZodSchema() { throw Error('No custom Zod override expected'); } } }
});
const node = new nodeClass();
const options = {
    chatflowid: 'compatibility-test',
    appDataSource: { getRepository: () => ({ findOneBy: async () => tool }) },
    databaseEntities: { Tool: 'Tool' }
};
const instance = await node.init({ inputs: { selectedTool: 'fixture' } }, '', options);
const definition = instance.schema.toJSON ? instance.schema.toJSON() : Object.keys(instance.schema.shape);
assert.deepEqual(Object.keys(instance.schema.shape).sort(), ['operation', 'url']);
assert.equal(JSON.stringify(definition).includes('CIRCADIAN_API_MARKET_KEY'), false);

const results = [];
for (const operation of ['extract', 'meta']) {
    calls.length = 0;
    const output = await instance.call({ operation, url: 'https://example.com/?a=1&b=2' });
    assert.deepEqual(JSON.parse(output), fixture.data);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).searchParams.get('url'), 'https://example.com/?a=1&b=2');
    assert.equal(calls[0].options.headers['x-api-market-key'], safeProcess.env.CIRCADIAN_API_MARKET_KEY);
    results.push({ operation, status: 'PASS', calls: calls.length });
}
calls.length = 0;
await assert.rejects(instance.call({ url: 'https://example.com/' }));
assert.equal(calls.length, 0);
results.push({ case: 'required operation validated by actual Flowise schema', status: 'PASS' });
fixture = { status: 429, data: { secret: 'not_returned' } };
const limited = JSON.parse(await instance.call({ operation: 'meta', url: 'https://example.com/' }));
assert.equal(limited.error, 'limit_reached');
assert.equal(calls.length, 1);
results.push({ case: 'quota response through actual node/core/executor', status: 'PASS' });

if (process.env.PAGE_TOOLS_REPLAY) {
    const recorded = JSON.parse(await readFile(process.env.PAGE_TOOLS_REPLAY, 'utf8'));
    for (const sample of recorded.results.filter(x => x.endpoint && x.data)) {
        calls.length = 0;
        fixture = { status: sample.httpStatus, data: sample.data };
        const result = JSON.parse(await instance.call({ operation: sample.endpoint, url: sample.data.url }));
        assert.deepEqual(result, sample.data);
        assert.equal(calls.length, 1);
        results.push({ case: 'saved gateway response replay ' + sample.endpoint, recordedAt: recorded.at, status: 'PASS', live: false });
    }
}
assert.ok(source.ui.includes("dialogProps.type === 'IMPORT'"));
for (const field of ['name', 'description', 'iconSrc', 'schema', 'func']) assert.ok(source.ui.includes('dialogProps.data.' + field));
assert.ok(source.loader.includes("'marketplaces', 'tools'"));
results.push({ case: 'tool fields accepted by pinned import dialog and marketplace loader', status: 'PASS', browserTest: false });
const report = { at: new Date().toISOString(), commit, hashes, results, limits: 'Actual node/core and selected unchanged upstream functions. DB/getVars/HTTP boundary mocked. No full app, browser import, E2B sandbox, live gateway call, LLM or funded checkout test.' };
if (process.env.FLOWISE_EVIDENCE_DIR) {
    await mkdir(process.env.FLOWISE_EVIDENCE_DIR, { recursive: true });
    await writeFile(process.env.FLOWISE_EVIDENCE_DIR + '/flowise-compatibility.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
