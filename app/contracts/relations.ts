import type { ContentObject, RelationField, WorkspaceState } from './workspace.ts';
export function markedValues(state: WorkspaceState, object: ContentObject, mark: 'relation-definition' | 'relation-fields' | 'relation-type') {
  return state.definitions.filter(d => d.marks.includes(mark)).flatMap(d => object.fields[d.id] ?? []);
}
export function isRelationDefinition(state: WorkspaceState, object: ContentObject) { return markedValues(state, object, 'relation-definition').includes(true); }
export function relationFields(state: WorkspaceState, object: ContentObject): RelationField[] { return markedValues(state, object, 'relation-fields') as RelationField[]; }
export function relationTypeId(state: WorkspaceState, object: ContentObject): string | undefined {
  const value = markedValues(state, object, 'relation-type')[0] as { ref?: string } | undefined; return value?.ref;
}
