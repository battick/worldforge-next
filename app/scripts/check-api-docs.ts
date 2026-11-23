import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API, API_VERSION } from '../contracts/api.ts';
import { openApiDocument } from '../backend/server/openapi.ts';

// Public code checkout needs only the machine-readable contract.
// --with-docs additionally checks the locally maintained, ignored Markdown guide.
const appDir = new URL('../', import.meta.url);
const args = process.argv.slice(2);
assert(args.every(arg => arg === '--with-docs'), 'Usage: check-api-docs.ts [--with-docs]');
const generated = JSON.parse(readFileSync(new URL('contracts/openapi.json', appDir), 'utf8'));
assert.deepEqual(generated, openApiDocument, 'OpenAPI已过期，请先运行 npm run api:export。');
assert.equal(generated.info.version, API_VERSION, 'OpenAPI版本与公共接口版本不同。');

const publicPaths: string[] = Object.values(API).filter(value => typeof value === 'string');
publicPaths.push(API.resume('contract-task-id').replace('contract-task-id', '{id}'));
assert.deepEqual(publicPaths.sort(), Object.keys(openApiDocument.paths).sort(), '公共接口路径与OpenAPI不一致。');
if (!args.includes('--with-docs')) {
  console.log(`Verified API ${API_VERSION}: ${publicPaths.length} public paths and generated OpenAPI; no local Markdown required.`);
} else {
  const document = readFileSync(new URL('docs/API接口文档.md', appDir), 'utf8');
  assert(document.includes(`接口版本：\`${API_VERSION}\``), 'Markdown接口版本未与contracts/api.ts同步。');

  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
  const expected = Object.entries(openApiDocument.paths).flatMap(([route, operations]) => Object.keys(operations)
    .filter(method => methods.has(method)).map(method => `${method.toUpperCase()} ${route}`)).sort();
  const actual = [...document.matchAll(/^### (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE) (\/\S+)\s*$/gm)]
    .map(match => `${match[1]} ${match[2]}`).sort();
  assert.equal(new Set(actual).size, actual.length, 'Markdown存在重复接口章节。');
  assert.deepEqual(actual, expected, 'Markdown的接口章节与OpenAPI不同，请同步新增、删除或改名的接口。');

  const examples = [...document.matchAll(/^```json\r?\n([\s\S]*?)^```\s*$/gm)];
  for (const [index, example] of examples.entries()) {
    try { JSON.parse(example[1]!); }
    catch { throw new Error(`接口文档第${index + 1}个JSON示例无法解析。`); }
  }
  console.log(`Verified API ${API_VERSION}: ${expected.length} documented operations, ${examples.length} JSON examples, and generated OpenAPI (${fileURLToPath(appDir)}).`);
}
