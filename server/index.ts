import express from 'express';
import cors from 'cors';
import { auditPanoramaRules } from './panoramaService.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.post('/api/audit', async (req, res) => {
  try {
    const { url, apiKey, unusedDays, haPairs } = req.body;

    if (!url || !apiKey) {
      return res.status(400).json({ error: 'Panorama URL and API key are required' });
    }

    const result = await auditPanoramaRules(url, apiKey, unusedDays || 90, haPairs || []);
    
    res.json({ rules: result.rules, deviceGroups: result.deviceGroups });
  } catch (error) {
    console.error('Audit error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to perform audit' 
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
