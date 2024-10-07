import { Agent } from 'http';
import net from 'net';
import log from 'book';
import Debug from 'debug';

const DEFAULT_MAX_SOCKETS = 10;

interface TunnelAgentOptions {
  clientId?: string;
  maxTcpSockets?: number;
}

// Implements an http.Agent interface to a pool of tunnel sockets
// A tunnel socket is a connection _from_ a client that will
// service http requests. This agent is usable wherever one can use an http.Agent
class TunnelAgent extends Agent {
  private availableSockets: net.Socket[] = [];
  private waitingCreateConn: Array<
    (err: Error | null, socket?: net.Socket) => void
  > = [];
  private debug: Debug.Debugger;
  private connectedSockets = 0;
  private maxTcpSockets: number;
  private server: net.Server;
  private started = false;
  private closed = false;

  constructor(options: TunnelAgentOptions = {}) {
    super({
      keepAlive: true,
      // only allow keepalive to hold on to one socket
      // this prevents it from holding on to all the sockets so they can be used for upgrades
      maxFreeSockets: 1,
    });

    // sockets we can hand out via createConnection
    this.availableSockets = [];

    // when a createConnection cannot return a socket, it goes into a queue
    // once a socket is available it is handed out to the next callback
    this.waitingCreateConn = [];

    this.debug = Debug(`lt:TunnelAgent[${options.clientId}]`);

    // track maximum allowed sockets
    this.connectedSockets = 0;
    this.maxTcpSockets = options.maxTcpSockets || DEFAULT_MAX_SOCKETS;

    // new tcp server to service requests for this client
    this.server = net.createServer();

    // flag to avoid double starts
    this.started = false;
    this.closed = false;
  }

  stats(): { connectedSockets: number } {
    return {
      connectedSockets: this.connectedSockets,
    };
  }

  listen(): Promise<{ port: number }> {
    const server = this.server;
    if (this.started) {
      throw new Error('already started');
    }
    this.started = true;

    server.on('close', this._onClose.bind(this));
    server.on('connection', this._onConnection.bind(this));
    server.on('error', (err: NodeJS.ErrnoException) => {
      // These errors happen from killed connections, we don't worry about them
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        return;
      }
      log.error(err);
    });

    return new Promise((resolve) => {
      server.listen(() => {
        const address = server.address();
        if (typeof address === 'object' && address !== null) {
          const port = address.port;
          this.debug('tcp server listening on port: %d', port);

          resolve({
            // port for lt client tcp connections
            port: port,
          });
        } else {
          throw new Error('Failed to get server address');
        }
      });
    });
  }

  private _onClose(): void {
    this.closed = true;
    this.debug('closed tcp socket');
    // flush any waiting connections
    for (const conn of this.waitingCreateConn) {
      conn(new Error('closed'), null);
    }
    this.waitingCreateConn = [];
    this.emit('end');
  }

  // new socket connection from client for tunneling requests to client
  private _onConnection(socket: net.Socket): boolean | void {
    // no more socket connections allowed
    if (this.connectedSockets >= this.maxTcpSockets) {
      this.debug('no more sockets allowed');
      socket.destroy();
      return false;
    }

    socket.once('close', (hadError: boolean) => {
      this.debug('closed socket (error: %s)', hadError);
      this.connectedSockets -= 1;
      // remove the socket from available list
      const idx = this.availableSockets.indexOf(socket);
      if (idx >= 0) {
        this.availableSockets.splice(idx, 1);
      }

      this.debug('connected sockets: %s', this.connectedSockets);
      if (this.connectedSockets <= 0) {
        this.debug('all sockets disconnected');
        this.emit('offline');
      }
    });

    // close will be emitted after this
    socket.once('error', () => {
      // we do not log these errors, sessions can drop from clients for many reasons
      // these are not actionable errors for our server
      socket.destroy();
    });

    if (this.connectedSockets === 0) {
      this.emit('online');
    }

    this.connectedSockets += 1;
    const address = socket.address();
    if (
      typeof address === 'object' &&
      address !== null &&
      'address' in address
    ) {
      this.debug('new connection from: %s:%s', address.address, address.port);
    } else {
      this.debug('new connection from: unknown address');
    }

    // if there are queued callbacks, give this socket now and don't queue into available
    const fn = this.waitingCreateConn.shift();
    if (fn) {
      this.debug('giving socket to queued conn request');
      setTimeout(() => {
        fn(null, socket);
      }, 0);
      return;
    }

    // make socket available for those waiting on sockets
    this.availableSockets.push(socket);
  }

  // fetch a socket from the available socket pool for the agent
  // if no socket is available, queue
  // cb(err, socket)
  createConnection(
    client,
    cb: (err: Error | null, socket?: net.Socket) => void
  ): void {
    console.log('cb', cb);
    if (this.closed) {
      cb(new Error('closed'));
      return;
    }

    console.log('create connection');

    // socket is a tcp connection back to the user hosting the site
    const sock = this.availableSockets.shift();

    // no available sockets
    // wait until we have one
    if (!sock) {
      this.waitingCreateConn.push(cb);
      this.debug('waiting connected: %s', this.connectedSockets);
      this.debug('waiting available: %s', this.availableSockets.length);
      return;
    }

    console.log('socket given');
    cb(null, sock);
  }

  destroy(): void {
    this.server.close();
    super.destroy();
  }
}

export default TunnelAgent;
