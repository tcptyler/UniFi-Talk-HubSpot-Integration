// TLS for UniFi consoles. Consoles ship self-signed certificates, so instead of turning verification
// off, the integration pins the exact certificate (SHA-256 fingerprint) the admin approved.
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';

export function normalizeFingerprint(fp: string | null | undefined): string {
  return String(fp ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
}

/**
 * HTTPS agent that only talks to a server presenting the pinned certificate. The socket is handed to
 * the request only after the fingerprint matches, so no request bytes (credentials included) are ever
 * written to an unexpected server.
 */
export function pinnedAgent(host: string, pin: string): https.Agent {
  const want = normalizeFingerprint(pin);
  if (want.length !== 64) throw new Error('certificate pin must be a SHA-256 fingerprint (64 hex characters)');
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  const createConnection = (options: tls.ConnectionOptions, cb: (err: Error | null, socket?: Duplex) => void) => {
    const socket = tls.connect({ ...options, host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const onError = (err: Error) => cb(err);
    socket.once('secureConnect', () => {
      socket.off('error', onError); // after hand-over, errors belong to the request
      const got = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
      if (got && got === want) cb(null, socket);
      else {
        socket.destroy();
        cb(new Error(`console certificate ${got || '(none)'} does not match the pinned fingerprint`));
      }
    });
    socket.once('error', onError);
    return undefined; // http.Agent waits for the callback when createConnection returns nothing
  };
  (agent as unknown as { createConnection: typeof createConnection }).createConnection = createConnection;
  return agent;
}

export interface CertificateInfo {
  sha256: string;
  subject: string | undefined;
  issuer: string | undefined;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}

/** Reads a server's certificate without sending anything, so an admin can approve the pin. */
export function fetchCertificate(host: string, port = 443, timeoutMs = 10_000): Promise<CertificateInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const subject = typeof cert.subject?.CN === 'string' ? cert.subject.CN : undefined;
      const issuer = typeof cert.issuer?.CN === 'string' ? cert.issuer.CN : undefined;
      resolve({
        sha256: normalizeFingerprint(cert.fingerprint256),
        subject,
        issuer,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        selfSigned: subject !== undefined && subject === issuer,
      });
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`timed out connecting to ${host}:${port}`)));
    socket.once('error', reject);
  });
}
