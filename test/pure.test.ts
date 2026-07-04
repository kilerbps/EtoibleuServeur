/**
 * pure.test.ts
 * Tests unitaires des fonctions pures de parsing/construction SDP et RTP.
 * Exécution : `npm test`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSdp } from '../src/sipHandler';
import {
  parseRtpHeader,
  extractRtpPayload,
  buildRtpPacket,
  createRtpSenderState,
} from '../src/rtpHandler';
import type { RtpSenderState } from '../src/types';

// ─── SDP ──────────────────────────────────────────────────────────────────────

test('parseSdp extrait IP, port et codec PCMU', () => {
  const sdp = [
    'v=0',
    'o=- 0 0 IN IP4 192.168.1.10',
    's=call',
    'c=IN IP4 192.168.1.10',
    't=0 0',
    'm=audio 40000 RTP/AVP 0 8',
    'a=rtpmap:0 PCMU/8000',
  ].join('\r\n');

  const info = parseSdp(sdp);
  assert.ok(info, 'devrait parser un SDP valide');
  assert.equal(info!.remoteIp, '192.168.1.10');
  assert.equal(info!.remoteRtpPort, 40000);
  assert.equal(info!.payloadType, 0);
  assert.equal(info!.codec, 'PCMU');
  assert.equal(info!.clockRate, 8000);
});

test('parseSdp retourne null si IP ou port manquant', () => {
  const sdp = ['v=0', 's=call', 't=0 0'].join('\r\n');
  assert.equal(parseSdp(sdp), null);
});

test('parseSdp accepte les fins de ligne LF seules', () => {
  const sdp = 'c=IN IP4 10.0.0.1\nm=audio 5004 RTP/AVP 0\na=rtpmap:0 PCMU/8000';
  const info = parseSdp(sdp);
  assert.ok(info);
  assert.equal(info!.remoteIp, '10.0.0.1');
  assert.equal(info!.remoteRtpPort, 5004);
});

// ─── RTP : parsing ──────────────────────────────────────────────────────────

test('parseRtpHeader décode correctement un en-tête valide', () => {
  const buf = Buffer.alloc(12);
  buf[0] = 0x80; // V=2
  buf[1] = 0x00; // PT=0 (PCMU)
  buf.writeUInt16BE(1234, 2);
  buf.writeUInt32BE(56789, 4);
  buf.writeUInt32BE(0xdeadbeef, 8);

  const header = parseRtpHeader(buf);
  assert.ok(header);
  assert.equal(header!.version, 2);
  assert.equal(header!.payloadType, 0);
  assert.equal(header!.sequenceNumber, 1234);
  assert.equal(header!.timestamp, 56789);
  assert.equal(header!.ssrc, 0xdeadbeef);
});

test('parseRtpHeader rejette un buffer trop court', () => {
  assert.equal(parseRtpHeader(Buffer.alloc(4)), null);
});

test('parseRtpHeader rejette une version différente de 2', () => {
  const buf = Buffer.alloc(12);
  buf[0] = 0x40; // V=1
  assert.equal(parseRtpHeader(buf), null);
});

test('extractRtpPayload retourne le payload après un en-tête simple', () => {
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const buf = Buffer.concat([Buffer.from([0x80, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), payload]);
  const out = extractRtpPayload(buf);
  assert.ok(out);
  assert.deepEqual([...out!], [1, 2, 3, 4, 5]);
});

test('extractRtpPayload saute les CSRC', () => {
  const header = Buffer.alloc(12);
  header[0] = 0x81; // V=2, CC=1 → 1 CSRC (4 octets)
  const csrc = Buffer.alloc(4, 0xaa);
  const payload = Buffer.from([9, 9]);
  const buf = Buffer.concat([header, csrc, payload]);
  const out = extractRtpPayload(buf);
  assert.ok(out);
  assert.deepEqual([...out!], [9, 9]);
});

// ─── RTP : construction ─────────────────────────────────────────────────────

test('buildRtpPacket produit un en-tête valide et incrémente l\'état', () => {
  const state: RtpSenderState = {
    ssrc: 0x11223344,
    sequenceNumber: 100,
    timestamp: 1000,
    timestampIncrement: 160,
  };
  const payload = Buffer.from([7, 7, 7]);
  const packet = buildRtpPacket(payload, state);

  const header = parseRtpHeader(packet);
  assert.ok(header);
  assert.equal(header!.version, 2);
  assert.equal(header!.payloadType, 0);
  assert.equal(header!.sequenceNumber, 100);
  assert.equal(header!.timestamp, 1000);
  assert.equal(header!.ssrc, 0x11223344);
  assert.deepEqual([...packet.subarray(12)], [7, 7, 7]);

  // L'état doit avoir avancé
  assert.equal(state.sequenceNumber, 101);
  assert.equal(state.timestamp, 1160);
});

test('buildRtpPacket fait boucler le numéro de séquence sur 16 bits', () => {
  const state: RtpSenderState = {
    ssrc: 1,
    sequenceNumber: 0xffff,
    timestamp: 0,
    timestampIncrement: 160,
  };
  buildRtpPacket(Buffer.alloc(0), state);
  assert.equal(state.sequenceNumber, 0);
});

test('createRtpSenderState produit des valeurs dans les bornes attendues', () => {
  const state = createRtpSenderState();
  assert.equal(state.timestampIncrement, 160);
  assert.ok(state.sequenceNumber >= 0 && state.sequenceNumber <= 0xffff);
  assert.ok(state.ssrc >= 0 && state.ssrc <= 0xffffffff);
});
