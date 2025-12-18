import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFLoader } from "langchain/document_loaders/fs/pdf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PDF_DIR = path.join(ROOT_DIR, 'scraper', 'pdfs');
const SCRAPED_DATA_DIR = path.join(ROOT_DIR, 'scraped_data');

async function getLatestScrapedJson() {
    const files = await fs.readdir(SCRAPED_DATA_DIR);
    const jsonFiles = files.filter(f => f.startsWith('jharkhand_gscc_') && f.endsWith('.json'));
    
    if (jsonFiles.length === 0) return null;

    const fileDetails = [];
    for (const name of jsonFiles) {
        const stats = await fs.stat(path.join(SCRAPED_DATA_DIR, name));
        fileDetails.push({ name, time: stats.mtimeMs });
    }

    fileDetails.sort((a, b) => b.time - a.time);
    return path.join(SCRAPED_DATA_DIR, fileDetails[0].name);
}

async function processLocalPdfWithLangchain(filePath) {
    try {
        const fileName = path.basename(filePath);
        console.log(`[local-pdf] Processing ${fileName} with Langchain...`);
        
        const loader = new PDFLoader(filePath, { splitPages: false });
        const docs = await loader.load();
        
        // combine all page content
        const text = docs.map(d => d.pageContent).join('\n');
        const pages = docs.length;
        
        return {
            url: `local://${fileName.replace(/\s+/g, '_')}`,
            title: fileName.replace(/\.[^/.]+$/, "").replace(/_/g, ' '),
            text: text,
            pages: pages,
            category: 'schemes',
            timestamp: new Date().toISOString(),
            parentPageUrl: 'local://internal-repository',
            parentPageTitle: 'Internal Scheme Documents',
            wordCount: text.split(/\s+/).filter(w => w.length > 0).length
        };
    } catch (error) {
        console.error(`[local-pdf] Error processing ${path.basename(filePath)}:`, error.message);
        return null;
    }
}

async function main() {
    try {
        const latestJson = await getLatestScrapedJson();
        if (!latestJson) {
            console.error('[local-pdf] No scraped JSON file found.');
            return;
        }
        
        console.log(`[local-pdf] Target: ${path.basename(latestJson)}`);
        
        const files = await fs.readdir(PDF_DIR);
        const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));
        
        if (pdfFiles.length === 0) {
            console.warn(`[local-pdf] No PDFs found in ${PDF_DIR}`);
            return;
        }

        const scrapedData = JSON.parse(await fs.readFile(latestJson, 'utf8'));
        
        if (!scrapedData.documents) scrapedData.documents = { pdfs: [] };
        if (!scrapedData.documents.pdfs) scrapedData.documents.pdfs = [];

        for (const file of pdfFiles) {
            const pdfObj = await processLocalPdfWithLangchain(path.join(PDF_DIR, file));
            if (pdfObj) {
                const idx = scrapedData.documents.pdfs.findIndex(p => p.url === pdfObj.url);
                if (idx === -1) {
                    scrapedData.documents.pdfs.push(pdfObj);
                    console.log(`[local-pdf] ✅ Added: ${pdfObj.title}`);
                } else {
                    scrapedData.documents.pdfs[idx] = pdfObj;
                    console.log(`[local-pdf] 🔄 Updated: ${pdfObj.title}`);
                }
            }
        }

        scrapedData.statistics.totalPDFs = scrapedData.documents.pdfs.length;
        await fs.writeFile(latestJson, JSON.stringify(scrapedData, null, 2));
        console.log(`[local-pdf] Process complete.`);

    } catch (error) {
        console.error('[local-pdf] Fatal error:', error);
    }
}

main();
