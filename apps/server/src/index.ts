import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AudioChunkEntity,
  TranscriptSegmentEntity,
  appDataSource,
  initDb,
  RecordingSessionEntity,
} from "@my-better-t-app/db";
import { env } from "@my-better-t-app/env/server";
import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { ManagedDiarizationAdapter } from "./diarization";
import { getMissingSequences } from "./reconcile";
import { checkRateLimit } from "./rate-limit";

const app = express();
const upload = multer();
const diarizationProvider = new ManagedDiarizationAdapter();
const s3Client = new S3Client({
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

const readS3ObjectBytes = async (key: string) => {
  const object = await s3Client.send(
    new GetObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
    })
  );
  if (!object.Body) {
    throw new Error("s3_object_body_missing");
  }
  return new Uint8Array(await object.Body.transformToByteArray());
};

const mergeWavChunks = (chunks: Uint8Array[]) => {
  if (chunks.length === 0) {
    throw new Error("no_wav_chunks_to_merge");
  }
  if (chunks.length === 1) return chunks[0]!;

  const pcmParts = chunks.map((chunk) => chunk.slice(44));
  const pcmLength = pcmParts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(44 + pcmLength);
  const view = new DataView(merged.buffer);

  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      merged[offset + i] = value.charCodeAt(i);
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcmLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 16000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcmLength, true);

  let offset = 44;
  for (const part of pcmParts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
};

app.use(express.json());
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

const getDisplaySpeaker = async (sessionId: string, speakerTag: string) => {
  const result = await appDataSource.query(
    `
      SELECT DISTINCT speaker_tag, display_speaker
      FROM transcript_segments
      WHERE session_id = $1
      ORDER BY display_speaker ASC
    `,
    [sessionId]
  );

  const knownSpeakers = new Map<string, string>();
  for (const row of result as Array<{ speaker_tag: string; display_speaker: string }>) {
    knownSpeakers.set(row.speaker_tag, row.display_speaker);
  }

  const existing = knownSpeakers.get(speakerTag);
  if (existing) return existing;

  return `user${knownSpeakers.size + 1}`;
};

app.get("/", (_req: Request, res: Response) => {
  res.send("OK");
});

app.post("/api/sessions/start", async (req: Request, res: Response) => {
  await initDb();
  const body = req.body as { sessionId?: string; startedAtMs?: number };
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.length > 0
      ? body.sessionId
      : crypto.randomUUID();
  const startedAtMs = typeof body.startedAtMs === "number" ? body.startedAtMs : Date.now();

  const sessionRepo = appDataSource.getRepository(RecordingSessionEntity);
  await sessionRepo.upsert(
    {
      id: sessionId,
      startedAtMs,
      createdAt: new Date(),
    },
    ["id"]
  );

  res.json({ sessionId, startedAtMs });
});

app.post(
  "/api/chunks/upload",
  upload.single("audio"),
  async (req: Request, res: Response) => {
    await initDb();

    const ip = (req.headers["x-forwarded-for"] as string | undefined) ?? req.ip ?? "unknown";
    const rateLimit = await checkRateLimit(ip);
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSec));
      return res.status(429).json({ error: "rate_limited" });
    }

    const sessionId = String(req.body.sessionId ?? "");
    const chunkId = String(req.body.chunkId ?? "");
    const sequenceNo = Number(req.body.sequenceNo);
    const startedAtMs = Number(req.body.startedAtMs);
    const endedAtMs = Number(req.body.endedAtMs);
    const sha256 = String(req.body.sha256 ?? "");
    const audio = req.file;

    if (
      !sessionId ||
      !chunkId ||
      Number.isNaN(sequenceNo) ||
      Number.isNaN(startedAtMs) ||
      Number.isNaN(endedAtMs) ||
      !sha256 ||
      !audio
    ) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    const chunkRepo = appDataSource.getRepository(AudioChunkEntity);
    const existing = await chunkRepo.findOne({
      where: { sessionId, chunkId },
    });
    if (existing) {
      return res.json({
        ackId: existing.id,
        status: existing.status,
        nextExpectedSequence: existing.sequenceNo + 1,
        s3Key: existing.s3Key,
        duplicate: true,
      });
    }

    const s3Key = `sessions/${sessionId}/${sequenceNo}.wav`;
    const audioBytes = new Uint8Array(audio.buffer);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET_NAME,
        Key: s3Key,
        Body: audioBytes,
        ContentType: "audio/wav",
      })
    );

    const ackId = crypto.randomUUID();
    await chunkRepo.insert({
      id: ackId,
      sessionId,
      chunkId,
      sequenceNo,
      startedAtMs,
      endedAtMs,
      sha256,
      s3Key,
      status: "stored",
      receivedAt: new Date(),
      updatedAt: new Date(),
    });

    // Keep chunk ingestion purely durable. Speaker diarization/transcription
    // is performed once in /api/sessions/:sessionId/finalize for full-context quality.
    const finalStatus = "stored";
    await chunkRepo.update({ id: ackId }, { status: finalStatus });

    return res.json({
      ackId,
      status: finalStatus,
      nextExpectedSequence: sequenceNo + 1,
      s3Key,
    });
  }
);

