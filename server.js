const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '10mb' }));

const WORKER_URL = process.env.WORKER_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const RENDER_TOKEN = process.env.RENDER_TOKEN;
const PORT = process.env.PORT || 3000;

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on('finish', () => { file.close(resolve); });
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    }).on('error', reject);
  });
}

function uploadToR2(buffer, filename) {
  return new Promise((resolve, reject) => {
    const base64 = buffer.toString('base64');
    const body = JSON.stringify({ data: base64, encoding: 'base64' });
    const url = new URL(WORKER_URL + '/upload?filename=' + encodeURIComponent(filename));
    const options = {
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + WORKER_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          parsed.success ? resolve(parsed) : reject(new Error('Upload failed: ' + JSON.stringify(parsed)));
        } catch (e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('Upload timeout')); });
    req.write(body);
    req.end();
  });
}

function runFFmpeg(cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('FFmpeg timed out after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve(stderr);
      } else {
        const tail = stderr.length > 500 ? stderr.slice(-500) : stderr;
        reject(new Error('FFmpeg exited with code ' + code + ': ' + tail));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'vault-ffmpeg-render', version: '1.2.0' });
});

app.post('/render', async (req, res) => {
  if (req.headers.authorization !== 'Bearer ' + RENDER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { clips, audio, title, clip_duration } = req.body;
  if (!clips || !clips.length) return res.status(400).json({ error: 'clips array required' });
  if (!audio) return res.status(400).json({ error: 'audio URL required' });

  const jobId = Date.now().toString();
  const tmpDir = '/tmp/render-' + jobId;
  fs.mkdirSync(tmpDir, { recursive: true });
  const secPerClip = clip_duration || 5;
  const totalDuration = clips.length * secPerClip;

  console.log('[' + jobId + '] Downloading ' + clips.length + ' clips + 1 audio...');

  try {
    var downloadStart = Date.now();
    var clipPromises = clips.map(function(url, i) {
      var dest = path.join(tmpDir, 'clip' + String(i).padStart(2, '0') + '.mp4');
      return downloadFile(url, dest).then(function() { return dest; });
    });
    var audioDest = path.join(tmpDir, 'voiceover.mp3');
    clipPromises.push(downloadFile(audio, audioDest).then(function() { return audioDest; }));
    var allPaths = await Promise.all(clipPromises);
    var clipPaths = allPaths.slice(0, -1);
    var dlTime = ((Date.now() - downloadStart) / 1000).toFixed(1);
    console.log('[' + jobId + '] Downloads complete in ' + dlTime + 's');

    var inputs = clipPaths.map(function(p) { return '-i "' + p + '"'; }).join(' ');
    var filterParts = clipPaths.map(function(_, i) {
      return '[' + i + ':v]scale=1920:1080,setsar=1,fps=30[v' + i + ']';
    });
    var concatInputs = clipPaths.map(function(_, i) { return '[v' + i + ']'; }).join('');
    var filterComplex = filterParts.join('; ') +
      '; ' + concatInputs + 'concat=n=' + clipPaths.length + ':v=1:a=0[outv]';
    var outputPath = path.join(tmpDir, 'output.mp4');

    var cmd = 'ffmpeg ' + inputs + ' -i "' + audioDest + '" ' +
      '-filter_complex "' + filterComplex + '" ' +
      '-map "[outv]" -map ' + clipPaths.length + ':a ' +
      '-c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -r 30 ' +
      '-c:a aac -b:a 192k -movflags +faststart ' +
      '-t ' + totalDuration + ' -y "' + outputPath + '"';

    console.log('[' + jobId + '] Running ffmpeg (' + clipPaths.length + ' clips, ' + totalDuration + 's output)...');
    var encodeStart = Date.now();
    await runFFmpeg(cmd, 300000);
    var encodeTime = ((Date.now() - encodeStart) / 1000).toFixed(1);
    console.log('[' + jobId + '] Encode complete in ' + encodeTime + 's');

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg produced no output file');
    }
    var outputBuffer = fs.readFileSync(outputPath);
    if (outputBuffer.length < 10000) {
      throw new Error('Output too small: ' + outputBuffer.length + ' bytes');
    }
    var sizeMb = (outputBuffer.length / 1024 / 1024).toFixed(1);
    console.log('[' + jobId + '] Output: ' + sizeMb + 'MB');

    var sanitized = (title || 'video').replace(/[^a-zA-Z0-9 ]/g, '')
      .substring(0, 50).trim().replace(/ /g, '-');
    var r2Filename = 'renders/' + sanitized + '-' + jobId + '.mp4';

    console.log('[' + jobId + '] Uploading to R2: ' + r2Filename + '...');
    var uploadStart = Date.now();
    var uploadResult = await uploadToR2(outputBuffer, r2Filename);
    var uploadTime = ((Date.now() - uploadStart) / 1000).toFixed(1);
    console.log('[' + jobId + '] Upload complete in ' + uploadTime + 's');

    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({
      success: true,
      url: uploadResult.presigned_url,
      size_mb: parseFloat(sizeMb),
      duration: totalDuration,
      encode_time_s: parseFloat(encodeTime),
      upload_time_s: parseFloat(uploadTime),
      job_id: jobId,
    });
    console.log('[' + jobId + '] Done');

  } catch (err) {
    console.error('[' + jobId + '] Error: ' + err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ success: false, error: err.message, job_id: jobId });
  }
});

app.listen(PORT, function() { console.log('vault-ffmpeg-render v1.2.0 listening on port ' + PORT); });
