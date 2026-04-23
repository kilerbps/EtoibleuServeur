/**
 * sipHandler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Gestion du dialogue SIP (RFC 3261) via le port UDP 5060.
 *
 * Responsabilités :
 *  - Parser les messages SIP entrants (INVITE, ACK, BYE, CANCEL).
 *  - Répondre : 100 Trying → 200 OK (avec SDP PCMU) → ACK → BYE.
 *  - Parser le SDP de l'INVITE pour extraire IP/port/codec distant.
 *  - Construire le SDP de réponse avec notre port RTP local.
 *  - Coordonner RtpHandler + ElevenLabsClient pour chaque appel.
 *  - Gérer la terminaison propre de l'appel (BYE, CANCEL).
 *
 * IMPORTANT : La lib `sip` gère l'UDP bas niveau ; nous gérons la logique
 * de session en TypeScript pur au-dessus.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as sip from 'sip';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './logger';
import { RtpHandler, allocateRtpPort } from './rtpHandler';
import { ElevenLabsClient } from './elevenLabsClient';
import type { AppConfig, ActiveCall, SdpMediaInfo } from './types';

const logger = createLogger('SIP');

// ─── Constantes SIP/SDP ───────────────────────────────────────────────────────

const USER_AGENT = 'EtoibleuServeur/1.0 (Node.js SIP Bridge)';
const PCMU_PAYLOAD_TYPE = 0;
const CLOCK_RATE = 8000;
// Durée max d'un appel (sécurité : 30 minutes)
const MAX_CALL_DURATION_MS = 30 * 60 * 1000;

// ─── Registre des appels actifs ───────────────────────────────────────────────

/** Map<callId, ActiveCall> */
const activeCalls = new Map<string, ActiveCall>();
/** Map<callId, RtpHandler> */
const rtpHandlers = new Map<string, RtpHandler>();
/** Map<callId, ElevenLabsClient> */
const aiClients = new Map<string, ElevenLabsClient>();
/** Map<callId, NodeJS.Timeout> — timers de sécurité */
const callTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Parseur SDP ─────────────────────────────────────────────────────────────

/**
 * Analyse le corps SDP d'un INVITE.
 * Extrait : IP distante, port RTP, payload type du premier codec offert.
 *
 * Format SDP minimal attendu :
 *   v=0
 *   o=...
 *   s=...
 *   c=IN IP4 <ip>
 *   t=0 0
 *   m=audio <port> RTP/AVP 0 8 ...
 *   a=rtpmap:0 PCMU/8000
 */
export function parseSdp(sdpBody: string): SdpMediaInfo | null {
  const lines = sdpBody.split(/\r?\n/);

  let remoteIp: string | null = null;
  let remoteRtpPort: number | null = null;
  let payloadType = PCMU_PAYLOAD_TYPE;
  let codec = 'PCMU';
  let clockRate = CLOCK_RATE;

  for (const line of lines) {
    const trimmed = line.trim();

    // c=IN IP4 x.x.x.x
    if (trimmed.startsWith('c=IN IP4 ')) {
      remoteIp = trimmed.substring('c=IN IP4 '.length).trim();
    }

    // m=audio <port> RTP/AVP <payloads...>
    if (trimmed.startsWith('m=audio ')) {
      const parts = trimmed.split(' ');
      const port = parseInt(parts[1] ?? '0', 10);
      if (!isNaN(port) && port > 0) {
        remoteRtpPort = port;
        // Payload type préféré = premier de la liste
        const firstPt = parseInt(parts[3] ?? '0', 10);
        if (!isNaN(firstPt)) payloadType = firstPt;
      }
    }

    // a=rtpmap:0 PCMU/8000
    if (trimmed.startsWith(`a=rtpmap:${payloadType} `)) {
      const rtpmap = trimmed.split(' ')[1] ?? '';
      const [codecName, rate] = rtpmap.split('/');
      if (codecName) codec = codecName.toUpperCase();
      if (rate) clockRate = parseInt(rate, 10);
    }
  }

  if (!remoteIp || remoteRtpPort === null) {
    logger.warn('SDP invalide — IP ou port manquant.');
    return null;
  }

  logger.debug('SDP parsé : %s:%d, codec=%s/%d, PT=%d', remoteIp, remoteRtpPort, codec, clockRate, payloadType);

  return { remoteIp, remoteRtpPort, payloadType, codec, clockRate };
}

