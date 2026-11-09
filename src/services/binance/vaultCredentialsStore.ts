import { BinanceCredentials } from './types';

export interface VaultSaveResult {
  success: boolean;
  checkpointRequired: boolean;
  message?: string;
}

export class VaultCredentialsStore {
  private static readonly endpoint = (
    import.meta.env.VITE_BINANCE_VAULT_ENDPOINT ||
    '/api/v1/vault/binance/credentials'
  ).trim();

  public static getVaultReference(): string {
    return this.endpoint;
  }

  public static async loadCredentials(): Promise<BinanceCredentials | null> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json'
        }
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      const credentials = this.extractCredentials(payload);
      if (!credentials) {
        return null;
      }

      return this.sanitize(credentials);
    } catch (error) {
      console.warn('Failed to load Binance credentials from vault:', error);
      return null;
    }
  }

  public static async saveCredentials(credentials: BinanceCredentials): Promise<VaultSaveResult> {
    const safeCredentials = this.sanitize(credentials);

    try {
      const response = await fetch(this.endpoint, {
        method: 'PUT',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(safeCredentials)
      });

      if (response.ok) {
        return { success: true, checkpointRequired: false };
      }

      const bodyText = await response.text();
      if (this.isOwnerApprovalCheckpoint(response.status, bodyText)) {
        return {
          success: false,
          checkpointRequired: true,
          message: 'Owner biometric/passkey approval is required in vault.'
        };
      }

      return {
        success: false,
        checkpointRequired: false,
        message: this.getFailureMessage(response.status, bodyText)
      };
    } catch (error) {
      console.error('Failed to save Binance credentials to vault:', error);
      return {
        success: false,
        checkpointRequired: false,
        message: 'Vault is unreachable. Credentials were not saved.'
      };
    }
  }

  private static extractCredentials(payload: unknown): BinanceCredentials | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const direct = payload as Partial<BinanceCredentials>;
    if (typeof direct.apiKey === 'string' && typeof direct.secretKey === 'string') {
      return { apiKey: direct.apiKey, secretKey: direct.secretKey };
    }

    const wrapped = payload as { credentials?: Partial<BinanceCredentials>; data?: Partial<BinanceCredentials> };
    const candidate = wrapped.credentials || wrapped.data;
    if (candidate && typeof candidate.apiKey === 'string' && typeof candidate.secretKey === 'string') {
      return { apiKey: candidate.apiKey, secretKey: candidate.secretKey };
    }

    return null;
  }

  private static sanitize(credentials: BinanceCredentials): BinanceCredentials {
    return {
      apiKey: credentials.apiKey?.trim() || '',
      secretKey: credentials.secretKey?.trim() || ''
    };
  }

  private static isOwnerApprovalCheckpoint(status: number, bodyText: string): boolean {
    if (status !== 401 && status !== 403) {
      return false;
    }

    const text = bodyText.toLowerCase();
    return (
      text.includes('biometric') ||
      text.includes('passkey') ||
      text.includes('owner approval') ||
      text.includes('webauthn')
    );
  }

  private static getFailureMessage(status: number, bodyText: string): string {
    if (status === 401 || status === 403) {
      return 'Vault rejected this request.';
    }

    if (bodyText && bodyText.length < 180) {
      return `Vault save failed (${status}): ${bodyText}`;
    }

    return `Vault save failed (${status}).`;
  }
}
