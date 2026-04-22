import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SQL = `
CREATE TABLE IF NOT EXISTS recording_sessions (
  id text PRIMARY KEY,
  started_at_ms bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audio_chunks (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  chunk_id text NOT NULL,
  sequence_no integer NOT NULL,
  started_at_ms bigint NOT NULL,
  ended_at_ms bigint NOT NULL,
  sha256 text NOT NULL,
  s3_key text NOT NULL,
  status text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS audio_chunks_session_chunk_id_uq
  ON audio_chunks(session_id, chunk_id);
CREATE UNIQUE INDEX IF NOT EXISTS audio_chunks_session_sequence_uq
  ON audio_chunks(session_id, sequence_no);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  sequence_no integer NOT NULL,
  speaker_tag text NOT NULL,
  display_speaker text NOT NULL,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  text text NOT NULL,
  confidence double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcript_segments_session_seq_idx
  ON transcript_segments(session_id, sequence_no);
`;

const run = async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  dotenv.config({
    path: resolve(__dirname, "../../../apps/server/.env"),
  });

  // The shared server env schema validates these at import time.
  process.env.CORS_ORIGIN ??= "http://localhost:3000";
  process.env.S3_REGION ??= "us-east-1";
  process.env.S3_BUCKET_NAME ??= "local-dev-bucket";
  process.env.S3_ACCESS_KEY_ID ??= "local-dev-key";
  process.env.S3_SECRET_ACCESS_KEY ??= "local-dev-secret";
  process.env.REDIS_URL ??= "redis://localhost:6379";

  const { initDb } = await import("./index");
  const ds = await initDb();
  await ds.query(SQL);
  await ds.destroy();
};

run().catch((error: unknown) => {
  console.error("Migration failed", error);
  process.exit(1);
});
