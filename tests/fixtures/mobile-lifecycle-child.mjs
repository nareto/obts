const [mode] = process.argv.slice(2);
const keepAlive = setInterval(() => {}, 1000);
process.on('message', () => {
  if (mode === 'clean') process.exit(0);
  if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
  if (mode === 'message-hang') process.send({ complete: true });
  if (mode === 'boundary') process.send({ boundary: 'synthetic' });
  if (mode === 'success') {
    process.send({ complete: true }, () => {
      clearInterval(keepAlive);
      process.disconnect();
    });
  }
});
process.stdout.write('ready\n');
