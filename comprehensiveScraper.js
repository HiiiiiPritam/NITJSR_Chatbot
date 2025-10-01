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

class NITJSRComprehensiveScraper {
    constructor(options = {}) {
        this.browser = null;
        this.page = null;
        this.visited = new Set();
        this.toVisit = new Set();
        this.maxPages = options.maxPages || 100;
        this.maxDepth = options.maxDepth || 3;
        this.delay = options.delay || 2000;
        this.baseUrl = 'https://nitjsr.ac.in';
        
        this.scrapedData = {
            metadata: {
                timestamp: new Date().toISOString(),
                source: 'NIT Jamshedpur Official Website',
                baseUrl: this.baseUrl,
                scrapeType: 'comprehensive',
                maxPages: this.maxPages,
                maxDepth: this.maxDepth
            },
            pages: [],
            documents: {
                pdfs: [],
                images: [],
                other: []
            },
            categories: {
                academics: [],
                admissions: [],
                placements: [],
                faculty: [],
                students: [],
                research: [],
                administration: [],
                news: [],
                events: [],
                departments: [],
                general: []
            },
            statistics: {
                totalPages: 0,
                totalPDFs: 0,
                totalImages: 0,
                totalLinks: 0,
                categorizedPages: 0
            }
        };
    }

    async initialize() {
        console.log('🚀 Initializing Comprehensive Website Scraper...');
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
                '--disable-features=VizDisplayCompositor',
                '--disable-images', // Speed optimization
                '--disable-javascript', // For some pages, speed optimization
            ]
        });
        this.page = await this.browser.newPage();
        
        // Set user agent
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await this.page.setViewport({ width: 1920, height: 1080 });
        
        console.log('✅ Comprehensive scraper initialized successfully');
    }

    categorizeUrl(url, content = '') {
        const urlLower = url.toLowerCase();
        const contentLower = content.toLowerCase();
        
        if (urlLower.includes('placement') || contentLower.includes('placement') || 
            urlLower.includes('career') || contentLower.includes('career')) {
            return 'placements';
        }
        if (urlLower.includes('admission') || urlLower.includes('apply') || 
            contentLower.includes('admission') || contentLower.includes('eligibility')) {
            return 'admissions';
        }
        if (urlLower.includes('academic') || urlLower.includes('syllabus') || 
            urlLower.includes('curriculum') || contentLower.includes('academic')) {
            return 'academics';
        }
        if (urlLower.includes('faculty') || urlLower.includes('staff') || 
            contentLower.includes('professor') || contentLower.includes('faculty')) {
            return 'faculty';
        }
        if (urlLower.includes('student') || urlLower.includes('hostel') || 
            contentLower.includes('student life') || urlLower.includes('activity')) {
            return 'students';
        }
        if (urlLower.includes('research') || urlLower.includes('publication') || 
            contentLower.includes('research') || urlLower.includes('phd')) {
            return 'research';
        }
        if (urlLower.includes('department') || urlLower.includes('dept') || 
            urlLower.includes('/cse') || urlLower.includes('/ece') || urlLower.includes('/mech')) {
            return 'departments';
        }
        if (urlLower.includes('news') || urlLower.includes('announcement') || 
            contentLower.includes('news') || urlLower.includes('notice')) {
            return 'news';
        }
        if (urlLower.includes('event') || urlLower.includes('seminar') || 
            urlLower.includes('workshop') || contentLower.includes('event')) {
            return 'events';
        }
        if (urlLower.includes('admin') || urlLower.includes('office') || 
            urlLower.includes('registrar') || contentLower.includes('administration')) {
            return 'administration';
        }
        
        return 'general';
    }

    isValidUrl(url) {
        try {
            const urlObj = new URL(url, this.baseUrl);
            
            // Only scrape nitjsr.ac.in domain
            if (!urlObj.hostname.includes('nitjsr.ac.in')) {
                return false;
            }
            
            // Skip certain file types and external links
            const skipExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.css', '.js', '.ico', '.svg'];
            const skipPatterns = [
                'mailto:', 'tel:', 'javascript:', '#',
                'facebook.com', 'twitter.com', 'linkedin.com', 'youtube.com',
                'google.com', 'maps.google', 'instagram.com'
            ];
            
            const pathname = urlObj.pathname.toLowerCase();
            
            if (skipExtensions.some(ext => pathname.endsWith(ext))) {
                return false;
            }
            
            if (skipPatterns.some(pattern => url.toLowerCase().includes(pattern))) {
                return false;
            }
            
            return true;
        } catch (error) {
            return false;
        }
    }

    async scrapePage(url, depth = 0) {
        if (this.visited.has(url) || depth > this.maxDepth || this.visited.size >= this.maxPages) {
            return null;
        }

        console.log(`🔍 Scraping [${depth}/${this.maxDepth}]: ${url}`);
        this.visited.add(url);

        try {
            await this.page.goto(url, { 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });

            await this.page.waitForTimeout(this.delay);

            const pageData = await this.page.evaluate(() => {
                const data = {
                    title: document.title || '',
                    headings: [],
                    content: [],
                    links: [],
                    metadata: {
                        description: '',
                        keywords: ''
                    }
                };

                // Extract meta information
                const metaDescription = document.querySelector('meta[name="description"]');
                if (metaDescription) {
                    data.metadata.description = metaDescription.getAttribute('content') || '';
                }
                
                const metaKeywords = document.querySelector('meta[name="keywords"]');
                if (metaKeywords) {
                    data.metadata.keywords = metaKeywords.getAttribute('content') || '';
                }

                // Extract headings with hierarchy
                document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
                    data.headings.push({
                        level: parseInt(heading.tagName.charAt(1)),
                        text: heading.textContent.trim(),
                        id: heading.id || null
                    });
                });

                // Extract meaningful content (paragraphs, lists, tables)
                const contentSelectors = [
                    'p', 'li', 'td', 'th', 'div.content', 
                    '.main-content', '.page-content', '.article-content'
                ];
                
                contentSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(element => {
                        const text = element.textContent.trim();
                        if (text && text.length > 20) { // Filter out short/meaningless text
                            data.content.push(text);
                        }
                    });
                });

                // Extract internal links
                document.querySelectorAll('a[href]').forEach(link => {
                    const href = link.getAttribute('href');
                    const text = link.textContent.trim();
                    if (href && text) {
                        data.links.push({
                            href: href,
                            text: text,
                            title: link.getAttribute('title') || ''
                        });
                    }
                });

                return data;
            });

            // Process the scraped data
            const processedPage = {
                url: url,
                timestamp: new Date().toISOString(),
                depth: depth,
                title: pageData.title,
                headings: pageData.headings,
                content: pageData.content.join(' '), // Join all content
                links: pageData.links,
                metadata: pageData.metadata,
                category: this.categorizeUrl(url, pageData.content.join(' ')),
                wordCount: pageData.content.join(' ').split(' ').length
            };

            // Add to appropriate category
            this.scrapedData.categories[processedPage.category].push(processedPage);
            this.scrapedData.pages.push(processedPage);

            // Add new links to visit queue
            pageData.links.forEach(link => {
                try {
                    const fullUrl = new URL(link.href, url).href;
                    if (this.isValidUrl(fullUrl) && !this.visited.has(fullUrl)) {
                        this.toVisit.add({url: fullUrl, depth: depth + 1});
                    }
                } catch (error) {
                    // Invalid URL, skip
                }
            });

            console.log(`✅ Scraped: ${pageData.title} (${pageData.content.length} content items)`);
            return processedPage;

        } catch (error) {
            console.error(`❌ Failed to scrape ${url}:`, error.message);
            return null;
        }
    }

    async scrapePDFDocuments() {
        if (!axios || !pdfParse) {
            console.log('📄 Skipping PDF scraping (dependencies not available)');
            return;
        }

        console.log('📄 Discovering and processing PDF documents...');
        const pdfLinks = new Set();

        // Collect PDF links from all scraped pages
        this.scrapedData.pages.forEach(page => {
            page.links.forEach(link => {
                if (link.href.toLowerCase().includes('.pdf')) {
                    try {
                        const fullUrl = new URL(link.href, page.url).href;
                        pdfLinks.add(fullUrl);
                    } catch (error) {
                        // Invalid URL
                    }
                }
            });
        });

        console.log(`📄 Found ${pdfLinks.size} PDF documents to process`);

        for (const pdfUrl of Array.from(pdfLinks).slice(0, 20)) { // Limit to 20 PDFs
            try {
                console.log(`📖 Processing PDF: ${pdfUrl}`);
                const response = await axios.get(pdfUrl, { 
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });

                const pdfData = await pdfParse(response.data);
                
                this.scrapedData.documents.pdfs.push({
                    url: pdfUrl,
                    title: pdfUrl.split('/').pop(),
                    text: pdfData.text,
                    pages: pdfData.numpages,
                    category: this.categorizeUrl(pdfUrl, pdfData.text),
                    timestamp: new Date().toISOString()
                });

                console.log(`✅ Processed PDF: ${pdfData.numpages} pages`);

            } catch (error) {
                console.error(`❌ Failed to process PDF ${pdfUrl}:`, error.message);
            }
        }
    }

    async scrapeComprehensive() {
        try {
            await this.initialize();
            
            // Start with main sections of the website
            const startUrls = [
                'https://nitjsr.ac.in/',
                'https://nitjsr.ac.in/Students/Placements',
                'https://nitjsr.ac.in/Admissions',
                'https://nitjsr.ac.in/Academics',
                'https://nitjsr.ac.in/Faculty',
                'https://nitjsr.ac.in/Research',
                'https://nitjsr.ac.in/Students',
                'https://nitjsr.ac.in/Administration'
            ];

            // Add starting URLs to visit queue
            startUrls.forEach(url => {
                this.toVisit.add({url: url, depth: 0});
            });

            console.log(`🌐 Starting comprehensive scrape of ${startUrls.length} main sections...`);

            // Process queue with breadth-first approach
            while (this.toVisit.size > 0 && this.visited.size < this.maxPages) {
                const {url, depth} = Array.from(this.toVisit)[0];
                this.toVisit.delete(Array.from(this.toVisit)[0]);

                await this.scrapePage(url, depth);
                
                // Show progress
                if (this.visited.size % 10 === 0) {
                    console.log(`📊 Progress: ${this.visited.size}/${this.maxPages} pages scraped`);
                }
            }

            // Process PDFs
            await this.scrapePDFDocuments();

            // Update statistics
            this.updateStatistics();

            const result = await this.saveData();
            await this.cleanup();

            return result;

        } catch (error) {
            console.error('❌ Comprehensive scraping failed:', error.message);
            await this.cleanup();
            throw error;
        }
    }

    updateStatistics() {
        this.scrapedData.statistics.totalPages = this.scrapedData.pages.length;
        this.scrapedData.statistics.totalPDFs = this.scrapedData.documents.pdfs.length;
        this.scrapedData.statistics.totalLinks = this.scrapedData.pages.reduce(
            (sum, page) => sum + page.links.length, 0
        );
        this.scrapedData.statistics.categorizedPages = Object.values(this.scrapedData.categories)
            .reduce((sum, category) => sum + category.length, 0);
    }

    async saveData() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
        const filename = `nitjsr_comprehensive_${timestamp}.json`;
        const filepath = path.join(__dirname, 'scraped_data', filename);

        // Ensure directory exists
        await fs.mkdir(path.dirname(filepath), { recursive: true });

        // Save the data
        await fs.writeFile(filepath, JSON.stringify(this.scrapedData, null, 2), 'utf8');

        const summary = {
            filename: filename,
            timestamp: new Date().toISOString(),
            totalPages: this.scrapedData.statistics.totalPages,
            totalPDFs: this.scrapedData.statistics.totalPDFs,
            totalLinks: this.scrapedData.statistics.totalLinks,
            categories: Object.keys(this.scrapedData.categories).map(cat => ({
                name: cat,
                count: this.scrapedData.categories[cat].length
            })),
            filepath: filepath
        };

        console.log(`💾 Data saved to: ${filepath}`);
        return { summary, filepath, data: this.scrapedData };
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            console.log('🧹 Browser cleanup completed');
        }
    }
}

// CLI usage
if (require.main === module) {
    (async () => {
        const scraper = new NITJSRComprehensiveScraper({
            maxPages: 50,  // Limit for testing
            maxDepth: 3,
            delay: 1000
        });
        
        try {
            const result = await scraper.scrapeComprehensive();
            console.log('🎉 Comprehensive scraping completed successfully!');
            console.log('📋 Summary:', result.summary);
        } catch (error) {
            console.error('💥 Comprehensive scraping failed:', error.message);
            process.exit(1);
        }
    })();
}

module.exports = { NITJSRComprehensiveScraper };