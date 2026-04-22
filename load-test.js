import http from "k6/http"
import { check } from "k6"

export const options = {
  scenarios: {
    chunk_uploads: {
      executor: "constant-arrival-rate",
      rate: 5000,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
}

export default function () {
  const payload = {
    sessionId: "load-test-session",
    chunkId: `chunk-${__VU}-${__ITER}`,
    sequenceNo: __ITER,
    startedAtMs: Date.now() - 5000,
    endedAtMs: Date.now(),
    sha256: "dummy-hash",
    audio: http.file("x".repeat(1024), "chunk.wav", "audio/wav"),
  }

  const res = http.post("http://localhost:3000/api/chunks/upload", payload)

  check(res, {
    "status is 2xx or 429": (response) => response.status >= 200 && response.status < 300 || response.status === 429,
  })
}
