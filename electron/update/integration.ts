import { app, ipcMain, net, protocol, type WebContents } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS } from '../channels';
import { DataUpdater } from './service';
import { UpdateHttp } from './http';
import { log } from '../../src/log';

if (!app.isReady())
  protocol.registerSchemesAsPrivileged([
    { scheme: 'brawl-data', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);

export async function setupDataUpdates(bundled: string, control: () => WebContents | null) {
  const updater = new DataUpdater(
    bundled,
    path.join(app.getPath('userData'), 'data-updates'),
    (signal, notify) => new UpdateHttp(signal, notify),
    (p) => {
      const contents = control();
      if (contents && !contents.isDestroyed()) contents.send(CHANNELS.dataProgress, p);
    },
  );
  await updater.initialize();
  protocol.handle('brawl-data', async (request) => {
    try {
      const file = updater.resolveUrl(request.url);
      if (!file) return new Response('Invalid snapshot asset.', { status: 404 });
      const response = await net.fetch(pathToFileURL(file).href);
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': file.endsWith('.json') ? 'application/json' : 'image/webp',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new Response('Snapshot asset unavailable.', { status: 404 });
    }
  });
  const requireControl = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== control()) throw new Error('Only the control window may update data.');
  };
  ipcMain.handle(CHANNELS.dataStatus, (event, check: boolean) =>
    updater.status(event.sender === control() && check === true),
  );
  ipcMain.handle(CHANNELS.dataProgressGet, () => updater.currentProgress);
  ipcMain.handle(CHANNELS.dataStart, (event, request: unknown) => {
    requireControl(event);
    return updater.start(request);
  });
  ipcMain.handle(CHANNELS.dataCancel, (event) => {
    requireControl(event);
    return updater.cancel();
  });
  app.on('before-quit', () => updater.cancel());
  log('electron-main', 'info', 'data.updates.ready');
}
