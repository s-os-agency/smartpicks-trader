import { BinanceCredentials } from './types';
import { StorageManager } from './storageManager';

export class BinanceApiClient {
  private proxyUrl: string = 'https://binance-proxy.vercel.app/api';
  private credentials: BinanceCredentials | null = null;
  private useLocalProxy: boolean = true;
  private proxyConnectionSuccessful: boolean = false;
  private lastProxyConnectionAttempt: number = 0;
  private proxyRetries: number = 5; // Increased from 3 to 5
  private directApiAvailable: boolean = false;
  private fallbackProxyUrl: string = 'https://binance-bridge-proxy.onrender.com/api'; // Fallback proxy
  private useFallbackProxy: boolean = false;
  private secondaryFallbackProxyUrl: string = 'https://binance-api-proxy.up.railway.app/api'; // Additional fallback
  private useSecondaryFallback: boolean = false;
  private timeDifference: number = 0;
  
  constructor(credentials: BinanceCredentials | null, useLocalProxy: boolean) {
    this.credentials = credentials;
    this.useLocalProxy = useLocalProxy;
    // Check if direct API is available on initialization
    this.checkDirectApiAvailability();
    // Initialize time difference check
    this.checkServerTimeDifference();
  }
  
  public setCredentials(credentials: BinanceCredentials | null): void {
    this.credentials = credentials;
  }
  
  public setProxyMode(useLocalProxy: boolean): void {
    this.useLocalProxy = useLocalProxy;
    this.proxyConnectionSuccessful = false;
  }
  
  public getProxyMode(): boolean {
    return this.useLocalProxy;
  }
  
  public isProxyWorking(): boolean {
    return this.proxyConnectionSuccessful;
  }
  
  public setProxyConnectionSuccessful(successful: boolean): void {
    this.proxyConnectionSuccessful = successful;
  }
  
  public isDirectApiAvailable(): boolean {
    return this.directApiAvailable;
  }
  
  public hasCredentials(): boolean {
    return this.credentials !== null && !!this.credentials.apiKey && !!this.credentials.secretKey;
  }
  
  public getApiKey(): string {
    return this.credentials?.apiKey || '';
  }

  public getCredentialsSnapshot(): BinanceCredentials | null {
    return this.credentials ? { ...this.credentials } : null;
  }

  public async generateSignature(queryString: string): Promise<string> {
    if (!this.credentials || !this.credentials.secretKey) {
      throw new Error('API secret key not configured');
    }
    
    try {
      // In a browser environment, we need to use the subtle crypto API
      const encoder = new TextEncoder();
      const data = encoder.encode(queryString);
      const key = encoder.encode(this.credentials.secretKey);
      
      // Create the HMAC signature using crypto.subtle
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      
      const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
      
      // Convert the signature to hex
      return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } catch (error) {
      console.error('Error generating signature:', error);
      throw new Error('Failed to generate API signature');
    }
  }

