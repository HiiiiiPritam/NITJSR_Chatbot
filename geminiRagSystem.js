require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pinecone } = require('@pinecone-database/pinecone');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const fs = require('fs').promises;
const path = require('path');

class NITJSRGeminiRAGSystem {
    constructor() {
        this.genAI = null;
        this.pinecone = null;
        this.index = null;
        this.embeddings = null;
        this.chatModel = null;
        this.textSplitter = null;
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;

        console.log('🚀 Initializing Gemini + Pinecone RAG System...');

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
                chunkSize: 1000,
                chunkOverlap: 200,
                separators: ['\\n\\n', '\\n', '. ', ' ', ''],
            });

            this.isInitialized = true;
            console.log('✅ Gemini RAG System initialized successfully!');

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

    async processAndStoreDocuments(scrapedData) {
        console.log('📚 Processing and storing documents in vector database...');

        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const documents = [];
            let docId = 0;

            // Handle comprehensive scraper data format
            let pagesToProcess = [];
            let pdfsToProcess = [];

            if (scrapedData.pages) {
                // New comprehensive format
                pagesToProcess = scrapedData.pages;
                pdfsToProcess = scrapedData.documents?.pdfs || [];
            } else if (scrapedData.placements) {
                // Old format compatibility
                pagesToProcess = scrapedData.placements.pageContent || [];
                pdfsToProcess = scrapedData.placements.pdfDocuments || [];
            }

            console.log(`📊 Processing ${pagesToProcess.length} pages and ${pdfsToProcess.length} PDFs`);

            // Process main page content
            for (const page of pagesToProcess) {
                // Combine all text content - handle both old and new formats
                const fullText = [
                    page.title || '',
                    ...(page.headings?.map(h => h.text || h) || []),
                    page.content || '', // New comprehensive format
                    ...(page.paragraphs || []), // Old format
                    ...(page.tables?.flat().flat() || []), // Old format
                    page.metadata?.description || '',
                    page.metadata?.keywords || ''
                ].filter(Boolean).join('\\n\\n');

                if (fullText.trim().length > 50) {
                    const chunks = await this.textSplitter.splitText(fullText);
                    
                    for (let i = 0; i < chunks.length; i++) {
                        documents.push({
                            id: `page-${docId}-chunk-${i}`,
                            text: chunks[i],
                            metadata: {
                                source: 'webpage',
                                url: page.url,
                                title: page.title,
                                timestamp: page.timestamp,
                                category: page.category || 'general',
                                depth: page.depth || 0,
                                wordCount: page.wordCount || 0,
                                chunkIndex: i,
                                totalChunks: chunks.length
                            }
                        });
                    }
                }
                docId++;
            }

            // Process PDF documents  
            for (const pdf of pdfsToProcess) {
                const pdfContent = pdf.content || pdf.text || ''; // Handle both formats
                if (pdfContent && pdfContent.trim().length > 50) {
                    const chunks = await this.textSplitter.splitText(pdfContent);
                    
                    for (let i = 0; i < chunks.length; i++) {
                        documents.push({
                            id: `pdf-${docId}-chunk-${i}`,
                            text: chunks[i],
                            metadata: {
                                source: 'pdf',
                                url: pdf.url,
                                title: pdf.title,
                                pages: pdf.pages,
                                timestamp: pdf.timestamp,
                                category: pdf.category || 'general',
                                chunkIndex: i,
                                totalChunks: chunks.length
                            }
                        });
                    }
                }
                docId++;
            }

            // Process statistics as special documents
            let statsText = '';
            if (scrapedData.placements?.statistics) {
                // Old format
                statsText = Object.entries(scrapedData.placements.statistics)
                    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                    .join('\\n');
            } else if (scrapedData.statistics) {
                // New comprehensive format
                const stats = scrapedData.statistics;
                statsText = `Total Pages: ${stats.totalPages}
Total PDFs: ${stats.totalPDFs}
Total Links: ${stats.totalLinks}
Categories: ${Object.entries(scrapedData.categories || {})
    .map(([cat, items]) => `${cat} (${items.length} pages)`)
    .join(', ')}`;
            }

            if (statsText.trim().length > 10) {
                documents.push({
                    id: 'statistics-main',
                    text: `NIT Jamshedpur Website Statistics:\\n${statsText}`,
                    metadata: {
                        source: 'statistics',
                        type: 'summary',
                        timestamp: scrapedData.metadata?.timestamp
                    }
                });
            }

            console.log(`📊 Prepared ${documents.length} document chunks for embedding`);

            // Generate embeddings and store in batches
            const batchSize = 5; // Smaller batch for Gemini API limits
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

            console.log(`🎉 Successfully stored ${documents.length} documents in vector database`);
            return { success: true, totalDocuments: documents.length };

        } catch (error) {
            console.error('❌ Error processing documents:', error.message);
            throw error;
        }
    }

    async queryDocuments(question, topK = 5) {
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
        console.log('🤖 Generating response with Gemini...');

        try {
            // Create context from relevant documents
            const context = relevantDocuments
                .map((doc, index) => `[Document ${index + 1}] ${doc.text}`)
                .join('\\n\\n');

            // Create prompt for Gemini
            const prompt = `You are an AI assistant specializing in NIT Jamshedpur placement information. Use the provided context to answer questions accurately and helpfully.

Context:
${context || 'No relevant context found.'}

Question: ${question}

Instructions:
- Answer based primarily on the provided context
- If the context doesn't contain enough information, state that clearly
- Provide specific data points when available (percentages, package amounts, company names)
- Be concise but comprehensive
- If mentioning statistics, try to provide the source or timeframe when available
- Format your response clearly with proper structure

Answer:`;

            // Generate response using Gemini
            const result = await this.chatModel.generateContent(prompt);
            const response = result.response;
            const text = response.text();

            console.log('✅ Response generated successfully');

            return {
                answer: text,
                sources: relevantDocuments.map(doc => ({
                    text: doc.text.substring(0, 200) + '...',
                    source: doc.metadata.source,
                    url: doc.metadata.url,
                    title: doc.metadata.title,
                    score: doc.score
                })),
                confidence: relevantDocuments.length > 0 ? relevantDocuments[0].score : 0
            };

        } catch (error) {
            console.error('❌ Error generating response:', error.message);
            throw error;
        }
    }

    async chat(question) {
        try {
            // Search for relevant documents
            const relevantDocs = await this.queryDocuments(question, 5);

            if (relevantDocs.length === 0) {
                return {
                    answer: "I don't have specific information about that topic in the NIT Jamshedpur placement data. Could you please rephrase your question or ask about placements, packages, companies, or statistics?",
                    sources: [],
                    confidence: 0
                };
            }

            // Generate response
            const response = await this.generateResponse(question, relevantDocs);
            return response;

        } catch (error) {
            console.error('❌ Chat error:', error.message);
            throw error;
        }
    }

    async getIndexStats() {
        try {
            const stats = await this.index.describeIndexStats();
            return {
                totalVectors: stats.totalVectorCount || 0,
                dimension: stats.dimension || 768,
                indexFullness: stats.indexFullness || 0
            };
        } catch (error) {
            console.error('❌ Error getting index stats:', error.message);
            return { error: error.message };
        }
    }

    async clearIndex() {
        console.log('🗑️ Clearing Pinecone index...');
        try {
            await this.index.deleteAll();
            console.log('✅ Index cleared successfully');
        } catch (error) {
            console.error('❌ Error clearing index:', error.message);
            throw error;
        }
    }

    // Alternative simple embedding function if LangChain Gemini embeddings don't work
    async createSimpleEmbedding(text) {
        try {
            // Use Gemini to create a simple embedding representation
            const model = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
            const prompt = `Create a numerical vector representation of the following text for semantic search. Return only comma-separated numbers: ${text.substring(0, 500)}`;
            
            const result = await model.generateContent(prompt);
            const response = result.response.text();
            
            // Parse the response to get numbers (fallback method)
            const numbers = response.match(/[-]?\\d+(?:\\.\\d+)?/g);
            if (numbers && numbers.length >= 100) {
                return numbers.slice(0, 768).map(num => parseFloat(num));
            }
            
            // If that fails, create a simple hash-based embedding
            return this.createHashEmbedding(text);
            
        } catch (error) {
            console.error('Error creating embedding:', error);
            return this.createHashEmbedding(text);
        }
    }

    createHashEmbedding(text, dimension = 768) {
        // Simple hash-based embedding as fallback
        const words = text.toLowerCase().split(/\\W+/).filter(w => w.length > 2);
        const embedding = new Array(dimension).fill(0);
        
        words.forEach((word, index) => {
            let hash = 0;
            for (let i = 0; i < word.length; i++) {
                const char = word.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32-bit integer
            }
            const position = Math.abs(hash) % dimension;
            embedding[position] += 1;
        });
        
        // Normalize the embedding
        const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        return embedding.map(val => magnitude > 0 ? val / magnitude : 0);
    }
}

module.exports = { NITJSRGeminiRAGSystem };