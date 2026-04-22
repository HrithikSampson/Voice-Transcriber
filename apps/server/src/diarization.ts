import "dotenv/config";
import { AssemblyAI } from "assemblyai";

export interface DiarizedSegment {
  speakerTag: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
}

export interface DiarizationProvider {
  transcribeChunk(input: {
    sessionId: string;
    sequenceNo: number;
    audioBytes: Uint8Array;
    startedAtMs: number;
    endedAtMs: number;
  }): Promise<DiarizedSegment[]>;
  transcribeSession(input: {
    sessionId: string;
    audioBytes: Uint8Array;
    startedAtMs: number;
    endedAtMs: number;
  }): Promise<DiarizedSegment[]>;
}

const API_KEY = process.env.ASSEMBLYAI_API_KEY ?? process.env.DIARIZATION_API_KEY;

export class ManagedDiarizationAdapter implements DiarizationProvider {
  private readonly client: AssemblyAI | null;

  constructor() {
    this.client = API_KEY
      ? new AssemblyAI({
          apiKey: API_KEY,
        })
      : null;
  }

  private async transcribeWithAssembly(input: {
    sessionId: string;
    audioBytes: Uint8Array;
    startedAtMs: number;
    endedAtMs: number;
    sequenceNo?: number;
  }): Promise<DiarizedSegment[]> {
    if (!this.client) {
      // Avoid hard-failing upload flow when key is missing.
      console.warn("Diarization skipped: DIARIZATION_API_KEY is not set");
      return [];
    }

    try {
      const transcript = await this.client.transcripts.transcribe({
        audio: Buffer.from(input.audioBytes),
        speech_models: ["universal-3-pro", "universal-2"],
        language_detection: true,
        speaker_labels: true,
      });

      if (transcript.status === "error") {
        console.warn("AssemblyAI transcript error", {
          sessionId: input.sessionId,
          sequenceNo: input.sequenceNo,
          error: transcript.error,
        });
        return [];
      }

      const utterances = transcript.utterances ?? [];
      const mappedUtterances = utterances
        .map((segment): DiarizedSegment | null => {
          if (!segment.text || segment.speaker === undefined) return null;
          const speakerTag = `speaker_${String(segment.speaker).toLowerCase()}`;
          return {
            speakerTag,
            startMs: Number(segment.start ?? input.startedAtMs),
            endMs: Number(segment.end ?? input.endedAtMs),
            text: segment.text,
            confidence: Number(segment.confidence ?? 0),
          };
        })
        .filter((segment): segment is DiarizedSegment => segment !== null);

      if (mappedUtterances.length > 0) {
        return mappedUtterances;
      }

      // Fallback for short clips where utterances are missing.
      if (transcript.text && transcript.text.trim().length > 0) {
        return [
          {
            speakerTag: "speaker_0",
            startMs: input.startedAtMs,
            endMs: input.endedAtMs,
            text: transcript.text.trim(),
            confidence: 0,
          },
        ];
      }

      return [];
    } catch (error) {
      console.warn("AssemblyAI transcribe request failed", {
        sessionId: input.sessionId,
        sequenceNo: input.sequenceNo,
        error: error instanceof Error ? error.message : "unknown_error",
      });
      return [];
    }
  }

  async transcribeChunk(input: {
    sessionId: string;
    sequenceNo: number;
    audioBytes: Uint8Array;
    startedAtMs: number;
    endedAtMs: number;
  }): Promise<DiarizedSegment[]> {
    return this.transcribeWithAssembly(input);
  }

  async transcribeSession(input: {
    sessionId: string;
    audioBytes: Uint8Array;
    startedAtMs: number;
    endedAtMs: number;
  }): Promise<DiarizedSegment[]> {
    return this.transcribeWithAssembly(input);
  }
}
