import type { Definition, HistoryRecord, WorkspaceState } from '../../contracts/workspace.ts';

/** Legacy bodies were created and attached together; later references never change original membership. */
export function resourceMembership(state: WorkspaceState, history: HistoryRecord[]): WorkspaceState {
  const definitions = new Map<string, Definition>();
  const membership = new Map<string, boolean>();
  for (const record of [...history].reverse()) {
    for (const change of record.changes) if (change.collection === 'definitions') {
      if (change.after) definitions.set(change.id, change.after as Definition); else definitions.delete(change.id);
    }
    const created = record.changes.filter(c => c.collection === 'resources' && c.before === null && c.after);
    for (const change of created) membership.set(change.id, true);
    for (const change of record.changes) if (change.collection === 'objects' && change.after) {
      const object = change.after as WorkspaceState['objects'][number];
      for (const [fid, values] of Object.entries(object.fields)) if (definitions.get(fid)?.marks.includes('body')) for (const value of values) {
        if (value && typeof value === 'object' && 'resource' in value && created.some(c => c.id === value.resource)) membership.set(String(value.resource), false);
      }
    }
  }
  return { ...state, resources: state.resources.map(resource => ({ ...resource, space: resource.space ?? membership.get(resource.id) ?? true })) };
}
