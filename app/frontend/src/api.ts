import { createWorldForgeClient } from '../../client/index.ts';
import type { WorkspaceCommand } from '../../contracts/workspace.ts';
const client = createWorldForgeClient(import.meta.env.VITE_API_BASE_URL ?? '');
export const WORKSPACE_CHANGED = 'worldforge:workspace-changed';
export const api = {
  ...client,
  async execute(command: WorkspaceCommand) {
    const result = await client.execute(command);
    window.dispatchEvent(new Event(WORKSPACE_CHANGED));
    return result;
  },
  async example() {
    const result = await client.example();
    window.dispatchEvent(new Event(WORKSPACE_CHANGED));
    return result;
  },
};
