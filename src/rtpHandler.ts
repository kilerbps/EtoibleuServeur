/**
 * rtpHandler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Gestion du flux RTP UDP bidirectionnel.
 *
 * Responsabilités :
 *  - Allouer un port UDP dynamique dans la plage configurée.
 *  - Parser les paquets RTP entrants (RFC 3550) et extraire le payload PCMU.
 *  - Construire les paquets RTP sortants (réponse de l'IA) avec seq/ts corrects.
 *  - Émettre les événements vers les abonnés (pattern EventEmitter).
 *
 * Contrainte de performance : TOUT en mémoire (Buffer), ZÉRO écriture disque.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import type { RtpHeader, RtpPacket, RtpSenderState } from './types';

const logger = createLogger('RTP');

// Taille fixe de l'en-tête RTP minimal (sans CSRC ni extension)
const RTP_HEADER_MIN_BYTES = 12;
// 20 ms à 8 000 Hz = 160 échantillons PCMU par paquet
const TIMESTAMP_INCREMENT = 160;
// Payload Type G.711 μ-law
const PCMU_PAYLOAD_TYPE = 0;

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Analyse les 12 premiers octets d'un paquet RTP.
 * Retourne null si le buffer est trop court ou si la version ≠ 2.
 */
export function parseRtpHeader(buf: Buffer): RtpHeader | null {
  if (buf.length < RTP_HEADER_MIN_BYTES) {
    logger.warn('Paquet RTP trop court (%d octets), ignoré.', buf.length);
    return null;
  }

  const byte0 = buf[0]!;
  const byte1 = buf[1]!;

  const version   = (byte0 >> 6) & 0x03;
  if (version !== 2) {
    logger.warn('Version RTP invalide : %d', version);
    return null;
  }

  const padding   = Boolean((byte0 >> 5) & 0x01);
  const extension = Boolean((byte0 >> 4) & 0x01);
  const csrcCount = byte0 & 0x0f;
  const marker    = Boolean((byte1 >> 7) & 0x01);
  const payloadType = byte1 & 0x7f;

  const sequenceNumber = buf.readUInt16BE(2);
  const timestamp      = buf.readUInt32BE(4);
  const ssrc           = buf.readUInt32BE(8);

  return { version, padding, extension, csrcCount, marker, payloadType, sequenceNumber, timestamp, ssrc };
}

/**
 * Extrait le payload brut PCMU d'un paquet RTP.
 * Prend en compte les CSRC optionnels et l'extension de header.
 */
export function extractRtpPayload(buf: Buffer): Buffer | null {
  const header = parseRtpHeader(buf);
  if (!header) return null;

  // Offset de base après le header fixe (12 octets)
  let offset = RTP_HEADER_MIN_BYTES;

  // Sauter les CSRC (chacun 4 octets)
  offset += header.csrcCount * 4;

  // Sauter l'extension si présente
  if (header.extension) {
    if (buf.length < offset + 4) {
      logger.warn('Buffer trop court pour lire l\'extension RTP.');
      return null;
    }
    // Les 2 octets suivants = longueur de l'extension en mots de 32 bits
    const extLength = buf.readUInt16BE(offset + 2);
    offset += 4 + extLength * 4;
  }

  if (offset >= buf.length) {
    logger.warn('Paquet RTP sans payload après l\'en-tête.');
    return null;
  }

  return buf.subarray(offset); // Vue mémoire directe — pas de copie
}

// ─── Construction de paquets sortants ────────────────────────────────────────

/**
 * Construit un paquet RTP sortant à partir d'un payload PCMU.
 * Mutate l'état `state` (seq++, ts+=160).
 */
export function buildRtpPacket(payload: Buffer, state: RtpSenderState): Buffer {
  const headerBuf = Buffer.allocUnsafe(RTP_HEADER_MIN_BYTES);

  // Byte 0 : V=2, P=0, X=0, CC=0
  headerBuf[0] = 0x80;
  // Byte 1 : M=0, PT=0 (PCMU)
  headerBuf[1] = PCMU_PAYLOAD_TYPE & 0x7f;

  headerBuf.writeUInt16BE(state.sequenceNumber, 2);
  headerBuf.writeUInt32BE(state.timestamp >>> 0, 4);  // force unsigned
  headerBuf.writeUInt32BE(state.ssrc >>> 0, 8);

  // Incrémenter l'état pour le prochain paquet
  state.sequenceNumber = (state.sequenceNumber + 1) & 0xffff;
  state.timestamp = (state.timestamp + state.timestampIncrement) >>> 0;

  return Buffer.concat([headerBuf, payload]);
}

