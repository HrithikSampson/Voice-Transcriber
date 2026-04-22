import { useCallback, useEffect, useRef, useState } from "react"

const SAMPLE_RATE = 16000
const BUFFER_SIZE = 4096
const MAX_UPLOAD_ATTEMPTS = 7
const BASE_RETRY_MS = 300
const MAX_RETRY_MS = 20_000
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL

export interface WavChunk {
  id: string
  blob: Blob
  url: string
  duration: number
  timestamp: number
}

export interface TranscriptSegment {
  speaker: string
  speakerTag: string
  startMs: number
  endMs: number
  text: string
  confidence: number
  sequenceNo: number
}

export type RecorderStatus = "idle" | "requesting" | "recording" | "paused"

interface UseRecorderOptions {
  chunkDuration?: number
  deviceId?: string
}

interface UploadItem {
  chunk: WavChunk
  sequenceNo: number
  startedAtMs: number
  endedAtMs: number
}

interface FinalizeTranscriptResponse {
  processedChunkSequences?: number[]
  segments?: Array<{
    speaker?: string
    speakerTag?: string
    startMs?: number
    endMs?: number
    text?: string
    confidence?: number
    sequenceNo?: number
  }>
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeStr(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, "data")
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: "audio/wav" })
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.round(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const srcIndex = i * ratio
    const low = Math.floor(srcIndex)
    const high = Math.min(low + 1, input.length - 1)
    const frac = srcIndex - low
    output[i] = input[low] * (1 - frac) + input[high] * frac
  }
  return output
}

