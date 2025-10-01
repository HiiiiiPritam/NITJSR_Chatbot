const fs = require('fs').promises;
const path = require('path');

// Try to load optional dependencies
let puppeteer, axios, pdfParse, cheerio;
try {
    puppeteer = require('puppeteer');
} catch (e) { console.warn('Puppeteer not available:', e.message); }
try {
    axios = require('axios');
} catch (e) { console.warn('Axios not available:', e.message); }
try {
    pdfParse = require('pdf-parse');
} catch (e) { console.warn('PDF-parse not available:', e.message); }
try {
    cheerio = require('cheerio');
} catch (e) { console.warn('Cheerio not available:', e.message); }

class NITJSRAdvancedScraper {
    constructor() {
        this.browser = null;
        this.page = null;
        this.scrapedData = {
            metadata: {
                timestamp: new Date().toISOString(),
                source: 'NIT Jamshedpur Official Website',
                baseUrl: 'https://nitjsr.ac.in'
            },
            placements: {
                pageContent: [],
                statistics: {},
                pdfDocuments: [],
                images: [],
                links: []
            }
        };
    }

    async initialize() {
        console.log('🚀 Initializing Advanced Scraper...');
        if (!puppeteer) {
            console.warn('⚠️ Puppeteer not available, scraper will work with limited functionality');
            return;
        }
        
        this.browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        });
        this.page = await this.browser.newPage();
        
        // Set user agent to avoid being blocked
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        // Set viewport
        await this.page.setViewport({ width: 1920, height: 1080 });
        
        console.log('✅ Scraper initialized successfully');
    }

    async scrapeMainPlacementsPage() {
        console.log('🔍 Scraping main placements page...');
        const url = 'https://nitjsr.ac.in/Students/Placements';
        
        try {
            await this.page.goto(url, { 
                waitUntil: 'networkidle2', 
                timeout: 30000 
            });

            // Wait for content to load
            await this.page.waitForTimeout(3000);

            // Extract main content
            const pageData = await this.page.evaluate(() => {
                const data = {
                    title: document.title,
                    headings: [],
                    paragraphs: [],
                    links: [],
                    tables: [],
                    images: []
                };

                // Extract headings
                document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
                    data.headings.push({
                        level: heading.tagName.toLowerCase(),
                        text: heading.textContent.trim(),
                        id: heading.id || null
                    });
                });

                // Extract paragraphs
                document.querySelectorAll('p').forEach(p => {
                    const text = p.textContent.trim();
                    if (text.length > 20) {
                        data.paragraphs.push(text);
                    }
                });

                // Extract links (especially PDFs)
                document.querySelectorAll('a').forEach(link => {
                    const href = link.href;
                    const text = link.textContent.trim();
                    if (href && text) {
                        data.links.push({
                            url: href,
                            text: text,
                            isPDF: href.toLowerCase().includes('.pdf'),
                            isInternal: href.includes('nitjsr.ac.in')
                        });
                    }
                });

                // Extract tables
                document.querySelectorAll('table').forEach(table => {
                    const tableData = [];
                    table.querySelectorAll('tr').forEach(row => {
                        const rowData = [];
                        row.querySelectorAll('td, th').forEach(cell => {
                            rowData.push(cell.textContent.trim());
                        });
                        if (rowData.length > 0) tableData.push(rowData);
                    });
                    if (tableData.length > 0) data.tables.push(tableData);
                });

                // Extract images
                document.querySelectorAll('img').forEach(img => {
                    if (img.src) {
                        data.images.push({
                            src: img.src,
                            alt: img.alt || '',
                            title: img.title || ''
                        });
                    }
                });

                return data;
            });

            this.scrapedData.placements.pageContent.push({
                url: url,
                timestamp: new Date().toISOString(),
                ...pageData
            });

            console.log(`✅ Scraped main page: ${pageData.title}`);
            console.log(`📄 Found ${pageData.links.length} links, ${pageData.links.filter(l => l.isPDF).length} PDFs`);

        } catch (error) {
            console.error('❌ Error scraping main page:', error.message);
        }
    }

    async scrapePDFDocuments() {
        console.log('📚 Processing PDF documents...');
        
        const allLinks = this.scrapedData.placements.pageContent.flatMap(page => page.links || []);
        const pdfLinks = allLinks.filter(link => link.isPDF);

        console.log(`🎯 Found ${pdfLinks.length} PDF documents to process`);

        for (const pdfLink of pdfLinks.slice(0, 5)) { // Limit to first 5 PDFs
            try {
                console.log(`📖 Processing: ${pdfLink.text}`);
                
                // Download PDF
                const response = await axios.get(pdfLink.url, {
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });

                // Parse PDF content
                const pdfBuffer = Buffer.from(response.data);
                const pdfData = await pdfParse(pdfBuffer);

                this.scrapedData.placements.pdfDocuments.push({
                    url: pdfLink.url,
                    title: pdfLink.text,
                    content: pdfData.text,
                    pages: pdfData.numpages,
                    info: pdfData.info,
                    timestamp: new Date().toISOString()
                });

                console.log(`✅ Processed PDF: ${pdfLink.text} (${pdfData.numpages} pages)`);
                
                // Add delay to avoid overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.error(`❌ Error processing PDF ${pdfLink.text}:`, error.message);
            }
        }
    }

    async extractStatistics() {
        console.log('📊 Extracting placement statistics...');
        
        const allContent = [
            ...this.scrapedData.placements.pageContent.flatMap(page => page.paragraphs || []),
            ...this.scrapedData.placements.pdfDocuments.flatMap(pdf => pdf.content || '')
        ].join(' ').toLowerCase();

        // Extract key statistics using regex patterns
        const stats = {};

        // Placement percentage
        const percentageMatches = allContent.match(/(\d+(?:\.\d+)?)\s*%?\s*placed?/gi);
        if (percentageMatches) {
            stats.placementPercentage = percentageMatches[0];
        }

        // Package information
        const packageMatches = allContent.match(/(\d+(?:\.\d+)?)\s*(lpa|lakhs?)\s*(highest|maximum|max|average|avg)/gi);
        if (packageMatches) {
            stats.packages = packageMatches.slice(0, 5);
        }

        // Company names
        const companyPatterns = [
            /microsoft/gi, /google/gi, /amazon/gi, /tcs/gi, /infosys/gi, /wipro/gi,
            /accenture/gi, /cognizant/gi, /deloitte/gi, /ibm/gi, /oracle/gi
        ];
        
        stats.companiesMentioned = [];
        companyPatterns.forEach(pattern => {
            const matches = allContent.match(pattern);
            if (matches) {
                stats.companiesMentioned.push(matches[0]);
            }
        });

        // Branch-wise data
        const branchPatterns = [
            /cse|computer science/gi, /ece|electronics/gi, /mechanical/gi, 
            /civil/gi, /electrical/gi, /chemical/gi, /metallurgy/gi
        ];
        
        stats.branchesMentioned = [];
        branchPatterns.forEach(pattern => {
            const matches = allContent.match(pattern);
            if (matches) {
                stats.branchesMentioned.push(...matches);
            }
        });

        this.scrapedData.placements.statistics = stats;
        console.log('✅ Statistics extraction completed');
    }

    async discoverRelatedPages() {
        console.log('🔗 Discovering related placement pages...');
        
        const placementKeywords = [
            'placement', 'career', 'training', 'internship', 'job', 
            'recruit', 'company', 'statistics', 'report'
        ];

        try {
            // Search for placement-related pages in navigation
            await this.page.goto('https://nitjsr.ac.in', { 
                waitUntil: 'networkidle2', 
                timeout: 30000 
            });

            const relatedLinks = await this.page.evaluate((keywords) => {
                const links = [];
                document.querySelectorAll('a').forEach(link => {
                    const text = link.textContent.toLowerCase();
                    const href = link.href;
                    
                    if (href && keywords.some(keyword => text.includes(keyword))) {
                        links.push({
                            url: href,
                            text: link.textContent.trim()
                        });
                    }
                });
                return links;
            }, placementKeywords);

            this.scrapedData.placements.links = relatedLinks;
            console.log(`✅ Found ${relatedLinks.length} related pages`);

        } catch (error) {
            console.error('❌ Error discovering related pages:', error.message);
        }
    }

    async saveData() {
        console.log('💾 Saving scraped data...');
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
        const filename = `nitjsr_advanced_placements_${timestamp}.json`;
        const filepath = path.join(__dirname, 'scraped_data', filename);

        // Ensure directory exists
        await fs.mkdir(path.dirname(filepath), { recursive: true });

        // Save data
        await fs.writeFile(filepath, JSON.stringify(this.scrapedData, null, 2));
        
        console.log(`✅ Data saved to: ${filename}`);
        
        // Create summary
        const summary = {
            timestamp: new Date().toISOString(),
            totalPages: this.scrapedData.placements.pageContent.length,
            totalPDFs: this.scrapedData.placements.pdfDocuments.length,
            totalLinks: this.scrapedData.placements.links.length,
            statistics: Object.keys(this.scrapedData.placements.statistics).length,
            filename: filename
        };

        return { success: true, summary, filepath };
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            console.log('🧹 Browser cleanup completed');
        }
    }

    async scrapeAll() {
        try {
            await this.initialize();
            await this.scrapeMainPlacementsPage();
            await this.scrapePDFDocuments();
            await this.extractStatistics();
            await this.discoverRelatedPages();
            
            const result = await this.saveData();
            await this.cleanup();
            
            return result;
            
        } catch (error) {
            console.error('❌ Scraping failed:', error.message);
            await this.cleanup();
            throw error;
        }
    }
}

// CLI usage
if (require.main === module) {
    (async () => {
        const scraper = new NITJSRAdvancedScraper();
        try {
            const result = await scraper.scrapeAll();
            console.log('🎉 Scraping completed successfully!');
            console.log('📋 Summary:', result.summary);
        } catch (error) {
            console.error('💥 Scraping failed:', error.message);
            process.exit(1);
        }
    })();
}

module.exports = { NITJSRAdvancedScraper };