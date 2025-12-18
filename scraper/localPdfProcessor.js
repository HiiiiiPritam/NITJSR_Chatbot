import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFLoader } from "langchain/document_loaders/fs/pdf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export class LocalPdfProcessor {
    constructor(options = {}) {
        this.pdfDir = options.pdfDir || path.join(ROOT_DIR, 'scraper', 'pdfs');
    }

    async processAll(scrapedData) {
        try {
            // Ensure PDF directory exists
            await fs.mkdir(this.pdfDir, { recursive: true });
            
            const files = await fs.readdir(this.pdfDir);
            const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));
            
            if (pdfFiles.length === 0) {
                console.log('[local-pdf] No local PDFs found in', this.pdfDir);
                return scrapedData;
            }

            console.log(`[local-pdf] Found ${pdfFiles.length} local PDFs. Processing...`);

            if (!scrapedData.documents) scrapedData.documents = { pdfs: [] };
            if (!scrapedData.documents.pdfs) scrapedData.documents.pdfs = [];

            let addedCount = 0;
            let updatedCount = 0;

            for (const file of pdfFiles) {
                const fullPath = path.join(this.pdfDir, file);
                const pdfObj = await this._processFile(fullPath);
                
                if (pdfObj) {
                    const idx = scrapedData.documents.pdfs.findIndex(p => p.url === pdfObj.url);
                    if (idx === -1) {
                        scrapedData.documents.pdfs.push(pdfObj);
                        addedCount++;
                    } else {
                        scrapedData.documents.pdfs[idx] = pdfObj;
                        updatedCount++;
                    }
                }
            }

            // Update global statistics
            if (!scrapedData.statistics) scrapedData.statistics = {};
            scrapedData.statistics.totalPDFs = scrapedData.documents.pdfs.length;

            console.log(`[local-pdf] Completed: ${addedCount} added, ${updatedCount} updated.`);
            return scrapedData;
        } catch (error) {
            console.error('[local-pdf] Error during batch processing:', error.message);
            return scrapedData;
        }
    }

    async _processFile(filePath) {
        try {
            const fileName = path.basename(filePath);
            const loader = new PDFLoader(filePath, { splitPages: false });
            const docs = await loader.load();
            
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
            console.error(`[local-pdf] Failed to process ${path.basename(filePath)}:`, error.message);
            return null;
        }
    }
}
