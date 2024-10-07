import http from 'http';
import net from 'net';
import pump from 'pump';
import EventEmitter from 'events';
import TunnelAgent from './tunnel-agent';

interface ClientOptions {
  agent: TunnelAgent;
  id: string;
}

// A client encapsulates req/res handling using an agent
//
// If an agent is destroyed, the request handling will error
// The caller is responsible for handling a failed request
class Client extends EventEmitter {
  private readonly agent: TunnelAgent;
  private readonly id: string;
  private graceTimeout: NodeJS.Timeout;

  constructor(options: ClientOptions) {
    super();

    this.agent = options.agent;
    this.id = options.id;

    // client is given a grace period in which they can connect before they are _removed_
    this.graceTimeout = setTimeout(() => {
      this.close();
    }, 1000).unref();

    this.agent.on('online', () => {
      console.log(`client online ${this.id}`);
      clearTimeout(this.graceTimeout);
    });

    this.agent.on('offline', () => {
      console.log(`client offline ${this.id}`);

      // if there was a previous timeout set, we don't want to double trigger
      clearTimeout(this.graceTimeout);

      // client is given a grace period in which they can re-connect before they are _removed_
      this.graceTimeout = setTimeout(() => {
        this.close();
      }, 1000).unref();
    });

    // TODO(roman): an agent error removes the client, the user needs to re-connect?
    // how does a user realize they need to re-connect vs some random client being assigned same port?
    this.agent.once('error', () => {
      this.close();
    });
  }

  stats(): { connectedSockets: number } {
    return this.agent.stats();
  }

  close(): void {
    clearTimeout(this.graceTimeout);
    this.agent.destroy();
    this.emit('close');
  }

  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    console.log('>', req.url);
    const opt: http.RequestOptions = {
      path: req.url,
      agent: this.agent,
      method: req.method,
      headers: req.headers,
    };

    const clientReq = http.request(opt, (clientRes) => {
      console.log('<', req.url);
      // write response code and headers
      res.writeHead(clientRes.statusCode || 500, clientRes.headers);

      // using pump is deliberate - see the pump docs for why
      pump(clientRes, res);
    });

    // this can happen when underlying agent produces an error
    // in our case we 504 gateway error this?
    // if we have already sent headers?
    clientReq.once('error', () => {
      // TODO(roman): if headers not sent - respond with gateway unavailable
    });

    // using pump is deliberate - see the pump docs for why
    pump(req, clientReq);
  }

  handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    console.log('> [up]', req.url);
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // These client side errors can happen if the client dies while we are reading
      // We don't need to surface these in our logs.
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        return;
      }
      console.error(err);
    });

    this.agent.createConnection(
      socket,
      (err: Error | null, conn?: net.Socket) => {
        console.log('< [up]', req.url);
        // any errors getting a connection mean we cannot service this request
        if (err || !conn) {
          socket.end();
          return;
        }

        // socket might have disconnected while we were waiting for a connection
        if (!socket.readable || !socket.writable) {
          conn.destroy();
          socket.end();
          return;
        }

        // WebSocket requests are special in that we simply re-create the header info
        // then directly pipe the socket data
        // avoids having to rebuild the request and handle upgrades via the http client
        const arr: string[] = [
          `${req.method} ${req.url} HTTP/${req.httpVersion}`,
        ];
        for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
          arr.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }

        arr.push('');
        arr.push('');

        // using pump is deliberate - see the pump docs for why
        pump(conn, socket);
        pump(socket, conn);
        conn.write(arr.join('\r\n'));
      }
    );
  }
}

export default Client;