  private async checkDirectApiAvailability(): Promise<void> {
    try {
      const response = await fetch('https://api.binance.com/api/v3/ping', {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      this.directApiAvailable = response.ok;
      console.log(`Direct Binance API availability: ${this.directApiAvailable}`);
    } catch (error) {
      console.warn('Direct Binance API check failed:', error);
      this.directApiAvailable = false;
    }
  }

  public async fetchWithProxy(
    endpoint: string, 
    params: Record<string, string> = {}, 
    method: string = 'GET',
    skipRetryOnFailure: boolean = false
  ): Promise<any> {
    const forceDirectApi = StorageManager.shouldForceDirectApi();
    
    // If force direct API is enabled, attempt to use the direct API immediately
    if (forceDirectApi) {
      console.log('Force direct API mode enabled, bypassing proxies');
      return this.attemptDirectApiCall(endpoint, params, method);
    }
    
    if (!this.hasCredentials() && !endpoint.match(/^(ping|ticker|time|klines)/)) {
      throw new Error('API credentials not configured');
    }

    let lastError;
    const maxRetries = skipRetryOnFailure ? 1 : this.proxyRetries;
    
    // Add timestamp and recvWindow to signed requests if not already present
    if (!params.timestamp && this.requiresSignature(endpoint) && method !== 'DELETE') {
      // Use server time with adjustment if available, otherwise use local time
      const timestamp = Date.now() + this.timeDifference;
      params.timestamp = timestamp.toString();
      
      // Add recvWindow for all signed requests to handle time differences
      if (!params.recvWindow) {
        params.recvWindow = '10000'; // 10 seconds
      }
    }
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const queryString = Object.entries(params)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&');

        // Determine which proxy URL to use
        let currentProxyUrl = this.proxyUrl;
        if (this.useFallbackProxy) {
          currentProxyUrl = this.fallbackProxyUrl;
        } else if (this.useSecondaryFallback) {
          currentProxyUrl = this.secondaryFallbackProxyUrl;
        }
        
        const url = `${currentProxyUrl}/${endpoint}${queryString ? `?${queryString}` : ''}`;
        
        const headers: Record<string, string> = {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache, no-store',
        };
        
        // Only add auth headers if we have credentials and they're needed
        if (this.credentials?.apiKey) {
          headers['X-API-KEY'] = this.credentials.apiKey;
          if (this.credentials.secretKey) {
            headers['X-API-SECRET-HASH'] = btoa(this.credentials.secretKey.slice(-8) || '');
          }
        }

        console.log(`Fetching via ${this.getCurrentProxyName()} proxy (attempt ${attempt + 1}/${maxRetries}): ${endpoint}`);
        this.lastProxyConnectionAttempt = Date.now();
        
        const response = await fetch(url, {
          method,
          headers,
          mode: 'cors',
          cache: 'no-store',
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
          console.warn(`HTTP error ${response.status}: ${response.statusText}`);
          let errorText = await response.text();
          throw new Error(`HTTP error ${response.status}: ${errorText || response.statusText}`);
        }

        const data = await response.json();
        this.proxyConnectionSuccessful = true;
        console.log(`Proxy request to ${endpoint} successful`);
        
        // Reset fallback flags on success
        this.useFallbackProxy = false;
        this.useSecondaryFallback = false;
        
        return data;
      } catch (error) {
        console.error(`Error in fetchWithProxy (attempt ${attempt + 1}/${maxRetries}):`, error);
        lastError = error;
        
        // Try different proxies on subsequent attempts
        if (attempt === 0) {
          this.useFallbackProxy = true;
          this.useSecondaryFallback = false;
          console.log("Switching to first fallback proxy for next attempt");
        } else if (attempt === 1) {
          this.useFallbackProxy = false;
          this.useSecondaryFallback = true;
          console.log("Switching to secondary fallback proxy for next attempt");
        } else if (attempt === 2 || forceDirectApi) {
          // Try direct API on the third attempt if available
          if (this.directApiAvailable && this.canUseDirectApi(endpoint)) {
            try {
              console.log(`Attempting direct API call for ${endpoint}...`);
              return await this.attemptDirectApiCall(endpoint, params, method);
            } catch (directError) {
              console.error('Direct API fallback failed:', directError);
              // Continue with proxy retries
            }
          }
        }
        
        // Wait a bit before retrying (increasing delay for each retry)
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          console.log(`Retrying proxy request to ${endpoint}...`);
        }
      }
    }
    
    // Reset fallback proxy flags after all attempts
    this.useFallbackProxy = false;
    this.useSecondaryFallback = false;
    this.proxyConnectionSuccessful = false;
    console.error(`All ${maxRetries} proxy attempts failed for ${endpoint}`);
    
    // Final attempt: try direct API if possible and not already tried
    if (!forceDirectApi && this.directApiAvailable && this.canUseDirectApi(endpoint)) {
      console.log(`Making final direct API attempt for ${endpoint}...`);
      try {
        return await this.attemptDirectApiCall(endpoint, params, method);
      } catch (directError) {
        console.error('Final direct API attempt failed:', directError);
      }
    }
    
    throw lastError || new Error(`Failed to fetch data from ${endpoint}`);
  }
  
  private getCurrentProxyName(): string {
    if (StorageManager.shouldForceDirectApi()) return 'forced direct API';
    if (this.useFallbackProxy) return 'fallback';
    if (this.useSecondaryFallback) return 'secondary fallback';
    return 'primary';
  }
  
  private canUseDirectApi(endpoint: string): boolean {
    // These endpoints can be used with direct API without requiring signed requests
    return endpoint.match(/^(ping|ticker|klines|time|exchangeInfo)/) !== null;
  }
  
