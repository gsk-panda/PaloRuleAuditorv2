// Enhanced debug logger for PaloRuleAuditor
import * as fs from 'fs';
import * as path from 'path';

export class DebugLogger {
  private static instance: DebugLogger;
  private logLevel: 'debug' | 'info' | 'warn' | 'error' = 'debug';
  private logToFile: boolean = false;
  private logFilePath: string = './debug.log';
  private startTime: number;

  private constructor() {
    this.startTime = Date.now();
    console.log('[DebugLogger] Initialized');
  }

  public static getInstance(): DebugLogger {
    if (!DebugLogger.instance) {
      DebugLogger.instance = new DebugLogger();
    }
    return DebugLogger.instance;
  }

  public setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.logLevel = level;
    console.log(`[DebugLogger] Log level set to ${level}`);
  }

  public enableFileLogging(filePath?: string): void {
    this.logToFile = true;
    if (filePath) {
      this.logFilePath = filePath;
    } else {
      // Generate date-based log file name: auditlog-yyyymmdd.log
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      this.logFilePath = path.join(process.cwd(), `auditlog-${year}${month}${day}.log`);
    }
    console.log(`[DebugLogger] File logging enabled at ${this.logFilePath}`);
  }

  public disableFileLogging(): void {
    this.logToFile = false;
    console.log('[DebugLogger] File logging disabled');
  }

  private getTimestamp(): string {
    const elapsed = Date.now() - this.startTime;
    return `[${new Date().toISOString()}] [+${elapsed}ms]`;
  }

  private writeToFile(message: string): void {
    if (this.logToFile) {
      try {
        fs.appendFileSync(this.logFilePath, message + '\n', 'utf-8');
      } catch (error) {
        console.error('[DebugLogger] Failed to write to log file:', error);
      }
    }
  }

  public debug(context: string, message: string, data?: any): void {
    if (this.logLevel === 'debug') {
      const logMessage = `${this.getTimestamp()} [DEBUG] [${context}] ${message}`;
      console.log(logMessage);
      this.writeToFile(logMessage);
      if (data) {
        const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
        console.log(data);
        this.writeToFile(dataStr);
      }
    }
  }

  public info(context: string, message: string, data?: any): void {
    if (this.logLevel === 'debug' || this.logLevel === 'info') {
      const logMessage = `${this.getTimestamp()} [INFO] [${context}] ${message}`;
      console.log(logMessage);
      this.writeToFile(logMessage);
      if (data) {
        const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
        console.log(data);
        this.writeToFile(dataStr);
      }
    }
  }

  public warn(context: string, message: string, data?: any): void {
    if (this.logLevel === 'debug' || this.logLevel === 'info' || this.logLevel === 'warn') {
      const logMessage = `${this.getTimestamp()} [WARN] [${context}] ${message}`;
      console.warn(logMessage);
      this.writeToFile(logMessage);
      if (data) {
        const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
        console.warn(data);
        this.writeToFile(dataStr);
      }
    }
  }

  public error(context: string, message: string, error?: any): void {
    const logMessage = `${this.getTimestamp()} [ERROR] [${context}] ${message}`;
    console.error(logMessage);
    this.writeToFile(logMessage);
    if (error) {
      if (error instanceof Error) {
        const errorMsg = `Error: ${error.message}`;
        const stackMsg = `Stack: ${error.stack}`;
        console.error(errorMsg);
        console.error(stackMsg);
        this.writeToFile(errorMsg);
        this.writeToFile(stackMsg);
      } else {
        const errorStr = typeof error === 'object' ? JSON.stringify(error, null, 2) : String(error);
        console.error(error);
        this.writeToFile(errorStr);
      }
    }
  }

  public logApiRequest(method: string, url: string, params?: any): void {
    this.debug('API', `${method} ${url}`, params);
  }

  public logApiResponse(url: string, status: number, data?: any): void {
    this.debug('API', `Response ${status} from ${url}`, data);
  }

  public logPanoramaRequest(endpoint: string, params: any): void {
    this.debug('PANORAMA', `Request to ${endpoint}`, params);
  }

  public logPanoramaResponse(endpoint: string, status: number, data?: any): void {
    this.debug('PANORAMA', `Response ${status} from ${endpoint}`, 
      data ? (typeof data === 'string' && data.length > 500 ? data.substring(0, 500) + '...' : data) : undefined);
  }
}

// Export a singleton instance
export const logger = DebugLogger.getInstance();
