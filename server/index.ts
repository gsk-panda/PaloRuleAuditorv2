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

    const rules = await auditPanoramaRules(url, apiKey, unusedDays || 90, haPairs || []);
    
    res.json({ rules });
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

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});
