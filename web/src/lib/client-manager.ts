import { hri } from 'human-readable-ids';
import Client from './client';
import TunnelAgent from './tunnel-agent';

interface ClientManagerOptions {
  max_tcp_sockets?: number;
}

interface ClientInfo {
  id: string;
  port: number;
  max_conn_count: number;
  url?: string;
}

class ClientManager {
  private opt: ClientManagerOptions;
  private clients: Map<string, Client>;
  stats: { tunnels: number };
  private graceTimeout: NodeJS.Timeout | null;

  constructor(opt: ClientManagerOptions = {}) {
    this.opt = opt;
    this.clients = new Map<string, Client>();
    this.stats = { tunnels: 0 };
    this.graceTimeout = null;
  }

  async newClient(id: string): Promise<ClientInfo> {
    if (this.clients.has(id)) {
      id = hri.random();
    }

    const maxSockets = this.opt.max_tcp_sockets || 10;
    const agent = new TunnelAgent({ clientId: id, maxTcpSockets: maxSockets });

    const client = new Client({ id, agent });
    this.clients.set(id, client);

    client.once('close', () => {
      this.removeClient(id);
    });

    try {
      const info = await agent.listen();
      this.stats.tunnels++;
      return { id, port: info.port, max_conn_count: maxSockets };
    } catch (err) {
      this.removeClient(id);
      throw err;
    }
  }

  removeClient(id: string): void {
    console.log(`removing client: ${id}`);
    const client = this.clients.get(id);
    if (!client) return;
    this.stats.tunnels--;
    this.clients.delete(id);
    client.close();
  }

  hasClient(id: string): boolean {
    return this.clients.has(id);
  }

  getClient(id: string): Client | undefined {
    return this.clients.get(id);
  }
}

export default ClientManager;
