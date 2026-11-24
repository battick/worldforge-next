import { z } from 'zod';
import { API_VERSION, API } from '../../contracts/api.ts';
import { commandSchema, definitionSchema } from '../core/model.ts';

export const documentInput = z.object({ markdown: z.string().max(100_000), version: z.number().int().positive() }).strict();
export const messageInput = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
const document = z.object({ markdown: z.string(), version: z.number().int(), updatedAt: z.string() });
const snapshot = z.object({ eventId: z.number().int(), document, messages: z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.string() })), tasks: z.array(z.object({ id: z.string(), prompt: z.string(), status: z.enum(['running', 'waiting', 'interrupted', 'failed', 'completed']), step: z.string(), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() })) });
const receipt = z.object({ operationId: z.string().uuid(), revision: z.number().int() });
const difference = z.object({ collection: z.enum(['worlds', 'definitions', 'objects', 'resources']), id: z.string(), before: z.unknown(), after: z.unknown() });
const workspace = z.object({
  state: z.object({ revision: z.number().int(), worlds: z.array(z.object({ id: z.string(), rootId: z.string() })), definitions: z.array(definitionSchema.extend({ version: z.number().int() })), objects: z.array(z.object({ id: z.string(), worldId: z.string(), fields: z.record(z.string(), z.array(z.unknown())) })), resources: z.array(z.object({ id: z.string(), worldId: z.string(), path: z.string(), version: z.number().int(), space: z.boolean().optional() })), resourceVersions: z.array(z.object({ id: z.string(), version: z.number().int(), mime: z.string(), content: z.string(), hash: z.string() })) }),
  history: z.array(receipt.extend({ baseRevision: z.number().int(), actor: z.literal('user'), createdAt: z.string(), changes: z.array(difference) })), references: z.array(z.object({ ownerId: z.string(), fieldId: z.string(), targetId: z.string(), kind: z.enum(['object', 'resource', 'definition']) })),
});
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'draft-2020-12' });
const content = (value: z.ZodType) => ({ 'application/json': { schema: schema(value) } });
const errors = Object.fromEntries([400, 403, 404, 409, 413, 415, 422, 500, 503].map(status => [status, { description: '统一错误，message供页面显示，code供程序判断', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } }]));
const endpoint = (summary: string, output: z.ZodType, input?: z.ZodType, status = 200) => ({ summary, ...(input ? { requestBody: { required: true, content: content(input) } } : {}), responses: { [status]: { description: '成功', content: content(output) }, ...errors } });

export const openApiDocument = {
  openapi: '3.1.0', info: { title: 'WorldForge 本机数据接口', version: API_VERSION, description: '前端替换时保持本接口；支持手工世界、Wiki和空间资料，Agent仍为固定回复演示。' }, servers: [{ url: 'http://127.0.0.1:4318' }],
  paths: {
    [API.openapi]: { get: endpoint('获取当前OpenAPI接口说明，正文为OpenAPI文档对象', z.record(z.string(), z.unknown())) },
    [API.health]: { get: endpoint('检查后端状态', z.object({ status: z.literal('ok'), stage: z.string(), model: z.literal('demo'), apiVersion: z.string() })) },
    [API.snapshot]: { get: endpoint('读取创作纸、消息和任务', snapshot) },
    [API.document]: { put: endpoint('带版本保存创作纸，版本冲突返回409', document, documentInput) },
    [API.messages]: { post: endpoint('开始演示任务', z.object({ taskId: z.string() }), messageInput, 202) },
    '/api/demo/tasks/{id}/resume': { post: { ...endpoint('显式继续原演示任务', z.object({ taskId: z.string() }), undefined, 202), parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
    [API.workspace]: { get: endpoint('一致读取定义、对象、资源、历史与引用', workspace) },
    [API.commands]: { post: endpoint('一次整体应用命令，相同操作编号和负载返回原收据', receipt, commandSchema) },
    [API.example]: { post: endpoint('显式新增虚构样例，不覆盖已有数据', z.object({ ids: z.record(z.string(), z.string()), command: commandSchema, receipt }), undefined, 201) },
    [API.events]: { get: { summary: 'SSE实时快照，event=snapshot，id为事件编号，data与GET snapshot相同；重连发送当前完整状态', responses: { 200: { description: '15秒心跳，关闭页面不停止后端任务', content: { 'text/event-stream': { schema: { type: 'string' } } } }, ...errors } } },
  },
  components: { schemas: { ApiError: schema(z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), details: z.unknown().optional() }) })) } },
};