/**
 * Crée un état initial pour l'émetteur RTP.
 * SSRC aléatoire, seq et ts initiaux aléatoires (conformément à la RFC 3550).
 */
export function createRtpSenderState(): RtpSenderState {
  return {
    ssrc:               (Math.random() * 0xffffffff) >>> 0,
    sequenceNumber:     Math.floor(Math.random() * 0xffff),
    timestamp:          Math.floor(Math.random() * 0xffffffff),
    timestampIncrement: TIMESTAMP_INCREMENT,
  };
}

// ─── Classe RtpHandler ───────────────────────────────────────────────────────

export interface RtpHandlerEvents {
  /** Déclenché à chaque paquet PCMU reçu de l'appelant */
  pcmuChunk: (payload: Buffer) => void;
  /** Déclenché au tout premier paquet RTP reçu de l'appelant */
  firstPacket: (rinfo: dgram.RemoteInfo) => void;
  /** Déclenché en cas d'erreur UDP */
  error: (err: Error) => void;
  /** Déclenché à la fermeture du socket */
  close: () => void;
}

// Typage strict des événements
export declare interface RtpHandler {
  on<K extends keyof RtpHandlerEvents>(event: K, listener: RtpHandlerEvents[K]): this;
  emit<K extends keyof RtpHandlerEvents>(event: K, ...args: Parameters<RtpHandlerEvents[K]>): boolean;
}

// Intervalle d'émission RTP : un paquet de 160 octets toutes les 20 ms (8 kHz).
const FRAME_BYTES = 160;
const PACING_INTERVAL_MS = 20;
// Limite du tampon de sortie (latence max ~2 s) pour éviter une dérive mémoire.
const MAX_BACKLOG_BYTES = FRAME_BYTES * (2000 / PACING_INTERVAL_MS); // 16 000 octets
// Nombre de tentatives d'allocation de port lors du bind.
const MAX_BIND_ATTEMPTS = 50;

