import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../config.json');

const DEFAULT_CONFIG: Config = {
  notesDir: path.join(__dirname, '../../../notes'),
  frontmatterTemplate: '---\ntitle: "{{title}}"\ndate: {{date}}\ntags: []\nrelated: []\n---',
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: Partial<Config>): Promise<Config> {
  const current = await loadConfig();
  const updated = { ...current, ...config };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

export { CONFIG_PATH, DEFAULT_CONFIG };
