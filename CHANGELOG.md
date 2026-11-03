# Changelog

## 0.1.0

First release. Two desktop controls in one bundle row (`desktop-tools`):

- **Restart** button appended to the Windows title-bar menu bar, right of the
  native 应用 / 编辑 menus. The Host answers `202`, a detached helper kills the
  Electron main process and the Host by PID, waits until both are gone, then
  relaunches the app with the Node-mode marker removed; the page polls
  `/api/dsh-desktop-tools/status` and reloads itself when the boot id changes.
- **Start with Windows** row in Settings → General, owning the per-user
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value
  `DeepSeek Harness`. The legacy `DSH NEXT` value is read for state and migrated
  away on the next enable.
- Routes: `GET /api/dsh-desktop-tools/status`,
  `POST /api/dsh-desktop-tools/restart`,
  `POST /api/dsh-desktop-tools/autostart`. All are loopback-only and
  same-origin; the POSTs additionally require `application/json`.
- Verified on Windows with the official desktop app 0.2.1-rc.5: the title-bar
  button renders with localized copy, the status route reports the live restart
  target, and toggling autostart writes/migrates the Run value.
