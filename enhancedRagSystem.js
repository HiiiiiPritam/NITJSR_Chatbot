require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pinecone } = require('@pinecone-database/pinecone');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const fs = require('fs').promises;
const path = require('path');

class EnhancedNITJSRRAGSystem {
    constructor() {
        this.genAI = null;
        this.pinecone = null;
        this.index = null;
        this.embeddings = null;
        this.chatModel = null;
        this.textSplitter = null;
        this.isInitialized = false;
        this.linkDatabase = new Map(); // Store links for easy retrieval
    }

    async initialize() {
        if (this.isInitialized) return;

        console.log('🚀 Initializing Enhanced Gemini + Pinecone RAG System...');

        try {
            // Initialize Google Gemini
            this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            this.chatModel = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

            // Initialize Pinecone
            this.pinecone = new Pinecone({
                apiKey: process.env.PINECONE_API_KEY.trim(),
            });

            // Get or create index
            await this.initializePineconeIndex();

            // Initialize embeddings using Gemini
            this.embeddings = new GoogleGenerativeAIEmbeddings({
                apiKey: process.env.GEMINI_API_KEY,
                modelName: 'embedding-001',
            });

            this.textSplitter = new RecursiveCharacterTextSplitter({
                chunkSize: 1200, // Increased chunk size for better context
                chunkOverlap: 300, // Increased overlap
                separators: ['\n\n', '\n', '. ', '! ', '? ', ' ', ''],
            });

            this.isInitialized = true;
            console.log('✅ Enhanced Gemini RAG System initialized successfully!');

        } catch (error) {
            console.error('❌ RAG System initialization failed:', error.message);
            throw error;
        }
    }

    async initializePineconeIndex() {
        const indexName = process.env.PINECONE_INDEX_NAME.trim();
        
        try {
            // Check if index exists
            const indexList = await this.pinecone.listIndexes();
            const indexExists = indexList.indexes?.some(index => index.name === indexName);

            if (!indexExists) {
                console.log(`🔨 Creating new Pinecone index: ${indexName}`);
                await this.pinecone.createIndex({
                    name: indexName,
                    dimension: 768, // Gemini embedding dimension
                    metric: 'cosine',
                    spec: {
                        serverless: {
                            cloud: 'aws',
                            region: process.env.PINECONE_ENVIRONMENT.trim()
                        }
                    }
                });
                
                // Wait for index to be ready
                console.log('⏳ Waiting for index to be ready...');
                await new Promise(resolve => setTimeout(resolve, 60000));
            }

            this.index = this.pinecone.index(indexName);
            console.log(`✅ Connected to Pinecone index: ${indexName}`);

        } catch (error) {
            console.error('❌ Pinecone index initialization failed:', error.message);
            throw error;
        }
    }

    buildLinkDatabase(scrapedData) {
        console.log('🔗 Building comprehensive link database...');
        
        // Store all types of links for easy retrieval
        if (scrapedData.links) {
            // PDF links
            scrapedData.links.pdf?.forEach(link => {
                const key = `pdf_${link.text.toLowerCase().replace(/\s+/g, '_')}`;
                this.linkDatabase.set(key, {
                    type: 'pdf',
                    url: link.url,
                    text: link.text,
                    title: link.title,
                    sourceUrl: link.sourceUrl,
                    sourceTitle: link.sourceTitle,
                    context: link.context
                });
                
                // Also store by URL patterns
                const urlParts = link.url.split('/');
                const filename = urlParts[urlParts.length - 1].replace('.pdf', '');
                this.linkDatabase.set(`pdf_${filename.toLowerCase()}`, this.linkDatabase.get(key));
            });

            // Internal page links
            scrapedData.links.internal?.forEach(link => {
                const key = `page_${link.text.toLowerCase().replace(/\s+/g, '_')}`;
                this.linkDatabase.set(key, {
                    type: 'page',
                    url: link.url,
                    text: link.text,
                    title: link.title,
                    sourceUrl: link.sourceUrl,
                    sourceTitle: link.sourceTitle,
                    context: link.context
                });
            });
        }

        // Store page URLs for direct access
        scrapedData.pages?.forEach(page => {
            const key = `page_${page.title.toLowerCase().replace(/\s+/g, '_')}`;
            this.linkDatabase.set(key, {
                type: 'page',
                url: page.url,
                text: page.title,
                title: page.title,
                category: page.category,
                wordCount: page.wordCount
            });
        });

        // Store PDF document info
        scrapedData.documents?.pdfs?.forEach(pdf => {
            const key = `pdf_${pdf.title.toLowerCase().replace(/\s+/g, '_')}`;
            this.linkDatabase.set(key, {
                type: 'pdf_document',
                url: pdf.url,
                text: pdf.title,
                title: pdf.title,
                pages: pdf.pages,
                category: pdf.category,
                sourceUrl: pdf.sourceUrl,
                wordCount: pdf.wordCount
            });
        });

        console.log(`✅ Built link database with ${this.linkDatabase.size} entries`);
    }

