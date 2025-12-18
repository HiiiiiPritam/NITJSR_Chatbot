import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { APIDataCollector, JsonSitemapLoader } from './apiCollector.js';
import { UrlHelpers } from './urlHelpers.js';
import { PageCategorizer } from './categories.js';
import { PageExtractor } from './pageExtractor.js';
import { XhrCapture } from './xhrCapture.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


class EnhancedNITJSRScraper {
    constructor(options = {}) {
        this.visited = new Set();
        this.toVisit = new Set();
        this.maxPages = options.maxPages || 650;
        this.maxDepth = options.maxDepth || 3;
        this.delay = options.delay || 1500;
        this.baseUrl = 'https://nitjsr.ac.in';
        this.baseApiUrl = 'https://nitjsr.ac.in/backend/api';
        this.excludeUrls = new Set();
        this.followInternalLinks = options.followInternalLinks !== false; // Default true

        this.browserManager = null;
        this.urlHelpers = new UrlHelpers(this.baseUrl);
        this.categorizer = new PageCategorizer(this.baseUrl);
        this.pageExtractor = new PageExtractor();

        this.xhrCapture = new XhrCapture(
            this.urlHelpers,
            this.categorizer,
            this.pdfPolicy,
            this.scrapedData,
            new Set(), // pdfUrls
            new Map()  // pdfUrlOriginals
        );

        if (Array.isArray(options.excludeUrls)) {
            options.excludeUrls.forEach((raw) => {
                try {
                    const normalized = this.urlHelpers.normalizeUrl(raw);
                    if (normalized) {
                        this.excludeUrls.add(normalized.toLowerCase());
                    }
                } catch {}
            });
        }

        this.scrapedData = {
            metadata: {
                timestamp: new Date().toISOString(),
                source: 'NIT Jamshedpur Official Website',
                baseUrl: this.baseUrl,
                scrapeType: 'hybrid_api_and_dom_with_navigation',
                maxPages: this.maxPages,
                maxDepth: this.maxDepth,
                followInternalLinks: this.followInternalLinks,
                dataCollection: {
                    apiStructuredData: true,
                    domStaticContent: true,
                    jsonSitemap: true,
                    internalLinkNavigation: true
                }
            },
            apiData: {},
            staticPages: [],
            allPdfUrls: [],
            statistics: {
                totalApiEndpoints: 0,
                totalStaticPages: 0,
                totalPDFs: 0,
                apiDataCategories: 0,
                linksFollowed: 0,
            },
        };


        this.apiHandledPaths = new Set([
            '/people/faculty',
            '/people/deans',
            '/people/responsibility',
            '/notices',
            '/events',
            '/department',
            '/hod',
            '/minutes',
            '/publications',
            '/research',
            '/warden',
            '/staff',
            '/tender',
            '/projects',
            '/conferences',
            '/department_notices',
            '/dean_office_notices',
            '/manuals_forms',
            '/calendar',
            '/alumni_publication',
            '/alumni_news',
            '/media_publication',
            '/mou',
            '/placement',
            '/former_directors',
            '/debarred_agencies',
            '/iks',
            '/thesissupervised',
            '/archives',
            '/administration',
            '/faculty_course',
            '/members',
            '/counters',
        ]);
    }


    async initialize() {
        if (!this.browserManager) {
            const { BrowserManager } = await import('./browserManager.js');
            this.browserManager = new BrowserManager();
        }
        await this.browserManager.initialize();
    }


    isExcluded(url) {
        const key = this.urlHelpers.normalizeForComparison(url);
        if (!key) return false;

        if (this.excludeUrls.has(key)) return true;
        return this.excludeUrls.has(key.endsWith('/') ? key.slice(0, -1) : key + '/');
    }


