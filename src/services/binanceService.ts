import { BinanceApiClient } from './binance/apiClient';
import { StorageManager } from './binance/storageManager';
import { LogManager } from './binance/logManager';
import { AccountService } from './binance/accountService';
import { MarketDataService } from './binance/marketDataService';
import { ConnectionService } from './binance/connectionService';
import { BalanceService } from './binance/balanceService';
import { TradingService } from './binance/tradingService';
import { CredentialsService } from './binance/credentialsService';
import { FallbackDataProvider } from './binance/fallbackDataProvider';
import { ConnectionStatusManager } from './binance/connectionStatusManager';
import { 
  BinanceCredentials, 
  BinanceBalance, 
  BinanceSymbol,
  BalanceInfo,
  AccountInfoResponse
} from './binance/types';
import { toast } from 'sonner';
import { VaultSaveResult } from './binance/vaultCredentialsStore';

class BinanceService {
  private apiClient: BinanceApiClient;
  private logManager: LogManager;
  private accountService: AccountService;
  private marketDataService: MarketDataService;
  private connectionService: ConnectionService;
  private balanceService: BalanceService;
  private tradingService: TradingService;
  private credentialsService: CredentialsService;
  private connectionStatusManager: ConnectionStatusManager;
  private credentialsReady: Promise<void>;
  
  constructor() {
    const credentials = StorageManager.loadCredentials();
    const useLocalProxy = StorageManager.getProxyMode();
    
    this.connectionStatusManager = new ConnectionStatusManager();
    this.apiClient = new BinanceApiClient(credentials, useLocalProxy);
    this.logManager = new LogManager();
    this.accountService = new AccountService(this.apiClient, this.logManager);
    this.marketDataService = new MarketDataService(this.apiClient, this.logManager);
    this.connectionService = new ConnectionService(this.apiClient, this.logManager, this.accountService);
    this.balanceService = new BalanceService(this.apiClient, this.logManager);
    this.tradingService = new TradingService(this.apiClient, this.logManager);
    this.credentialsService = new CredentialsService(this.apiClient);
    this.credentialsReady = this.credentialsService.initializeCredentialsFromVault().then(() => undefined);
    
    const permissions = StorageManager.loadApiPermissions();
    this.accountService.setApiPermissions(permissions.read, permissions.trading);
    
    // Check server time difference on startup
    this.apiClient.checkServerTimeDifference().catch(err => {
      console.warn("Failed to check server time:", err);
    });
    
    // Set up auto-reconnect on window focus
    window.addEventListener('focus', this.handleWindowFocus.bind(this));
  }
  
  private handleWindowFocus(): void {
    // Only auto-reconnect if we haven't had a successful connection in a while
    const hoursSinceLastConnection = this.connectionStatusManager.getHoursSinceLastConnection();
    if (hoursSinceLastConnection > 1 && this.hasCredentials()) {
      console.log("Window focused, testing connection after inactivity...");
      this.testConnection().catch(err => {
        console.warn("Auto-reconnect failed:", err);
      });
    }
  }

  public hasCredentials(): boolean {
    return this.credentialsService.hasCredentials();
  }

  public getVaultReference(): string {
    return this.credentialsService.getVaultReference();
  }

  public async initializeCredentialsFromVault(): Promise<boolean> {
    const loaded = await this.credentialsService.initializeCredentialsFromVault();
    this.credentialsReady = Promise.resolve();
    return loaded;
  }

  private async ensureCredentialsReady(): Promise<void> {
    await this.credentialsReady;
  }