export class RtpHandler extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private readonly senderState: RtpSenderState;
  private remoteAddress: string | null = null;
  private remotePort: number | null = null;
  public localPort = 0;
  public readonly serverIp: string;
  private readonly portMin: number;
  private readonly portMax: number;
  private firstPacketReceived = false;
  private latched = false;

  /** Tampon PCMU sortant, drainé à cadence fixe (20 ms) pour un flux RTP régulier. */
  private outboundBacklog: Buffer = Buffer.alloc(0);
  private paceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(serverIp: string, portMin: number, portMax: number) {
    super();
    this.serverIp    = serverIp;
    this.portMin     = portMin;
    this.portMax     = portMax;
    this.senderState = createRtpSenderState();
  }

  /** (Ré)initialise un socket UDP et attache les gestionnaires d'événements. */
  private createSocket(): dgram.Socket {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', (err) => {
      logger.error('Erreur socket UDP [port %d] : %s', this.localPort, err.message);
      this.emit('error', err);
    });

    socket.on('close', () => {
      logger.debug('Socket UDP [port %d] fermé.', this.localPort);
    });

    socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      // RTP symétrique (latching) : on répond TOUJOURS à la source réelle des
      // paquets, ce qui corrige les IP privées annoncées dans le SDP (NAT).
      if (!this.latched || this.remoteAddress !== rinfo.address || this.remotePort !== rinfo.port) {
        this.remoteAddress = rinfo.address;
        this.remotePort    = rinfo.port;
        this.latched       = true;
        logger.info('RTP distant verrouillé sur la source réelle : %s:%d', rinfo.address, rinfo.port);
      }

      if (!this.firstPacketReceived) {
        this.firstPacketReceived = true;
        logger.info('Premier paquet RTP reçu de %s:%d.', rinfo.address, rinfo.port);
        this.emit('firstPacket', rinfo);
      }

      const payload = extractRtpPayload(msg);
      if (!payload) return;

      logger.debug('RTP reçu — seq=%d, payload=%d octets', msg.readUInt16BE(2), payload.length);
      this.emit('pcmuChunk', payload);
    });

    return socket;
  }

  /**
   * Alloue et lie un port UDP libre dans la plage configurée, sans TOCTOU :
   * on tente directement le bind et on réessaie sur un autre port en cas de conflit.
   * @returns le port réellement alloué
   */
  async bind(): Promise<number> {
    const range = this.portMax - this.portMin;

    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      const candidate = this.portMin + Math.floor(Math.random() * range);
      const socket = this.createSocket();

      const bound = await new Promise<boolean>((resolve) => {
        const onError = () => {
          socket.removeListener('error', onError);
          socket.close(() => resolve(false));
        };
        socket.once('error', onError);
        socket.bind(candidate, this.serverIp, () => {
          socket.removeListener('error', onError);
          resolve(true);
        });
      });

      if (bound) {
        this.socket    = socket;
        this.localPort = candidate;
        logger.info('Socket RTP lié sur le port UDP %d (IP: %s)', candidate, this.serverIp);
        this.startPacing();
        return candidate;
      }
    }

    throw new Error(
      `Impossible d'allouer un port RTP dans la plage [${this.portMin}, ${this.portMax}] après ${MAX_BIND_ATTEMPTS} tentatives.`,
    );
  }

  /**
   * Configure l'adresse distante (depuis le SDP de l'INVITE).
   * Sert de repli pour émettre avant le premier paquet reçu ; elle sera
   * remplacée par la source réelle dès qu'un paquet arrive (RTP symétrique).
   */
  setRemote(address: string, port: number): void {
    if (this.latched) return; // Ne pas écraser une adresse déjà verrouillée
    this.remoteAddress = address;
    this.remotePort    = port;
    logger.debug('RTP distant provisoire (SDP) : %s:%d', address, port);
  }

  /**
   * Met en file de l'audio PCMU à destination de l'appelant.
   * Les données sont émises à cadence régulière (20 ms) par le pacer.
   * @param pcmuPayload Buffer audio brut (PCMU 8kHz), taille quelconque
   */
  enqueueAudio(pcmuPayload: Buffer): void {
    this.outboundBacklog = Buffer.concat([this.outboundBacklog, pcmuPayload]);

    // Borne la latence : si le tampon déborde, on abandonne les frames les plus anciennes.
    if (this.outboundBacklog.length > MAX_BACKLOG_BYTES) {
      const excess = this.outboundBacklog.length - MAX_BACKLOG_BYTES;
      this.outboundBacklog = this.outboundBacklog.subarray(excess);
      logger.warn('Tampon RTP sortant plein, %d octets abandonnés.', excess);
    }
  }

  /** Démarre le timer d'émission régulière (une frame de 160 octets / 20 ms). */
  private startPacing(): void {
    if (this.paceTimer) return;
    this.paceTimer = setInterval(() => this.drainOneFrame(), PACING_INTERVAL_MS);
  }

  /** Émet une frame de 160 octets si disponible, sinon ne fait rien. */
  private drainOneFrame(): void {
    if (this.outboundBacklog.length < FRAME_BYTES) return;
    const frame = this.outboundBacklog.subarray(0, FRAME_BYTES);
    this.outboundBacklog = this.outboundBacklog.subarray(FRAME_BYTES);
    this.sendFrame(frame);
  }

  /** Encapsule et envoie une frame PCMU dans un paquet RTP. */
  private sendFrame(pcmuPayload: Buffer): void {
    if (!this.socket || !this.remoteAddress || !this.remotePort) return;

    const packet = buildRtpPacket(pcmuPayload, this.senderState);
    this.socket.send(packet, 0, packet.length, this.remotePort, this.remoteAddress, (err) => {
      if (err) {
        logger.error('Erreur d\'envoi RTP vers %s:%d — %s', this.remoteAddress, this.remotePort, err.message);
      }
    });
  }

  /** Ferme le socket UDP et arrête le pacer proprement. */
  close(): void {
    if (this.paceTimer) {
      clearInterval(this.paceTimer);
      this.paceTimer = null;
    }
    this.outboundBacklog = Buffer.alloc(0);
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Déjà fermé, ignorer
      }
      this.socket = null;
    }
  }
}
