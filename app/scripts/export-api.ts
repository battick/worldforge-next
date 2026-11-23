import { writeFileSync, mkdirSync } from 'node:fs';
import { openApiDocument } from '../backend/server/openapi.ts';
mkdirSync('contracts', { recursive: true });
writeFileSync('contracts/openapi.json', JSON.stringify(openApiDocument, null, 2) + '\n');
console.log('Exported contracts/openapi.json from the backend request schemas.');