    isHandledByApi(url) {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname.toLowerCase();

            for (const apiPath of this.apiHandledPaths) {
                if (pathname.startsWith(apiPath.toLowerCase())) {
                    return true;
                }
            }
            return false;
        } catch {
            return false;
        }
    }


    isInternalLink(url, currentUrl) {
        try {
            const urlObj = new URL(url, currentUrl);
            return urlObj.hostname === new URL(this.baseUrl).hostname;
        } catch {
            return false;
        }
    }


    shouldFollowLink(url, currentDepth) {
        // Don't follow if excluded
        if (this.isExcluded(url)) return false;

        // Don't follow if handled by API
        // if (this.isHandledByApi(url)) return false;

        // Don't follow PDF links
        if (url.toLowerCase().endsWith('.pdf')) return false;

        // Don't follow if already visited
        const visitKey = this.urlHelpers.normalizeForComparison(url);
        if (!visitKey || this.visited.has(visitKey)) return false;

        // Don't follow if depth exceeded
        if (currentDepth >= this.maxDepth) return false;

        // Don't follow if max pages reached
        if (this.visited.size >= this.maxPages) return false;

        // Don't follow external links
        if (!this.isInternalLink(url, this.baseUrl)) return false;

        return true;
    }


    async collectApiData() {
        console.log('\n=== Phase 1: Collecting API-Driven Structured Data ===');

        const apiCollector = new APIDataCollector(this.baseApiUrl);
        const apiData = await apiCollector.collectAll();
        await apiCollector.saveData();

        this.scrapedData.apiData = apiData;
        this.scrapedData.allPdfUrls.push(...(apiData.pdfList || []));

        this.scrapedData.statistics.totalApiEndpoints = Object.keys(apiData).length;
        this.scrapedData.statistics.apiDataCategories = Object.keys(apiData).length;

        console.log(`API data collection complete: ${this.scrapedData.statistics.apiDataCategories} categories`);
    }


    async loadJsonSitemap(sitemapPath) {
        console.log('\n=== Phase 2: Loading JSON Sitemap ===');

        const loader = new JsonSitemapLoader(sitemapPath, this.baseUrl);
        const urls = await loader.load();

        urls.forEach(entry => {
            if (this.isExcluded(entry.url)) return;
            // if (this.isHandledByApi(entry.url)) {
            //     console.log(`Skipping (API-handled): ${entry.url}`);
            //     return;
            // }

            const visitKey = this.urlHelpers.normalizeForComparison(entry.url);
            if (!visitKey || this.visited.has(visitKey)) return;

            this.toVisit.add(entry);
        });

        console.log(`✅ Loaded ${urls.length} URLs, ${this.toVisit.size} will be scraped (rest handled by API)`);
    }


    async scrapeStaticPage(url, depth = 0, sourceUrl = null) {
        if (this.isExcluded(url)) return null;
        // if (this.isHandledByApi(url)) {
        //     console.log(`Skipping API-handled URL: ${url}`);
        //     return null;
        // }

        if (!this.urlHelpers.isValidUrl(url)) return null;

        const visitKey = this.urlHelpers.normalizeForComparison(url) || url;
        if (this.visited.has(visitKey) || depth > this.maxDepth || this.visited.size >= this.maxPages) {
            return null;
        }

        const sourceInfo = sourceUrl ? ` (from: ${sourceUrl})` : '';
        console.log(`Scraping [${depth}/${this.maxDepth}] (${this.visited.size}/${this.maxPages}): ${url}${sourceInfo}`);
        this.visited.add(visitKey);

        await this.browserManager.ensurePage();

        const pageMeta = { title: '' };

        // ADD: Attach XHR listener
        let detachXHR = this.xhrCapture.capturePageXHR(
            this.browserManager.page,
            url,
            pageMeta
        );

        try {
            await this.browserManager.page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: 45000,
            });

            await this.browserManager.page.waitForTimeout(this.delay);

            const pageTitle = await this.browserManager.page.title().catch(() => '');

            let rawPageData = null;
            try {
                rawPageData = await this.pageExtractor.extractFullDom(this.browserManager.page);
            } catch (err) {
                console.error(`Failed to extract DOM for ${url}:`, err.message);
                return null;
            }

            const pageData = this.pageExtractor.normalizeDomData(rawPageData);

            const allContent = [
                pageData.title,
                ...pageData.headings.map((h) => h.text),
                ...pageData.content,
                ...pageData.lists.flat(),
                pageData.metadata.description,
                pageData.metadata.keywords,
            ]
                .filter(Boolean)
                .join(' ');

            const pdfLinks = pageData.links
                .filter(link => link.href && link.href.toLowerCase().endsWith('.pdf'))
                .map(link => ({
                    url: link.href.startsWith('http') ? link.href : `${this.baseUrl}${link.href}`,
                    text: link.text,
                    sourceUrl: url,
                    sourceTitle: pageTitle
                }));

            this.scrapedData.allPdfUrls.push(...pdfLinks);

            const cacheKey = this.urlHelpers.normalizeForComparison(url) || url;
            const resolvedUrl = this.browserManager.page.url();
            const resolvedKey = this.urlHelpers.normalizeForComparison(resolvedUrl) || resolvedUrl;

            // ADD: Merge XHR responses
            const xhrEntries = this.xhrCapture.mergeXhrEntries(cacheKey, resolvedKey);


            const processedPage = {
                url: url,
                timestamp: new Date().toISOString(),
                depth: depth,
                sourceUrl: sourceUrl,
                title: pageData.title || pageTitle,
                headings: pageData.headings,
                content: allContent,
                rawContent: pageData.content,
                tables: pageData.tables || [],
                lists: pageData.lists,
                metadata: pageData.metadata,
                category: this.categorizer.categorizeUrl(url, allContent),
                wordCount: allContent.split(' ').length,
                pdfLinks: pdfLinks,
                xhrResponses: xhrEntries,
                internalLinksFound: 0
            };

            this.scrapedData.staticPages.push(processedPage);

            // Process and follow internal links if enabled
            if (this.followInternalLinks) {
                let linksAdded = 0;
                pageData.links.forEach(link => {
                    if (!link.href) return;

                    try {
                        const fullUrl = link.href.startsWith('http')
                            ? link.href
                            : new URL(link.href, url).href;

                        if (this.shouldFollowLink(fullUrl, depth)) {
                            const linkKey = this.urlHelpers.normalizeForComparison(fullUrl);
                            if (linkKey) {
                                // Check if not already in toVisit queue
                                let alreadyQueued = false;
                                for (const entry of this.toVisit) {
                                    if (entry.url === fullUrl) {
                                        alreadyQueued = true;
                                        break;
                                    }
                                }

                                if (!alreadyQueued) {
                                    this.toVisit.add({
                                        url: fullUrl,
                                        depth: depth + 1,
                                        sourceUrl: url
                                    });
                                    linksAdded++;
                                    this.scrapedData.statistics.linksFollowed++;
                                }
                            }
                        }
                    } catch (err) {
                        // Ignore malformed URLs
                    }
                });

                processedPage.internalLinksFound = linksAdded;
                if (linksAdded > 0) {
                    console.log(`  └─ Added ${linksAdded} internal links to queue`);
                }
            }

            console.log(`✅ Scraped: ${pageData.title} (${allContent.split(' ').length} words, ${pdfLinks.length} PDFs)`);
            return processedPage;

        } catch (error) {
            console.error(`❌ Failed to scrape ${url}:`, error.message);

            if (error.message && (error.message.includes('Target closed') || error.message.includes('Session closed'))) {
                try {
                    await this.browserManager.ensurePage();
                } catch (e) {
                    console.warn('⚠️ Failed to recreate page after crash:', e.message);
                }
            }
            return null;
        } finally {
            if (detachXHR) detachXHR();
            const cleanupKey = this.urlHelpers.normalizeForComparison(url) || url;
            if (cleanupKey) {
                this.xhrCapture.clearXhrForPage(cleanupKey);
            }
        }
    }


    async scrapeStaticPages() {
        console.log('\n=== Phase 3: Scraping Static Content Pages ===');
        console.log(`Follow internal links: ${this.followInternalLinks ? 'ENABLED' : 'DISABLED'}`);

        while (this.toVisit.size > 0 && this.visited.size < this.maxPages) {
            const iterator = this.toVisit.values().next();
            if (iterator.done) break;

            const entry = iterator.value;
            this.toVisit.delete(entry);

            await this.scrapeStaticPage(entry.url, entry.depth || 0, entry.sourceUrl || null);

            if (this.visited.size % 10 === 0) {
                console.log(`Progress: ${this.visited.size}/${this.maxPages} pages scraped, ${this.toVisit.size} URLs in queue`);
            }
        }

        console.log(`✅ Static page scraping complete: ${this.scrapedData.staticPages.length} pages`);
        if (this.followInternalLinks) {
            console.log(`   Total internal links followed: ${this.scrapedData.statistics.linksFollowed}`);
        }
    }


    updateStatistics() {
        this.scrapedData.statistics.totalStaticPages = this.scrapedData.staticPages.length;
        this.scrapedData.statistics.totalPDFs = this.scrapedData.allPdfUrls.length;
    }


    async saveData() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
        const filename = `nitjsr_hybrid_complete_${timestamp}.json`;
        const filepath = path.resolve(__dirname, '..', 'scraped_data', filename);

        await fs.mkdir(path.dirname(filepath), { recursive: true });
        await fs.writeFile(filepath, JSON.stringify(this.scrapedData, null, 2), 'utf8');

        const summary = {
            filename: filename,
            timestamp: new Date().toISOString(),
            totalApiCategories: this.scrapedData.statistics.apiDataCategories,
            totalStaticPages: this.scrapedData.statistics.totalStaticPages,
            totalPDFs: this.scrapedData.statistics.totalPDFs,
            linksFollowed: this.scrapedData.statistics.linksFollowed,
            dataBreakdown: {
                apiData: Object.keys(this.scrapedData.apiData),
                staticPagesCount: this.scrapedData.staticPages.length,
                facultyProfiles: this.scrapedData.apiData.people?.faculty?.length || 0,
                publications: this.scrapedData.apiData.publications?.length || 0,
            },
            filepath: filepath,
        };

        console.log(`\nComplete data saved to: ${filepath}`);
        console.log(`Summary:`);
        console.log(`   - API data categories: ${summary.totalApiCategories}`);
        console.log(`   - Faculty profiles: ${summary.dataBreakdown.facultyProfiles}`);
        console.log(`   - Publications: ${summary.dataBreakdown.publications}`);
        console.log(`   - Static pages: ${summary.totalStaticPages}`);
        console.log(`   - Internal links followed: ${summary.linksFollowed}`);
        console.log(`   - Total PDFs: ${summary.totalPDFs}`);

        return { summary, filepath, data: this.scrapedData };
    }


    async scrapeComplete(sitemapPath) {
        try {
            await this.initialize();

            await this.collectApiData();
            await this.loadJsonSitemap(sitemapPath);
            await this.scrapeStaticPages();

            // ADD: Load additional data
            const { loadAdditionalData } = await import('./loadAdditionalData.js');
            this.scrapedData.additionalData = await loadAdditionalData();
            console.log('Loaded additional curriculum, web team, and TAP data');


            this.updateStatistics();
            const result = await this.saveData();

            return result;

        } catch (error) {
            console.error('❌ Hybrid scraping failed:', error);
            throw error;
        } finally {
            await this.cleanup();
        }
    }


    async cleanup() {
        if (this.browserManager) {
            await this.browserManager.cleanup();
        }
    }
}

export { EnhancedNITJSRScraper };