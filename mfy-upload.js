const upload_url = "http://172.86.81.97:8000/api/raw";
const chunkSize = 1 * 1024 * 1024; // 1MB

const body = (typeof $response !== "undefined" && $response.body) ? $response.body : "";
const url = (typeof $request !== "undefined" && $request.url) ? $request.url : "";

if (!body || body.length === 0) {
    console.log("[mfy] no response body");
    $done({});
}

const upload_id = Math.random().toString(36).substr(2, 9);
const totalChunks = Math.ceil(body.length / chunkSize);
let sentChunks = 0;
let failedChunks = 0;

function log(message) {
    console.log(`[mfy-upload] [${upload_id}] ${message}`);
}

log(`start upload, chunks=${totalChunks}, bytes=${body.length}`);
log(`url=${url}`);

function sendChunk(index) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, body.length);
    const chunk = body.slice(start, end);

    const options = {
        url: upload_url,
        headers: {
            "X-Original-Url": url,
            "X-Upload-Id": upload_id,
            "X-Chunk-Index": String(index),
            "X-Total-Chunks": String(totalChunks),
            "Content-Type": "application/octet-stream",
        },
        body: chunk,
    };

    $httpClient.post(options, (error, resp, data) => {
        sentChunks++;

        if (error) {
            failedChunks++;
            log(`chunk ${index + 1} failed: ${error}`);
        } else if (resp.status !== 200) {
            failedChunks++;
            log(`chunk ${index + 1} failed: HTTP ${resp.status}`);
        } else {
            log(`chunk ${index + 1} ok`);
        }

        if (sentChunks === totalChunks) {
            log(`done, failed=${failedChunks}/${sentChunks}`);
            $done({});
        } else {
            sendChunk(index + 1);
        }
    });
}

sendChunk(0);