export function useRecorder(options: UseRecorderOptions = {}) {
  const { chunkDuration = 5, deviceId } = options

  const [status, setStatus] = useState<RecorderStatus>("idle")
  const [chunks, setChunks] = useState<WavChunk[]>([])
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const sampleCountRef = useRef(0)
  const chunkThreshold = SAMPLE_RATE * chunkDuration
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const pausedElapsedRef = useRef(0)
  const statusRef = useRef<RecorderStatus>("idle")
  const sequenceRef = useRef(0)
  const sessionIdRef = useRef<string | null>(null)
  const uploadQueueRef = useRef<UploadItem[]>([])
  const isUploadingRef = useRef(false)
  const opfsDirRef = useRef<FileSystemDirectoryHandle | null>(null)
  const uploadedPendingProcessRef = useRef<Set<number>>(new Set())
  const transcriptCursorRef = useRef(-1)

  statusRef.current = status

  const sleep = useCallback(async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }, [])

  const sha256Hex = useCallback(async (blob: Blob) => {
    const bytes = await blob.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(hashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }, [])

  const retryDelayWithJitter = useCallback((attempt: number) => {
    const exponential = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** attempt)
    // Full-jitter backoff prevents clients retrying in lockstep.
    return Math.floor(Math.random() * exponential)
  }, [])

  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current
    if (!SERVER_URL) return null

    const response = await fetch(`${SERVER_URL}/api/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startedAtMs: Date.now() }),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { sessionId?: string }
    sessionIdRef.current = body.sessionId ?? null
    return sessionIdRef.current
  }, [])

  const getOpfsDir = useCallback(async () => {
    if (opfsDirRef.current) return opfsDirRef.current
    if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) return null

    const root = await navigator.storage.getDirectory()
    const sessionDirName = sessionIdRef.current ?? "pending-session"
    const chunksDir = await root.getDirectoryHandle("chunks", { create: true })
    const sessionDir = await chunksDir.getDirectoryHandle(sessionDirName, { create: true })
    opfsDirRef.current = sessionDir
    return sessionDir
  }, [])

  const persistChunkToOpfs = useCallback(
    async (item: UploadItem) => {
      const dir = await getOpfsDir()
      if (!dir) return false
      const fileHandle = await dir.getFileHandle(`${item.sequenceNo}.wav`, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(item.chunk.blob)
      await writable.close()
      return true
    },
    [getOpfsDir]
  )

  const deleteChunkFromOpfs = useCallback(async (sequenceNo: number) => {
    const dir = opfsDirRef.current
    if (!dir) return
    await dir.removeEntry(`${sequenceNo}.wav`).catch(() => undefined)
  }, [])

  const uploadWithRetry = useCallback(
    async (item: UploadItem) => {
      if (!SERVER_URL) return false
      const sessionId = await ensureSession()
      if (!sessionId) return false

      const chunkHash = await sha256Hex(item.chunk.blob)
      for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
        const form = new FormData()
        form.set("sessionId", sessionId)
        form.set("chunkId", item.chunk.id)
        form.set("sequenceNo", String(item.sequenceNo))
        form.set("startedAtMs", String(item.startedAtMs))
        form.set("endedAtMs", String(item.endedAtMs))
        form.set("sha256", chunkHash)
        form.set("audio", item.chunk.blob, `${item.sequenceNo}.wav`)

        const response = await fetch(`${SERVER_URL}/api/chunks/upload`, {
          method: "POST",
          body: form,
        }).catch(() => null)

        if (response?.ok) return true

        const retryAfterHeader = response?.headers.get("Retry-After")
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0
        const delayMs = Math.max(retryAfterMs, retryDelayWithJitter(attempt))
        await sleep(delayMs)
      }
      return false
    },
    [ensureSession, retryDelayWithJitter, sha256Hex, sleep]
  )

  const pumpQueue = useCallback(async () => {
    if (isUploadingRef.current) return
    isUploadingRef.current = true
    try {
      while (uploadQueueRef.current.length > 0) {
        const item = uploadQueueRef.current[0]
        const uploaded = await uploadWithRetry(item)
        if (!uploaded) {
          // Keep item in queue for later retries to avoid dropping chunks.
          break
        }
        uploadedPendingProcessRef.current.add(item.sequenceNo)
        uploadQueueRef.current.shift()
      }
    } finally {
      isUploadingRef.current = false
    }
  }, [uploadWithRetry])

  const enqueueUpload = useCallback(
    (item: UploadItem) => {
      uploadQueueRef.current.push(item)
      void pumpQueue()
    },
    [pumpQueue]
  )

  const emitChunk = useCallback(
    (merged: Float32Array) => {
      const blob = encodeWav(merged, SAMPLE_RATE)
      const url = URL.createObjectURL(blob)
      const now = Date.now()
      const sequenceNo = sequenceRef.current
      const durationMs = Math.max(1, Math.floor((merged.length / SAMPLE_RATE) * 1000))
      const chunk: WavChunk = {
        id: crypto.randomUUID(),
        blob,
        url,
        duration: merged.length / SAMPLE_RATE,
        timestamp: now,
      }
      sequenceRef.current += 1
      setChunks((prev) => [...prev, chunk])

      const uploadItem = {
        chunk,
        sequenceNo,
        startedAtMs: now - durationMs,
        endedAtMs: now,
      }
      void persistChunkToOpfs(uploadItem).finally(() => {
        enqueueUpload(uploadItem)
      })
    },
    [enqueueUpload, persistChunkToOpfs]
  )

  const flushChunk = useCallback(() => {
    if (samplesRef.current.length === 0) return

    const totalLen = samplesRef.current.reduce((n, b) => n + b.length, 0)
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const buf of samplesRef.current) {
      merged.set(buf, offset)
      offset += buf.length
    }
    samplesRef.current = []
    sampleCountRef.current = 0

    emitChunk(merged)
  }, [emitChunk])

  const start = useCallback(async () => {
    if (statusRef.current === "recording") return

    setStatus("requesting")
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId
          ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
      })

      const audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(mediaStream)
      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      const nativeSampleRate = audioCtx.sampleRate

      processor.onaudioprocess = (e) => {
        if (statusRef.current !== "recording") return

        const input = e.inputBuffer.getChannelData(0)
        const resampled = resample(new Float32Array(input), nativeSampleRate, SAMPLE_RATE)

        samplesRef.current.push(resampled)
        sampleCountRef.current += resampled.length

        if (sampleCountRef.current >= chunkThreshold) {
          // flush synchronously from the collected buffers
          const totalLen = samplesRef.current.reduce((n, b) => n + b.length, 0)
          const merged = new Float32Array(totalLen)
          let off = 0
          for (const buf of samplesRef.current) {
            merged.set(buf, off)
            off += buf.length
          }
          samplesRef.current = []
          sampleCountRef.current = 0

          emitChunk(merged)
        }
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      streamRef.current = mediaStream
      audioCtxRef.current = audioCtx
      processorRef.current = processor
      setStream(mediaStream)

      samplesRef.current = []
      sampleCountRef.current = 0
      sequenceRef.current = 0
      uploadQueueRef.current = []
      uploadedPendingProcessRef.current.clear()
      transcriptCursorRef.current = -1
      setTranscript([])
      sessionIdRef.current = null
      opfsDirRef.current = null
      pausedElapsedRef.current = 0
      startTimeRef.current = Date.now()
      setElapsed(0)
      setStatus("recording")

      timerRef.current = setInterval(() => {
        if (statusRef.current === "recording") {
          setElapsed(
            pausedElapsedRef.current + (Date.now() - startTimeRef.current) / 1000
          )
        }
      }, 100)
    } catch {
      setStatus("idle")
    }
  }, [deviceId, chunkThreshold, emitChunk])

  const pollProcessedChunks = useCallback(async () => {
    if (!SERVER_URL) return
    const sessionId = sessionIdRef.current
    if (!sessionId || uploadedPendingProcessRef.current.size === 0) return

    const response = await fetch(
      `${SERVER_URL}/api/sessions/${sessionId}/transcript/stream?sinceSequence=${transcriptCursorRef.current}`
    ).catch(() => null)
    if (!response?.ok) return

    const payload = (await response.json()) as {
      segments?: Array<{
        sequence_no?: number
        sequenceNo?: number
        display_speaker?: string
        speaker_tag?: string
        start_ms?: number
        end_ms?: number
        text?: string
        confidence?: number
      }>
    }
    const segments = payload.segments ?? []
    const processedSequences = new Set<number>()
    let maxSeen = transcriptCursorRef.current

    for (const segment of segments) {
      const sequence = segment.sequenceNo ?? segment.sequence_no
      if (typeof sequence !== "number") continue
      processedSequences.add(sequence)
      if (sequence > maxSeen) maxSeen = sequence
    }

    transcriptCursorRef.current = maxSeen
    if (segments.length > 0) {
      const normalized: TranscriptSegment[] = segments
        .map((segment) => {
          const sequenceNo = segment.sequenceNo ?? segment.sequence_no
          if (typeof sequenceNo !== "number") return null
          return {
            speaker: segment.display_speaker ?? "user0",
            speakerTag: segment.speaker_tag ?? "speaker_unknown",
            startMs: Number(segment.start_ms ?? 0),
            endMs: Number(segment.end_ms ?? 0),
            text: segment.text ?? "",
            confidence: Number(segment.confidence ?? 0),
            sequenceNo,
          }
        })
        .filter((segment): segment is TranscriptSegment => segment !== null)

      setTranscript((previous) => {
        const seen = new Set(
          previous.map(
            (item) => `${item.sequenceNo}-${item.startMs}-${item.endMs}-${item.speakerTag}-${item.text}`
          )
        )
        const additions = normalized.filter((item) => {
          const key = `${item.sequenceNo}-${item.startMs}-${item.endMs}-${item.speakerTag}-${item.text}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        return [...previous, ...additions].sort((a, b) => {
          if (a.sequenceNo !== b.sequenceNo) return a.sequenceNo - b.sequenceNo
          return a.startMs - b.startMs
        })
      })
    }

    for (const sequence of processedSequences) {
      if (!uploadedPendingProcessRef.current.has(sequence)) continue
      await deleteChunkFromOpfs(sequence)
      uploadedPendingProcessRef.current.delete(sequence)
    }
  }, [deleteChunkFromOpfs])

  const finalizeSessionTranscript = useCallback(async () => {
    if (!SERVER_URL) return
    const sessionId = sessionIdRef.current
    if (!sessionId) return

    const MAX_WAIT_MS = 30_000
    const WAIT_STEP_MS = 300
    const started = Date.now()
    while (Date.now() - started < MAX_WAIT_MS) {
      if (!isUploadingRef.current && uploadQueueRef.current.length === 0) {
        break
      }
      await sleep(WAIT_STEP_MS)
    }

    const response = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/finalize`, {
      method: "POST",
    }).catch(() => null)
    if (!response?.ok) return
    const payload = (await response.json()) as FinalizeTranscriptResponse
    const segments = payload.segments ?? []
    const processedChunkSequences = payload.processedChunkSequences ?? []

    const finalized = segments
      .map((segment): TranscriptSegment | null => {
        if (!segment.text) return null
        return {
          speaker: segment.speaker ?? "user0",
          speakerTag: segment.speakerTag ?? "speaker_unknown",
          startMs: Number(segment.startMs ?? 0),
          endMs: Number(segment.endMs ?? 0),
          text: segment.text,
          confidence: Number(segment.confidence ?? 0),
          sequenceNo: Number(segment.sequenceNo ?? 0),
        }
      })
      .filter((segment): segment is TranscriptSegment => segment !== null)

    if (finalized.length > 0) {
      setTranscript(finalized)
    }

    if (processedChunkSequences.length > 0) {
      for (const sequence of processedChunkSequences) {
        if (uploadedPendingProcessRef.current.has(sequence)) {
          await deleteChunkFromOpfs(sequence)
          uploadedPendingProcessRef.current.delete(sequence)
        }
      }
    } else {
      uploadedPendingProcessRef.current.clear()
    }
  }, [deleteChunkFromOpfs, sleep])

  const stop = useCallback(() => {
    flushChunk()

    processorRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    if (audioCtxRef.current?.state !== "closed") {
      audioCtxRef.current?.close()
    }
    if (timerRef.current) clearInterval(timerRef.current)

    processorRef.current = null
    audioCtxRef.current = null
    streamRef.current = null
    setStream(null)
    setStatus("idle")
    void finalizeSessionTranscript()
  }, [finalizeSessionTranscript, flushChunk])

  const pause = useCallback(() => {
    if (statusRef.current !== "recording") return
    pausedElapsedRef.current += (Date.now() - startTimeRef.current) / 1000
    setStatus("paused")
  }, [])

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") return
    startTimeRef.current = Date.now()
    setStatus("recording")
  }, [])

  const clearChunks = useCallback(() => {
    for (const c of chunks) URL.revokeObjectURL(c.url)
    setChunks([])
  }, [chunks])

  // cleanup on unmount
  useEffect(() => {
    return () => {
      processorRef.current?.disconnect()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (audioCtxRef.current?.state !== "closed") {
        audioCtxRef.current?.close()
      }
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      void pollProcessedChunks()
    }, 1500)
    return () => clearInterval(interval)
  }, [pollProcessedChunks])

  return { status, start, stop, pause, resume, chunks, transcript, elapsed, stream, clearChunks }
}
