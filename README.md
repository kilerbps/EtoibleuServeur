# Étoile Bleue — Serveur pont SIP/RTP ↔ ElevenLabs Conversational AI

Serveur Node.js/TypeScript qui relie la **téléphonie classique (SIP/RTP)** à l'**IA conversationnelle vocale d'ElevenLabs**, dans un contexte de **triage médical**.

Un patient appelle un numéro → le serveur établit l'appel SIP, capte la voix (RTP/PCMU), la transmet en temps réel à un agent ElevenLabs via WebSocket, et rejoue la réponse vocale de l'IA vers l'appelant.

```
Appelant (téléphone/softphone)
   │  SIP (signalisation) + RTP (voix G.711 μ-law)   ── UDP
   ▼
[ Serveur pont Node.js ]
   │  WebSocket wss:// (audio Base64)
   ▼
ElevenLabs Conversational AI (agent vocal médical)
```

## Fonctionnalités

- Signalisation SIP (RFC 3261) : `INVITE` → `100 Trying` → `200 OK` (SDP) → `ACK` → `BYE`/`CANCEL`.
- Flux RTP (RFC 3550) bidirectionnel en G.711 **PCMU** 8 kHz.
- **Émission RTP cadencée à 20 ms** (pas de rafale → audio fluide).
- **RTP symétrique (NAT latching)** : réponse audio dirigée vers la source réelle des paquets.
- Pont WebSocket ElevenLabs full-duplex avec **reconnexion automatique** bornée.
- **Contrôle d'accès** par liste blanche d'IP et **limite d'appels simultanés**.
- Allocation dynamique de ports RTP sans race condition.
- Tout en mémoire (Buffers), zéro écriture disque.

## Prérequis

- Node.js ≥ 20
- Un agent ElevenLabs Conversational AI configuré en **μ-law 8 kHz** (entrée **et** sortie)
- Une IP/port UDP `5060` joignable par l'opérateur SIP (et la plage RTP ouverte au pare-feu)

## Installation

```bash
npm install
cp .env.example .env   # puis renseigner les valeurs
```

## Configuration (`.env`)

| Variable | Requis | Défaut | Description |
|---|---|---|---|
| `SERVER_IP` | ✅ | — | IP d'écoute (publique/VPN, ou `0.0.0.0` en local) |
| `SIP_PORT` | ❌ | `5060` | Port UDP SIP |
| `RTP_PORT_MIN` | ❌ | `10000` | Borne basse de la plage RTP |
| `RTP_PORT_MAX` | ❌ | `20000` | Borne haute de la plage RTP |
| `ELEVENLABS_API_KEY` | ✅ | — | Clé API ElevenLabs |
| `ELEVENLABS_AGENT_ID` | ✅ | — | ID de l'agent conversationnel |
| `MAX_CONCURRENT_CALLS` | ❌ | `50` | Nombre max d'appels simultanés |
| `SIP_ALLOWED_IPS` | ❌ | *(vide)* | IP autorisées, séparées par des virgules. Vide = toutes |
| `EXPECTED_AUDIO_FORMAT` | ❌ | `ulaw_8000` | Format audio attendu de l'agent |
| `LOG_LEVEL` | ❌ | `info` | `debug` \| `info` \| `warn` \| `error` |

## Lancement

```bash
# Développement (rechargement à chaud)
npm run dev

# Production
npm run build
npm start
```

## Tests

```bash
npm test
```

Les tests couvrent les fonctions pures de parsing/construction SDP et RTP.

## Docker

```bash
docker build -t etoibleu-serveur-sip .
docker run --rm --env-file .env \
  -p 5060:5060/udp -p 10000-20000:10000-20000/udp \
  etoibleu-serveur-sip
```

> Note : le mode `host` réseau (`--network host`) est souvent préférable pour la VoIP afin d'éviter les problèmes de NAT sur la plage RTP.

## Structure du projet

| Fichier | Rôle |
|---|---|
| `src/server.ts` | Point d'entrée, cycle de vie, arrêt propre |
| `src/config.ts` | Chargement/validation des variables d'environnement |
| `src/types.ts` | Interfaces TypeScript partagées |
| `src/sipHandler.ts` | Signalisation SIP + orchestration des appels |
| `src/rtpHandler.ts` | Flux RTP (parsing, construction, pacing, NAT) |
| `src/elevenLabsClient.ts` | Client WebSocket ElevenLabs |
| `src/logger.ts` | Logger léger sans dépendance |

## Licence

MIT
