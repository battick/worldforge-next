/** Public JSON contracts. No database, validation library, React or Node dependency. */
export const objectKinds = ['world', 'entry', 'relation'] as const;
export type ObjectKind = typeof objectKinds[number];
export const roles = ['id', 'kind', 'created', 'updated', 'version'] as const;
export type SystemRole = typeof roles[number];
export const marks = ['identity', 'kind', 'created', 'updated', 'version', 'title', 'body', 'classification', 'navigation', 'source', 'target', 'time-start', 'time-end', 'time-point', 'summary', 'cover', 'world-status', 'navigation-folder', 'relation-definition', 'relation-fields', 'relation-type'] as const;
export interface Constraints {
  required?: boolean; minCount?: number; maxCount?: number; min?: number; max?: number; minLength?: number; maxLength?: number;
  options?: string[]; unique?: 'world' | 'workspace'; targetKinds?: ObjectKind[]; sameWorld?: boolean;
}
export interface DefinitionInput {
  id: string; scope: string; name: string; type: 'text' | 'number' | 'boolean' | 'choice' | 'link' | 'reference' | 'resource' | 'json';
  marks: typeof marks[number][]; constraints: Constraints; comment?: string; system?: SystemRole;
}
export interface Definition extends DefinitionInput { version: number }
export interface World { id: string; rootId: string }
export interface ContentObject { id: string; worldId: string; fields: Record<string, unknown[]> }
export interface Resource { id: string; worldId: string; path: string; version: number; space?: boolean }
/** Stored as values of a JSON field marked relation-fields on an ordinary entry. */
export interface RelationField { fieldId: string; defaults?: unknown[] }
export interface ResourceVersion { id: string; version: number; mime: string; content: string; hash: string }
export interface WorkspaceState { revision: number; worlds: World[]; definitions: Definition[]; objects: ContentObject[]; resources: Resource[]; resourceVersions: ResourceVersion[] }
export type Change =
  | { type: 'world.create'; id: string }
  | { type: 'definition.put'; definition: Omit<DefinitionInput, 'scope'> & { scope?: string } }
  | { type: 'definition.delete'; id: string }
  | { type: 'object.create'; id: string; worldId: string; kind: ObjectKind; fields: Record<string, unknown[]> }
  | { type: 'object.update'; id: string; set?: Record<string, unknown[]>; unset?: string[] }
  | { type: 'object.delete'; id: string }
  | { type: 'resource.put'; id: string; worldId: string; path: string; mime: string; content: string; space?: boolean }
  | { type: 'resource.delete'; id: string };
export interface WorkspaceCommand { operationId: string; baseRevision: number; worldId?: string; changes: Change[] }
export interface Receipt { operationId: string; revision: number }
export interface Difference { collection: 'worlds' | 'definitions' | 'objects' | 'resources'; id: string; before: unknown; after: unknown }
export interface HistoryRecord extends Receipt { baseRevision: number; actor: 'user' | 'agent'; taskId?: string; createdAt: string; changes: Difference[] }
export interface ReferenceIndex { ownerId: string; fieldId: string; targetId: string; kind: 'object' | 'resource' | 'definition' }
export interface WorkspaceView { state: WorkspaceState; history: HistoryRecord[]; references: ReferenceIndex[] }
export interface ExampleResponse { ids: Record<string, string>; command: WorkspaceCommand; receipt: Receipt }
