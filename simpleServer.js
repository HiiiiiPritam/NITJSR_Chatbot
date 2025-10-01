const express = require('express');
const cors = require('cors');
const path = require('path');

class SimpleNITJSRServer {
    constructor() {
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        // CORS configuration
        this.app.use(cors({
            origin: process.env.NODE_ENV === 'production' 
                ? ['https://yourdomain.com'] 
                : ['http://localhost:3000', 'http://127.0.0.1:3000'],
            credentials: true
        }));

        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Serve static files
        this.app.use(express.static(path.join(__dirname, 'public')));

        // Request logging middleware
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            next();
        });

        // Error handling middleware
        this.app.use((error, req, res, next) => {
            console.error('Server Error:', error);
            res.status(500).json({
                success: false,
                error: process.env.NODE_ENV === 'development' 
                    ? error.message 
                    : 'Internal server error'
            });
        });
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                message: 'Simple NIT JSR server is running'
            });
        });

        // Test endpoint
        this.app.get('/test', (req, res) => {
            res.json({
                success: true,
                message: 'Test endpoint working!',
                timestamp: new Date().toISOString()
            });
        });

        // Simple chat endpoint (mock response)
        this.app.post('/chat', (req, res) => {
            const { question } = req.body;

            if (!question || question.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Question is required and cannot be empty'
                });
            }

            // Mock response for now
            res.json({
                success: true,
                question: question,
                answer: `This is a mock response to: "${question}". The full RAG system requires proper API keys and configuration.`,
                timestamp: new Date().toISOString()
            });
        });

        // Root endpoint
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                success: false,
                error: 'Endpoint not found'
            });
        });
    }

    async start(port = process.env.PORT || 3000) {
        try {
            this.server = this.app.listen(port, () => {
                console.log(`🚀 Simple NIT JSR Server running on port ${port}`);
                console.log(`📍 Health check: http://localhost:${port}/health`);
                console.log(`💬 Frontend: http://localhost:${port}`);
                console.log(`🧪 Test: http://localhost:${port}/test`);
                console.log('✅ Server is fully operational!');
            });

            // Graceful shutdown
            process.on('SIGTERM', () => this.shutdown());
            process.on('SIGINT', () => this.shutdown());

        } catch (error) {
            console.error('❌ Server startup failed:', error.message);
            process.exit(1);
        }
    }

    async shutdown() {
        console.log('🛑 Shutting down server...');
        if (this.server) {
            this.server.close(() => {
                console.log('✅ Server shutdown complete');
                process.exit(0);
            });
        }
    }
}

// Start server if this file is run directly
if (require.main === module) {
    const server = new SimpleNITJSRServer();
    server.start();
}

module.exports = { SimpleNITJSRServer };