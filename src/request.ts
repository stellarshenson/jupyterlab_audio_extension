import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

/**
 * Build the websocket URL for an audio-capture endpoint: `stream` (microphone capture) or
 * `speaker` (playback).
 *
 * The endpoint lives under the Jupyter base URL and inherits Jupyter token auth - the
 * token is passed as a query parameter because the WebSocket constructor cannot set
 * Authorization headers.
 */
export function audioCaptureWsUrl(
  serverSettings: ServerConnection.ISettings,
  endpoint: 'stream' | 'speaker' = 'stream'
): string {
  let url = URLExt.join(
    serverSettings.wsUrl,
    'jupyterlab-audio-extension', // our server extension's API namespace
    endpoint
  );
  if (serverSettings.token) {
    url += `?token=${encodeURIComponent(serverSettings.token)}`;
  }
  return url;
}