  private requiresSignature(endpoint: string): boolean {
    // These endpoints require signature
    return !endpoint.match(/^(ping|ticker\/price|ticker\/24hr|time|klines|exchangeInfo)$/);
  }
  
  private async attemptDirectApiCall(endpoint: string, params: Record<string, string>, method: string = 'GET'): Promise<any> {
    const apiBase = 'https://api.binance.com/api/v3';
    let url: string;
    
    // Add signature if needed
    if (this.requiresSignature(endpoint) && this.credentials?.secretKey) {
      // Make a copy of params to avoid modifying the original
      const signedParams = { ...params };
      
      // Ensure timestamp is included
      if (!signedParams.timestamp) {
        signedParams.timestamp = (Date.now() + this.timeDifference).toString();
      }
      
      // Generate signature
      const queryString = Object.entries(signedParams)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
      
      const signature = await this.generateSignature(queryString);
      url = `${apiBase}/${endpoint}?${queryString}&signature=${signature}`;
    } else {
      // Convert proxy endpoints to direct API endpoints
      switch (endpoint) {
        case 'ping':
          url = `${apiBase}/ping`;
          break;
        case 'time':
          url = `${apiBase}/time`;
          break;
        case 'ticker/price':
          if (params.symbol) {
            url = `${apiBase}/ticker/price?symbol=${params.symbol}`;
          } else {
            url = `${apiBase}/ticker/price`;
          }
          break;
        case 'ticker/24hr':
          if (params.symbol) {
            url = `${apiBase}/ticker/24hr?symbol=${params.symbol}`;
          } else {
            url = `${apiBase}/ticker/24hr`;
          }
          break;
        case 'klines':
          url = `${apiBase}/klines?symbol=${params.symbol}&interval=${params.interval}&limit=${params.limit || 100}`;
          break;
        case 'exchangeInfo':
          url = `${apiBase}/exchangeInfo`;
          if (params.symbol) {
            url += `?symbol=${params.symbol}`;
          }
          break;
        default:
          throw new Error(`Endpoint ${endpoint} not supported for direct API fallback`);
      }
    }
    
    // Add API key header for authenticated requests
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Cache-Control': 'no-cache, no-store'
    };
    
    if (this.credentials?.apiKey) {
      headers['X-MBX-APIKEY'] = this.credentials.apiKey;
    }
    
    console.log(`Direct API request to ${endpoint}`);
    const response = await this.fetchWithRetry(url, { method, headers }, 3);
    return await response.json();
  }

  public async fetchWithRetry(url: string, options: RequestInit = {}, retries = 3): Promise<Response> {
    let lastError;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        console.log(`Attempt ${attempt + 1}: Fetching ${url}`);
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(15000),
          cache: 'no-store'
        });
        
        if (!response.ok) {
          console.warn(`HTTP error ${response.status}: ${response.statusText}`);
          let errorText = await response.text();
          throw new Error(`HTTP error ${response.status}: ${errorText || response.statusText}`);
        }
        
        console.log(`Request to ${url} successful`);
        return response;
      } catch (error) {
        console.warn(`API request failed (attempt ${attempt + 1}/${retries}):`, error);
        lastError = error;
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }
    
    console.error(`All ${retries} attempts to ${url} failed`);
    throw lastError;
  }
  
  public async checkServerTimeDifference(): Promise<number> {
    try {
      const localTime = Date.now();
      const response = await fetch('https://api.binance.com/api/v3/time', {
        signal: AbortSignal.timeout(5000),
        cache: 'no-store'
      });
      
      if (!response.ok) {
        return 0;
      }
      
      const data = await response.json();
      const serverTime = data.serverTime;
      const endLocalTime = Date.now();
      
      // Calculate time difference considering the request latency
      const latency = (endLocalTime - localTime) / 2;
      const adjustedLocalTime = localTime + latency;
      const difference = serverTime - adjustedLocalTime;
      
      console.log(`Server time difference: ${difference}ms (latency: ${latency}ms)`);
      this.timeDifference = difference;
      return difference;
    } catch (error) {
      console.warn('Failed to check server time:', error);
      return 0;
    }
  }
  
  public getTimeDifference(): number {
    return this.timeDifference;
  }
}
