declare module 'sip' {
  export interface SipRequest {
    method?: string;
    uri?: string;
    version?: string;
    headers: Record<string, string | Array<{ host: string; port?: number }> | any>;
    content?: string | Buffer;
  }

  export interface SipResponse {
    status: number;
    reason: string;
    version?: string;
    headers: Record<string, string | any>;
    content?: string | Buffer;
  }

  export interface StartOptions {
    port?: number;
    address?: string;
    logger?: {
      recv?: (msg: any, info: any) => void;
      send?: (msg: any, info: any) => void;
    };
  }

  export interface SipClient {
    send(message: SipResponse | SipRequest): void;
    destroy(): void;
  }

  export function create(
    options: StartOptions,
    callback: (request: SipRequest) => void
  ): SipClient;

  export function start(
    options: StartOptions,
    callback: (request: SipRequest) => void
  ): void;

  export function makeResponse(
    request: SipRequest,
    status: number,
    reason: string
  ): SipResponse;

  export function send(message: SipResponse | SipRequest): void;
}
