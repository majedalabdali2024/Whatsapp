import 'dotenv/config';
import express from 'express';
import routes from './routes.js';
import apiKey from './middlewares/apiKey.js';
import { init, cleanup } from './whatsapp.js';

const app = express();

// Configure Express middleware
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.json({ limit: '50mb' }));
app.use(apiKey);
app.use('/', routes);

// Start the Express server
function startApp() {
  const envPort = process.env.PORT;
  // 0.0.0.0 مطلوب على Railway والسحابة حتى يصل المرور من خارج الحاوية؛ للتطوير المحلي الضيق استخدم HOST=127.0.0.1
  const host = process.env.HOST ?? '0.0.0.0';

  // iisnode sets PORT to a named pipe path (e.g. \\.\pipe\xxx)
  // Detect this and listen on the pipe directly (no host binding)
  const isNamedPipe = envPort && isNaN(parseInt(envPort));
  const port = isNamedPipe ? envPort : parseInt(envPort ?? 8090);

  const onListening = () => {
    init();
    if (isNamedPipe) {
      console.log(`Server is listening on named pipe (iisnode)`);
    } else {
      console.log(`Server is listening on http://${host}:${port}`);
    }
  };

  // For iisnode: listen on pipe only (no host). For standalone: listen on host:port
  const server = isNamedPipe
    ? app.listen(port, onListening)
    : app.listen(port, host, onListening);

  // Increase keep-alive timeout to prevent C# HttpClient pooled connections from being closed prematurely
  // Default is 5s which is too short - C# HttpClient reuses pooled connections after page load delays
  server.keepAliveTimeout = 65000; // 65 seconds
  server.headersTimeout = 66000;   // must be > keepAliveTimeout

  return server;
}

export default startApp;
export { app };