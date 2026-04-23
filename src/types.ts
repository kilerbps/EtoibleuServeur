/**
 * types.ts
 * Interfaces et types TypeScript partagés dans tout le projet.
 */

// ─── Configuration ─────────────────────────────────────────────────────────

export interface AppConfig {
  serverIp: string;
  sipPort: number;
  rtpPortMin: number;
  rtpPortMax: number;
  elevenLabsApiKey: string;
  elevenLabsAgentId: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ─── SIP ───────────────────────────────────────────────────────────────────

/** Représente un contact SDP analysé pour la piste audio */
export interface SdpMediaInfo {
  /** IP distante (c= line) */
  remoteIp: string;
  /** Port RTP distant (m= line) */
  remoteRtpPort: number;
  /** Payload type négocié (0 = PCMU) */
  payloadType: number;
  /** Codec (ex: PCMU) */
  codec: string;
  /** Fréquence d'échantillonnage (ex: 8000) */
  clockRate: number;
}

/** Représente un appel SIP en cours */
export interface ActiveCall {
  /** Identifiant unique de l'appel (Call-ID SIP) */
  callId: string;
  /** Tag de la branche From */
  fromTag: string;
  /** Tag de la branche To (généré par nous) */
  toTag: string;
  /** Informations SDP de l'appelant */
  remoteSdp: SdpMediaInfo;
  /** Port RTP local alloué dynamiquement */
  localRtpPort: number;
  /** Adresse IP de l'appelant (pour renvoyer le RTP) */
  remoteAddress: string;
  /** Port RTP de l'appelant */
  remotePort: number;
  /** Timestamp de début d'appel */
  startedAt: Date;
}

// ─── RTP ───────────────────────────────────────────────────────────────────

/** Header RTP décodé (RFC 3550) */
export interface RtpHeader {
  version: number;        // 2 bits — toujours 2
  padding: boolean;       // 1 bit
  extension: boolean;     // 1 bit
  csrcCount: number;      // 4 bits
  marker: boolean;        // 1 bit
  payloadType: number;    // 7 bits — 0 = PCMU
  sequenceNumber: number; // 16 bits
  timestamp: number;      // 32 bits
  ssrc: number;           // 32 bits — identifiant de source
}

/** Paquet RTP complet décodé */
export interface RtpPacket {
  header: RtpHeader;
  payload: Buffer; // Audio brut PCMU
}

/** État interne du générateur de paquets RTP sortants */
export interface RtpSenderState {
  ssrc: number;
  sequenceNumber: number;
  timestamp: number;
  /** Incrément de timestamp par paquet (160 = 20ms à 8000Hz) */
  timestampIncrement: number;
}

// ─── ElevenLabs WebSocket ──────────────────────────────────────────────────

/** Message envoyé vers l'API ElevenLabs (audio entrant) */
export interface ElevenLabsInboundMessage {
  user_audio_chunk: string; // Base64 PCMU 8kHz
}

/** Message de configuration initial envoyé à l'ouverture du WebSocket */
export interface ElevenLabsConversationConfig {
  type: 'conversation_initiation_client_data';
  conversation_config_override?: {
    agent?: {
      prompt?: { prompt: string };
      first_message?: string;
      language?: string;
    };
    tts?: {
      voice_id?: string;
    };
  };
  custom_llm_extra_body?: Record<string, unknown>;
}

/** Événement générique reçu de l'API ElevenLabs */
export interface ElevenLabsEvent {
  type: string;
}

/** Audio reçu depuis ElevenLabs (réponse de l'IA) */
export interface ElevenLabsAudioEvent extends ElevenLabsEvent {
  type: 'audio';
  audio: {
    chunk: string; // Base64 PCMU 8kHz
    event_id?: number;
  };
}

/** Transcription partielle ou finale depuis ElevenLabs */
export interface ElevenLabsTranscriptionEvent extends ElevenLabsEvent {
  type: 'user_transcript';
  user_transcription_event: {
    user_transcript: string;
  };
}

/** Réponse agent textuelle depuis ElevenLabs */
export interface ElevenLabsAgentResponseEvent extends ElevenLabsEvent {
  type: 'agent_response';
  agent_response_event: {
    agent_response: string;
  };
}

/** Événement de fin de conversation */
export interface ElevenLabsPingEvent extends ElevenLabsEvent {
  type: 'ping';
  ping_event: {
    event_id: number;
  };
}

/** Réponse de pong que nous devons renvoyer */
export interface ElevenLabsPongMessage {
  type: 'pong';
  event_id: number;
}

/** Données d'initiation de conversation retournées par ElevenLabs */
export interface ElevenLabsConversationInitiationEvent extends ElevenLabsEvent {
  type: 'conversation_initiation_metadata';
  conversation_initiation_metadata_event: {
    conversation_id: string;
    agent_output_audio_format: string;
  };
}
