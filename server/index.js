'use strict';

const { createMotionDriveServer } = require('./src/create-server');

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const app = createMotionDriveServer();
    app.server.listen(port, '0.0.0.0', () => {
      console.log('\n  MOTIONDRIVE // LOCAL ARCADE CONTROL');
      console.log(`  Browser game: http://localhost:${port}`);
      console.log(`  Listen port:  ${port}`);
      console.log('  Phone: use the LAN IP shown in the game pairing panel.');
      console.log('  Press Ctrl+C to stop.\n');
    });
    const shutdown = async () => {
      console.log('\nShutting down MotionDrive…');
      try { await app.close(); process.exit(0); }
      catch (error) { console.error('Shutdown error:', error.message); process.exit(1); }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}

module.exports = { createMotionDriveServer };
