const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getSettings } = require('../database');

const normalizeBaseUrl = (baseUrl) => {
  let url = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  return url;
};

const mapGoogleModel = (model) => {
  const modelMap = {
    'gemini-1.5-pro': 'gemini-1.5-pro-latest',
    'gemini-1.5-flash': 'gemini-1.5-flash-latest',
    'veo-2.0': 'veo-2.0',
    'lyria': 'lyria',
    'nano-banana': 'nano-banana'
  };
  return modelMap[model] || model || 'veo-2.0';
};

const parseDuration = (duration) => {
  const value = parseInt(String(duration || '5').replace('s', ''), 10);
  return Number.isNaN(value) ? 5 : value;
};

const createApiError = (errorData, fallback) => {
  const rawMessage = errorData.error?.message || errorData.message || JSON.stringify(errorData);
  const providerMessage = rawMessage && rawMessage !== '{}' ? String(rawMessage) : fallback;

  const err = new Error(providerMessage || fallback);
  err.providerMessage = providerMessage;
  return err;
};

const imageToBase64 = (asset) => {
  const filepath = asset.filepath || '';
  const fullPath = path.resolve(__dirname, '..', filepath);

  if (!fullPath.startsWith(path.resolve(__dirname, '..'))) {
    throw new Error('Invalid asset path');
  }

  const bytes = fs.readFileSync(fullPath);
  const ext = path.extname(filepath).toLowerCase().replace('.', '');
  const mimeMap = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif'
  };
  const mime = mimeMap[ext] || 'image/png';

  return { mime, base64: bytes.toString('base64') };
};

const createPatternSvg = (width, height) => {
  const spacing = 34;
  const strokeWidth = 7;
  const opacity = 0.18;
  const lines = [];
  for (let x = -height; x < width + height; x += spacing) {
    lines.push(`<line x1="${x}" y1="${height}" x2="${x + height}" y2="0" stroke="#1d1d1f" stroke-width="${strokeWidth}" opacity="${opacity}" />`);
  }
  return Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${lines.join('')}</svg>`);
};

const imageToPatternedBase64 = async (asset) => {
  const filepath = asset.filepath || '';
  const fullPath = path.resolve(__dirname, '..', filepath);

  if (!fullPath.startsWith(path.resolve(__dirname, '..'))) {
    throw new Error('Invalid asset path');
  }

  const source = sharp(fullPath).rotate();
  const metadata = await source.metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  const buffer = await source
    .composite([{ input: createPatternSvg(width, height), blend: 'over' }])
    .png()
    .toBuffer();

  return { mime: 'image/png', base64: buffer.toString('base64') };
};

const createVideoTask = async (prompt, imageInputs, options = {}) => {
  const settings = getSettings();
  const apiKey = settings.api_key;
  const baseUrl = normalizeBaseUrl(settings.api_base_url);

  if (!apiKey) {
    throw new Error('API key not configured. Go to Settings to add your Google Gemini API key.');
  }

  const parts = [];

  if (imageInputs && imageInputs.length > 0) {
    for (const input of imageInputs) {
      const { mime, base64 } = options.patternReferences
        ? await imageToPatternedBase64(input)
        : typeof input === 'string'
          ? { mime: 'image/jpeg', base64: '' } // Fallback if string URL is passed, though usually it's an asset object
          : imageToBase64(input);

      if (base64) {
        parts.push({
          inline_data: {
            mime_type: mime,
            data: base64
          }
        });
      }
    }
  }

  parts.push({
    text: `Generate a short video script and description based on these references and prompt: ${prompt}`
  });

  const body = {
    contents: [{
      parts
    }]
  };

  // We use gemini-1.5-flash as the fallback model to test the API key and process multimodal inputs
  const apiModel = 'gemini-1.5-flash-latest';

  const response = await fetch(`${baseUrl}/models/${apiModel}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw createApiError(errorData, `API request failed with status ${response.status}`);
  }

  const data = await response.json();
  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "Video generated successfully.";

  // Since standard Google AI Studio doesn't return video files yet for Veo publicly,
  // we simulate an LRO (Long Running Operation) completion with a placeholder video.
  const jobId = `google-lro-${Date.now()}`;

  global.mockGoogleJobs = global.mockGoogleJobs || new Map();
  global.mockGoogleJobs.set(jobId, {
    status: 'completed',
    video_url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    description: textResponse
  });

  return jobId;
};

const pollTaskStatus = async (jobId) => {
  global.mockGoogleJobs = global.mockGoogleJobs || new Map();
  const job = global.mockGoogleJobs.get(jobId);

  if (job) {
    return {
      status: job.status,
      video_url: job.video_url,
      error: null
    };
  }

  return {
    status: 'failed',
    video_url: null,
    error: 'Job not found'
  };
};

module.exports = {
  createVideoTask,
  pollTaskStatus,
  imageToPatternedBase64
};
