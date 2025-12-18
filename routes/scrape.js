import fs from 'fs/promises';
import path from 'path';
import { authenticateAdmin } from "../config/auth.js";

const summarizePageCategories = (pages = []) => {
    const counts = pages.reduce((acc, page) => {
        const key = page?.category || 'general';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
};


export function setupScrapeRoutes(app, server) {

    // Scrape fresh data endpoint
    app.post('/scrape', authenticateAdmin, async (req, res) => {
        try {
            if (!server.scraperEnabled) {
                return res.status(503).json({ success: false, error: 'Scraper is disabled' });
            }
            const payload = req.body || {};
            const { force = false } = payload;
            const scrapeOptions = server.buildScrapeOptions(payload);
            const hasOverrides = Object.keys(scrapeOptions).length > 0;

            console.log('Starting comprehensive data scrape...');
            if (hasOverrides) {
                console.log('[scrape] Runtime overrides:', scrapeOptions);
            }
            const scraper = await server.ensureScraper();
            const scrapeResult = await scraper.scrapeComprehensive(scrapeOptions);

            res.json({
                success: true,
                message: 'Comprehensive data scraped successfully (including local PDFs)',
                summary: scrapeResult.summary,
                options: scrapeOptions,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error('Scrape error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    //Embed the latest available scraped file
    app.post('/embed-latest', authenticateAdmin, async (req, res) => {
        try {
            const dataDir = path.join(path.dirname(__dirname), 'scraped_data');
            const files = await fs.readdir(dataDir);
            const latestFile = files
                .filter(f => f.startsWith('jharkhand_gscc_') && f.endsWith('.json'))
                .sort((a, b) => b.localeCompare(a))
                [0];

            if (!latestFile) {
                return res.status(404).json({ success: false, error: 'No scraped data files found' });
            }

            const filePath = path.join(dataDir, latestFile);
            const scrapedData = JSON.parse(await fs.readFile(filePath, 'utf8'));

            console.log(`[embed-latest] Processing ${latestFile}...`);
            await server.ragSystem.initialize();
            const embedResult = await server.ragSystem.processAndStoreDocuments(scrapedData);

            res.json({
                success: true,
                message: `Latest data file (${latestFile}) embedded successfully`,
                stats: embedResult?.stats,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('[embed-latest] Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });



    // Combined scrape and embed endpoint
    app.post('/scrape-and-embed', authenticateAdmin, async (req, res) => {
        try {
            if (!server.scraperEnabled) {
                return res.status(503).json({ success: false, error: 'Scraper is disabled' });
            }
            const payload = req.body || {};
            const { force = false } = payload;
            const scrapeOptions = server.buildScrapeOptions(payload);
            const hasOverrides = Object.keys(scrapeOptions).length > 0;

            console.log('[scrape-and-embed] Starting combined scrape + embed...');
            if (hasOverrides) {
                console.log('[scrape-and-embed] Runtime overrides:', scrapeOptions);
            }

            const scraper = await server.ensureScraper();
            const scrapeResult = await scraper.scrapeComprehensive(scrapeOptions);
            console.log(
                '[scrape-and-embed] Scrape completed:',
                scrapeResult?.summary || 'No summary available'
            );

            const scrapedData = JSON.parse(await fs.readFile(scrapeResult.filepath, 'utf8'));

            // Build a brief summary for logs/response
            const brief = {
                pagesScraped: scrapedData.pages?.length || 0,
                pdfsProcessed: scrapedData.documents?.pdfs?.length || 0,
                totalLinks: scrapedData.statistics?.totalLinks || 0,
                pdfLinks: scrapedData.links?.pdf?.length || 0,
                internalLinks: scrapedData.links?.internal?.length || 0,
                categories: summarizePageCategories(scrapedData.pages || []),
                timestamp: scrapedData.metadata?.timestamp || new Date().toISOString(),
                scrapeType: scrapedData.metadata?.scrapeType || 'unknown',
                filename: path.basename(scrapeResult.filepath),
            };

            console.log('[scrape-and-embed] Summary:', {
                pagesScraped: brief.pagesScraped,
                pdfsProcessed: brief.pdfsProcessed,
                totalLinks: brief.totalLinks,
                categories: brief.categories?.length || 0,
                file: brief.filename,
            });

            if (force) {
                console.log('[scrape-and-embed] Force flag set — clearing existing vector index...');
                await server.ragSystem.clearIndex();
            }

            await server.ragSystem.initialize();

            console.log('[scrape-and-embed] Embedding scraped data into vector store...');
            const embedResult = await server.ragSystem.processAndStoreDocuments(scrapedData);
            console.log(
                '[scrape-and-embed] Embedding completed:',
                embedResult?.stats || 'No stats available'
            );

            server.isInitialized = true;

            res.json({
                success: true,
                message: 'Comprehensive data scraped and embedded successfully',
                timestamp: new Date().toISOString(),
                aiProvider: 'Google Gemini',
                options: scrapeOptions,
                scrape: {
                    summary: scrapeResult.summary,
                    brief,
                },
                embed: {
                    runStartedAt: embedResult?.runStartedAt || null,
                    stats: embedResult?.stats || null,
                    ledger: Boolean(embedResult?.ledger),
                },
            });

        } catch (error) {
            console.error('[scrape-and-embed] Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

}
