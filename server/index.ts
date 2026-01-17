import express from 'express';
import cors from 'cors';
import { auditPanoramaRules } from './panoramaService.js';

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.post('/api/audit', async (req, res) => {
  try {
    console.log('Received audit request');
    const { url, apiKey, unusedDays, haPairs } = req.body;

    if (!url || !apiKey) {
      console.log('Missing required parameters');
      return res.status(400).json({ error: 'Panorama URL and API key are required' });
    }

    console.log('Calling auditPanoramaRules...');
    const result = await auditPanoramaRules(url, apiKey, unusedDays || 90, haPairs || []);
    console.log(`Audit completed: ${result.rules.length} rules, ${result.deviceGroups.length} device groups`);
    
    res.json({ rules: result.rules, deviceGroups: result.deviceGroups });
  } catch (error) {
    console.error('Audit error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to perform audit';
    console.error('Error details:', errorMessage);
    res.status(500).json({ 
      error: errorMessage
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`API server running on port ${PORT}`);
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please stop the existing process or use a different port.`);
    console.error(`To find and kill the process: lsof -ti:${PORT} | xargs kill -9`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    throw err;
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