    async processAndStoreDocuments(scrapedData) {
        console.log('📚 Processing and storing enhanced documents in vector database...');

        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            // Build comprehensive link database
            this.buildLinkDatabase(scrapedData);

            const documents = [];
            let docId = 0;

            // Handle enhanced scraper data format
            let pagesToProcess = scrapedData.pages || [];
            let pdfsToProcess = scrapedData.documents?.pdfs || [];

            console.log(`📊 Processing ${pagesToProcess.length} pages and ${pdfsToProcess.length} PDFs`);

            // Process main page content with enhanced metadata
            for (const page of pagesToProcess) {
                // Combine all text content with better structure
                const structuredText = [
                    `Title: ${page.title || ''}`,
                    `URL: ${page.url}`,
                    `Category: ${page.category || 'general'}`,
                    page.headings?.map(h => `Heading ${h.level}: ${h.text}`).join('\n') || '',
                    page.content || '',
                    page.tables?.map(table => 
                        table.map(row => row.join(' | ')).join('\n')
                    ).join('\n\n') || '',
                    page.lists?.map(list => list.map(item => `• ${item}`).join('\n')).join('\n\n') || '',
                    `Description: ${page.metadata?.description || ''}`,
                    `Keywords: ${page.metadata?.keywords || ''}`
                ].filter(Boolean).join('\n\n');

                if (structuredText.trim().length > 100) {
                    const chunks = await this.textSplitter.splitText(structuredText);
                    
                    for (let i = 0; i < chunks.length; i++) {
                        documents.push({
                            id: `page-${docId}-chunk-${i}`,
                            text: chunks[i],
                            metadata: {
                                source: 'webpage',
                                sourceType: 'page',
                                url: page.url,
                                title: page.title,
                                timestamp: page.timestamp,
                                category: page.category || 'general',
                                depth: page.depth || 0,
                                wordCount: page.wordCount || 0,
                                chunkIndex: i,
                                totalChunks: chunks.length,
                                hasLinks: page.links?.length > 0,
                                hasTables: page.tables?.length > 0,
                                hasLists: page.lists?.length > 0
                            }
                        });
                    }
                }
                docId++;
            }

            // Process PDF documents with enhanced metadata
            for (const pdf of pdfsToProcess) {
                const pdfContent = pdf.text || pdf.content || '';
                if (pdfContent && pdfContent.trim().length > 100) {
                    const structuredPdfText = [
                        `PDF Title: ${pdf.title}`,
                        `URL: ${pdf.url}`,
                        `Category: ${pdf.category || 'general'}`,
                        `Pages: ${pdf.pages}`,
                        `Source Page: ${pdf.sourceTitle || 'Unknown'}`,
                        `Content: ${pdfContent}`
                    ].filter(Boolean).join('\n\n');

                    const chunks = await this.textSplitter.splitText(structuredPdfText);
                    
                    for (let i = 0; i < chunks.length; i++) {
                        documents.push({
                            id: `pdf-${docId}-chunk-${i}`,
                            text: chunks[i],
                            metadata: {
                                source: 'pdf',
                                sourceType: 'pdf_document',
                                url: pdf.url,
                                title: pdf.title,
                                pages: pdf.pages,
                                timestamp: pdf.timestamp,
                                category: pdf.category || 'general',
                                sourceUrl: pdf.sourceUrl,
                                sourceTitle: pdf.sourceTitle,
                                wordCount: pdf.wordCount,
                                chunkIndex: i,
                                totalChunks: chunks.length
                            }
                        });
                    }
                }
                docId++;
            }

            // Process link information as searchable content
            if (scrapedData.links) {
                const linkContent = [
                    `PDF Documents Available:`,
                    scrapedData.links.pdf?.map(link => 
                        `• ${link.text} - ${link.url} (Found on: ${link.sourceTitle})`
                    ).join('\n') || 'No PDFs found',
                    `\nInternal Pages:`,
                    scrapedData.links.internal?.slice(0, 50).map(link => 
                        `• ${link.text} - ${link.url}`
                    ).join('\n') || 'No internal links found'
                ].join('\n');

                if (linkContent.length > 100) {
                    documents.push({
                        id: 'links-directory',
                        text: linkContent,
                        metadata: {
                            source: 'links',
                            sourceType: 'link_directory',
                            type: 'directory',
                            timestamp: scrapedData.metadata?.timestamp,
                            totalPdfs: scrapedData.links.pdf?.length || 0,
                            totalInternalLinks: scrapedData.links.internal?.length || 0
                        }
                    });
                }
            }

            // Enhanced statistics document
            const statsContent = [
                `NIT Jamshedpur Website Statistics and Overview:`,
                `Total Pages Scraped: ${scrapedData.statistics?.totalPages || 0}`,
                `Total PDF Documents: ${scrapedData.statistics?.totalPDFs || 0}`,
                `Total Links Found: ${scrapedData.statistics?.totalLinks || 0}`,
                `Categories Breakdown:`,
                Object.entries(scrapedData.categories || {}).map(([cat, items]) => 
                    `• ${cat}: ${items.length} pages`
                ).join('\n'),
                `\nAvailable PDF Documents:`,
                scrapedData.documents?.pdfs?.map(pdf => 
                    `• ${pdf.title} (${pdf.pages} pages, ${pdf.wordCount} words) - ${pdf.category}`
                ).join('\n') || 'No PDFs processed'
            ].join('\n');

            if (statsContent.length > 100) {
                documents.push({
                    id: 'statistics-enhanced',
                    text: statsContent,
                    metadata: {
                        source: 'statistics',
                        sourceType: 'summary',
                        type: 'overview',
                        timestamp: scrapedData.metadata?.timestamp
                    }
                });
            }

            console.log(`📊 Prepared ${documents.length} enhanced document chunks for embedding`);

            // Generate embeddings and store in batches
            const batchSize = 5; // Conservative batch size for Gemini API limits
            const batches = [];
            
            for (let i = 0; i < documents.length; i += batchSize) {
                batches.push(documents.slice(i, i + batchSize));
            }

            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batch = batches[batchIndex];
                console.log(`🔄 Processing batch ${batchIndex + 1}/${batches.length}...`);

                try {
                    // Generate embeddings for batch
                    const embeddings = await Promise.all(
                        batch.map(doc => this.embeddings.embedQuery(doc.text))
                    );

                    // Prepare vectors for Pinecone
                    const vectors = batch.map((doc, index) => ({
                        id: doc.id,
                        values: embeddings[index],
                        metadata: {
                            text: doc.text.substring(0, 1000), // Pinecone metadata limit
                            ...doc.metadata
                        }
                    }));

                    // Upsert to Pinecone
                    await this.index.upsert(vectors);
                    
                    console.log(`✅ Batch ${batchIndex + 1} stored successfully`);

                    // Add delay to avoid rate limits
                    if (batchIndex < batches.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                } catch (error) {
                    console.error(`❌ Error processing batch ${batchIndex + 1}:`, error.message);
                }
            }

            console.log(`🎉 Successfully stored ${documents.length} enhanced documents in vector database`);
            return { success: true, totalDocuments: documents.length };

        } catch (error) {
            console.error('❌ Error processing enhanced documents:', error.message);
            throw error;
        }
    }

    findRelevantLinks(question, documents) {
        const questionLower = question.toLowerCase();
        const relevantLinks = [];

        // Search for PDF links
        if (questionLower.includes('pdf') || questionLower.includes('document')) {
            for (const [key, link] of this.linkDatabase.entries()) {
                if (key.startsWith('pdf_') && (
                    link.text.toLowerCase().includes(questionLower) ||
                    questionLower.includes(link.text.toLowerCase()) ||
                    documents.some(doc => doc.text.toLowerCase().includes(link.text.toLowerCase()))
                )) {
                    relevantLinks.push(link);
                }
            }
        }

        // Search for relevant pages
        for (const [key, link] of this.linkDatabase.entries()) {
            if ((link.text.toLowerCase().includes(questionLower) || 
                 questionLower.includes(link.text.toLowerCase()) ||
                 (link.category && questionLower.includes(link.category))) &&
                relevantLinks.length < 5) {
                relevantLinks.push(link);
            }
        }

        return relevantLinks;
    }

    async queryDocuments(question, topK = 8) { // Increased topK for better context
        console.log(`🔍 Searching for: "${question}"`);

        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            // Generate embedding for the question using Gemini
            const questionEmbedding = await this.embeddings.embedQuery(question);

            // Search Pinecone
            const searchResults = await this.index.query({
                vector: questionEmbedding,
                topK: topK,
                includeMetadata: true,
                includeValues: false
            });

            const relevantDocuments = searchResults.matches?.map(match => ({
                text: match.metadata.text,
                score: match.score,
                metadata: match.metadata
            })) || [];

            console.log(`📋 Found ${relevantDocuments.length} relevant documents`);
            return relevantDocuments;

        } catch (error) {
            console.error('❌ Error querying documents:', error.message);
            throw error;
        }
    }

    async generateResponse(question, relevantDocuments) {
        console.log('🤖 Generating enhanced response with Gemini...');

        try {
            // Find relevant links
            const relevantLinks = this.findRelevantLinks(question, relevantDocuments);

            // Create enhanced context from relevant documents
            const context = relevantDocuments
                .map((doc, index) => {
                    const sourceInfo = doc.metadata.sourceType === 'pdf_document' 
                        ? `[PDF Document ${index + 1}: ${doc.metadata.title} (${doc.metadata.pages} pages)]`
                        : `[Page ${index + 1}: ${doc.metadata.title}]`;
                    return `${sourceInfo} ${doc.text}`;
                })
                .join('\n\n');

            // Add links information to context
            const linksContext = relevantLinks.length > 0 
                ? `\n\nRelevant Links Available:\n${relevantLinks.map(link => 
                    `• ${link.text}: ${link.url} ${link.type === 'pdf' ? '(PDF Document)' : '(Web Page)'}`
                  ).join('\n')}`
                : '';

            // Create enhanced prompt for Gemini
            const prompt = `You are an AI assistant specializing in NIT Jamshedpur information. Use the provided context to answer questions accurately and helpfully.

Context:
${context || 'No relevant context found.'}${linksContext}

Question: ${question}

Instructions:
- Answer based primarily on the provided context
- If the context doesn't contain enough information, state that clearly
- Provide specific data points when available (percentages, package amounts, company names)
- Be comprehensive but well-structured
- When mentioning statistics, provide the source or timeframe when available
- If relevant links are available, mention them in your response
- For PDF documents, specify the document name and that it's a PDF
- Include direct URLs when they would be helpful to the user
- Format your response clearly with proper structure
- If asked about documents or PDFs, provide the actual links when available

Answer:`;

            // Generate response using Gemini
            const result = await this.chatModel.generateContent(prompt);
            const response = result.response;
            const text = response.text();

            console.log('✅ Enhanced response generated successfully');

            // Prepare enhanced sources with links
            const enhancedSources = relevantDocuments.map(doc => ({
                text: doc.text.substring(0, 200) + '...',
                source: doc.metadata.source,
                sourceType: doc.metadata.sourceType,
                url: doc.metadata.url,
                title: doc.metadata.title,
                score: doc.score,
                pages: doc.metadata.pages,
                category: doc.metadata.category
            }));

            // Add relevant links as additional sources
            relevantLinks.forEach(link => {
                enhancedSources.push({
                    text: link.context || link.text,
                    source: link.type,
                    sourceType: 'link',
                    url: link.url,
                    title: link.text,
                    score: 0.8, // High relevance for matched links
                    category: 'link'
                });
            });

            return {
                answer: text,
                sources: enhancedSources,
                relevantLinks: relevantLinks,
                confidence: relevantDocuments.length > 0 ? relevantDocuments[0].score : 0
            };

        } catch (error) {
            console.error('❌ Error generating enhanced response:', error.message);
            throw error;
        }
    }

    async chat(question) {
        try {
            // Search for relevant documents
            const relevantDocs = await this.queryDocuments(question, 8);

            if (relevantDocs.length === 0) {
                return {
                    answer: "I don't have specific information about that topic in the NIT Jamshedpur data. Could you please rephrase your question or ask about placements, academics, faculty, departments, or other college-related topics?",
                    sources: [],
                    relevantLinks: [],
                    confidence: 0
                };
            }

            // Generate enhanced response
            const response = await this.generateResponse(question, relevantDocs);
            return response;

        } catch (error) {
            console.error('❌ Enhanced chat error:', error.message);
            throw error;
        }
    }

    async getIndexStats() {
        try {
            const stats = await this.index.describeIndexStats();
            return {
                totalVectors: stats.totalVectorCount || 0,
                dimension: stats.dimension || 768,
                indexFullness: stats.indexFullness || 0,
                linkDatabaseSize: this.linkDatabase.size
            };
        } catch (error) {
            console.error('❌ Error getting enhanced index stats:', error.message);
            return { error: error.message };
        }
    }

    async clearIndex() {
        console.log('🗑️ Clearing Pinecone index and link database...');
        try {
            await this.index.deleteAll();
            this.linkDatabase.clear();
            console.log('✅ Index and link database cleared successfully');
        } catch (error) {
            console.error('❌ Error clearing index:', error.message);
            throw error;
        }
    }
}

module.exports = { EnhancedNITJSRRAGSystem };