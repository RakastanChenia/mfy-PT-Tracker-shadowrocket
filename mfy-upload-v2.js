// MFY PT Tracker 自动上报 —— 小分片 + 并行上传版
// 相对原版只有 5 处改动（不改变上传契约，服务端无需任何改动）：
//   1) chunkSize 1MB -> 64KB：实际包体约 190KB，1MB 阈值等于"永远不切片"
//   2) 串行推进 -> 最多 4 片并行（滑动窗口补位，谁先回来谁补位）
//   3) 端点 -> /api/raw2：服务端收到即回（异步处理），老接口 /api/raw 保持兼容
//   4) 空包时补上 return：原版 $done({}) 之后没有 return，会继续发出一个空请求
//   5) 每片可选重试一次：同一个 X-Chunk-Index 重发是幂等的（服务端按编号覆盖写）

const UPLOAD_VERSION = "v2-64k-parallel";   // 版本标记：日志里会打印，用来确认自己拿到的是不是新版

const upload_url = "http://168.138.217.249:8000/api/raw2";
const chunkSize  = 64 * 1024;   // 64KB
const PARALLEL   = 4;           // 最多 4 片在途
const RETRY      = 1;           // 每片最多重试次数（0 = 不重试）

const body = (typeof $response !== "undefined" && $response.body) ? $response.body : "";
const url  = (typeof $request  !== "undefined" && $request.url)  ? $request.url  : "";

if (!body || body.length === 0) {
  console.log("[mfy] no response body");
  $done({});
  return;
}

const upload_id   = Math.random().toString(36).substr(2, 9);
const totalChunks = Math.ceil(body.length / chunkSize);
const tried = {};
let started = 0, done = 0, failed = 0;

function log(message) {
  console.log("[mfy-upload] [" + upload_id + "] " + message);
}

log("version=" + UPLOAD_VERSION + ", chunks=" + totalChunks + ", bytes=" + body.length);
log("url=" + url);

function sendChunk(index) {
  const start = index * chunkSize;
  const chunk = body.slice(start, Math.min(start + chunkSize, body.length));

  $httpClient.post({
    url: upload_url,
    headers: {
      "X-Original-Url": url,
      "X-Upload-Id": upload_id,
      "X-Chunk-Index": String(index),
      "X-Total-Chunks": String(totalChunks),
      "Content-Type": "application/octet-stream",
    },
    body: chunk,
  }, (error, resp, data) => {
    const ok = !error && resp && resp.status === 200;

    if (!ok) {
      tried[index] = (tried[index] || 0) + 1;
      if (tried[index] <= RETRY) {
        // 重试期间这一格窗口空着，回来后会继续补位；幂等，不会污染数据
        log("chunk " + (index + 1) + " failed (" + (error || ("HTTP " + resp.status)) + "), retry " + tried[index]);
        setTimeout(() => sendChunk(index), 1000 * tried[index]);
        return;
      }
      failed++;
      log("chunk " + (index + 1) + " failed: " + (error || ("HTTP " + resp.status)));
    }

    done++;
    if (done === totalChunks) {
      log("done, failed=" + failed + "/" + totalChunks);
      $done({});          // 必须等全部结束才 $done，否则脚本提前退出会取消在途请求
      return;
    }
    if (started < totalChunks) sendChunk(started++);   // 滑动窗口补位 -> 始终 <= PARALLEL 条在途
  });
}

for (let i = 0; i < Math.min(PARALLEL, totalChunks); i++) sendChunk(started++);