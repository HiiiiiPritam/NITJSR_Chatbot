import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function loadAdditionalData() {
    const filePath = path.join(__dirname, 'additionalData.json');
    const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return data;
}