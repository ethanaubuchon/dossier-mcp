import { writeFileSync } from 'node:fs';
import { serializeOpenApiDocument } from '../src/openapi.js';

const target = new URL('../openapi.json', import.meta.url);
writeFileSync(target, serializeOpenApiDocument());
console.log(`wrote ${target.pathname}`);
