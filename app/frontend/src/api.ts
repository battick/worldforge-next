import { createWorldForgeClient } from '../../client/index.ts';
export const api = createWorldForgeClient(import.meta.env.VITE_API_BASE_URL ?? '');
