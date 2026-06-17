const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.use(express.json({ limit: '10mb' }));

// R2 config from env
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'vault-clips';
const RENDER_TOKEN = process.env.RENDER_TOKEN || 'vault-render-2026';
const PORT = process.env.PORT || 3000;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
});

// Download file from URL to local path (follows redirects)
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        reject(new Error(`Download failed: HTTP ${response.statusCode} for ${url.substring(0, 80)}...`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on('finish', () => { file.close(resolve); });
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    }).on('error', reject);
  });
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'vault-ffmpeg-render', version: '1.0.0' });
});

// Main render endpoint
app.post('/render', async (req, res) => {
  // Auth check
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${RENDER_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { clips, audio, title, clip_duration } = req.body;
  if (!clips || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips array required' });
  }
  if (!audio) {
    return res.status(400).json({ error: 'audio URL required' });
  }

  const jobId = Date.now().toString();
  const tmpDir = `/tmp/render-${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const secPerClip = clip_duration || 5;
  const totalDuration = clips.length * secPerClip;

  try {
    // === STEP 1: Download all clips + audio in parallel ===
    console.log(`[${jobId}] Downloading ${clips.length} clips + 1 audio...`);
    const startDl = Date.now();

    const clipPromises = clips.map((url, i) => {
      const dest = path.join(tmpDir, `clip${String(i).padStart(2, '0')}.mp4`);
      return downloadFile(url, dest).then(() => dest);
    });
    const audioDest = path.join(tmpDir, 'voiceover.mp3');
    clipPromises.push(downloadFile(audio, audioDest).then(() => audioDest));

    const allPaths = await Promise.all(clipPromises);
    const clipPaths = allPaths.slice(0, -1);
    console.log(`[${jobId}] Downloads complete in ${((Date.now() - startDl) / 1000).toFixed(1)}s`);

    // === STEP 2: Build and run ffmpeg command ===
    const inputs = clipPaths.map(p => `-i "${p}"`).join(' ');
    const audioInput = `-i "${audioDest}"`;

    const filterParts = clipPaths.map((_, i) =>
      `[${i}:v]scale=1920:1080,setsar=1,fps=30[v${i}]`
    );
    const concatInputs = clipPaths.map((_, i) => `[v${i}]`).join('');
    const filterComplex = filterParts.join('; ') +
      `; ${concatInputs}concat=n=${clipPaths.length}:v=1:a=0[outv]`;

    const audioIndex = clipPaths.length;
    const outputPath = path.join(tmpDir, 'output.mp4');

    const cmd = [
      'ffmpeg',
      inputs,
      audioInput,
      `-filter_complex "${filterComplex}"`,
      '-map "[outv]"',
      `-map ${audioIndex}:a`,
      '-c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -r 30',
      '-c:a aac -b:a 192k',
      '-movflags +faststart',
      `-t ${totalDuration}`,
      '-y',
      `"${outputPath}"`,
    ].join(' ');

    console.log(`[${jobId}] Running ffmpeg (${clips.length} clips, ${totalDuration}s output)...`);
    const startEncode = Date.now();
    execSync(cmd, { timeout: 600000, stdio: 'pipe' });
    const encodeTime = ((Date.now() - startEncode) / 1000).toFixed(1);
    console.log(`[${jobId}] Encode complete in ${encodeTime}s`);

    // === STEP 3: Upload to R2 ===
    const outputBuffer = fs.readFileSync(outputPath);
    const sizeMB = (outputBuffer.length / 1024 / 1024).toFixed(1);
    const sanitized = (title || 'vault-video')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .substring(0, 50)
      .trim()
      .replace(/ /g, '-');
    const r2Key = `renders/${sanitized}-${jobId}.mp4`;

    console.log(`[${jobId}] Uploading ${sizeMB}MB to R2 as ${r2Key}...`);
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: outputBuffer,
      ContentType: 'video/mp4',
    }));

    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
      { expiresIn: 21600 }
    );

    console.log(`[${jobId}] Done. Cleaning up tmp files.`);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({
      success: true,
      url: presignedUrl,
      key: r2Key,
      size: outputBuffer.length,
      size_mb: parseFloat(sizeMB),
      duration: totalDuration,
      encode_time_s: parseFloat(encodeTime),
      job_id: jobId,
    });

  } catch (err) {
    console.error(`[${jobId}] RENDER ERROR:`, err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.status(500).json({
      success: false,
      error: err.message,
      job_id: jobId,
    });
  }
});

app.listen(PORT, () => {
  console.log(`vault-ffmpeg-render listening on port ${PORT}`);
});