  public async saveCredentials(credentials: BinanceCredentials): Promise<VaultSaveResult> {
    try {
      const result = await this.credentialsService.saveCredentials(credentials);
      
      this.accountService.setConnectionStatus('unknown');
      this.accountService.setLastConnectionError(null);
      this.balanceService.resetCache(); // Clear cache when credentials change
      
      if (result.success) {
        // After saving credentials, immediately test the connection
        this.logManager.addTradingLog("API credentials updated, testing connection...", 'info');
        this.scheduleConnectionTest();
      } else if (result.checkpointRequired) {
        this.logManager.addTradingLog("Vault checkpoint is waiting for owner approval.", 'warning');
      } else {
        this.logManager.addTradingLog(result.message || "Failed to save credentials to vault.", 'error');
      }
      
      return result;
    } catch (error) {
      console.error('Failed to save credentials:', error);
      this.logManager.addTradingLog(`Failed to save credentials: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return {
        success: false,
        checkpointRequired: false,
        message: error instanceof Error ? error.message : 'Failed to save credentials.'
      };
    }
  }
  
  private scheduleConnectionTest(): void {
    setTimeout(() => {
      this.testConnection().then(success => {
        if (success) {
          this.logManager.addTradingLog("Successfully connected with new credentials", 'success');
          this.getAccountBalance(true);
        } else {
          this.logManager.addTradingLog("Connection test with new credentials failed", 'error');
          
          // Check if this is likely a network issue
          const lastError = this.getLastConnectionError();
          if (lastError && (
              lastError.includes("Network connectivity") || 
              lastError.includes("internet") || 
              lastError.includes("offline") ||
              lastError.includes("Load failed")
          )) {
            toast.error("Network connectivity issue detected. Please check your internet connection.");
            this.logManager.addTradingLog("Network connectivity issue detected. Please check your internet connection or try enabling offline mode.", 'warning');
          }
        }
      });
    }, 500);
  }

  public getApiKey(): string {
    return this.credentialsService.getApiKey();
  }

  public setProxyMode(useLocalProxy: boolean) {
    this.credentialsService.setProxyMode(useLocalProxy);
    
    this.accountService.setConnectionStatus('unknown');
    this.accountService.setLastConnectionError(null);
    this.balanceService.resetCache(); // Clear cache when proxy mode changes
    
    this.scheduleConnectionTest();
    
    return true;
  }

  public getProxyMode(): boolean {
    return this.credentialsService.getProxyMode();
  }

  public setApiPermissions(readPermission: boolean, tradingPermission: boolean): void {
    this.accountService.setApiPermissions(readPermission, tradingPermission);
    this.credentialsService.setApiPermissions(readPermission, tradingPermission);
  }
  
  public getApiPermissions(): { read: boolean, trading: boolean } {
    return this.accountService.getApiPermissions();
  }

  public async detectApiPermissions(): Promise<{ read: boolean, trading: boolean }> {
    try {
      const permissions = await this.accountService.detectApiPermissions();
      this.credentialsService.setApiPermissions(permissions.read, permissions.trading);
      return permissions;
    } catch (error) {
      console.error("Error detecting API permissions:", error);
      // Default to assuming read permission if we can't detect
      const fallback = { read: true, trading: false };
      this.credentialsService.setApiPermissions(fallback.read, fallback.trading);
      return fallback;
    }
  }

  public getConnectionStatus(): 'connected' | 'disconnected' | 'unknown' {
    return this.accountService.getConnectionStatus();
  }

  public isProxyWorking(): boolean {
    return this.apiClient.isProxyWorking();
  }

  public getLastConnectionError(): string | null {
    return this.accountService.getLastConnectionError();
  }

  public async testConnection(): Promise<boolean> {
    await this.ensureCredentialsReady();
    try {
      // First check for network connectivity by testing connectivity to a major site
      try {
        const networkTestResponse = await fetch('https://www.google.com/generate_204', {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
          cache: 'no-cache',
          headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
        });
        
        if (!networkTestResponse.ok) {
          console.warn("General network connectivity test failed");
          this.accountService.setConnectionStatus('disconnected');
          this.accountService.setLastConnectionError("Network connectivity issue detected. Your device appears to be offline.");
          return false;
        }
      } catch (networkError) {
        console.error("Network connectivity test failed:", networkError);
        this.accountService.setConnectionStatus('disconnected');
        this.accountService.setLastConnectionError("Network connectivity issue detected. Your device appears to be offline.");
        
        const connectionErrors = this.connectionStatusManager.incrementConnectionErrors();
        if (connectionErrors >= 2) {
          toast.error("Network connectivity issue detected. Please check your internet connection.");
        }
        
        return false;
      }
      
      const result = await this.connectionService.testConnection();
      if (result) {
        this.balanceService.resetCache();
        this.connectionStatusManager.recordSuccessfulConnection();
      } else {
        const connectionErrors = this.connectionStatusManager.incrementConnectionErrors();
        this.connectionStatusManager.checkConnectionTimeAndNotify();
        
        if (connectionErrors >= this.connectionStatusManager.getMaxConnectionErrors()) {
          toast.error("Multiple connection failures. Switching to offline demo mode.");
          this.logManager.addTradingLog("Multiple connection failures. Using offline demo mode.", 'warning');
          this.credentialsService.setOfflineMode(true);
        }
      }
      return result;
    } catch (error) {
      console.error("Test connection error:", error);
      this.connectionStatusManager.incrementConnectionErrors();
      
      // Detect network errors specifically
      if (error instanceof Error && (
          error.message.includes("Network") || 
          error.message.includes("internet") || 
          error.message.includes("offline") || 
          error.message.includes("Load failed")
      )) {
        this.accountService.setLastConnectionError("Network connectivity issue detected. Please check your internet connection.");
        toast.error("Network connectivity issue detected. Please check your internet connection.");
      }
      
      return false;
    }
  }

  public isInOfflineMode(): boolean {
    return this.credentialsService.isInOfflineMode();
  }
  
  public setOfflineMode(enabled: boolean): void {
    this.credentialsService.setOfflineMode(enabled);
    if (enabled) {
      toast.info("Offline mode enabled. Using demo data.");
      this.logManager.addTradingLog("Offline mode enabled. Using demo data.", 'info');
    } else {
      toast.info("Offline mode disabled. Attempting to connect to Binance...");
      this.testConnection();
    }
  }

  public isInTestMode(): boolean {
    return false;
  }

  public getDefaultTradingPairs(): string[] {
    try {
      return this.accountService.getDefaultTradingPairs();
    } catch (error) {
      return FallbackDataProvider.getDefaultTradingPairs();
    }
  }

  public async getAccountInfo(): Promise<AccountInfoResponse> {
    await this.ensureCredentialsReady();
    try {
      if (this.accountService.getConnectionStatus() === 'unknown' && this.hasCredentials()) {
        await this.testConnection();
      }
      
      return await this.balanceService.getAccountInfo();
    } catch (error) {
      console.error('Error in getAccountInfo:', error);
      toast.error('Failed to fetch account information. Using demo data.');
      
      // Return fallback data
      return {
        balances: FallbackDataProvider.getSafeBalances(),
        isDefault: true,
        isLimitedAccess: true
      };
    }
  }

  public async getAccountBalance(forceRefresh: boolean = false): Promise<Record<string, BalanceInfo>> {
    await this.ensureCredentialsReady();
    try {
      if (this.accountService.getConnectionStatus() === 'unknown' && this.hasCredentials()) {
        await this.testConnection();
      }
      
      return await this.balanceService.getAccountBalance(forceRefresh);
    } catch (error) {
      console.error('Error in getAccountBalance:', error);
      toast.error('Failed to fetch account balance. Using demo data.');
      
      // Create fallback data
      const fallbackData: Record<string, BalanceInfo> = {};
      const mockBalances = FallbackDataProvider.getSafeBalances();
      
      mockBalances.forEach(balance => {
        fallbackData[balance.asset] = {
          available: balance.free,
          total: (parseFloat(balance.free) + parseFloat(balance.locked)).toString(),
          usdValue: balance.asset === 'USDT' ? parseFloat(balance.free) : 0,
          rawAsset: balance.asset,
          isDefault: true
        };
      });
      
      return fallbackData;
    }
  }

  public forceDirectApi(enabled: boolean): void {
    StorageManager.forceDirectApi(enabled);
    if (enabled) {
      this.accountService.setConnectionStatus('unknown');
      this.accountService.setLastConnectionError(null);
      this.balanceService.resetCache();
      this.logManager.addTradingLog("Force direct API enabled. Bypassing all proxies.", 'info');
      toast.success("Direct API mode enabled. Bypassing all proxies.");
      this.scheduleConnectionTest();
    } else {
      this.logManager.addTradingLog("Direct API mode disabled. Using proxy configuration.", 'info');
      toast.info("Direct API mode disabled.");
      this.scheduleConnectionTest();
    }
  }
  
  public isDirectApiForced(): boolean {
    return StorageManager.shouldForceDirectApi();
  }
  
  public bypassConnectionChecks(bypass: boolean): void {
    StorageManager.bypassConnectionChecks(bypass);
    if (bypass) {
      this.logManager.addTradingLog("Connection checks bypassed. All operations will proceed regardless of actual connectivity.", 'warning');
    } else {
      this.logManager.addTradingLog("Connection check bypass disabled. Normal connectivity checks restored.", 'info');
    }
  }
  
  public areConnectionChecksBypassed(): boolean {
    return StorageManager.shouldBypassConnectionChecks();
  }

  public async placeMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string
  ): Promise<any> {
    await this.ensureCredentialsReady();
    const result = await this.tradingService.placeMarketOrder(symbol, side, quantity);
    this.balanceService.resetCache();
    return result;
  }

  public async getSymbols(): Promise<BinanceSymbol[]> {
    return this.marketDataService.getSymbols();
  }

  public async getRecentTrades(symbol: string): Promise<any[]> {
    return this.marketDataService.getRecentTrades(symbol);
  }

  public async getPrices(): Promise<Record<string, string>> {
    return this.marketDataService.getPrices();
  }

  public async getKlines(
    symbol: string,
    interval: string,
    limit: number = 100
  ): Promise<any[]> {
    return this.marketDataService.getKlines(symbol, interval, limit);
  }

  public getTradingLogs() {
    return this.logManager.getTradingLogs();
  }

  public clearTradingLogs() {
    this.logManager.clearTradingLogs();
  }

  public addTradingLog(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
    this.logManager.addTradingLog(message, type);
  }
}

const binanceService = new BinanceService();
export default binanceService;
