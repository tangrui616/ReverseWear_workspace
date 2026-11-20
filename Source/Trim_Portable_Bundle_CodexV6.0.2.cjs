const { unlink } = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ appOutDir, electronPlatformName }) => {
  if (electronPlatformName !== 'win32') return;

  // With a pre-extracted Electron distribution, electron-builder leaves its
  // default demo app and distribution version marker in the staging folder.
  for (const file of ['resources/default_app.asar', 'version']) {
    await unlink(path.join(appOutDir, file)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
};
