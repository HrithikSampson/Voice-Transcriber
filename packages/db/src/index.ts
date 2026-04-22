import "reflect-metadata";
import { env } from "@my-better-t-app/env/server";
import { DataSource, EntitySchema } from "typeorm";

export type ChunkStatus = "received" | "stored" | "transcribed" | "failed";

export interface RecordingSession {
  id: string;
  startedAtMs: number;
  createdAt: Date;
}

export interface AudioChunk {
  id: string;
  sessionId: string;
  chunkId: string;
  sequenceNo: number;
  startedAtMs: number;
  endedAtMs: number;
  sha256: string;
  s3Key: string;
  status: ChunkStatus;
  receivedAt: Date;
  updatedAt: Date;
}

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  sequenceNo: number;
  speakerTag: string;
  displaySpeaker: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  createdAt: Date;
}

export const RecordingSessionEntity = new EntitySchema<RecordingSession>({
  name: "recording_sessions",
  columns: {
    id: { type: String, primary: true },
    startedAtMs: { type: "bigint", name: "started_at_ms" },
    createdAt: { type: "timestamptz", createDate: true, name: "created_at" },
  },
});

export const AudioChunkEntity = new EntitySchema<AudioChunk>({
  name: "audio_chunks",
  columns: {
    id: { type: String, primary: true },
    sessionId: { type: String, name: "session_id" },
    chunkId: { type: String, name: "chunk_id" },
    sequenceNo: { type: Number, name: "sequence_no" },
    startedAtMs: { type: "bigint", name: "started_at_ms" },
    endedAtMs: { type: "bigint", name: "ended_at_ms" },
    sha256: { type: String },
    s3Key: { type: String, name: "s3_key" },
    status: { type: String },
    receivedAt: { type: "timestamptz", createDate: true, name: "received_at" },
    updatedAt: { type: "timestamptz", updateDate: true, name: "updated_at" },
  },
  indices: [
    {
      name: "audio_chunks_session_chunk_id_uq",
      columns: ["sessionId", "chunkId"],
      unique: true,
    },
    {
      name: "audio_chunks_session_sequence_uq",
      columns: ["sessionId", "sequenceNo"],
      unique: true,
    },
  ],
});

export const TranscriptSegmentEntity = new EntitySchema<TranscriptSegment>({
  name: "transcript_segments",
  columns: {
    id: { type: String, primary: true },
    sessionId: { type: String, name: "session_id" },
    sequenceNo: { type: Number, name: "sequence_no" },
    speakerTag: { type: String, name: "speaker_tag" },
    displaySpeaker: { type: String, name: "display_speaker" },
    startMs: { type: "bigint", name: "start_ms" },
    endMs: { type: "bigint", name: "end_ms" },
    text: { type: String },
    confidence: { type: Number },
    createdAt: { type: "timestamptz", createDate: true, name: "created_at" },
  },
  indices: [
    {
      name: "transcript_segments_session_seq_idx",
      columns: ["sessionId", "sequenceNo"],
    },
  ],
});

export const appDataSource = new DataSource({
  type: "postgres",
  url: env.DATABASE_URL,
  synchronize: false,
  logging: false,
  entities: [RecordingSessionEntity, AudioChunkEntity, TranscriptSegmentEntity],
});

let initialized = false;

export const initDb = async () => {
  if (!initialized) {
    await appDataSource.initialize();
    initialized = true;
  }
  return appDataSource;
};
