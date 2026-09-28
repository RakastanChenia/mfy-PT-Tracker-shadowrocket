// MFY PT Tracker 自动上报 —— v4.1 诊断版
//
// 1. 每一步都打日志，方便定位到底断在哪；
// 2. 兼容 body / bodyBytes 为 ArrayBuffer、Uint8Array、base64 字符串、raw 字符串；
// 3. 只上传模块 pattern 匹配到的目标响应。

const UPLOAD_VERSION = "v4.1.5-dispatch-only";

const upload_url = "http://167.234.217.255:8000/api/raw2";
const MIN_CHUNK  = 64 * 1024;   // 64KB 起步：小包也切得开
const BURST      = 8;           // 一轮最多派发几片（回调不会回来，必须一次发完）

const TARGET_HOSTS = {
  "mkcn-prod-public-60001-1.dailygn.com": true,
  "mkcn-prod-public-60001-2.dailygn.com": true
};

function log(message) {
  console.log("[mfy-upload] " + message);
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

function looksLikeBase64(s) {
  if (typeof s !== "string") return false;
  const clean = s.replace(/[\r\n\t ]/g, "");
  return clean.length > 0 && clean.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(clean);
}

function getBase64Body() {
  const resp = (typeof $response !== "undefined") ? $response : null;
  if (!resp) {
    log("FATAL: no $response object");
    return { data: "", source: "none" };
  }

  const bb = resp.bodyBytes;
  if (bb) {
    if (typeof ArrayBuffer !== "undefined" && bb instanceof ArrayBuffer) {
      return { data: bytesToBase64(new Uint8Array(bb)), source: "bodyBytes:ArrayBuffer:" + bb.byteLength };
    }
    if (typeof Uint8Array !== "undefined" && bb instanceof Uint8Array) {
      return { data: bytesToBase64(bb), source: "bodyBytes:Uint8Array:" + bb.length };
    }
    if (typeof bb === "string") {
      if (looksLikeBase64(bb)) {
        return { data: bb.replace(/[\r\n\t ]/g, ""), source: "bodyBytes:base64-string:" + bb.length };
      }
      return { data: stringToBase64(bb), source: "bodyBytes:raw-string:" + bb.length };
    }
    log("WARN: bodyBytes unknown type=" + (typeof bb));
  }

  const b = resp.body;
  if (b) {
    if (typeof ArrayBuffer !== "undefined" && b instanceof ArrayBuffer) {
      return { data: bytesToBase64(new Uint8Array(b)), source: "body:ArrayBuffer:" + b.byteLength };
    }
    if (typeof Uint8Array !== "undefined" && b instanceof Uint8Array) {
      return { data: bytesToBase64(b), source: "body:Uint8Array:" + b.length };
    }
    if (typeof b === "string") {
      if (looksLikeBase64(b)) {
        return { data: b.replace(/[\r\n\t ]/g, ""), source: "body:base64-string:" + b.length };
      }
      return { data: stringToBase64(b), source: "body:raw-string:" + b.length };
    }
    log("WARN: body unknown type=" + (typeof b));
  }

  return { data: "", source: "empty" };
}

function startUpload() {
let released = false;
// $done 只能放行一次；提前放行后，收尾路径再调用它是无害的空操作。
function release() {
  if (released) return;
  released = true;
  $done({});
}

let url = "";
try {
  url = (typeof $request !== "undefined" && $request.url)
    ? String($request.url)
    : "";
} catch (e) {
  log("FATAL: read $request.url failed: " + e);
}

log("trigger url=" + url);

if (!url) {
  log("FATAL: $request.url is empty, cannot upload");
  release();
  return;
}

if (!isTargetUrl(url)) {
  log("SKIP: url not target: " + url);
  release();
  return;
}

const bodyInfo = getBase64Body();
log("body source=" + bodyInfo.source + ", base64Len=" + bodyInfo.data.length);

if (!bodyInfo.data || bodyInfo.data.length === 0) {
  log("FATAL: no response body data");
  release();
  return;
}

const bodyB64 = bodyInfo.data;
const upload_id   = Math.random().toString(36).substr(2, 9);
// 实测：$done() 之后 ~1ms 脚本上下文就 dealloc，$httpClient 的回调永远不会回来。
// 所以只能"一次派发完、不等回执"：分片大小自适应，保证 chunks ≤ BURST，任何包体都不会被截断。
const chunkSize  = Math.max(MIN_CHUNK, Math.ceil(bodyB64.length / BURST));
const totalChunks = Math.ceil(bodyB64.length / chunkSize);


log("version=" + UPLOAD_VERSION + ", upload_id=" + upload_id + ", chunks=" + totalChunks + ", base64Bytes=" + bodyB64.length);
function sendChunk(index) {
  const start = index * chunkSize;
  $httpClient.post({
    url: upload_url,
    headers: {
      "X-Original-Url": url,
      "X-Upload-Version": UPLOAD_VERSION,
      "X-Upload-Id": upload_id,
      "X-Chunk-Index": String(index),
      "X-Total-Chunks": String(totalChunks),
      "X-Body-Encoding": "base64",
      "Content-Type": "application/octet-stream",
    },
    body: bodyB64.slice(start, Math.min(start + chunkSize, bodyB64.length)),
  }, function () {});   // 回调永远不会回来（$done 后上下文立即销毁），空函数只为满足 API 签名
}

// 一次性把分片交给网络栈（毫秒级），随后立刻放行响应体 —— 游戏不等上传。
for (let i = 0; i < totalChunks; i++) sendChunk(i);
log("DISPATCH_ALL chunks=" + totalChunks + " chunkSize=" + chunkSize + " -> release response");
release();
}

startUpload();
