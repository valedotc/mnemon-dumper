// logger.ts

export type LogLevel = 0 | 1 | 2 | 3;

export class Logger {
  constructor(readonly level: LogLevel) {}

  info(msg: string): void  { console.log(`[mnemon] ${msg}`); }
  warn(msg: string): void  { console.warn(`[mnemon] ${msg}`); }
  error(msg: string): void { console.error(`[mnemon] ${msg}`); }

  v(msg: string):   void { if (this.level >= 1) console.log(`[mnemon] [v] ${msg}`); }
  vv(msg: string):  void { if (this.level >= 2) console.log(`[mnemon] [vv] ${msg}`); }
  vvv(msg: string): void { if (this.level >= 3) console.log(`[mnemon] [vvv] ${msg}`); }
}

export const SILENT = new Logger(0);
