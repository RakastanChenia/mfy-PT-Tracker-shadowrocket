// MFY PT Tracker 自动上报 —— 小分片 + 并行 + 应用层重传版
//
// 发送链路：
//   PJSK Response -> 64KB 分片 -> 最多 4 片并行 -> HTTP POST /api/raw2
//   单片网络错误/可重试 HTTP 状态 -> 自动重试，最多 3 次（总计最多 4 次尝试）
//
// 重传语义：同一个 X-Upload-Id + X-Chunk-Index 是幂等的；服务端按编号覆盖保存。
// 服务端 /api/raw2 还会记录 upload_id 的 processing/done 状态，防止“最后一个 200 回执丢失后重传”导致重复创建已完成上传。

const UPLOAD_VERSION = "v3-64k-parallel-retry3-sanjose";   // 2026-09-27 起上传端点在圣何塞；日志里看到这个后缀=已拿到新脚本

const upload_url = "http://167.234.217.255:8000/api/raw2";
const chunkSize  = 64 * 1024;   // 64KB
const PARALLEL   = 4;           // 最多 4 片在途
const MAX_RETRIES = 3;          // 每片最多重试 3 次；总尝试次数最多 4 次
const RETRY_DELAY_MS = [1000, 2000, 4000];

const body = (typeof $response !== "undefined" && $response.body) ? $response.body : "";
const url  = (typeof $request  !== "undefined" && $request.url)  ? $request.url : "";

if (!body || body.length === 0) {
  console.log("[mfy] no response body");
  $done({});
  return;
}

const upload_id   = Math.random().toString(36).substr(2, 9);
const totalChunks = Math.ceil(body.length / chunkSize);
const retryCount = {};
let started = 0;
let completed = 0;
let failed = 0;

function log(message) {
  console.log("[mfy-upload] [" + upload_id + "] " + message);
}

function statusOf(resp) {
  return resp && resp.status != null ? Number(resp.status) : 0;
}

function errorText(error, resp) {
  if (error) return String(error);
  const status = statusOf(resp);
  return status ? ("HTTP " + status) : "no response";
}

function isRetryable(error, resp) {
  // 网络错误 / 没有收到响应：重试。
  if (error || !resp) return true;

  // 408 Request Timeout、425 Too Early、429 Too Many Requests、5xx 服务端错误：重试。
  // 4xx 参数错误等永久性错误不重复打，避免无意义请求。
  const status = statusOf(resp);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

log("version=" + UPLOAD_VERSION + ", chunks=" + totalChunks + ", bytes=" + body.length);
log("url=" + url);

function finishOne(index) {
  completed++;
  if (completed !== totalChunks) return;

  log("done, failed=" + failed + "/" + totalChunks);
  $done({});
}

function sendChunk(index) {
  const start = index * chunkSize;
  const chunk = body.slice(start, Math.min(start + chunkSize, body.length));
  const attempt = (retryCount[index] || 0) + 1;

  $httpClient.post({
    url: upload_url,
    headers: {
      "X-Original-Url": url,
      "X-Upload-Version": UPLOAD_VERSION,
      "X-Upload-Id": upload_id,
      "X-Chunk-Index": String(index),
      "X-Total-Chunks": String(totalChunks),
      "X-Upload-Attempt": String(attempt),
      "Content-Type": "application/octet-stream",
    },
    body: chunk,
  }, (error, resp, data) => {
    const status = statusOf(resp);
    const ok = !error && status === 200;

    if (!ok) {
      if (isRetryable(error, resp) && (retryCount[index] || 0) < MAX_RETRIES) {
        retryCount[index] = (retryCount[index] || 0) + 1;
        const delay = RETRY_DELAY_MS[Math.min(retryCount[index] - 1, RETRY_DELAY_MS.length - 1)];
        log("chunk " + (index + 1) + " failed on attempt " + attempt + " (" + errorText(error, resp) + "), retry " + retryCount[index] + " in " + delay + "ms");
        setTimeout(() => sendChunk(index), delay);
        return;
      }

      failed++;
      log("chunk " + (index + 1) + " permanently failed after attempt " + attempt + ": " + errorText(error, resp));
      finishOne(index);
      if (started < totalChunks) sendChunk(started++);
      return;
    }

    log("chunk " + (index + 1) + " ok on attempt " + attempt + (data ? " response=" + String(data).slice(0, 120) : ""));
    finishOne(index);
    if (completed < totalChunks && started < totalChunks) sendChunk(started++);
  });
}

for (let i = 0; i < Math.min(PARALLEL, totalChunks); i++) {
  sendChunk(started++);
}
