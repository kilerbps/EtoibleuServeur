/**
 * elevenLabsClient.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Gestion de la connexion WebSocket vers l'API Conversational AI d'ElevenLabs.
 *
 * Responsabilités :
 *  - Ouvrir une connexion WebSocket sécurisée (wss://).
 *  - Envoyer les chunks audio PCMU de l'appelant (encodés en Base64).
 *  - Recevoir et décoder les chunks audio de la réponse IA.
 *  - Gérer le protocole ElevenLabs (ping/pong, fin de conversation).
 *  - Émettre des événements typés vers le module appelant.
 *
 * Contrainte : NON BLOQUANT — toutes les opérations sont asynchrones.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import type {
  AppConfig,
  ElevenLabsAudioEvent,
  ElevenLabsConversationConfig,
  ElevenLabsConversationInitiationEvent,
  ElevenLabsEvent,
  ElevenLabsInboundMessage,
  ElevenLabsPingEvent,
  ElevenLabsPongMessage,
  ElevenLabsTranscriptionEvent,
  ElevenLabsAgentResponseEvent,
} from './types';

const logger = createLogger('ElevenLabs');

// URL WebSocket de l'API ElevenLabs Conversational AI
const WS_BASE_URL = 'wss://api.elevenlabs.io/v1/convai/conversation';

// Taille maximale de la file d'attente audio (en chunks) avant de commencer à dropper
const MAX_QUEUE_SIZE = 200;

// ─── Types d'événements ──────────────────────────────────────────────────────

export interface ElevenLabsClientEvents {
  /** Audio brut PCMU reçu de l'IA (prêt à encapsuler en RTP) */
  audioChunk: (pcmuBuffer: Buffer) => void;
  /** Transcription de l'appelant reçue */
  userTranscript: (text: string) => void;
  /** Réponse textuelle de l'agent */
  agentResponse: (text: string) => void;
  /** Connexion WebSocket établie */
  connected: () => void;
  /** Connexion WebSocket fermée */
  disconnected: (code: number, reason: string) => void;
  /** Erreur WebSocket */
  error: (err: Error) => void;
}

export declare interface ElevenLabsClient {
  on<K extends keyof ElevenLabsClientEvents>(event: K, listener: ElevenLabsClientEvents[K]): this;
  emit<K extends keyof ElevenLabsClientEvents>(event: K, ...args: Parameters<ElevenLabsClientEvents[K]>): boolean;
}

// ─── Classe principale ────────────────────────────────────────────────────────

