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
  return new Promise(function(resolve, reject) {
    var proto = url.startsWith('https') ? https : http;
    proto.get(url, function(response) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        reject(new Error('Download failed: HTTP ' + response.statusCode));
        return;
      }
      var file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on('finish', function() { file.close(resolve); });
      file.on('error', function(err) { fs.unlink(destPath, function() {}); reject(err); });
    }).on('error', reject);
  });
}

function uploadToR2(buffer, filename) {
  return new Promise(function(resolve, reject) {
    var base64 = buffer.toString('base64');
    var body = JSON.stringify({ data: base64, encoding: 'base64' });
    var url = new URL(WORKER_URL + '/upload?filename=' + encodeURIComponent(filename));
    var options = {
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + WORKER_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          parsed.success ? resolve(parsed) : reject(new Error('Upload failed: ' + JSON.stringify(parsed)));
        } catch (e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, function() { req.destroy(new Error('Upload timeout')); });
    req.write(body);
    req.end();
  });
}

function runFFmpeg(cmd, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var proc = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    var stderr = '';
    var killed = false;

    var timer = setTimeout(function() {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('FFmpeg timed out after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);

    proc.stderr.on('data', function(chunk) { stderr += chunk.toString(); });

    proc.on('close', function(code) {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve(stderr);
      } else {
        var tail = stderr.length > 500 ? stderr.slice(-500) : stderr;
        reject(new Error('FFmpeg exited with code ' + code + ': ' + tail));
      }
    });

    proc.on('error', function(err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}

app.get('/', function(req, res) {
  res.json({ status: 'ok', service: 'vault-ffmpeg-render', version: '1.3.0' });
});

app.post('/render', async function(req, res) {
  if (req.headers.authorization !== 'Bearer ' + RENDER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  var clips = req.body.clips;
  var audio = req.body.audio;
  var title = req.body.title;
  var clip_duration = req.body.clip_duration;

  if (!clips || !clips.length) return res.status(400).json({ error: 'clips array required' });
  if (!audio) return res.status(400).json({ error: 'audio URL required' });

  var jobId = Date.now().toString();
  var tmpDir = '/tmp/render-' + jobId;
  fs.mkdirSync(tmpDir, { recursive: true });
  var secPerClip = clip_duration || 5;
  var totalDuration = clips.length * secPerClip;

  console.log('[' + jobId + '] Downloading ' + clips.length + ' clips + 1 audio...');

  try {
    // --- PHASE 1: Download all clips + audio ---
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

    // --- PHASE 2: Pre-process each clip individually (low memory) ---
    console.log('[' + jobId + '] Pre-processing ' + clipPaths.length + ' clips...');
    var prepStart = Date.now();
    var prepPaths = [];
    for (var i = 0; i < clipPaths.length; i++) {
      var prepDest = path.join(tmpDir, 'prep' + String(i).padStart(2, '0') + '.ts');
      var prepCmd = 'ffmpeg -i "' + clipPaths[i] + '" ' +
        '-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30" ' +
        '-c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p ' +
        '-an -f mpegts -y "' + prepDest + '"';
      await runFFmpeg(prepCmd, 60000);
      prepPaths.push(prepDest);
      console.log('[' + jobId + '] Clip ' + (i + 1) + '/' + clipPaths.length + ' preprocessed');
    }
    var prepTime = ((Date.now() - prepStart) / 1000).toFixed(1);
    console.log('[' + jobId + '] All clips preprocessed in ' + prepTime + 's');

    // --- PHASE 3: Concat via demuxer (near-zero memory) ---
    var concatList = path.join(tmpDir, 'concat.txt');
    var listContent = prepPaths.map(function(p) {
      return "file '" + p + "'";
    }).join('\n');
    fs.writeFileSync(concatList, listContent);

    var concatDest = path.join(tmpDir, 'concat.ts');
    var concatCmd = 'ffmpeg -f concat -safe 0 -i "' + concatList + '" -c copy -y "' + concatDest + '"';

    console.log('[' + jobId + '] Concatenating...');
    await runFFmpeg(concatCmd, 60000);
    console.log('[' + jobId + '] Concat complete');

    // --- PHASE 4: Mux audio onto concatenated video ---
    var outputPath = path.join(tmpDir, 'output.mp4');
    var muxCmd = 'ffmpeg -i "' + concatDest + '" -i "' + audioDest + '" ' +
      '-c:v copy -c:a aac -b:a 192k -movflags +faststart ' +
      '-t ' + totalDuration + ' -y "' + outputPath + '"';

    console.log('[' + jobId + '] Muxing audio...');
    var encodeStart = Date.now();
    await runFFmpeg(muxCmd, 120000);
    var encodeTime = ((Date.now() - encodeStart) / 1000).toFixed(1);
    console.log('[' + jobId + '] Mux complete in ' + encodeTime + 's');

    // Verify output
    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg produced no output file');
    }
    var outputBuffer = fs.readFileSync(outputPath);
    if (outputBuffer.length < 10000) {
      throw new Error('Output too small: ' + outputBuffer.length + ' bytes');
    }
    var sizeMb = (outputBuffer.length / 1024 / 1024).toFixed(1);
    console.log('[' + jobId + '] Output: ' + sizeMb + 'MB');

    // --- PHASE 5: Upload to R2 via Worker ---
    var sanitized = (title || 'video').replace(/[^a-zA-Z0-9 ]/g, '')
      .substring(0, 50).trim().replace(/ /g, '-');
    var r2Filename = 'renders/' + sanitized + '-' + jobId + '.mp4';

    console.log('[' + jobId + '] Uploading to R2: ' + r2Filename + '...');
    var uploadStart = Date.now();
    var uploadResult = await uploadToR2(outputBuffer, r2Filename);
    var uploadTime = ((Date.now() - uploadStart) / 1000).toFixed(1);
    console.log('[' + jobId + '] Upload complete in ' + uploadTime + 's');

    // --- PHASE 6: Cleanup and respond ---
    fs.rmSync(tmpDir, { recursive: true, force: true });

    var totalTime = ((Date.now() - downloadStart) / 1000).toFixed(1);
    res.json({
      success: true,
      url: uploadResult.presigned_url,
      size_mb: parseFloat(sizeMb),
      duration: totalDuration,
      preprocess_time_s: parseFloat(prepTime),
      encode_time_s: parseFloat(encodeTime),
      upload_time_s: parseFloat(uploadTime),
      total_time_s: parseFloat(totalTime),
      job_id: jobId,
    });
    console.log('[' + jobId + '] Done — total ' + totalTime + 's');

  } catch (err) {
    console.error('[' + jobId + '] Error: ' + err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ success: false, error: err.message, job_id: jobId });
  }
});

app.listen(PORT, function() { console.log('vault-ffmpeg-render v1.3.0 listening on port ' + PORT); });
