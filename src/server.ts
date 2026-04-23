/**
 * server.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Point d'entrée principal de l'application.
 *
 * Initialise le projet, charge la configuration, configure le logger
 * et démarre le serveur SIP UDP.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { loadConfig } from './config';
import { setLogLevel, createLogger } from './logger';
import { startSipServer } from './sipHandler';

// ─── Initialisation ──────────────────────────────────────────────────────────

try {
  // 1. Charger et valider la configuration (variables d'environnement)
  const config = loadConfig();

  // 2. Configurer le niveau de journalisation
  setLogLevel(config.logLevel);

  const mainLogger = createLogger('MAIN');
  mainLogger.info('Démarrage du pont SIP ↔ ElevenLabs Conversational AI');
  mainLogger.info('Configuration chargée avec succès.');

  // 3. Démarrer le serveur SIP
  const stopSip = startSipServer(config);

  // ─── Gestion de l'arrêt propre (Graceful Shutdown) ─────────────────────────

  const shutdown = (signal: string) => {
    mainLogger.info('Signal %s reçu. Arrêt en cours...', signal);
    stopSip();
    setTimeout(() => {
      mainLogger.info('Processus terminé.');
      process.exit(0);
    }, 500); // Laisser le temps aux logs de s'écrire et aux sockets de se fermer
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Empêcher l'arrêt silencieux sur exception non gérée (tout en loggant l'erreur)
  process.on('uncaughtException', (err) => {
    mainLogger.error('Exception non gérée : %s', err.stack || err.message);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    mainLogger.error('Promesse rejetée non gérée : %s', reason);
  });

} catch (err) {
  // Erreur fatale au démarrage (ex: variable d'environnement manquante)
  console.error('\x1b[31m\x1b[1m[FATAL ERROR]\x1b[0m', (err as Error).message);
  process.exit(1);
}