app.get("/api/sessions/:sessionId/transcript", async (req: Request, res: Response) => {
  await initDb();
  const { sessionId } = req.params;
  const repo = appDataSource.getRepository(TranscriptSegmentEntity);
  const segments = await repo.find({
    where: { sessionId },
    order: { sequenceNo: "ASC" },
  });
  res.json({
    sessionId,
    segments: segments.map((segment) => ({
      speaker: segment.displaySpeaker,
      speakerTag: segment.speakerTag,
      startMs: Number(segment.startMs),
      endMs: Number(segment.endMs),
      text: segment.text,
      confidence: segment.confidence,
      sequenceNo: segment.sequenceNo,
    })),
  });
});

app.get("/api/sessions/:sessionId/transcript/stream", async (req: Request, res: Response) => {
  await initDb();
  const { sessionId } = req.params;
  const sinceSequence = Number(req.query.sinceSequence ?? "-1");

  const query = Number.isNaN(sinceSequence)
    ? `SELECT * FROM transcript_segments WHERE session_id = $1 ORDER BY sequence_no ASC, start_ms ASC`
    : `SELECT * FROM transcript_segments WHERE session_id = $1 AND sequence_no > $2 ORDER BY sequence_no ASC, start_ms ASC`;

  const rows = Number.isNaN(sinceSequence)
    ? await appDataSource.query(query, [sessionId])
    : await appDataSource.query(query, [sessionId, sinceSequence]);

  res.json({
    sessionId,
    segments: rows,
  });
});

app.post("/api/sessions/:sessionId/finalize", async (req: Request, res: Response) => {
  await initDb();
  const { sessionId: rawSessionId } = req.params;
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : "";
  if (!sessionId) {
    return res.status(400).json({ error: "invalid_session_id" });
  }
  const chunkRepo = appDataSource.getRepository(AudioChunkEntity);
  const transcriptRepo = appDataSource.getRepository(TranscriptSegmentEntity);
  const chunks = await chunkRepo.find({
    where: { sessionId },
    order: { sequenceNo: "ASC" },
  });

  if (chunks.length === 0) {
    return res.status(404).json({ error: "no_chunks_for_session" });
  }

  try {
    const firstChunk = chunks[0];
    const lastChunk = chunks[chunks.length - 1];
    if (!firstChunk || !lastChunk) {
      return res.status(404).json({ error: "no_chunks_for_session" });
    }

    const chunkBytes = await Promise.all(chunks.map((chunk) => readS3ObjectBytes(chunk.s3Key)));
    const mergedWav = mergeWavChunks(chunkBytes);
    const sessionDiarization = await diarizationProvider.transcribeSession({
      sessionId,
      audioBytes: mergedWav,
      startedAtMs: Number(firstChunk.startedAtMs),
      endedAtMs: Number(lastChunk.endedAtMs),
    });

    await transcriptRepo.delete({ sessionId });
    let idx = 0;
    for (const segment of sessionDiarization) {
      const displaySpeaker = await getDisplaySpeaker(sessionId, segment.speakerTag);
      await transcriptRepo.insert({
        id: crypto.randomUUID(),
        sessionId,
        sequenceNo: idx,
        speakerTag: segment.speakerTag,
        displaySpeaker,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        confidence: segment.confidence,
        createdAt: new Date(),
      });
      idx += 1;
    }

    const segments = await transcriptRepo.find({
      where: { sessionId },
      order: { sequenceNo: "ASC" },
    });

    return res.json({
      sessionId,
      processedChunkSequences: chunks.map((chunk) => chunk.sequenceNo),
      segments: segments.map((segment) => ({
        speaker: segment.displaySpeaker,
        speakerTag: segment.speakerTag,
        startMs: Number(segment.startMs),
        endMs: Number(segment.endMs),
        text: segment.text,
        confidence: segment.confidence,
        sequenceNo: segment.sequenceNo,
      })),
    });
  } catch (error) {
    console.error("Session finalize failed", {
      sessionId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return res.status(502).json({ error: "session_finalize_failed" });
  }
});

app.post("/api/chunks/reconcile", async (req: Request, res: Response) => {
  await initDb();
  const body = req.body as { sessionId?: string; expectedThroughSequence?: number };
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const expectedThroughSequence = Number(body.expectedThroughSequence);

  if (!sessionId || Number.isNaN(expectedThroughSequence) || expectedThroughSequence < 0) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const repo = appDataSource.getRepository(AudioChunkEntity);
  const chunks = await repo.find({
    where: { sessionId },
    order: { sequenceNo: "ASC" },
  });
  const missing = getMissingSequences(
    expectedThroughSequence,
    chunks.map((chunk) => chunk.sequenceNo)
  );

  return res.json({
    sessionId,
    expectedThroughSequence,
    ackedCount: chunks.length,
    missingSequences: missing,
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
