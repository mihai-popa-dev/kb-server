const express = require('express');
const path = require('path');
const {initDatabase} = require('./databse');
const { setupMCP } = require('.mcp');
const { setupRoutes } = require('./routes');

const PORT = process.env.KB_PORT || 3000;

async function start() {
    console.log('Starting KB Server...');

    // Initialize SQLite db
    await initDatabase();
    console.log('Database ready');

    const app = express();
    app.use(express.json());

    // Setup MCP tools
    setupMCP(app);

    // Setup REST routes (web dashboard + API)
    setupRoutes(app);

    app.listen(PORT, ()=> {
        console.log(`KB Server is running on port ${PORT}`);
    });
}

start().catch(err=> {
    console.error('Failed to start KB Server:', err);
    process.exit(1);
});