// ─── Constructeur SDP de réponse ──────────────────────────────────────────────

/**
 * Construit le SDP de notre 200 OK.
 * On impose PCMU (PT=0) sur notre port RTP local alloué dynamiquement.
 */
function buildAnswerSdp(localIp: string, localRtpPort: number, sessionId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    'v=0',
    `o=EtoibleuServeur ${now} ${now} IN IP4 ${localIp}`,
    `s=ElevenLabs AI Bridge`,
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${localRtpPort} RTP/AVP ${PCMU_PAYLOAD_TYPE}`,
    `a=rtpmap:${PCMU_PAYLOAD_TYPE} PCMU/${CLOCK_RATE}`,
    `a=ptime:20`,
    `a=maxptime:150`,
    `a=sendrecv`,
    '',
  ].join('\r\n');
}

// ─── Gestion des en-têtes SIP ─────────────────────────────────────────────────

function generateTag(): string {
  return uuidv4().replace(/-/g, '').substring(0, 8);
}

function generateBranch(): string {
  return `z9hG4bK-${uuidv4().replace(/-/g, '').substring(0, 12)}`;
}

// ─── Cycle de vie d'un appel ─────────────────────────────────────────────────

/**
 * Démarre le pont audio pour un appel.
 * Connecte RtpHandler ↔ ElevenLabsClient en mode full-duplex.
 */
async function startCallBridge(callId: string, config: AppConfig): Promise<void> {
  const call = activeCalls.get(callId);
  if (!call) return;

  logger.info('[%s] Démarrage du pont audio.', callId);

  // ── Créer et lier le socket RTP ──
  const rtpHandler = new RtpHandler(call.localRtpPort, config.serverIp);
  rtpHandlers.set(callId, rtpHandler);

  // Configurer l'adresse distante dès le départ (depuis le SDP)
  rtpHandler.setRemote(call.remoteSdp.remoteIp, call.remoteSdp.remoteRtpPort);

  try {
    await rtpHandler.bind();
  } catch (err) {
    logger.error('[%s] Impossible de lier le socket RTP : %s', callId, (err as Error).message);
    terminateCall(callId);
    return;
  }

  // ── Créer le client ElevenLabs ──
  const aiClient = new ElevenLabsClient(config, callId);
  aiClients.set(callId, aiClient);

  // ── Pont RTP → ElevenLabs (voix de l'appelant → IA) ──
  rtpHandler.on('pcmuChunk', (payload: Buffer) => {
    aiClient.sendAudioChunk(payload);
  });

  // ── Pont ElevenLabs → RTP (réponse IA → appelant) ──
  aiClient.on('audioChunk', (pcmuBuffer: Buffer) => {
    // L'API ElevenLabs retourne des chunks de taille variable.
    // On les découpe en blocs de 160 octets (20ms à 8kHz) pour le RTP.
    const chunkSize = 160;
    for (let offset = 0; offset < pcmuBuffer.length; offset += chunkSize) {
      const slice = pcmuBuffer.subarray(offset, Math.min(offset + chunkSize, pcmuBuffer.length));
      rtpHandler.sendPcmu(slice);
    }
  });

  aiClient.on('userTranscript', (text) => {
    logger.info('[%s] 🎤 Appelant : "%s"', callId, text);
  });

  aiClient.on('agentResponse', (text) => {
    logger.info('[%s] 🤖 Agent IA : "%s"', callId, text);
  });

  aiClient.on('error', (err) => {
    logger.error('[%s] Erreur ElevenLabs : %s', callId, err.message);
  });

  aiClient.on('disconnected', (code) => {
    logger.warn('[%s] ElevenLabs déconnecté (code=%d). Terminaison de l\'appel.', callId, code);
    terminateCall(callId);
  });

  rtpHandler.on('error', (err) => {
    logger.error('[%s] Erreur RTP : %s', callId, err.message);
  });

  // ── Connecter l'IA ──
  try {
    await aiClient.connect();
  } catch (err) {
    logger.error('[%s] Échec de connexion ElevenLabs : %s', callId, (err as Error).message);
    terminateCall(callId);
    return;
  }

  // ── Timer de sécurité (durée max d'appel) ──
  const timer = setTimeout(() => {
    logger.warn('[%s] Durée max d\'appel atteinte. Terminaison forcée.', callId);
    terminateCall(callId);
  }, MAX_CALL_DURATION_MS);

  callTimers.set(callId, timer);
  logger.info('[%s] Pont audio actif.', callId);
}

/** Termine proprement un appel : libère RTP, ferme WebSocket, nettoie les maps. */
function terminateCall(callId: string): void {
  logger.info('[%s] Terminaison de l\'appel.', callId);

  const timer = callTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    callTimers.delete(callId);
  }

  const rtp = rtpHandlers.get(callId);
  if (rtp) {
    rtp.close();
    rtpHandlers.delete(callId);
  }

  const ai = aiClients.get(callId);
  if (ai) {
    ai.disconnect();
    aiClients.delete(callId);
  }

  activeCalls.delete(callId);
  logger.info('[%s] Appel terminé et ressources libérées.', callId);
}

// ─── Instance Globale SIP ───────────────────────────────────────────────────────

let sipClient: sip.SipClient;

// ─── Handler SIP principal ────────────────────────────────────────────────────

/**
 * Démarre le serveur SIP sur le port UDP 5060.
 * Retourne une fonction d'arrêt propre.
 */
export function startSipServer(config: AppConfig): () => void {
  logger.info('Démarrage du serveur SIP sur %s:%d (UDP)', config.serverIp, config.sipPort);

  sipClient = sip.create(
    {
      port:    config.sipPort,
      address: config.serverIp, // Écouter spécifiquement sur l'IP du VPN
      logger: {
        recv: (msg: sip.SipRequest | any) => logger.debug('← SIP reçu : %s', msg.method || msg.status || 'inconnu'),
        send: (msg: sip.SipRequest | any) => logger.debug('→ SIP envoyé : %s', msg.method || msg.status || 'inconnu'),
      },
    },
    async (request: sip.SipRequest) => {
      const method = request.method?.toUpperCase();
      const callId: string = (request.headers['call-id'] as string | undefined) ?? 'unknown';

      logger.info('[%s] ← %s reçu', callId, method);

      switch (method) {
        case 'INVITE':
          console.log(`\n======================================================`);
          console.log(`[CRASH TEST] 📞 SIP INVITE REÇU (Call-ID: ${callId})`);
          console.log(`======================================================\n`);
          await handleInvite(request, config);
          break;

        case 'ACK':
          handleAck(callId);
          break;

        case 'BYE':
          handleBye(request, callId);
          break;

        case 'CANCEL':
          handleCancel(request, callId);
          break;

        case 'OPTIONS':
          // Répondre 200 OK pour les keep-alive OPTIONS
          sipClient.send(sip.makeResponse(request, 200, 'OK'));
          break;

        default:
          logger.warn('[%s] Méthode SIP non gérée : %s', callId, method);
          sipClient.send(sip.makeResponse(request, 405, 'Method Not Allowed'));
      }
    },
  );

  // Retourner la fonction d'arrêt
  return () => {
    logger.info('Arrêt du serveur SIP...');
    if (sipClient && typeof sipClient.destroy === 'function') {
      sipClient.destroy();
    }
    // Terminer tous les appels actifs
    for (const callId of activeCalls.keys()) {
      terminateCall(callId);
    }
    logger.info('Serveur SIP arrêté.');
  };
}

// ─── Handlers individuels ─────────────────────────────────────────────────────

async function handleInvite(request: sip.SipRequest, config: AppConfig): Promise<void> {
  const callId: string = (request.headers['call-id'] as string | undefined) ?? uuidv4();
  const fromHeader = request.headers['from'] as any;
  const fromTag = fromHeader?.params?.tag ?? generateTag();
  const toTag = generateTag();

  // ── 1. Répondre 100 Trying immédiatement ──
  const trying = sip.makeResponse(request, 100, 'Trying');
  sipClient.send(trying);
  logger.info('[%s] → 100 Trying envoyé.', callId);

  // ── 2. Parser le SDP entrant ──
  const sdpBody = typeof request.content === 'string'
    ? request.content
    : request.content?.toString() ?? '';

  const remoteSdp = parseSdp(sdpBody);
  if (!remoteSdp) {
    logger.error('[%s] SDP invalide ou manquant. Rejet (488).', callId);
    sipClient.send(sip.makeResponse(request, 488, 'Not Acceptable Here'));
    return;
  }

  // ── 3. Allouer un port RTP local ──
  let localRtpPort: number;
  try {
    localRtpPort = await allocateRtpPort(config.rtpPortMin, config.rtpPortMax, config.serverIp);
    console.log(`\n======================================================`);
    console.log(`[CRASH TEST] 🔓 PORT UDP RTP DYNAMIQUE OUVERT : ${localRtpPort} SUR L'IP ${config.serverIp}`);
    console.log(`======================================================\n`);
  } catch (err) {
    logger.error('[%s] Impossible d\'allouer un port RTP : %s', callId, (err as Error).message);
    sipClient.send(sip.makeResponse(request, 503, 'Service Unavailable'));
    return;
  }

  // Extraire l'adresse de l'appelant depuis le Via header
  const via = request.headers['via'] as Array<{ host: string; port?: number }> | undefined;
  const remoteAddress = via?.[0]?.host ?? remoteSdp.remoteIp;
  const remotePort = remoteSdp.remoteRtpPort;

  // ── 4. Enregistrer l'appel ──
  const call: ActiveCall = {
    callId,
    fromTag,
    toTag,
    remoteSdp,
    localRtpPort,
    remoteAddress,
    remotePort,
    startedAt: new Date(),
  };
  activeCalls.set(callId, call);

  // ── 5. Construire et envoyer le 200 OK avec notre SDP ──
  const answerSdp = buildAnswerSdp(config.serverIp, localRtpPort, callId);
  console.log(`\n======================================================`);
  console.log(`[CRASH TEST] 📝 SDP NÉGOCIÉ (200 OK) :`);
  console.log(`    -> IP : ${config.serverIp}`);
  console.log(`    -> Port RTP : ${localRtpPort}`);
  console.log(`    -> Codec : G.711 PCMU (PT=0) @ 8000Hz`);
  console.log(`======================================================\n`);

  const ok200 = sip.makeResponse(request, 200, 'OK');
  // Ajouter le tag To
  if (ok200.headers['to']) {
    if (typeof ok200.headers['to'] === 'object') {
      if (!ok200.headers['to'].params) ok200.headers['to'].params = {};
      ok200.headers['to'].params.tag = toTag;
    } else if (typeof ok200.headers['to'] === 'string') {
      ok200.headers['to'] += `;tag=${toTag}`;
    }
  }
  ok200.headers['content-type']   = 'application/sdp';
  ok200.headers['content-length'] = Buffer.byteLength(answerSdp).toString();
  ok200.headers['user-agent']     = USER_AGENT;
  ok200.content                   = answerSdp;

  sipClient.send(ok200);
  logger.info('[%s] → 200 OK envoyé (port RTP local : %d).', callId, localRtpPort);

  // ── 6. Démarrer le pont audio (non bloquant) ──
  startCallBridge(callId, config).catch((err: Error) => {
    logger.error('[%s] Erreur démarrage pont audio : %s', callId, err.message);
    terminateCall(callId);
  });
}

function handleAck(callId: string): void {
  logger.info('[%s] ← ACK reçu — dialogue SIP établi.', callId);
  // L'ACK confirme que le 200 OK a bien été reçu.
  // Le pont audio est déjà démarré dans handleInvite.
}

function handleBye(request: sip.SipRequest, callId: string): void {
  logger.info('[%s] ← BYE reçu — terminaison de l\'appel.', callId);
  // Répondre 200 OK au BYE
  sipClient.send(sip.makeResponse(request, 200, 'OK'));
  terminateCall(callId);
}

function handleCancel(request: sip.SipRequest, callId: string): void {
  logger.info('[%s] ← CANCEL reçu.', callId);
  sipClient.send(sip.makeResponse(request, 200, 'OK'));
  // Envoyer 487 Request Terminated si l'INVITE était en cours
  terminateCall(callId);
}


