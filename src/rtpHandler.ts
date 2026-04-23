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

export class RtpHandler extends EventEmitter {
  private readonly socket: dgram.Socket;
  private readonly senderState: RtpSenderState;
  private remoteAddress: string | null = null;
  private remotePort: number | null = null;
  public readonly localPort: number;
  public readonly serverIp: string;
  private firstPacketReceived = false;

  constructor(localPort: number, serverIp: string) {
    super();
    this.localPort    = localPort;
    this.serverIp     = serverIp;
    this.senderState  = createRtpSenderState();
    this.socket       = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      logger.error('Erreur socket UDP [port %d] : %s', this.localPort, err.message);
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      logger.info('Socket UDP [port %d] fermé.', this.localPort);
      this.emit('close');
    });

    this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      // Mémoriser l'adresse distante dès le premier paquet reçu
      if (!this.remoteAddress) {
        this.remoteAddress = rinfo.address;
        this.remotePort    = rinfo.port;
        logger.info('RTP distant détecté : %s:%d', this.remoteAddress, this.remotePort);
      }
      
      if (!this.firstPacketReceived) {
        this.firstPacketReceived = true;
        console.log(`\n======================================================`);
        console.log(`[CRASH TEST] 🎤 PREMIER PAQUET AUDIO (RTP) REÇU DE L'UTILISATEUR !`);
        console.log(`    -> Depuis : ${rinfo.address}:${rinfo.port}`);
        console.log(`======================================================\n`);
      }

      const payload = extractRtpPayload(msg);
      if (!payload) return;

      logger.debug('RTP reçu — seq=%d, payload=%d octets', msg.readUInt16BE(2), payload.length);
      this.emit('pcmuChunk', payload);
    });
  }

  /** Démarre l'écoute UDP sur le port local */
  async bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.bind(this.localPort, this.serverIp, () => {
        logger.info('Socket RTP lié sur le port UDP %d (IP: %s)', this.localPort, this.serverIp);
        resolve();
      });
      this.socket.once('error', reject);
    });
  }

  /**
   * Configure l'adresse distante (depuis le SDP de l'INVITE).
   * Permet d'envoyer du RTP même avant le premier paquet reçu.
   */
  setRemote(address: string, port: number): void {
    this.remoteAddress = address;
    this.remotePort    = port;
    logger.info('RTP distant configuré manuellement : %s:%d', address, port);
  }

  /**
   * Envoie un chunk PCMU encapsulé dans un paquet RTP vers l'appelant.
   * @param pcmuPayload Buffer audio brut (PCMU 8kHz)
   */
  sendPcmu(pcmuPayload: Buffer): void {
    if (!this.remoteAddress || !this.remotePort) {
      logger.warn('sendPcmu ignoré — adresse distante inconnue.');
      return;
    }

    const packet = buildRtpPacket(pcmuPayload, this.senderState);
    this.socket.send(packet, 0, packet.length, this.remotePort, this.remoteAddress, (err) => {
      if (err) {
        logger.error('Erreur d\'envoi RTP vers %s:%d — %s', this.remoteAddress, this.remotePort, err.message);
      }
    });
  }

  /** Ferme le socket UDP proprement */
  close(): void {
    try {
      this.socket.close();
    } catch {
      // Déjà fermé, ignorer
    }
  }
}

// ─── Utilitaire : allocation de port libre ────────────────────────────────────

/**
 * Trouve un port UDP disponible dans la plage [min, max].
 * Teste les ports aléatoirement pour éviter les collisions entre appels.
 */
export async function allocateRtpPort(min: number, max: number, serverIp: string): Promise<number> {
  const range = max - min;
  const maxAttempts = 50;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = min + Math.floor(Math.random() * range);
    const available = await isPortAvailable(port, serverIp);
    if (available) {
      logger.debug('Port RTP alloué : %d', port);
      return port;
    }
  }

  throw new Error(`Impossible d'allouer un port RTP dans la plage [${min}, ${max}] après ${maxAttempts} tentatives.`);
}

function isPortAvailable(port: number, serverIp: string): Promise<boolean> {
  return new Promise((resolve) => {
    const testSocket = dgram.createSocket('udp4');
    testSocket.once('error', () => resolve(false));
    testSocket.bind(port, serverIp, () => {
      testSocket.close(() => resolve(true));
    });
  });
}