export class ElevenLabsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly config: AppConfig;
  private readonly callId: string;
  private isConnected: boolean = false;
  private firstPacketReceived = false;

  /**
   * File d'attente circulaire pour les chunks audio entrants.
   * Si le WebSocket n'est pas encore prêt, on met en file
   * pour ne pas perdre les premières milliseconde de parole.
   */
  private audioQueue: Buffer[] = [];

  constructor(config: AppConfig, callId: string) {
    super();
    this.config = config;
    this.callId = callId;
  }

  // ─── Connexion ──────────────────────────────────────────────────────────────

  /** Ouvre la connexion WebSocket et envoie la configuration initiale. */
  async connect(): Promise<void> {
    const url = `${WS_BASE_URL}?agent_id=${encodeURIComponent(this.config.elevenLabsAgentId)}`;

    logger.info('[%s] Connexion WebSocket → %s', this.callId, url);

    this.ws = new WebSocket(url, {
      headers: {
        'xi-api-key': this.config.elevenLabsApiKey,
      },
    });

    this.ws.on('open', () => this.handleOpen());
    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('close', (code, reason) => this.handleClose(code, reason.toString()));
    this.ws.on('error', (err) => this.handleError(err));
  }

  // ─── Handlers WebSocket ─────────────────────────────────────────────────────

  private handleOpen(): void {
    logger.info('[%s] WebSocket ElevenLabs ouvert.', this.callId);
    this.isConnected = true;

    // Envoyer la configuration de conversation
    const initMsg: ElevenLabsConversationConfig = {
      type: 'conversation_initiation_client_data',
    };

    this.sendJson(initMsg);
    logger.debug('[%s] Configuration de conversation envoyée.', this.callId);

    // Vider la file d'attente audio accumulée avant la connexion
    this.flushAudioQueue();

    this.emit('connected');
  }

  private handleMessage(data: WebSocket.RawData): void {
    let event: ElevenLabsEvent;

    try {
      event = JSON.parse(data.toString()) as ElevenLabsEvent;
    } catch (err) {
      logger.warn('[%s] Message WebSocket non-JSON reçu, ignoré.', this.callId);
      return;
    }

    logger.debug('[%s] Événement reçu : type=%s', this.callId, event.type);

    switch (event.type) {
      case 'conversation_initiation_metadata':
        this.handleConversationInit(event as ElevenLabsConversationInitiationEvent);
        break;

      case 'audio':
        this.handleAudioEvent(event as ElevenLabsAudioEvent);
        break;

      case 'ping':
        this.handlePing(event as ElevenLabsPingEvent);
        break;

      case 'user_transcript':
        this.handleUserTranscript(event as ElevenLabsTranscriptionEvent);
        break;

      case 'agent_response':
        this.handleAgentResponse(event as ElevenLabsAgentResponseEvent);
        break;

      case 'interruption':
        logger.info('[%s] Interruption reçue de l\'IA.', this.callId);
        break;

      case 'internal_tentative_agent_response':
        // Réponse intermédiaire, ignorée pour la voix
        break;

      default:
        logger.debug('[%s] Événement inconnu ignoré : %s', this.callId, event.type);
    }
  }

  private handleConversationInit(event: ElevenLabsConversationInitiationEvent): void {
    const meta = event.conversation_initiation_metadata_event;
    logger.info(
      '[%s] Conversation ElevenLabs initiée. ID=%s, format=%s',
      this.callId,
      meta.conversation_id,
      meta.agent_output_audio_format,
    );
  }

  private handleAudioEvent(event: ElevenLabsAudioEvent): void {
    const base64Chunk = event.audio?.chunk;
    if (!base64Chunk) {
      logger.warn('[%s] Événement audio sans données.', this.callId);
      return;
    }

    if (!this.firstPacketReceived) {
      this.firstPacketReceived = true;
      console.log(`\n======================================================`);
      console.log(`[CRASH TEST] 🤖 PREMIER PAQUET AUDIO REÇU D'ELEVENLABS !`);
      console.log(`======================================================\n`);
    }

    // Décoder le Base64 directement en Buffer (pas de conversion intermédiaire)
    const pcmuBuffer = Buffer.from(base64Chunk, 'base64');
    logger.debug('[%s] Audio IA reçu : %d octets PCMU', this.callId, pcmuBuffer.length);

    this.emit('audioChunk', pcmuBuffer);
  }

  private handlePing(event: ElevenLabsPingEvent): void {
    // Le protocole ElevenLabs exige un pong immédiat pour maintenir la session
    const pong: ElevenLabsPongMessage = {
      type: 'pong',
      event_id: event.ping_event.event_id,
    };
    this.sendJson(pong);
    logger.debug('[%s] Pong envoyé (event_id=%d).', this.callId, event.ping_event.event_id);
  }

  private handleUserTranscript(event: ElevenLabsTranscriptionEvent): void {
    const text = event.user_transcription_event?.user_transcript ?? '';
    logger.info('[%s] Transcription appelant : "%s"', this.callId, text);
    this.emit('userTranscript', text);
  }

  private handleAgentResponse(event: ElevenLabsAgentResponseEvent): void {
    const text = event.agent_response_event?.agent_response ?? '';
    logger.info('[%s] Réponse agent : "%s"', this.callId, text);
    this.emit('agentResponse', text);
  }

  private handleClose(code: number, reason: string): void {
    logger.info('[%s] WebSocket ElevenLabs fermé (code=%d, raison=%s).', this.callId, code, reason || 'N/A');
    this.isConnected = false;
    this.ws = null;
    this.emit('disconnected', code, reason);
  }

  private handleError(err: Error): void {
    logger.error('[%s] Erreur WebSocket ElevenLabs : %s', this.callId, err.message);
    this.emit('error', err);
  }

  // ─── Envoi audio ─────────────────────────────────────────────────────────────

  /**
   * Envoie un chunk audio PCMU de l'appelant vers l'IA.
   * Si la connexion n'est pas encore établie, le chunk est mis en file d'attente.
   * @param pcmuBuffer Buffer audio brut G.711 μ-law 8kHz
   */
  sendAudioChunk(pcmuBuffer: Buffer): void {
    if (!this.isConnected || !this.ws) {
      // Mettre en file d'attente, mais avec limite pour éviter un débordement mémoire
      if (this.audioQueue.length < MAX_QUEUE_SIZE) {
        this.audioQueue.push(pcmuBuffer);
        logger.debug('[%s] Audio en file d\'attente (%d)', this.callId, this.audioQueue.length);
      } else {
        logger.warn('[%s] File audio pleine, chunk ignoré.', this.callId);
      }
      return;
    }

    this.sendAudioImmediate(pcmuBuffer);
  }

  private sendAudioImmediate(pcmuBuffer: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg: ElevenLabsInboundMessage = {
      user_audio_chunk: pcmuBuffer.toString('base64'),
    };
    this.sendJson(msg);
  }

  /** Vide la file d'attente audio vers le WebSocket maintenant ouvert */
  private flushAudioQueue(): void {
    if (this.audioQueue.length === 0) return;
    logger.info('[%s] Envoi de %d chunks audio en attente.', this.callId, this.audioQueue.length);

    for (const chunk of this.audioQueue) {
      this.sendAudioImmediate(chunk);
    }
    this.audioQueue = [];
  }

  // ─── Utilitaires ─────────────────────────────────────────────────────────────

  private sendJson(payload: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('[%s] Tentative d\'envoi JSON alors que le WebSocket est fermé.', this.callId);
      return;
    }
    this.ws.send(JSON.stringify(payload), (err) => {
      if (err) {
        logger.error('[%s] Erreur d\'envoi WebSocket : %s', this.callId, err.message);
      }
    });
  }

  /** Ferme proprement la connexion WebSocket */
  disconnect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.info('[%s] Fermeture WebSocket ElevenLabs.', this.callId);
      this.ws.close(1000, 'Appel terminé');
    }
    this.isConnected = false;
    this.audioQueue  = [];
  }
}
