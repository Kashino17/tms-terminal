import { storageService } from './storage.service';

export const authService = {
  async login(host: string, port: number, password: string): Promise<string> {
    const url = `http://${host}:${port}/auth/login`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    return data.token;
  },

  async loginAndSave(serverId: string, host: string, port: number, password: string): Promise<string> {
    const token = await this.login(host, port, password);
    await storageService.updateServer(serverId, { token });
    return token;
  },

  async testConnection(host: string, port: number): Promise<{ ok: boolean; platform?: string; error?: string }> {
    try {
      const url = `http://${host}:${port}/health`;
      const res = await fetch(url);
      const data = await res.json();
      return { ok: true, platform: data.platform };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      return { ok: false, error: message };
    }
  },
};
