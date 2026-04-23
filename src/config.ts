/**
 * config.ts
 * Charge et valide la configuration depuis les variables d'environnement.
 * Doit être importé en tout premier dans server.ts.
 */

import * as dotenv from 'dotenv';
import { AppConfig } from './types';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[CONFIG] Variable d'environnement manquante : ${key}`);
  }
  return value;
}

function optionalEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`[CONFIG] La variable ${key} doit être un entier, reçu : "${raw}"`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const logLevel = (process.env['LOG_LEVEL'] ?? 'info') as AppConfig['logLevel'];
  const validLevels: AppConfig['logLevel'][] = ['debug', 'info', 'warn', 'error'];
  if (!validLevels.includes(logLevel)) {
    throw new Error(`[CONFIG] LOG_LEVEL invalide : "${logLevel}". Valeurs acceptées : ${validLevels.join(', ')}`);
  }

  const config: AppConfig = {
    serverIp:           requireEnv('SERVER_IP'),
    sipPort:            optionalEnvInt('SIP_PORT', 5060),
    rtpPortMin:         optionalEnvInt('RTP_PORT_MIN', 10000),
    rtpPortMax:         optionalEnvInt('RTP_PORT_MAX', 20000),
    elevenLabsApiKey:   requireEnv('ELEVENLABS_API_KEY'),
    elevenLabsAgentId:  requireEnv('ELEVENLABS_AGENT_ID'),
    logLevel,
  };

  if (config.rtpPortMin >= config.rtpPortMax) {
    throw new Error('[CONFIG] RTP_PORT_MIN doit être strictement inférieur à RTP_PORT_MAX');
  }

  return config;
}
