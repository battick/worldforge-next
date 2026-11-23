import { readFileSync } from 'node:fs';
import { Store } from '../../backend/server/store.ts';
import { WorkspaceRepository } from '../../backend/server/workspace.ts';

const store = new Store(process.env.WORKSPACE_TEST_DIR!);
const repository = new WorkspaceRepository(store.db, () => {}, stage => { if (stage === process.env.WORKSPACE_TEST_STAGE) process.exit(79); });
repository.execute(JSON.parse(readFileSync(process.env.WORKSPACE_TEST_COMMAND!, 'utf8')));
store.close();
