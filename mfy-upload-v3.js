// MFY PT Tracker 自动上报 —— v4 base64 分片版
//
// v4 修复点：
// 1. 只上传目标 PJSK 接口，避免非目标响应产生 rejected 噪声；
// 2. 响应体先 Base64 编码再分片，避免二进制 AES 密文被 JS 字符串/UTF-8 损坏；
// 3. 服务端 /api/raw2 组装后先 Base64 解码，再 AES 解密。

const UPLOAD_VERSION = "v4-64k-parallel-base64-filter-sanjose";

const upload_url = "http://167.234.217.255:8000/api/raw2";
const chunkSize  = 64 * 1024;   // 64KB
const PARALLEL   = 4;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = [1000, 2000, 4000];

const TARGET_HOSTS = {
  "mkcn-prod-public-60001-1.dailygn.com": true,
  "mkcn-prod-public-60001-2.dailygn.com": true
};

function log(message) {
  console.log("[mfy-upload] " + message);
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
  if (error || !resp) return true;
  const status = statusOf(resp);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isTargetUrl(url) {
  try {
    url = String(url);
    const m = url.match(/^https?:\/\/([^\/?#]+)([^?#]*)/i);
    if (!m) return false;

    const host = m[1].toLowerCase().split(":")[0];
    if (!TARGET_HOSTS[host]) return false;

    const path = m[2].split("?")[0];
    if (path.indexOf("/api/user/") !== 0) return false;

    if (path.indexOf("/mysekai/harvest") >= 0) return true;
    if (path.indexOf("/mysekai/tutorial/harvest") >= 0) return true;
    if (path.indexOf("/multi-live/") >= 0) return true;

    if (path.indexOf("/rank-match-season/") >= 0) {
      return path.indexOf("/live/") >= 0 && url.indexOf("type=result") >= 0;
    }

    if (path.indexOf("/live/") >= 0) return true;
    if (path.indexOf("/challenge-live/solo/") >= 0) return true;

    return false;
  } catch (e) {
    return false;
  }
}

function bytesToBase64(u8) {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < u8.length; i += 3) {
    const b1 = u8[i];
    const b2 = i + 1 < u8.length ? u8[i + 1] : 0;
    const b3 = i + 2 < u8.length ? u8[i + 2] : 0;

    out += B64[b1 >> 2];
    out += B64[((b1 & 3) << 4) | (b2 >> 4)];
    out += (i + 1 < u8.length) ? B64[((b2 & 15) << 2) | (b3 >> 6)] : "=";
    out += (i + 2 < u8.length) ? B64[b3 & 63] : "=";
  }
  return out;
}

function stringToBase64(s) {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xff;
  }
  return bytesToBase64(bytes);
}

function getBase64Body() {
  try {
    if (typeof $response !== "undefined" && $response.bodyBytes) {
      const bb = $response.bodyBytes;

      if (typeof ArrayBuffer !== "undefined" && bb instanceof ArrayBuffer) {
        return bytesToBase64(new Uint8Array(bb));
      }
      if (typeof Uint8Array !== "undefined" && bb instanceof Uint8Array) {
        return bytesToBase64(bb);
      }
      if (typeof bb === "string") {
        const clean = bb.replace(/\s/g, "");
        if (/^[A-Za-z0-9+/=]+$/.test(clean)) {
          return clean;
        }
      }
    }
  } catch (e) {}

  if (typeof $response !== "undefined" && $response.body) {
    return stringToBase64(String($response.body));
  }

  return "";
}

const url = (typeof $request !== "undefined" && $request.url)
  ? String($request.url)
  : "";

if (!url || !isTargetUrl(url)) {
  console.log("[mfy] skip non-target url=" + url);
  $done({});
  return;
}

const bodyB64 = getBase64Body();

if (!bodyB64 || bodyB64.length === 0) {
  console.log("[mfy] no response body");
  $done({});
  return;
}

const upload_id   = Math.random().toString(36).substr(2, 9);
const totalChunks = Math.ceil(bodyB64.length / chunkSize);
const retryCount = {};

let started = 0;
let completed = 0;
let failed = 0;

log("version=" + UPLOAD_VERSION + ", chunks=" + totalChunks + ", base64Bytes=" + bodyB64.length);
log("url=" + url);

function finishOne(index) {
  completed++;
  if (completed !== totalChunks) return;

  log("done, failed=" + failed + "/" + totalChunks);
  $done({});
}

function sendChunk(index) {
  const start = index * chunkSize;
  const chunk = bodyB64.slice(start, Math.min(start + chunkSize, bodyB64.length));
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
      "X-Body-Encoding": "base64",
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