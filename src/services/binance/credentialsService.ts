
import { BinanceApiClient } from './apiClient';
import { StorageManager } from './storageManager';
import { BinanceCredentials } from './types';
import { VaultSaveResult } from './vaultCredentialsStore';

export class CredentialsService {
  private apiClient: BinanceApiClient;
  private isOfflineMode: boolean = false;
  private autoReconnectTimer: NodeJS.Timeout | null = null;
  private connectionRetryCount: number = 0;
  private maxConnectionRetries: number = 5;
  
  constructor(apiClient: BinanceApiClient) {
    this.apiClient = apiClient;
    // Load offline mode setting
    this.isOfflineMode = StorageManager.getOfflineMode();
    
    // Set up network status monitoring
    this.setupNetworkMonitoring();
  }
  
  private setupNetworkMonitoring(): void {
    // Auto-enable offline mode when network goes down
    window.addEventListener('offline', () => {
      if (!this.isOfflineMode) {
        console.log('Network went offline, automatically enabling offline mode');
        this.setOfflineMode(true);
        // No toast notification to avoid being intrusive
      }
    });
    
    // When coming back online, try to reconnect automatically
    window.addEventListener('online', () => {
      console.log('Network came back online, attempting to reconnect');
      this.connectionRetryCount = 0;
      
      // Cancel any existing reconnect timer
      if (this.autoReconnectTimer) {
        clearTimeout(this.autoReconnectTimer);
      }
      
      // Start the reconnection attempt
      this.attemptReconnection();
    });
    
    // Setup periodic connectivity checks, but less frequent to reduce network traffic
    setInterval(() => {
      // Only check if we're online and have credentials
      if (navigator.onLine && !this.isOfflineMode && this.hasCredentials()) {
        this.verifyConnectivity();
      }
    }, 120000); // Check every 2 minutes (increased from 1 minute)
  }
  
  private attemptReconnection(): void {
    if (this.connectionRetryCount >= this.maxConnectionRetries) {
      console.log('Maximum reconnection attempts reached');
      return;
    }
    
    this.connectionRetryCount++;
    console.log(`Reconnection attempt ${this.connectionRetryCount}/${this.maxConnectionRetries}`);
    
    // Try to ping Binance
    fetch('https://api.binance.com/api/v3/ping', {
      method: 'GET',
      cache: 'no-cache',
      signal: AbortSignal.timeout(5000)
    }).then(() => {
      // If we got here, we at least have some connectivity
      console.log('Basic connectivity to Binance detected');
      
      // If we're in offline mode, suggest switching back but don't show toast
      if (this.isOfflineMode) {
        // Don't show toast, just trigger an event for components to handle
        window.dispatchEvent(new CustomEvent('binance-connectivity-restored'));
      }
    }).catch(error => {
      console.warn('Reconnection ping failed:', error);
      
      // Schedule another attempt with exponential backoff
      const backoffTime = Math.min(5000 * Math.pow(1.5, this.connectionRetryCount), 30000);
      console.log(`Scheduling next reconnection attempt in ${backoffTime}ms`);
      
      this.autoReconnectTimer = setTimeout(() => {
        this.attemptReconnection();
      }, backoffTime);
    });
  }
  
  private verifyConnectivity(): void {
    // Simple connectivity check
    const img = new Image();
    img.onload = () => {
      console.log('Binance connectivity verified');
    };
    img.onerror = () => {
      console.warn('Periodic connectivity check failed');
      // We don't auto-switch to offline here to avoid disrupting the user
    };
    img.src = `https://www.binance.com/favicon.ico?_=${Date.now()}`;
  }
  
  public hasCredentials(): boolean {
    return this.apiClient.hasCredentials();
  }
  
  public getApiKey(): string {
    return this.apiClient.getApiKey();
  }
  
  public async initializeCredentialsFromVault(): Promise<boolean> {
    const credentials = await StorageManager.hydrateCredentialsFromVault();
    this.apiClient.setCredentials(credentials);
    return !!credentials;
  }

  public getVaultReference(): string {
    return StorageManager.getVaultReference();
  }

  public async saveCredentials(credentials: BinanceCredentials): Promise<VaultSaveResult> {
    try {
      const existingCredentials = this.apiClient.getCredentialsSnapshot();
      const nextSecretKey = credentials.secretKey?.trim() || existingCredentials?.secretKey || '';

      // Trim whitespace from credentials to prevent common errors
      const trimmedCredentials = {
        apiKey: credentials.apiKey?.trim() || '',
        secretKey: nextSecretKey
      };
      
      this.apiClient.setCredentials(trimmedCredentials);
      const result = await StorageManager.saveCredentials(trimmedCredentials);
      
      if (result.success) {
        window.dispatchEvent(new CustomEvent('binance-credentials-updated'));
        // Reset connection retry count when credentials change
        this.connectionRetryCount = 0;
      } else {
        this.apiClient.setCredentials(await StorageManager.hydrateCredentialsFromVault());
      }
      
      return result;
    } catch (error) {
      console.error('Failed to save credentials:', error);
      return {
        success: false,
        checkpointRequired: false,
        message: error instanceof Error ? error.message : 'Failed to save credentials.'
      };
    }
  }
  
  public setProxyMode(useLocalProxy: boolean): boolean {
    this.apiClient.setProxyMode(useLocalProxy);
    StorageManager.saveProxyMode(useLocalProxy);
    
    // Reset connection retry count when proxy mode changes
    this.connectionRetryCount = 0;
    
    return true;
  }
  
  public getProxyMode(): boolean {
    return this.apiClient.getProxyMode();
  }
  
  public setApiPermissions(readPermission: boolean, tradingPermission: boolean): void {
    StorageManager.saveApiPermissions({ read: readPermission, trading: tradingPermission });
  }
  
  public getApiPermissions(): { read: boolean, trading: boolean } {
    return StorageManager.loadApiPermissions();
  }
  
  public setOfflineMode(enabled: boolean): void {
    this.isOfflineMode = enabled;
    StorageManager.saveOfflineMode(enabled);
    
    // Broadcast event for components to update
    window.dispatchEvent(new CustomEvent('offline-mode-changed', { 
      detail: { enabled } 
    }));
    
    console.log(`Offline mode ${enabled ? 'enabled' : 'disabled'}`);
    
    if (!enabled) {
      // Reset connection retry count when exiting offline mode
      this.connectionRetryCount = 0;
    }
  }
  
  public isInOfflineMode(): boolean {
    return this.isOfflineMode;
  }
}
