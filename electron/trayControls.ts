import { Menu, type BrowserWindow, type MenuItemConstructorOptions, type Tray } from 'electron';

/** Bring back the advisor without changing capture or overlay state. */
export function installTrayWindowControls(
  tray: Tray,
  window: () => BrowserWindow | null,
  actions: MenuItemConstructorOptions[],
) {
  const showInterface = () => {
    const control = window();
    if (!control || control.isDestroyed()) return;
    if (control.isMinimized()) control.restore();
    if (process.env.BRAWL_E2E) control.showInactive();
    else {
      control.show();
      control.focus();
    }
  };
  tray.on('double-click', showInterface);
  const menu = Menu.buildFromTemplate([
    { id: 'show-interface', label: 'Show interface', click: showInterface },
    { type: 'separator' },
    ...actions,
  ]);
  tray.setContextMenu(menu);
  return menu;
}
